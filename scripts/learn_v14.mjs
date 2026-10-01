// fbm-1.4 "learn from every miss" — walk-forward, market-blind.
//   node --no-warnings scripts/learn_v14.mjs <batch> [--write]
// For each position|stat it learns a correction  actual − projection ≈ β·x  from the PREGAME inputs x that
// were frozen in the ledger before kickoff (expected volume, shares, efficiency, team plays, expected margin,
// QB efficiency, role, small-sample / role-change flags). Book lines are never an input.
// Robust: Huber loss via IRLS, so one-off blowups (injury exits, a 90-yard catch) can only pull the fit a little.
// Ridge-shrunk toward "no correction", λ picked on the last third of the TRAINING weeks only.
// Fold 1: learn 2024 → test 2025 + 2026.  Final: learn 2024+2025 → test 2026 (weeks 2–3 were inspected earlier).
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { FEATS, buildX, loadUsage, usageFeatures, predictCorr } from '../src/v14.js';

const batch = Number(process.argv[2]);
const WRITE = process.argv.includes('--write');
const db = new DatabaseSync(new URL('../data/ledger.sqlite', import.meta.url).pathname, { readOnly: true });
const raw = db.prepare(`SELECT p.season, p.week, p.game_id, p.player_id, p.player_name, p.team, p.position pos, p.role, p.stat, p.projection proj, p.p10, p.p50, p.p90,
    s.actual, l.line, c.context_json ctx, a.context_json act
  FROM blind_predictions p JOIN blind_scores s USING (batch_id, game_id, player_id, stat)
  LEFT JOIN blind_lines l USING (batch_id, game_id, player_id, stat)
  LEFT JOIN blind_pred_context c USING (batch_id, game_id, player_id)
  LEFT JOIN blind_actual_context a USING (batch_id, game_id, player_id)
  WHERE p.batch_id = ? AND p.league = 'nfl' AND s.status = 'scored' AND s.actual IS NOT NULL AND p.projection IS NOT NULL`).all(batch);

// Recent-usage trend (nflverse weekly player stats + snap counts), strictly prior weeks — same code the live model uses.
const USE = {};
for (const season of [2024, 2025, 2026]) USE[season] = await loadUsage(season);

const STATS = ['pass_yds', 'pass_att', 'completions', 'pass_td', 'ints', 'rush_yds', 'carries', 'rush_td', 'rec_yds', 'receptions', 'targets', 'rec_td', 'long_rec', 'long_rush', 'long_cmp', 'fg_made', 'xp_made', 'k_pts'];
const num = (v) => (Number.isFinite(v) ? v : 0);
const rows = raw.filter((r) => STATS.includes(r.stat)).map((r) => {
  const c = r.ctx ? JSON.parse(r.ctx) : {};
  const x = buildX({ proj: r.proj, p10: r.p10, p90: r.p90, week: r.week, role: r.role, ctx: c, usage: usageFeatures(USE[r.season], r.week, r.team, r.player_name) });
  const a = r.act ? JSON.parse(r.act) : null;
  return { ...r, x, c, actVol: a?.stats ? { targets: a.stats.targets, carries: a.stats.carries, pass_att: a.stats.pass_att } : null };
});

