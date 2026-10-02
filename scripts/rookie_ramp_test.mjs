// ROOKIE RAMP: when a rookie's share has been climbing, does weighting his LATEST role predict his next game better than
// his average? And the teammate losing that work (same position) — should he be pulled toward his latest, lower role?
// nflverse weekly 2021–25 (rookie = no regular-season games in any earlier season of the data). For each player-game in
// weeks 3–12 with ≥2 earlier games this season: baseline = recency-weighted average share (0.85^games ago, like the
// live model's recent weighting); ramp = baseline + α·(last − baseline). Error = |prediction − next game's share|.
//   node --no-warnings scripts/rookie_ramp_test.mjs [--write]
import fs from 'node:fs';
import { loadWeekly } from '../src/situational.js';
const SEASONS = [2021, 2022, 2023, 2024, 2025];
const W = {}; for (const s of SEASONS) W[s] = await loadWeekly(s);
const firstSeason = new Map(); for (const s of SEASONS) for (const r of W[s]) if (!firstSeason.has(r.player_id)) firstSeason.set(r.player_id, s);
const ALPHAS = [0, 0.25, 0.5, 0.75, 1];
const RISE = { carry: 0.1, target: 0.05 };
const rows = [];
for (const s of SEASONS.slice(1)) {
  const team = new Map(); for (const r of W[s]) { const k = `${r.game_id}|${r.team}`; const t = team.get(k) || team.set(k, { car: 0, tgt: 0 }).get(k); t.car += +r.carries || 0; t.tgt += +r.targets || 0; }
  const by = new Map(); for (const r of W[s]) { const pos = r.position === 'FB' ? 'RB' : r.position; if (!['RB', 'WR', 'TE'].includes(pos)) continue; const t = team.get(`${r.game_id}|${r.team}`); (by.get(r.player_id) || by.set(r.player_id, []).get(r.player_id)).push({ week: +r.week, team: r.team, pos, carry: t.car ? (+r.carries || 0) / t.car : 0, target: t.tgt ? (+r.targets || 0) / t.tgt : 0 }); }
  // rising rookies per team-week (to find the teammate losing work)
  const ramping = new Map(); // `${team}|${week}|${pos}|${kind}` → rookie id
  const cases = [];
  for (const [id, G] of by) {
    G.sort((a, b) => a.week - b.week);
    const rookie = firstSeason.get(id) === s;
    for (let i = 2; i < G.length - 1; i++) {
      const prev = G.slice(0, i + 1), next = G[i + 1];
      if (next.week > 13 || prev.some((g) => g.team !== next.team)) continue;
      for (const kind of ['carry', 'target']) {
        if (kind === 'carry' && G[0].pos !== 'RB') continue;
        let sw = 0, sv = 0; prev.forEach((g, j) => { const w = Math.pow(0.85, prev.length - 1 - j); sw += w; sv += w * g[kind]; });
        const base = sv / sw, last = prev[prev.length - 1][kind], earlier = prev.slice(0, -1).reduce((a, g) => a + g[kind], 0) / (prev.length - 1);
        const rising = last - earlier >= RISE[kind] && last >= prev[prev.length - 2][kind];
        const steady = prev.length >= 3 && prev.slice(-3).every((g, j, a) => j === 0 || g[kind] >= a[j - 1][kind]) && last - earlier >= RISE[kind];
        const falling = earlier - last >= RISE[kind];
        if (base < 0.03 && last < 0.03) continue;
        cases.push({ id, rookie, kind, pos: G[0].pos, team: next.team, week: prev[prev.length - 1].week, base, last, next: next[kind], rising, falling, steady });
        if (rookie && rising) ramping.set(`${next.team}|${prev[prev.length - 1].week}|${G[0].pos}|${kind}`, id);
      }
    }
  }
  for (const c of cases) { c.season = s; c.teammateOfRamp = !c.rookie && c.falling && ramping.has(`${c.team}|${c.week}|${c.pos}|${c.kind}`); rows.push(c); }
}
const groups = {
  'rookies, share rising': (c) => c.rookie && c.rising,
  'rookies, rising 3 games in a row': (c) => c.rookie && c.steady,
  'veterans, rising 3 in a row (control)': (c) => !c.rookie && c.steady,
  'all players, share falling': (c) => c.falling,
  'veterans, share rising (control)': (c) => !c.rookie && c.rising,
  'veteran losing work to a ramping rookie': (c) => c.teammateOfRamp,
  'other veterans, share falling (control)': (c) => !c.rookie && c.falling && !c.teammateOfRamp,
};
const out = { learnedAt: new Date().toISOString(), rise: RISE, byGroup: {} };
for (const [name, f] of Object.entries(groups)) for (const kind of ['carry', 'target']) {
  const L = rows.filter((c) => c.kind === kind && f(c)); if (L.length < 20) { console.log(`${name} · ${kind}: n=${L.length} (too few)`); continue; }
  const mae = (a, S) => S.reduce((s, c) => s + Math.abs(c.base + a * (c.last - c.base) - c.next), 0) / S.length;
  const res = ALPHAS.map((a) => mae(a, L));
  // walk-forward: choose α on seasons ≤ 2023, score on 2024–25
  const tr = L.filter((c) => c.season <= 2023), te = L.filter((c) => c.season >= 2024);
  const aStar = ALPHAS.reduce((b, a) => (mae(a, tr) < mae(b, tr) ? a : b), 0);
  const held = te.length ? { base: mae(0, te), ramp: mae(aStar, te) } : null;
  out.byGroup[`${name}|${kind}`] = { n: L.length, maeByAlpha: Object.fromEntries(ALPHAS.map((a, i) => [a, +res[i].toFixed(4)])), alphaTrain: aStar, heldOut2024_25: held && { n: te.length, base: +held.base.toFixed(4), ramp: +held.ramp.toFixed(4) } };
  const fixed = [0.25, 0.5].map((a) => te.length ? `${a}: ${(mae(a, te) * 100).toFixed(2)}` : '').join(' ');
  out.byGroup[`${name}|${kind}`].heldOutFixed = Object.fromEntries([0.25, 0.5].map((a) => [a, te.length ? +mae(a, te).toFixed(4) : null]));
  console.log(`   held-out 2024–25 with fixed α → ${fixed}`);
  console.log(`${name} · ${kind} share (n=${L.length}): MAE by α ${ALPHAS.map((a, i) => `${a}:${(res[i] * 100).toFixed(2)}`).join(' ')} pts | α picked on 2022–23 = ${aStar}, held-out 2024–25 (n=${te.length}) ${(held.base * 100).toFixed(2)} → ${(held.ramp * 100).toFixed(2)}`);
}
if (process.argv.includes('--write')) { fs.writeFileSync(new URL('../src/fitted_rookie_ramp.json', import.meta.url), JSON.stringify(out, null, 1)); console.log('wrote src/fitted_rookie_ramp.json'); }
