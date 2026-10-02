// Three run-game questions, nflverse 2022–25 (each prediction uses only earlier weeks):
//  A. Run defense: shrink a defense's quality-adjusted RB YPC allowed toward LEAGUE (current) or toward its own regressed
//     LAST-SEASON level? Target: each RB game's YPC (carries-weighted squared error), player baseline × mult^0.5.
//  B. Garbage time: a back's carry share measured on ALL plays (current) vs NON-BLOWOUT plays only (|score diff| < 17),
//     predicting his share of the team's non-blowout carries next game.
//  C. Rookie YPC trend: rookie backs' next-game YPC from flat season YPC vs recency-weighted YPC.
//   node --no-warnings scripts/run_context_tests.mjs
import { loadWeekly, rbDefenseQuality } from '../src/situational.js';
import { loadPlays, loadPlayerIds } from '../src/pbp.js';
const ids = await loadPlayerIds();
const W = {}; for (const s of [2021, 2022, 2023, 2024, 2025]) W[s] = await loadWeekly(s);
const isRb = (r) => (r.position === 'RB' || r.position === 'FB') && +r.carries > 0;

// ---------- A ----------
{
  const cfgs = [{ name: 'league (current)', r: 0 }, ...[0.25, 0.5, 0.75].map((r) => ({ name: `last season ×${r}`, r }))];
  const res = cfgs.map(() => ({ se: 0, w: 0, se2: 0, w2: 0 }));
  for (const s of [2022, 2023, 2024, 2025]) {
    const cur = W[s], prev = W[s - 1], prev2 = W[s - 2] || [];
    const prevQ = new Map(); const lgPrev = (() => { const L = prev.filter(isRb); return L.reduce((a, r) => a + +r.rushing_yards, 0) / L.reduce((a, r) => a + +r.carries, 0); })();
    for (const t of new Set(prev.map((r) => r.opponent_team))) { const q = rbDefenseQuality(prev, prev2, 99, t); if (q) prevQ.set(t, q.adjYpc / lgPrev); }
    for (let wk = 3; wk <= 17; wk++) {
      const games = cur.filter((r) => isRb(r) && +r.week === wk && +r.carries >= 5); if (!games.length) continue;
      const dq = new Map();
      for (const g of games) {
        let q = dq.get(g.opponent_team); if (q === undefined) { q = rbDefenseQuality(cur, prev, wk, g.opponent_team); dq.set(g.opponent_team, q); }
        if (!q) continue;
        const pc = cur.filter((r) => r.player_id === g.player_id && +r.week < wk), pp = prev.filter((r) => r.player_id === g.player_id);
        const c = pc.reduce((a, r) => a + +r.carries, 0) + 0.5 * pp.reduce((a, r) => a + +r.carries, 0), y = pc.reduce((a, r) => a + +r.rushing_yards, 0) + 0.5 * pp.reduce((a, r) => a + +r.rushing_yards, 0);
        const base = (y + 60 * q.lg) / (c + 60), act = +g.rushing_yards / +g.carries;
        cfgs.forEach((cf, i) => {
          const prior = q.lg * (1 + cf.r * ((prevQ.get(g.opponent_team) ?? 1) - 1));
          const mult = ((q.adjYpc * q.carries + prior * 80) / (q.carries + 80)) / q.lg;
          const e = (base * Math.pow(Math.min(1.25, Math.max(0.8, mult)), 0.5) - act) ** 2 * +g.carries;
          res[i].se += e; res[i].w += +g.carries; if (s >= 2024) { res[i].se2 += e; res[i].w2 += +g.carries; }
        });
      }
    }
  }
  console.log('A. run defense prior — carries-weighted YPC error (all 2022–25 | 2024–25):');
  cfgs.forEach((cf, i) => console.log(`   ${cf.name.padEnd(18)} ${(res[i].se / res[i].w).toFixed(4)} | ${(res[i].se2 / res[i].w2).toFixed(4)}`));
}

