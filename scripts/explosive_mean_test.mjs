// Should EXPLOSIVENESS move the projected average, not just the range? For every RB game (weeks 3–17, 2022–25, 5+ carries):
// predict that game's YPC from (1) his shrunk YPC to date (this season + half of last), and add (2) his shrunk 10+ yd run
// rate and (3) the defense's 10+ rate allowed. Coefficients fit on 2022–23, scored on 2024–25 (carries-weighted squared error).
// Also checks the ranges: share of his carries going 10+ / 20+ predicted vs actual (calibration of the explosive tail).
//   node --no-warnings scripts/explosive_mean_test.mjs
import { loadWeekly } from '../src/situational.js';
const W = {}; for (const s of [2021, 2022, 2023, 2024, 2025]) W[s] = await loadWeekly(s);
const isRb = (r) => (r.position === 'RB' || r.position === 'FB') && +r.carries > 0;
const rows = [];
for (const s of [2022, 2023, 2024, 2025]) {
  const cur = W[s].filter(isRb), prev = W[s - 1].filter(isRb);
  const lgY = cur.reduce((a, r) => a + +r.rushing_yards, 0) / cur.reduce((a, r) => a + +r.carries, 0), lg10 = cur.reduce((a, r) => a + +r.rushing_10, 0) / cur.reduce((a, r) => a + +r.carries, 0);
  for (const g of cur) {
    const wk = +g.week; if (wk < 3 || +g.carries < 5) continue;
    const pc = cur.filter((r) => r.player_id === g.player_id && +r.week < wk), pp = prev.filter((r) => r.player_id === g.player_id);
    const S = (L, k) => L.reduce((a, r) => a + +r[k], 0);
    const c = S(pc, 'carries') + 0.5 * S(pp, 'carries'); if (c < 20) continue;
    const ypc = (S(pc, 'rushing_yards') + 0.5 * S(pp, 'rushing_yards') + 60 * lgY) / (c + 60);
    const r10 = (S(pc, 'rushing_10') + 0.5 * S(pp, 'rushing_10') + 80 * lg10) / (c + 80);
    const dc = cur.filter((r) => r.opponent_team === g.opponent_team && +r.week < wk); const dC = S(dc, 'carries');
    const d10 = (S(dc, 'rushing_10') + 150 * lg10) / (dC + 150), dY = (S(dc, 'rushing_yards') + 150 * lgY) / (dC + 150);
    rows.push({ s, w: +g.carries, y: +g.rushing_yards / +g.carries, x: [ypc * Math.sqrt(dY / lgY), r10 - lg10, d10 - lg10], p10: r10 * (d10 / lg10), a10: +g.rushing_10 / +g.carries });
  }
}
function fit(L, use) { // weighted OLS y - x0 = b·x[use]
  const k = use.length, A = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0)), b = new Array(k + 1).fill(0);
  for (const r of L) { const v = [1, ...use.map((j) => r.x[j])], t = r.y - r.x[0]; for (let i = 0; i <= k; i++) { b[i] += r.w * v[i] * t; for (let j = 0; j <= k; j++) A[i][j] += r.w * v[i] * v[j]; } }
  const M = A.map((row, i) => [...row, b[i]]); for (let c = 0; c <= k; c++) { let p = c; for (let r = c + 1; r <= k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c]; for (let q = c; q <= k + 1; q++) M[c][q] /= d; for (let r = 0; r <= k; r++) if (r !== c) { const f = M[r][c]; for (let q = c; q <= k + 1; q++) M[r][q] -= f * M[c][q]; } }
  return M.map((r) => r[k + 1]);
}
const err = (L, use, b) => { let e = 0, w = 0; for (const r of L) { const p = r.x[0] + (b ? b[0] + use.reduce((a, j, i) => a + b[i + 1] * r.x[j], 0) : 0); e += r.w * (p - r.y) ** 2; w += r.w; } return e / w; };
const tr = rows.filter((r) => r.s <= 2023), te = rows.filter((r) => r.s >= 2024);
const base = fit(tr, []);
console.log(`n train ${tr.length}, test ${te.length}`);
for (const [name, use] of [['YPC only (current)', []], ['+ his explosive rate', [1]], ['+ defense explosive allowed', [2]], ['+ both', [1, 2]]]) {
  const b = fit(tr, use); console.log(`  ${name.padEnd(28)} 2024–25 error ${err(te, use, b).toFixed(4)}  coefs ${b.map((v) => v.toFixed(2)).join(' ')}`);
}
// tail calibration: predicted vs actual 10+ share by predicted bucket
const bk = [[0, 0.08], [0.08, 0.1], [0.1, 0.12], [0.12, 1]];
console.log('  10+ run rate, predicted vs actual (carries-weighted): ' + bk.map(([a, z]) => { const L = rows.filter((r) => r.p10 >= a && r.p10 < z); const W2 = L.reduce((q, r) => q + r.w, 0); return `${(a * 100).toFixed(0)}–${(z * 100).toFixed(0)}%: ${(L.reduce((q, r) => q + r.w * r.p10, 0) / W2 * 100).toFixed(1)} vs ${(L.reduce((q, r) => q + r.w * r.a10, 0) / W2 * 100).toFixed(1)} (n ${L.length})`; }).join(' · '));

