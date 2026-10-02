// Do Player Ratings (Madden + Production Monitor) improve projections? 2024 (Madden 25 weekly releases).
// For each 2024 projection (raw blind batch → live calibration), residual = actual − projection. Fit
//   residual = a + b·PR + c·PR·defense (opponent allowance factor for his position's main stat, centered)
// on weeks 2–9 → test 10–18, and 10–18 → 2–9. Report MAE with vs without the rating correction.
//   node --no-warnings scripts/player_rating_projection_test.mjs [batch=14]
import fs from 'node:fs';
import { calibratedRows } from './lib/pipeline.mjs';
import { buildMonitor, productionScores } from '../src/productionMonitor.js';
import { loadPlayerIds } from '../src/pbp.js';
const BATCH = Number(process.argv[2] || 14);
const FIT = JSON.parse(fs.readFileSync(new URL('../src/fitted_player_rating.json', import.meta.url), 'utf8')).byPos;
const M = JSON.parse(fs.readFileSync(new URL('../reports/madden25_iterations.json', import.meta.url), 'utf8'));
const norm = (n) => String(n).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’,]/g, '').replace(/-/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
const ids = await loadPlayerIds();
const mon = await buildMonitor([2023, 2024]);
const STATS = { RB: ['carries', 'rush_yds'], WR: ['receptions', 'rec_yds'], TE: ['receptions', 'rec_yds'], QB: ['pass_yds'] };
const ANCHOR = JSON.parse(fs.readFileSync(new URL('../src/fitted_anchor.json', import.meta.url), 'utf8')).byStat;
const allRows = await calibratedRows(BATCH);
// apply the live season-average anchor on top of calibration (prior actuals this season, ≥2 games), as live does
const hist = new Map(); for (const r of allRows) { const k = `${r.season}|${r.player_id}|${r.stat}`; (hist.get(k) || hist.set(k, []).get(k)).push([r.week, r.actual]); }
for (const r of allRows) { const aw = ANCHOR[r.key]?.w || 0; const pr = (hist.get(`${r.season}|${r.player_id}|${r.stat}`) || []).filter(([w]) => w < r.week); if (aw && pr.length >= 2) { const avg = pr.reduce((a, [, v]) => a + v, 0) / pr.length; r.cal = Math.max(0, r.cal + aw * (avg - r.cal)); } }
const rows = allRows.filter((r) => r.season === 2024 && r.week >= 4 && STATS[r.pos]?.includes(r.stat));
// Player Rating at a week: latest Madden release ≤ week, production scores from games before the week.
const cache = new Map();
function prAt(week) {
  if (cache.has(week)) return cache.get(week);
  const it = [13, 10, 7, 4].find((w) => w <= week); const mad = new Map(), dup = new Set();
  for (const x of M[it]) { const k = norm(x.name); if (mad.has(k)) dup.add(k); mad.set(k, x.overall); }
  const out = new Map();
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const S = [...productionScores(mon, { lambda: FIT[pos].lambda, before: { season: 2024, week } }).values()].filter((s) => s.pos === pos && s.eff != null && (s.effN || 0) >= ({ QB: 100, RB: 40, WR: 20, TE: 15 })[pos]);
    const L = S.map((s) => ({ s, m: dup.has(norm(s.name)) ? null : mad.get(norm(s.name)) ?? null })).filter((x) => x.m != null);
    const z = (f) => { const v = L.map(f), mu = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / v.length) || 1; return (x) => (f(x) - mu) / sd; };
    const zm = z((x) => x.m), ze = z((x) => x.s.eff), zu = z((x) => x.s.usage ?? 0), b = FIT[pos].beta;
    const sc = (x) => b.madden * zm(x) + b.efficiency * ze(x) + b.usage * zu(x), zs = z(sc);
    for (const x of L) out.set(x.s.id, zs(x));
  }
  cache.set(week, out); return out;
}
// defense factor for the projection row: the monitor's opponent factor from his game that week (pre-game allowance)
const oppF = new Map(); for (const [id, p] of mon) for (const g of p.games) if (g.season === 2024) { const part = p.pos === 'QB' ? g.parts.pass : p.pos === 'RB' ? g.parts.rush : g.parts.recv; if (part) oppF.set(`${id}|${g.week}`, part.oppFactor - 1); }
const data = [];
for (const r of rows) {
  const gs = ids.byEspn.get(String(r.player_id))?.gsis; if (!gs) continue;
  const pr = prAt(r.week).get(gs); if (pr == null) continue;
  data.push({ key: `${r.pos}|${r.stat}`, week: r.week, res: r.actual - r.cal, pr, d: oppF.get(`${gs}|${r.week}`) ?? 0 });
}
function fit(L) { const X = L.map((r) => [1, r.pr, r.pr * r.d]), y = L.map((r) => r.res); const P = 3, A = Array.from({ length: P }, () => new Array(P).fill(0)), b = new Array(P).fill(0);
  X.forEach((x, i) => { for (let a = 0; a < P; a++) { b[a] += x[a] * y[i]; for (let c = 0; c < P; c++) A[a][c] += x[a] * x[c]; } }); for (let i = 1; i < P; i++) A[i][i] += L.length * 0.01;
  const Mx = A.map((row, i) => [...row, b[i]]); for (let c = 0; c < P; c++) { let p = c; for (let r = c + 1; r < P; r++) if (Math.abs(Mx[r][c]) > Math.abs(Mx[p][c])) p = r; [Mx[c], Mx[p]] = [Mx[p], Mx[c]]; const dd = Mx[c][c]; for (let k = c; k <= P; k++) Mx[c][k] /= dd; for (let r = 0; r < P; r++) if (r !== c) { const f = Mx[r][c]; for (let k = c; k <= P; k++) Mx[r][k] -= f * Mx[c][k]; } }
  return Mx.map((r) => r[P]); }