// ---------- robust ridge regression (Huber, IRLS) ----------
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) continue;
    for (let k = 0; k < n; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
}
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? (b[Math.floor((b.length - 1) / 2)] + b[Math.ceil((b.length - 1) / 2)]) / 2 : 0; };
function fitHuber(L, lambda) {
  const d = L[0].x.length;
  const mu = Array(d).fill(0), sd = Array(d).fill(1);
  for (let j = 0; j < d; j++) { const v = L.map((r) => r.x[j]); mu[j] = v.reduce((s, q) => s + q, 0) / v.length; const s = Math.sqrt(v.reduce((s2, q) => s2 + (q - mu[j]) ** 2, 0) / v.length); sd[j] = s > 1e-9 ? s : 0; }
  const Z = L.map((r) => [1, ...r.x.map((v, j) => (sd[j] ? (v - mu[j]) / sd[j] : 0))]);
  const y = L.map((r) => r.actual - r.proj);
  const delta = 1.0 * Math.max(1, median(y.map((v) => Math.abs(v - median(y)))) * 1.4826);
  let beta = Array(d + 1).fill(0), w = Array(L.length).fill(1);
  for (let it = 0; it < 30; it++) {
    const A = Array.from({ length: d + 1 }, () => Array(d + 1).fill(0)), b = Array(d + 1).fill(0);
    for (let i = 0; i < Z.length; i++) for (let j = 0; j <= d; j++) { b[j] += w[i] * Z[i][j] * y[i]; for (let k = 0; k <= d; k++) A[j][k] += w[i] * Z[i][j] * Z[i][k]; }
    for (let j = 1; j <= d; j++) A[j][j] += lambda * L.length;
    const nb = solve(A, b);
    const done = nb.every((v, j) => Math.abs(v - beta[j]) < 1e-6);
    beta = nb;
    w = Z.map((z, i) => { const r = Math.abs(y[i] - z.reduce((s, v, j) => s + v * beta[j], 0)); return r <= delta ? 1 : delta / r; });
    if (done) break;
  }
  return { mu, sd, beta, delta };
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const mae = (L, f) => mean(L.map((r) => Math.abs(f(r) - r.actual)));

function learn(train) {
  const by = {};
  for (const r of train) (by[`${r.pos}|${r.stat}`] ||= []).push(r);
  const out = {};
  for (const [k, L] of Object.entries(by)) {
    if (L.length < 150) continue;
    // λ from a time split INSIDE training: fit on early weeks, validate on the latest third.
    const weeks = [...new Set(L.map((r) => `${r.season}-${String(r.week).padStart(2, '0')}`))].sort();
    const cut = weeks[Math.floor(weeks.length * 2 / 3)];
    const fitL = L.filter((r) => `${r.season}-${String(r.week).padStart(2, '0')}` < cut), valL = L.filter((r) => `${r.season}-${String(r.week).padStart(2, '0')}` >= cut);
    // Bar to clear: v1.3's shrunk median shift learned on the same early weeks (not just the raw projection).
    const sh = (() => { const d = fitL.map((r) => r.actual - r.proj).sort((a, b) => a - b); return d.length ? (d.length / (d.length + 40)) * d[Math.floor((d.length - 1) / 2)] : 0; })();
    let best = { lambda: null, mae: mae(valL, (r) => Math.max(0, r.proj + sh)) };
    for (const lambda of [0.01, 0.03, 0.1, 0.3, 1, 3]) {
      if (fitL.length < 100) break;
      const m = fitHuber(fitL, lambda);
      const v = mae(valL, (r) => Math.max(0, r.proj + predictCorr(m, r.x)));
      if (v < best.mae - 1e-9) best = { lambda, mae: v };
    }
    if (best.lambda == null) { out[k] = { n: L.length, lambda: null, note: 'keeps v1.3 — no learned correction beat it on held-out training weeks' }; continue; }
    const m = fitHuber(L, best.lambda);
    const f = (r) => Math.max(0, r.proj + predictCorr(m, r.x));
    // Range: smallest width multiplier with >= 80% training coverage around the corrected centre.
    let s = 2.4;
    for (let q = 0.5; q <= 2.4001; q += 0.05) {
      const cov = mean(L.map((r) => { const c0 = f(r); const lo = Math.max(0, c0 + q * (num(r.p10) - r.proj)), hi = c0 + q * (num(r.p90) - r.proj); return r.actual >= lo && r.actual <= hi ? 1 : 0; }));
      if (cov >= 0.8) { s = +q.toFixed(2); break; }
    }
    const lessons = m.beta.slice(1).map((b, j) => ({ feature: FEATS[j], effect: +(b).toFixed(3) })).filter((e) => Math.abs(e.effect) > 0.05 * Math.max(1, Math.abs(m.delta)) && e.feature)
      .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, 4);
    // Training domain: every role this correction saw in training. For any other role (e.g. a backup
    // QB or fullback shown only as a 'Support' candidate) the live model falls back to v1.3 — no extrapolation.
    // (minProj is recorded for the skeptic's reference only: out-of-sample, low projections in trained roles DID improve.)
    const projSorted = L.map((r) => r.proj).sort((a, b) => a - b);
    const roles = {}; for (const r of L) roles[r.role || '?'] = (roles[r.role || '?'] || 0) + 1;
    const domain = { minProj: +projSorted[Math.floor(0.1 * (projSorted.length - 1))].toFixed(3), roles: Object.fromEntries(Object.entries(roles).filter(([, n]) => n >= 1)) };
    out[k] = { n: L.length, lambda: best.lambda, s, domain, mu: m.mu.map((v) => +v.toFixed(5)), sd: m.sd.map((v) => +v.toFixed(5)), beta: m.beta.map((v) => +v.toFixed(5)), delta: +m.delta.toFixed(3), lessons };
  }
  return out;
}