// ---- Shrink K for the 10+ and 20+ rates (tail calibration), and the mean coefficient refit at the chosen K ----
{
  const out = [];
  for (const s of [2022, 2023, 2024, 2025]) {
    const cur = W[s].filter(isRb), prev = W[s - 1].filter(isRb);
    const S = (L, k) => L.reduce((a, r) => a + +r[k], 0);
    const lgC = S(cur, 'carries'), lg10 = S(cur, 'rushing_10') / lgC, lg20 = S(cur, 'rushing_20') / lgC, lgY = S(cur, 'rushing_yards') / lgC;
    for (const g of cur) { const wk = +g.week; if (wk < 3 || +g.carries < 5) continue;
      const pc = cur.filter((r) => r.player_id === g.player_id && +r.week < wk), pp = prev.filter((r) => r.player_id === g.player_id);
      const c = S(pc, 'carries') + 0.5 * S(pp, 'carries'); if (c < 20) continue;
      out.push({ s, w: +g.carries, c, n10: S(pc, 'rushing_10') + 0.5 * S(pp, 'rushing_10'), n20: S(pc, 'rushing_20') + 0.5 * S(pp, 'rushing_20'), yds: S(pc, 'rushing_yards') + 0.5 * S(pp, 'rushing_yards'), lg10, lg20, lgY, a10: +g.rushing_10 / +g.carries, a20: +g.rushing_20 / +g.carries, y: +g.rushing_yards / +g.carries });
    }
  }
  for (const [tail, nk, lk, ak] of [['10+', 'n10', 'lg10', 'a10'], ['20+', 'n20', 'lg20', 'a20']]) {
    const res = [80, 150, 250, 400, 700].map((K) => { let e = 0, w = 0; for (const r of out) { const p = (r[nk] + K * r[lk]) / (r.c + K); e += r.w * (p - r[ak]) ** 2; w += r.w; } return [K, e / w]; });
    console.log(`  ${tail} shrink K: ` + res.map(([K, e]) => `${K}: ${(e * 1e4).toFixed(3)}`).join(' · '));
  }
  for (const K of [80, 250, 400]) {
    const L = out.map((r) => ({ s: r.s, w: r.w, y: r.y, x: [(r.yds + 60 * r.lgY) / (r.c + 60), (r.n10 + K * r.lg10) / (r.c + K) - r.lg10] }));
    const tr2 = L.filter((r) => r.s <= 2023), te2 = L.filter((r) => r.s >= 2024);
    const b0 = fit(tr2, []), b1 = fit(tr2, [1]);
    console.log(`  mean adj at K=${K}: 2024–25 error YPC only ${err(te2, [], b0).toFixed(4)} → + explosive ${err(te2, [1], b1).toFixed(4)} (coef ${b1[1].toFixed(2)}); full-data coef ${fit(L, [1])[1].toFixed(2)}`);
  }
}