const result = {};
for (const key of [...new Set(data.map((d) => d.key))]) {
  const D = data.filter((d) => d.key === key), A = D.filter((d) => d.week <= 9), B = D.filter((d) => d.week >= 10);
  const mae = (L, b) => L.reduce((a, r) => a + Math.abs(r.res - (b ? b[0] + b[1] * r.pr + b[2] * r.pr * r.d : 0)), 0) / L.length;
  const bA = fit(A), bB = fit(B), bAll = fit(D);
  const base = (mae(A, null) * A.length + mae(B, null) * B.length) / D.length, withPR = (mae(B, bA) * B.length + mae(A, bB) * A.length) / D.length;
  result[key] = { n: D.length, base, withPR, beta: bAll };
  console.log(`${key.padEnd(15)} n ${String(D.length).padStart(4)} | projection MAE ${base.toFixed(3)} → with Player Rating ${withPR.toFixed(3)} (${(((withPR - base) / base) * 100).toFixed(1)}%) | per 1 SD of rating: ${bAll[1] >= 0 ? '+' : ''}${bAll[1].toFixed(2)}, × defense: ${bAll[2] >= 0 ? '+' : ''}${bAll[2].toFixed(2)}`);
}
fs.writeFileSync(new URL('../reports/player_rating_projection_2024.json', import.meta.url), JSON.stringify({ baseline: 'live pipeline (calibration + season anchor)', byStat: result }, null, 1));

// Calibration check by rating level: average residual (actual − projection) per z bucket, vs the linear fit.
for (const key of ['RB|rush_yds', 'RB|carries']) {
  const D = data.filter((d) => d.key === key), b = result[key].beta;
  console.log(`\n${key}: residual by Player Rating level (2024)`);
  for (const [lo, hi, lbl] of [[-9, -1, 'z < −1'], [-1, 0, '−1…0'], [0, 1, '0…1'], [1, 1.5, '1…1.5'], [1.5, 9, 'z ≥ 1.5 (elite)']]) {
    const B = D.filter((d) => d.pr >= lo && d.pr < hi); if (!B.length) continue;
    const m = B.reduce((a, r) => a + r.res, 0) / B.length, se = Math.sqrt(B.reduce((a, r) => a + (r.res - m) ** 2, 0) / (B.length - 1) / B.length);
    const fitM = B.reduce((a, r) => a + b[0] + b[1] * r.pr + b[2] * r.pr * r.d, 0) / B.length;
    console.log(`   ${lbl.padEnd(16)} n ${String(B.length).padStart(3)}  actual − projection ${m >= 0 ? '+' : ''}${m.toFixed(1)} ± ${se.toFixed(1)}  | linear fit says ${fitM >= 0 ? '+' : ''}${fitM.toFixed(1)}`);
  }
}

// Tiered correction: elite (z ≥ 1.5) / middle / weak (z < −1) bucket means, shrunk n/(n+K); two-fold by weeks.
const TIERS = [[1.5, 9, 'elite'], [-1, 1.5, 'middle'], [-9, -1, 'weak']];
const tierOf = (z) => TIERS.find(([lo, hi]) => z >= lo && z < hi)[2];
const tiered = {};
for (const key of Object.keys(result)) {
  const D = data.filter((d) => d.key === key), A = D.filter((d) => d.week <= 9), B = D.filter((d) => d.week >= 10);
  const K = 15;
  const means = (L) => Object.fromEntries(TIERS.map(([, , t]) => { const T = L.filter((r) => tierOf(r.pr) === t); const m = T.length ? T.reduce((a, r) => a + r.res, 0) / T.length : 0; return [t, (m * T.length) / (T.length + K)]; }));
  const mA = means(A), mB = means(B), mAll = means(D);
  const mae = (L, m) => L.reduce((a, r) => a + Math.abs(r.res - (m ? m[tierOf(r.pr)] : 0)), 0) / L.length;
  const base = (mae(A) * A.length + mae(B) * B.length) / D.length, tier = (mae(B, mA) * B.length + mae(A, mB) * A.length) / D.length;
  tiered[key] = { base, tiered: tier, linear: result[key].withPR, shifts: mAll };
  console.log(`${key.padEnd(15)} held-out MAE: none ${base.toFixed(3)} | linear ${result[key].withPR.toFixed(3)} | tiered ${tier.toFixed(3)} (${(((tier - base) / base) * 100).toFixed(1)}%) | shifts ${JSON.stringify(Object.fromEntries(Object.entries(mAll).map(([k, v]) => [k, +v.toFixed(1)])))}`);
}
fs.writeFileSync(new URL('../reports/player_rating_tiers_2024.json', import.meta.url), JSON.stringify(tiered, null, 1));