// v1.3 for a fair fold-matched comparison: shrunk median residual shift (exactly as learn_v13.mjs).
function learnV13(train) {
  const by = {}; for (const r of train) (by[`${r.pos}|${r.stat}`] ||= []).push(r);
  const out = {}; for (const [k, L] of Object.entries(by)) { if (L.length < 40) continue; const sorted = L.map((r) => r.actual - r.proj).sort((a, b) => a - b); out[k] = (L.length / (L.length + 40)) * sorted[Math.floor((sorted.length - 1) / 2)]; }
  return out;
}

function evaluate(test, v13, v14) {
  const fRaw = (r) => r.proj;
  const f13 = (r) => Math.max(0, r.proj + (v13[`${r.pos}|${r.stat}`] ?? 0));
  const inDomain = (m, r) => m.domain.roles[r.role || '?'] != null;
  const f14any = (r) => { const m = v14[`${r.pos}|${r.stat}`]; return m?.beta ? Math.max(0, r.proj + predictCorr(m, r.x)) : f13(r); };
  const f14 = (r) => { const m = v14[`${r.pos}|${r.stat}`]; return m?.beta && inDomain(m, r) ? Math.max(0, r.proj + predictCorr(m, r.x)) : f13(r); };
  const outRows = test.filter((r) => { const m = v14[`${r.pos}|${r.stat}`]; return m?.beta && !inDomain(m, r); });
  const lineRows = test.filter((r) => r.line != null);
  const pick = (f) => { let w = 0, l = 0; for (const r of lineRows) { const p = f(r); if (p === r.line || r.actual === r.line) continue; if ((r.actual > r.line) === (p > r.line)) w++; else l++; } return { w, l, rate: +(w / (w + l)).toFixed(4) }; };
  const KEY = ['QB|pass_yds', 'RB|rush_yds', 'WR|rec_yds', 'TE|rec_yds', 'RB|rec_yds', 'WR|receptions', 'TE|receptions', 'RB|carries', 'QB|completions'];
  const byStat = {};
  for (const k of KEY) { const L = test.filter((r) => `${r.pos}|${r.stat}` === k); if (L.length) byStat[k] = { n: L.length, raw: +mae(L, fRaw).toFixed(2), v13: +mae(L, f13).toFixed(2), v14: +mae(L, f14).toFixed(2) }; }
  // Skeptic calibration: rows where the learned correction is > 35% of the projection (src/skeptic.js bigCorrection).
  const big = test.filter((r) => { const m = v14[`${r.pos}|${r.stat}`]; return m?.beta && inDomain(m, r) && r.proj > 5 && Math.abs(predictCorr(m, r.x)) > 0.35 * r.proj; });
  const bigBy = {}; for (const r of big) (bigBy[`${r.pos}|${r.stat}`] ||= []).push(r);
  return {
    bigCorrection: { n: big.length, v13: big.length ? +mae(big, f13).toFixed(3) : null, v14: big.length ? +mae(big, f14).toFixed(3) : null,
      byStat: Object.fromEntries(Object.entries(bigBy).map(([k, L]) => [k, { n: L.length, v13: +mae(L, f13).toFixed(2), v14: +mae(L, f14).toFixed(2) }])) },
    outOfDomain: { n: outRows.length, v13: outRows.length ? +mae(outRows, f13).toFixed(3) : null, v14Extrapolated: outRows.length ? +mae(outRows, f14any).toFixed(3) : null },
    n: test.length,
    mae: { raw: +mae(test, fRaw).toFixed(3), v13: +mae(test, f13).toFixed(3), v14: +mae(test, f14).toFixed(3) },
    lineRows: lineRows.length,
    maeOnLineRows: { raw: +mae(lineRows, fRaw).toFixed(3), v13: +mae(lineRows, f13).toFixed(3), v14: +mae(lineRows, f14).toFixed(3), line: +mae(lineRows, (r) => r.line).toFixed(3) },
    closerThanLine: { v13: +mean(lineRows.map((r) => (Math.abs(f13(r) - r.actual) < Math.abs(r.line - r.actual) ? 1 : 0))).toFixed(3), v14: +mean(lineRows.map((r) => (Math.abs(f14(r) - r.actual) < Math.abs(r.line - r.actual) ? 1 : 0))).toFixed(3) },
    picks: { v13: pick(f13), v14: pick(f14) },
    byStat,
  };
}