// ---------- B ----------
{
  const r = { all: 0, nb: 0, n: 0, allD: 0, nbD: 0, nD: 0 };
  for (const s of [2022, 2023, 2024, 2025]) {
    const P = (await loadPlays(s)).filter((p) => !p.post && p.t === 'R' && p.ru && !p.scr && ids.posByGsis.get(p.ru) === 'RB');
    const G = new Map(); // team → week → {all:{pid:n}, tot, nb:{}, nbTot}
    for (const p of P) { const t = (G.get(p.o) || G.set(p.o, new Map()).get(p.o)); const g = t.get(p.w) || t.set(p.w, { all: {}, tot: 0, nb: {}, nbTot: 0 }).get(p.w); g.all[p.ru] = (g.all[p.ru] || 0) + 1; g.tot++; if (p.sd == null || Math.abs(p.sd) < 17) { g.nb[p.ru] = (g.nb[p.ru] || 0) + 1; g.nbTot++; } }
    for (const [, T] of G) {
      const weeks = [...T.keys()].sort((a, b) => a - b);
      for (let i = 2; i < weeks.length - 1; i++) {
        const hist = weeks.slice(0, i + 1).map((w) => T.get(w)), nx = T.get(weeks[i + 1]); if (!nx.nbTot) continue;
        const backs = new Set(hist.flatMap((g) => Object.keys(g.all)));
        for (const b of backs) {
          let a = 0, at = 0, n = 0, nt = 0; hist.forEach((g, j) => { const w = Math.pow(0.82, hist.length - 1 - j); a += w * (g.all[b] || 0); at += w * g.tot; n += w * (g.nb[b] || 0); nt += w * g.nbTot; });
          const sAll = at ? a / at : 0, sNb = nt ? n / nt : 0, y = (nx.nb[b] || 0) / nx.nbTot;
          if (sAll < 0.02) continue;
          r.all += Math.abs(sAll - y); r.nb += Math.abs(sNb - y); r.n++;
          if (sAll < 0.25) { r.allD += Math.abs(sAll - y); r.nbD += Math.abs(sNb - y); r.nD++; } // depth backs
        }
      }
    }
  }
  console.log(`B. garbage time — next game's non-blowout carry share, error (pts): all backs n=${r.n} all-plays ${(r.all / r.n * 100).toFixed(2)} vs non-blowout ${(r.nb / r.n * 100).toFixed(2)} | depth backs (<25%) n=${r.nD} ${(r.allD / r.nD * 100).toFixed(2)} vs ${(r.nbD / r.nD * 100).toFixed(2)}`);
}

// ---------- C ----------
{
  const first = new Map(); for (const s of [2021, 2022, 2023, 2024, 2025]) for (const x of W[s]) if (!first.has(x.player_id)) first.set(x.player_id, s);
  const lams = [1, 0.85, 0.7, 0.5]; const e = lams.map(() => [0, 0]);
  for (const s of [2022, 2023, 2024, 2025]) {
    const by = new Map(); for (const x of W[s]) if (isRb(x) && first.get(x.player_id) === s) (by.get(x.player_id) || by.set(x.player_id, []).get(x.player_id)).push(x);
    for (const [, G] of by) { G.sort((a, b) => +a.week - +b.week); for (let i = 2; i < G.length - 1; i++) { const nx = G[i + 1]; if (+nx.carries < 5) continue; const H = G.slice(0, i + 1); const act = +nx.rushing_yards / +nx.carries;
      lams.forEach((l, k) => { let c = 0, y = 0; H.forEach((g, j) => { const w = Math.pow(l, H.length - 1 - j); c += w * +g.carries; y += w * +g.rushing_yards; }); const pred = (y + 40 * 4.25) / (c + 40); e[k][0] += (pred - act) ** 2 * +nx.carries; e[k][1] += +nx.carries; }); } }
  }
  console.log('C. rookie YPC trend — next-game YPC error by recency λ: ' + lams.map((l, k) => `λ ${l}: ${(e[k][0] / e[k][1]).toFixed(3)}`).join(' · '));
}
