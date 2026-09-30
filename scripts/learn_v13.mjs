// "Learn from every pick" — walk-forward, so nothing is scored on data it learned from.
//   node --no-warnings scripts/learn_v13.mjs <batch>
// Fold 1: learn on 2024 picks  -> test on 2025 and 2026.
// Final:  learn on 2024+2025   -> test on 2026 (weeks 2–3 were inspected earlier; labeled).
// Learned per position|stat (n >= 40 in training):
//   centre  : actual ≈ a + b·projection (OLS, shrunk toward a=0, b=1 with 40 pseudo-obs)
//   range   : width multiplier s so the 10–90 range covers 80% in training
//   pick gap: win rate by |model − line| gap (reported; used only if it held in training AND test)
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const batch = Number(process.argv[2]);
const db = new DatabaseSync(new URL('../data/ledger.sqlite', import.meta.url).pathname, { readOnly: true });
const rows = db.prepare(`SELECT p.season, p.week, p.position pos, p.stat, p.projection proj, p.p10, p.p50, p.p90, s.actual, s.status, l.line
  FROM blind_predictions p JOIN blind_scores s USING (batch_id, game_id, player_id, stat)
  LEFT JOIN blind_lines l USING (batch_id, game_id, player_id, stat)
  WHERE p.batch_id = ? AND p.league = 'nfl' AND s.status = 'scored' AND s.actual IS NOT NULL`).all(batch);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const K = 40;

const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : 0; };
function learn(train) {
  const by = {};
  for (const r of train) (by[`${r.pos}|${r.stat}`] ||= []).push(r);
  const out = {};
  for (const [k, L] of Object.entries(by)) {
    if (L.length < 40) continue;
    const n = L.length;
    // Centre: median residual (MAE-optimal), shrunk toward 0 with K pseudo-observations. Slope fixed at 1.
    const a = (n / (n + K)) * median(L.map((r) => r.actual - r.proj));
    const b = 1;
    const f = (v) => Math.max(0, a + b * v);
    // Range: SMALLEST width multiplier whose training coverage is >= 80% (never below target).
    let pickS = 2.4, cov = null;
    for (let s = 0.5; s <= 2.4001; s += 0.05) {
      const c = mean(L.map((r) => { const med = f(r.p50 ?? r.proj); const lo = Math.max(0, med + s * (f(r.p10) - med)), hi = med + s * (f(r.p90) - med); return r.actual >= lo && r.actual <= hi ? 1 : 0; }));
      if (c >= 0.8) { pickS = +s.toFixed(2); cov = c; break; }
    }
    // Picks: training win rate for this stat (only rows with a line).
    const P = L.filter((r) => r.line != null && r.proj !== r.line && r.actual !== r.line);
    const wins = P.filter((r) => (r.actual > r.line) === (r.proj > r.line)).length;
    out[k] = { n, a: +a.toFixed(4), b, s: pickS, trainCoverage: cov && +cov.toFixed(3), trainPicks: P.length, trainWinRate: P.length ? +(wins / P.length).toFixed(4) : null };
  }
  // Follow-or-fade: regress (actual - line) on (proj - line) across all training picks.
  const P = train.filter((r) => r.line != null);
  const X = P.map((r) => r.proj - r.line), Y = P.map((r) => r.actual - r.line);
  const sxx = X.reduce((s, v) => s + v * v, 0), sxy = X.reduce((s, v, i) => s + v * Y[i], 0);
  const beta = sxx ? sxy / sxx : 0;
  const res = Y.map((v, i) => v - beta * X[i]);
  const se = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / Math.max(1, P.length - 1) / sxx);
  out.__market = { beta: +beta.toFixed(4), se: +se.toFixed(4), t: +(beta / se).toFixed(2), n: P.length };
  return out;
}