// ---------- miss decomposition: volume vs efficiency (learned from actual vs expected touches) ----------
function decompose(L, stat, volKey, ctxKey) {
  const R = L.filter((r) => r.stat === stat && r.actVol?.[volKey] != null && r.c?.[ctxKey] > 0 && r.actual != null);
  if (!R.length) return null;
  let volErr = 0, effErr = 0;
  for (const r of R) {
    const expVol = r.c[ctxKey], actVol = r.actVol[volKey];
    const expPer = r.proj / expVol, actPer = actVol > 0 ? r.actual / actVol : expPer;
    volErr += Math.abs((actVol - expVol) * expPer); effErr += Math.abs((actPer - expPer) * actVol);
  }
  return { n: R.length, shareOfMissFromVolume: +(volErr / (volErr + effErr)).toFixed(3), avgExpVol: +mean(R.map((r) => r.c[ctxKey])).toFixed(2), avgActVol: +mean(R.map((r) => r.actVol[volKey])).toFixed(2) };
}

const bySeason = (s) => rows.filter((r) => r.season === s);
const r24 = bySeason(2024), r25 = bySeason(2025), r26 = bySeason(2026);
const fold1 = learn(r24), fold1v13 = learnV13(r24);
const fin = learn([...r24, ...r25]), finv13 = learnV13([...r24, ...r25]);
const result = {
  batch, learnedAt: new Date().toISOString(), model: 'fbm-1.4.0',
  method: 'Per position|stat Huber ridge regression of (actual − projection) on frozen pregame inputs; λ chosen on the latest third of training weeks; walk-forward; book lines never used as inputs.',
  features: FEATS,
  fold1: { test2025: evaluate(r25, fold1v13, fold1), test2026: evaluate(r26, fold1v13, fold1) },
  final: { test2026: evaluate(r26, finv13, fin) },
  missDecomposition: {
    rec_yds: decompose([...r24, ...r25, ...r26], 'rec_yds', 'targets', 'targets'),
    rush_yds: decompose([...r24, ...r25, ...r26], 'rush_yds', 'carries', 'carries'),
  },
  byStat: fin,
};
console.log(JSON.stringify({ fold1: result.fold1, final: result.final, missDecomposition: result.missDecomposition }, null, 1));
for (const [k, v] of Object.entries(fin)) if (v.lessons?.length) console.log(k, 'λ', v.lambda, 's', v.s, v.lessons.map((e) => `${e.feature} ${e.effect > 0 ? '+' : ''}${e.effect}`).join(', '));
else console.log(k, v.note || '');
if (WRITE) { fs.writeFileSync(new URL('../src/fitted_v14.json', import.meta.url), JSON.stringify(result, null, 1)); console.log('wrote src/fitted_v14.json'); }
