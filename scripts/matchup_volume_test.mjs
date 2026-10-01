// Does a favorable matchup bring MORE TARGETS (not just more yards per target)? nflverse pbp 2022–25.
// For each receiver-game (≥2 prior games this season with ≥10% target share), residual = this game's target
// share − his trailing share. Predictors, all from the opponent's PRIOR games only (no leakage):
//   funnel  — share of targets the defense allowed to his position, minus league share for that position
//   softYPT — yards per target the defense allowed to his position, minus league
//   zoneFit — (WR/TE) defense's yds/target allowed on the pass locations he is usually targeted at, minus league
// Reports the fitted slope and how much of the residual it explains, then a walk-forward check:
// does adding k·predictor to the trailing share reduce target misses on the next season?
import { loadPlays, loadPlayerIds } from '../src/pbp.js';
const { posByGsis } = await loadPlayerIds();
const P = (id) => { const p = posByGsis.get(id); return p === 'FB' ? 'RB' : p; };
const out = [];
for (const season of [2022, 2023, 2024, 2025]) {
  const plays = (await loadPlays(season)).filter((p) => !p.post && p.t === 'P' && !p.sk && p.rec);
  const byGame = new Map();
  for (const p of plays) { const k = `${p.g}|${p.o}`; (byGame.get(k) || byGame.set(k, { w: p.w, o: p.o, d: p.d, plays: [] }).get(k)).plays.push(p); }
  const games = [...byGame.values()].sort((a, b) => a.w - b.w);
  const L = { n: 0, pos: {}, ypt: {}, loc: {} };
  const D = new Map(), R = new Map(); // defense aggregates, receiver aggregates (season-to-date)
  const weeks = [...new Set(games.map((g) => g.w))];
  for (const w of weeks) {
    const gw = games.filter((g) => g.w === w);
    // 1) evaluate with data before week w
    for (const g of gw) {
      const tot = g.plays.length, cnt = new Map(), yds = new Map();
      for (const p of g.plays) { cnt.set(p.rec, (cnt.get(p.rec) || 0) + 1); yds.set(p.rec, (yds.get(p.rec) || 0) + p.y); }
      const d = D.get(g.d);
      if (!d || d.n < 60 || L.n < 500) continue;
      for (const [id, c] of cnt) {
        const r = R.get(id), pos = P(id);
        if (!r || r.games.length < 2 || !['WR', 'TE', 'RB'].includes(pos)) continue;
        const trail = r.games.reduce((a, x) => a + x, 0) / r.games.length;
        if (trail < 0.1) continue;
        const lgShare = (L.pos[pos] || 0) / L.n, dShare = (d.pos[pos] || 0) / d.n;
        const lgYpt = L.ypt[pos][0] / L.ypt[pos][1], dYpt = d.ypt[pos] ? d.ypt[pos][0] / Math.max(1, d.ypt[pos][1]) : lgYpt;
        let zf = 0, zn = 0;
        for (const [loc, n] of Object.entries(r.loc)) { const dl = d.loc[loc], ll = L.loc[loc]; if (!dl || !ll) continue; zf += n * (dl[0] / dl[1] - ll[0] / ll[1]); zn += n; }
        out.push({ season, tg: c, yptResid: yds.get(id) / c - r.y / Math.max(1, r.t), resid: c / tot - trail, trail, funnel: dShare - lgShare, soft: (dYpt - lgYpt) * Math.min(1, d.ypt[pos]?.[1] / 40 || 0), zone: zn ? zf / zn : 0, pos });
      }
      // receivers with 0 targets this game but a role also count
      for (const [id, r] of R) if (r.team === g.o && !cnt.has(id) && r.games.length >= 2 && r.last >= w - 1) { /* skip: absence vs DNP is ambiguous */ }
    }
    // 2) update with week w
    for (const g of gw) {
      const tot = g.plays.length, cnt = new Map();
      const d = D.get(g.d) || D.set(g.d, { n: 0, pos: {}, ypt: {}, loc: {} }).get(g.d);
      for (const p of g.plays) {
        cnt.set(p.rec, (cnt.get(p.rec) || 0) + 1);
        const pos = P(p.rec); if (!pos) continue;
        const loc = `${p.pl || 'x'}|${p.ay == null ? 'x' : p.ay >= 15 ? 'deep' : p.ay >= 5 ? 'mid' : 'short'}`;
        for (const A of [d, L]) { A.n++; A.pos[pos] = (A.pos[pos] || 0) + 1; (A.ypt[pos] ||= [0, 0]); A.ypt[pos][0] += p.y; A.ypt[pos][1]++; (A.loc[loc] ||= [0, 0]); A.loc[loc][0] += p.y; A.loc[loc][1]++; }
        const r = R.get(p.rec) || R.set(p.rec, { team: g.o, games: [], loc: {}, last: 0 }).get(p.rec);
        r.loc[loc] = (r.loc[loc] || 0) + 1; r.y = (r.y || 0) + p.y; r.t = (r.t || 0) + 1;
      }
      for (const [id, c] of cnt) { const r = R.get(id); r.games.push(c / tot); r.last = w; }
    }
  }
}
const ols1 = (rows, k) => { const n = rows.length, mx = rows.reduce((a, r) => a + r[k], 0) / n, my = rows.reduce((a, r) => a + r.resid, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (const r of rows) { sxy += (r[k] - mx) * (r.resid - my); sxx += (r[k] - mx) ** 2; syy += (r.resid - my) ** 2; } const b = sxy / sxx; const se = Math.sqrt((syy - b * sxy) / (n - 2) / sxx); return { b, se, r2: (b * sxy) / syy }; };
console.log(`receiver-games: ${out.length}`);
for (const pos of ['WR', 'TE', 'RB', 'all']) {
  const rows = pos === 'all' ? out : out.filter((r) => r.pos === pos);
  for (const k of ['funnel', 'soft', 'zone']) { const f = ols1(rows, k); console.log(`${pos.padEnd(3)} ${k.padEnd(6)} slope ${f.b.toFixed(4)} ±${f.se.toFixed(4)} (z ${(f.b / f.se).toFixed(1)})  R² ${(f.r2 * 100).toFixed(2)}%`); }
}
// Walk-forward: fit slope on earlier seasons, apply to the next; compare mean |error| of target share.
for (const k of ['funnel', 'soft', 'zone']) {
  let base = 0, adj = 0, n = 0;
  for (const test of [2023, 2024, 2025]) {
    const tr = out.filter((r) => r.season < test), te = out.filter((r) => r.season === test);
    const { b } = ols1(tr, k);
    for (const r of te) { base += Math.abs(r.resid); adj += Math.abs(r.resid - b * r[k]); n++; }
  }
  console.log(`walk-forward ${k.padEnd(6)} share error ${(base / n * 100).toFixed(3)}% → ${(adj / n * 100).toFixed(3)}%  (${(((adj - base) / base) * 100).toFixed(2)}%)`);
}

// Efficiency: does the same matchup signal predict YARDS PER TARGET (target-weighted)?
console.log('\nYards per target vs matchup (weighted by targets):');
const wols = (rows, k) => { let sw = 0, mx = 0, my = 0; for (const r of rows) { sw += r.tg; mx += r.tg * r[k]; my += r.tg * r.yptResid; } mx /= sw; my /= sw; let sxy = 0, sxx = 0; for (const r of rows) { sxy += r.tg * (r[k] - mx) * (r.yptResid - my); sxx += r.tg * (r[k] - mx) ** 2; } return sxy / sxx; };
for (const pos of ['WR', 'TE', 'RB']) for (const k of ['soft', 'zone']) {
  const rows = out.filter((r) => r.pos === pos);
  const b = wols(rows, k);
  let base = 0, adj = 0, n = 0;
  for (const test of [2023, 2024, 2025]) { const bb = wols(out.filter((r) => r.pos === pos && r.season < test), k); for (const r of rows.filter((x) => x.season === test)) { base += r.tg * Math.abs(r.yptResid); adj += r.tg * Math.abs(r.yptResid - bb * r[k]); n += r.tg; } }
  console.log(`${pos} ${k.padEnd(5)} slope ${b.toFixed(3)} yds/target per 1 yd/target the defense allows  | walk-forward error ${(base / n).toFixed(3)} → ${(adj / n).toFixed(3)} (${(((adj - base) / base) * 100).toFixed(2)}%)`);
}
