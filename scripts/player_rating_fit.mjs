// PLAYER RATING = Madden + Production Monitor. Learn the mix (and the production recency λ) that best predicts each
// player's next-4-game production, 2024 (Madden 25 weekly releases). Two-fold by time: fit weeks 4/7 → test 10/13 and
// fit 10/13 → test 4/7; the shipped weights are fit on all four.   node --no-warnings scripts/player_rating_fit.mjs [--write]
import fs from 'node:fs';
import { buildMonitor, productionScores } from '../src/productionMonitor.js';
import { loadWeekly } from '../src/situational.js';
const M = JSON.parse(fs.readFileSync(new URL('../reports/madden25_iterations.json', import.meta.url), 'utf8'));
const norm = (n) => String(n).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’,]/g, '').replace(/-/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
const weekly = await loadWeekly(2024);
const fut = (id, pos, W) => { let n = 0, d = 0; for (const r of weekly) { if (r.player_id !== id || +r.week < W || +r.week >= W + 4) continue;
  if (pos === 'QB') { n += +r.passing_yards || 0; d += +r.attempts || 0; } else if (pos === 'RB') { n += +r.rushing_yards || 0; d += +r.carries || 0; } else { n += +r.receiving_yards || 0; d += +r.targets || 0; } }
  return d >= ({ QB: 40, RB: 15, WR: 8, TE: 6 })[pos] ? [n / d, d] : null; };
const LAMBDAS = [0.8, 0.9, 0.95, 1];
const data = {}; // lambda → pos → rows
for (const W of [4, 7, 10, 13]) {
  const mon = await buildMonitor([2023, 2024], { season: 2024, beforeWeek: W });
  const mad = new Map(), dup = new Set(); for (const x of M[W]) { const k = norm(x.name); if (mad.has(k)) dup.add(k); mad.set(k, x.overall); }
  for (const lam of LAMBDAS) {
    const S = productionScores(mon, { lambda: lam });
    for (const s of S.values()) {
      if (!['QB', 'RB', 'WR', 'TE'].includes(s.pos) || s.eff == null || (s.effN || 0) < ({ QB: 100, RB: 40, WR: 20, TE: 15 })[s.pos]) continue;
      const k = norm(s.name); if (dup.has(k) || !mad.has(k)) continue;
      const f = fut(s.id, s.pos, W); if (!f) continue;
      ((data[lam] ||= {})[s.pos] ||= []).push({ W, madden: mad.get(k), eff: s.eff, usage: s.usage ?? 0, y: f[0], w: f[1] });
    }
  }
}
const zcols = (L) => { for (const k of ['madden', 'eff', 'usage']) for (const W of [4, 7, 10, 13]) { const S = L.filter((r) => r.W === W); const m = S.reduce((a, r) => a + r[k], 0) / S.length, sd = Math.sqrt(S.reduce((a, r) => a + (r[k] - m) ** 2, 0) / S.length) || 1; for (const r of S) r['z' + k] = (r[k] - m) / sd; } };
function ols(L, cols) { const P = cols.length + 1, A = Array.from({ length: P }, () => new Array(P).fill(0)), b = new Array(P).fill(0);
  for (const r of L) { const x = [1, ...cols.map((c) => r[c])]; for (let i = 0; i < P; i++) { b[i] += r.w * x[i] * r.y; for (let j = 0; j < P; j++) A[i][j] += r.w * x[i] * x[j]; } }
  const Wt = L.reduce((a, r) => a + r.w, 0); for (let i = 1; i < P; i++) A[i][i] += Wt * 0.01;
  const Mx = A.map((row, i) => [...row, b[i]]); for (let c = 0; c < P; c++) { let p = c; for (let r = c + 1; r < P; r++) if (Math.abs(Mx[r][c]) > Math.abs(Mx[p][c])) p = r; [Mx[c], Mx[p]] = [Mx[p], Mx[c]]; const d = Mx[c][c]; for (let k = c; k <= P; k++) Mx[c][k] /= d; for (let r = 0; r < P; r++) if (r !== c) { const f = Mx[r][c]; for (let k = c; k <= P; k++) Mx[r][k] -= f * Mx[c][k]; } }
  return Mx.map((r) => r[P]); }
const wcorr = (L, f) => { const W = L.reduce((a, r) => a + r.w, 0), mx = L.reduce((a, r) => a + r.w * f(r), 0) / W, my = L.reduce((a, r) => a + r.w * r.y, 0) / W; let sxy = 0, sxx = 0, syy = 0; for (const r of L) { const dx = f(r) - mx, dy = r.y - my; sxy += r.w * dx * dy; sxx += r.w * dx * dx; syy += r.w * dy * dy; } return sxy / Math.sqrt(sxx * syy); };
const result = { season: 2024, target: 'raw next-4-game production per touch (QB yds/att, RB yds/carry, WR/TE yds/target)', byPos: {} };
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  let best = null;
  for (const lam of LAMBDAS) {
    const L = data[lam]?.[pos]; if (!L?.length) continue; zcols(L);
    const cols = ['zmadden', 'zeff', 'zusage'];
    const A = L.filter((r) => r.W <= 7), B = L.filter((r) => r.W >= 10);
    const bA = ols(A, cols), bB = ols(B, cols);
    const pr = (b) => (r) => b[0] + cols.reduce((a, c, j) => a + b[j + 1] * r[c], 0);
    const oos = (wcorr(B, pr(bA)) * B.length + wcorr(A, pr(bB)) * A.length) / L.length;
    const mad = (wcorr(B, (r) => r.zmadden) * B.length + wcorr(A, (r) => r.zmadden) * A.length) / L.length;
    const prod = (wcorr(B, (r) => r.zeff) * B.length + wcorr(A, (r) => r.zeff) * A.length) / L.length;
    if (!best || oos > best.oos) best = { lam, oos, mad, prod, n: L.length, beta: ols(L, cols) };
  }
  const b = best.beta, tot = Math.abs(b[1]) + Math.abs(b[2]) + Math.abs(b[3]);
  result.byPos[pos] = { lambda: best.lam, n: best.n, outOfSample: { playerRating: best.oos, maddenOnly: best.mad, productionOnly: best.prod }, beta: { intercept: b[0], madden: b[1], efficiency: b[2], usage: b[3] }, share: { madden: b[1] / tot, efficiency: b[2] / tot, usage: b[3] / tot } };
  console.log(`${pos} (n ${best.n}, production λ ${best.lam}) out-of-sample r: Player Rating ${best.oos.toFixed(3)} | Madden only ${best.mad.toFixed(3)} | production only ${best.prod.toFixed(3)} || weights: Madden ${(100 * b[1] / tot).toFixed(0)}%, efficiency ${(100 * b[2] / tot).toFixed(0)}%, usage ${(100 * b[3] / tot).toFixed(0)}%`);
}
if (process.argv.includes('--write')) { fs.writeFileSync(new URL('../src/fitted_player_rating.json', import.meta.url), JSON.stringify({ learnedAt: new Date().toISOString(), ...result }, null, 1)); console.log('wrote src/fitted_player_rating.json'); }
