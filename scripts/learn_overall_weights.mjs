// Learn how the skill ratings combine into OVERALL: which skills predict a player's PRODUCTION over his next 4 games?
//   RB: rushing + receiving yards per game · WR/TE: receiving yards per game · QB: passing + rushing EPA per game
// Ratings at weeks 4/7/10/13 of 2024 and 2025 (only earlier games). Non-negative least squares on skill z-scores
// (a better skill can never LOWER an overall). Checked both ways (fit 2024 → rank 2025, fit 2025 → rank 2024) against the
// hand-set weights, by Spearman rank correlation with that production.
//   node --no-warnings scripts/learn_overall_weights.mjs [--write]
import fs from 'node:fs';
import { buildRecords, ratingsFrom, SKILLS, zOf } from '../src/playerRatings.js';
import { loadWeekly } from '../src/situational.js';
const recs = await buildRecords([2023, 2024, 2025]);
const W = {}; for (const s of [2024, 2025]) for (const r of await loadWeekly(s)) (W[r.player_id] ||= []).push(r);
const prod = (pos, r) => pos === 'QB' ? (+r.passing_epa || 0) + (+r.rushing_epa || 0) : pos === 'RB' ? (+r.rushing_yards || 0) + (+r.receiving_yards || 0) : +r.receiving_yards || 0;
const rows = [];
for (const S of [2024, 2025]) for (const Wk of [4, 7, 10, 13]) {
  const res = ratingsFrom(recs, S, Wk);
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const pts = [];
    for (const p of res.byPos[pos]) {
      const g = (W[p.gsis] || []).filter((r) => +r.season === S && +r.week >= Wk && +r.week < Wk + 4);
      if (g.length < 2) continue;
      pts.push({ x: SKILLS[pos].map(([k]) => (p.skills[k] && !p.skills[k].noData ? zOf(p.skills[k].rating) : 0)), y: g.reduce((a, r) => a + prod(pos, r), 0) / g.length });
    }
    const mu = pts.reduce((a, b) => a + b.y, 0) / pts.length, sd = Math.sqrt(pts.reduce((a, b) => a + (b.y - mu) ** 2, 0) / pts.length) || 1;
    for (const q of pts) rows.push({ pos, S, x: q.x, y: (q.y - mu) / sd, grp: `${S}|${Wk}|${pos}` });
  }
}
function nnls(L) { // projected coordinate descent
  const P = L[0].x.length; const w = new Array(P).fill(0.1);
  for (let it = 0; it < 400; it++) for (let j = 0; j < P; j++) {
    let num = 0, den = 0; for (const r of L) { const pred = r.x.reduce((a, v, i) => a + v * w[i], 0) - r.x[j] * w[j]; num += r.x[j] * (r.y - pred); den += r.x[j] ** 2; }
    w[j] = Math.max(0, num / (den + 1e-9));
  }
  const s = w.reduce((a, b) => a + b, 0) || 1; return w.map((v) => v / s);
}
const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); o.forEach(([, i], k) => (r[i] = k)); return r; };
const spearman = (a, b) => { const ra = rank(a), rb = rank(b), n = a.length, m = (n - 1) / 2; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (ra[i] - m) * (rb[i] - m); va += (ra[i] - m) ** 2; vb += (rb[i] - m) ** 2; } return c / Math.sqrt(va * vb); };
const score = (L, w) => { const G = {}; for (const r of L) (G[r.grp] ||= []).push(r); const v = Object.values(G).map((g) => spearman(g.map((r) => r.x.reduce((a, x, i) => a + x * w[i], 0)), g.map((r) => r.y))); return v.reduce((a, b) => a + b, 0) / v.length; };
const out = { learnedAt: new Date().toISOString(), target: 'next-4-game production (RB scrimmage yds/g, WR/TE rec yds/g, QB EPA/g)', byPos: {} };
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  const L = rows.filter((r) => r.pos === pos), A = L.filter((r) => r.S === 2024), B = L.filter((r) => r.S === 2025);
  const hand = SKILLS[pos].map(([, , , , w]) => w);
  const wA = nnls(A), wB = nnls(B), wAll = nnls(L);
  const h = [score(B, hand), score(A, hand)], l = [score(B, wA), score(A, wB)];
  const ship = l[0] > h[0] && l[1] > h[1];
  out.byPos[pos] = { ship, weights: Object.fromEntries(SKILLS[pos].map(([k], i) => [k, +wAll[i].toFixed(3)])), spearman: { hand, learned: l } };
  console.log(`${pos}: rank corr with next-4 production — hand weights ${h.map((v) => v.toFixed(3)).join(' / ')} · learned ${l.map((v) => v.toFixed(3)).join(' / ')} ${ship ? 'SHIP' : 'keep hand'}`);
  console.log('   learned weights: ' + SKILLS[pos].map(([k], i) => `${k} ${Math.round(wAll[i] * 100)}%`).join(' · '));
}
if (process.argv.includes('--write')) { fs.writeFileSync(new URL('../src/fitted_overall_weights.json', import.meta.url), JSON.stringify(out, null, 1)); console.log('wrote src/fitted_overall_weights.json'); }