function evaluate(test, calib) {
  const apply = (r) => {
    const c = calib?.[`${r.pos}|${r.stat}`];
    if (c && !Number.isFinite(c.a)) return { ...r };
    if (!c) return { ...r };
    const f = (v) => Math.max(0, c.a + c.b * v), med = f(r.p50 ?? r.proj);
    return { ...r, proj: f(r.proj), p10: Math.max(0, med + c.s * (f(r.p10) - med)), p90: med + c.s * (f(r.p90) - med) };
  };
  const T = test.map(apply);
  const picks = T.filter((r) => r.line != null && r.proj !== r.line);
  let w = 0, l = 0;
  for (const r of picks) { if (r.actual === r.line) continue; if ((r.actual > r.line) === (r.proj > r.line)) w++; else l++; }
  const bins = [[0, 0.25], [0.25, 0.5], [0.5, 1], [1, 99]].map(([lo, hi]) => {
    let bw = 0, bl = 0;
    for (const r of picks) { const z = Math.abs(r.proj - r.line) / Math.max(1, (r.p90 - r.p10) / 2.563); if (z < lo || z >= hi || r.actual === r.line) continue; if ((r.actual > r.line) === (r.proj > r.line)) bw++; else bl++; }
    return { gap: `${lo}-${hi === 99 ? 'inf' : hi}`, w: bw, l: bl, rate: bw + bl ? +(bw / (bw + bl)).toFixed(3) : null };
  });
  const lineRows = T.filter((r) => r.line != null);
  // Learned pick rules (only meaningful when calib came from a DIFFERENT season):
  const rule = (keep, flip = false) => { let rw = 0, rl = 0; for (const r of picks) { if (r.actual === r.line || !keep(r)) continue; const side = (r.proj > r.line) !== flip; if ((r.actual > r.line) === side) rw++; else rl++; } return { w: rw, l: rl, rate: rw + rl ? +(rw / (rw + rl)).toFixed(4) : null }; };
  const stats52 = calib ? new Set(Object.entries(calib).filter(([k, c]) => k !== '__market' && c.trainPicks >= 100 && c.trainWinRate > 0.524).map(([k]) => k)) : new Set();
  const pickRules = calib ? {
    onlyStatsThatBeat524InTraining: { stats: [...stats52], ...rule((r) => stats52.has(`${r.pos}|${r.stat}`)) },
    fadeModelIfTrainingBetaNegative: { beta: calib.__market?.beta, ...rule(() => true, (calib.__market?.beta ?? 0) < 0) },
  } : null;
  return { pickRules, rmse: +Math.sqrt(mean(T.map((r) => (r.proj - r.actual) ** 2))).toFixed(3),
    n: T.length, mae: +mean(T.map((r) => Math.abs(r.proj - r.actual))).toFixed(3), bias: +mean(T.map((r) => r.proj - r.actual)).toFixed(3),
    coverage: +mean(T.map((r) => (r.actual >= r.p10 && r.actual <= r.p90 ? 1 : 0))).toFixed(3),
    picks: w + l, wins: w, losses: l, winRate: w + l ? +(w / (w + l)).toFixed(4) : null, gapBins: bins,
    maeOnLineRows: lineRows.length ? +mean(lineRows.map((r) => Math.abs(r.proj - r.actual))).toFixed(3) : null,
    lineMae: lineRows.length ? +mean(lineRows.map((r) => Math.abs(r.line - r.actual))).toFixed(3) : null,
  };
}

const bySeason = (s) => rows.filter((r) => r.season === s);
const r24 = bySeason(2024), r25 = bySeason(2025), r26 = bySeason(2026);
const fold1 = learn(r24);
const final = learn([...r24, ...r25]);
const result = {
  batch, learnedAt: new Date().toISOString(),
  note: 'Walk-forward. Fold 1 learns on 2024 only and is scored on 2025 and 2026. Final learns on 2024+2025 and is scored on 2026 (weeks 2–3 inspected earlier). 2025 outcomes were also the fit targets for the v1.2 constants, so 2025 is in-sample for v1.2 itself.',
  fold1: {
    test2025: { before: evaluate(r25, null), after: evaluate(r25, fold1) },
    test2026: { before: evaluate(r26, null), after: evaluate(r26, fold1) },
  },
  final: { test2026: { before: evaluate(r26, null), after: evaluate(r26, final) } },
  byStat: final, fold1ByStat: fold1,
};
fs.writeFileSync(new URL('../src/fitted_v13.json', import.meta.url), JSON.stringify(result, null, 1));
const show = (o) => `MAE ${o.mae} RMSE ${o.rmse} bias ${o.bias} cov ${o.coverage} | picks ${o.wins}-${o.losses} (${o.winRate}) | model MAE on line rows ${o.maeOnLineRows} vs line ${o.lineMae}`;
console.log('rows', rows.length, '2024', r24.length, '2025', r25.length, '2026', r26.length);
for (const [name, v] of Object.entries({ 'fold1 → 2025': result.fold1.test2025, 'fold1 → 2026': result.fold1.test2026, 'final → 2026': result.final.test2026 })) {
  console.log(`${name}\n  before: ${show(v.before)}\n  after:  ${show(v.after)}\n  learned pick rules on test: ${JSON.stringify(v.after.pickRules)}\n  gap bins before ${JSON.stringify(v.before.gapBins)}\n  gap bins after  ${JSON.stringify(v.after.gapBins)}`);
}
