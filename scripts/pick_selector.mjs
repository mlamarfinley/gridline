// PICK SELECTOR: learn which sides of posted lines actually win, then pick only the most confident.
//   node --no-warnings scripts/pick_selector.mjs [batch=13] [--write]
// Target: did the stat go OVER the line (pushes dropped). Logistic regression on pregame features only:
//   z      — (live calibrated projection − line) / model spread ((p90 − p10) / 2.56)
//   zMed   — (simulated median − line) / spread   (skewed stats: the median is what the line is set near)
//   hist   — (his season average before this game − line) / spread, and his over-rate vs this line so far
//   stat dummies (each stat has its own under/over lean), stat × z (how much to trust the gap per stat)
// Evaluation: learn 2024 → test 2025, learn 2025 → test 2024. Pick the side with P > 0.5; rank by |P − 0.5|;
// report hit rate at several selectivity levels (out of sample only).
import fs from 'node:fs';
import { calibratedRows } from './lib/pipeline.mjs';
const BATCH = Number(process.argv.find((a) => /^\d+$/.test(a)) || 13);
const STATS = ['pass_yds', 'pass_att', 'completions', 'rush_yds', 'carries', 'rec_yds', 'receptions', 'rush_att'];
const R = (await calibratedRows(BATCH)).filter((r) => r.line != null && STATS.includes(r.stat) && r.actual !== r.line && r.season <= 2025);
// prior actuals this season (same batch) for the "his record vs this line" features
const hist = new Map(); for (const r of R) { const k = `${r.season}|${r.player_id}|${r.stat}`; (hist.get(k) || hist.set(k, []).get(k)).push([r.week, r.actual]); }
const SK = [...new Set(R.map((r) => r.stat))].sort();
const feats = (r) => {
  const sd = Math.max(1e-6, (r.p90 - r.p10) / 2.56);
  const z = (r.cal - r.line) / sd, zMed = ((r.p50 ?? r.proj) - r.line) / sd;
  const pr = (hist.get(`${r.season}|${r.player_id}|${r.stat}`) || []).filter(([w]) => w < r.week).map(([, v]) => v);
  const avg = pr.length ? pr.reduce((a, b) => a + b, 0) / pr.length : r.line;
  const hz = pr.length ? Math.max(-3, Math.min(3, (avg - r.line) / sd)) : 0, orate = pr.length ? pr.filter((v) => v > r.line).length / pr.length - 0.5 : 0;
  const zc = Math.max(-3, Math.min(3, z));
  return [1, zc, Math.max(-3, Math.min(3, zMed)), hz, orate * Math.min(1, pr.length / 4), ...SK.map((s) => (s === r.stat ? 1 : 0)), ...SK.map((s) => (s === r.stat ? zc : 0))];
};
const data = R.map((r) => ({ r, x: feats(r), y: r.actual > r.line ? 1 : 0 }));
function fit(D, lambda = 2) {
  const P = D[0].x.length; let b = new Array(P).fill(0);
  for (let it = 0; it < 40; it++) {
    const A = Array.from({ length: P }, () => new Array(P).fill(0)), g = new Array(P).fill(0);
    for (const d of D) { const p = 1 / (1 + Math.exp(-d.x.reduce((a, v, j) => a + v * b[j], 0))); const w = p * (1 - p); for (let i = 0; i < P; i++) { g[i] += (d.y - p) * d.x[i]; for (let j = 0; j < P; j++) A[i][j] += w * d.x[i] * d.x[j]; } }
    for (let i = 1; i < P; i++) { A[i][i] += lambda; g[i] -= lambda * b[i]; }
    const M = A.map((row, i) => [...row, g[i]]);
    for (let c = 0; c < P; c++) { let piv = c; for (let r = c + 1; r < P; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; const dd = M[c][c] || 1e-9; for (let k = c; k <= P; k++) M[c][k] /= dd; for (let r = 0; r < P; r++) if (r !== c) { const f = M[r][c]; for (let k = c; k <= P; k++) M[r][k] -= f * M[c][k]; } }
    const step = M.map((r) => r[P]); b = b.map((v, i) => v + step[i]); if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return b;
}
const prob = (b, x) => 1 / (1 + Math.exp(-x.reduce((a, v, j) => a + v * b[j], 0)));
const results = [];
for (const [trS, teS] of [[2024, 2025], [2025, 2024]]) {
  const b = fit(data.filter((d) => d.r.season === trS));
  for (const d of data.filter((d) => d.r.season === teS)) { const p = prob(b, d.x); results.push({ conf: Math.abs(p - 0.5), win: (p > 0.5) === (d.y === 1), side: p > 0.5 ? 'OVER' : 'UNDER', stat: d.r.stat, fold: `${trS}→${teS}`, game: d.r.game_id }); }
}
results.sort((a, b) => b.conf - a.conf);
const rate = (L) => `${L.filter((x) => x.win).length}-${L.filter((x) => !x.win).length} (${((100 * L.filter((x) => x.win).length) / L.length).toFixed(1)}%)`;
console.log(`props with lines (2024–25): ${results.length}`);
for (const f of [0.01, 0.02, 0.05, 0.1, 0.25, 1]) { const L = results.slice(0, Math.max(1, Math.round(results.length * f))); console.log(`top ${String(f * 100).padStart(3)}% most confident: ${String(L.length).padStart(5)} picks  ${rate(L)}  · min confidence ${(L[L.length - 1].conf * 100 + 50).toFixed(1)}%`); }
// one pick per game (most confident), as the dashboard would show it
const perGame = new Map(); for (const x of results) { const k = `${x.fold}|${x.game}`; if (!perGame.has(k)) perGame.set(k, x); }
const PG = [...perGame.values()].sort((a, b) => b.conf - a.conf);
console.log(`\nbest pick per game: ${rate(PG)} over ${PG.length} games; top half of those: ${rate(PG.slice(0, PG.length >> 1))}; top quarter: ${rate(PG.slice(0, PG.length >> 2))}`);
const top = results.slice(0, Math.round(results.length * 0.05));
console.log('top 5% mix:', JSON.stringify(Object.entries(top.reduce((a, x) => ((a[`${x.stat} ${x.side}`] = (a[`${x.stat} ${x.side}`] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).slice(0, 8)));
if (process.argv.includes('--write')) { const b = fit(data); fs.writeFileSync(new URL('../src/fitted_pick_selector.json', import.meta.url), JSON.stringify({ batch: BATCH, learnedAt: new Date().toISOString(), stats: SK, beta: b, note: 'logistic P(over); see scripts/pick_selector.mjs' }, null, 1)); console.log('wrote src/fitted_pick_selector.json'); }
