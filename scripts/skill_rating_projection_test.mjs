// Do PRODUCTION SKILL RATINGS improve projections, for every position and stat? Walk-forward both ways: fit on 2024 →
// test 2025 and fit on 2025 → test 2024 (no Madden needed). Baseline = live projection (calibration + season anchor +
// the RB Player-Rating correction is NOT included — this tests skill ratings alone on top of calibration + anchor).
// Model: residual = a + Σ b_k · (skill rating_k − 50)/50  (ridge), per position|stat.
//   node --no-warnings scripts/skill_rating_projection_test.mjs [batch=14] [--write]
import fs from 'node:fs';
import { calibratedRows } from './lib/pipeline.mjs';
import { buildRecords, ratingsFrom, SKILLS } from '../src/playerRatings.js';
import { loadPlayerIds } from '../src/pbp.js';
const BATCH = Number(process.argv.find((a) => /^\d+$/.test(a)) || 14);
const ANCHOR = JSON.parse(fs.readFileSync(new URL('../src/fitted_anchor.json', import.meta.url), 'utf8')).byStat;
const ids = await loadPlayerIds();
const STATS = { RB: ['carries', 'rush_yds', 'receptions', 'rec_yds'], WR: ['targets', 'receptions', 'rec_yds'], TE: ['targets', 'receptions', 'rec_yds'], QB: ['pass_att', 'completions', 'pass_yds', 'rush_yds'] };
const all = await calibratedRows(BATCH);
const hist = new Map(); for (const r of all) { const k = `${r.season}|${r.player_id}|${r.stat}`; (hist.get(k) || hist.set(k, []).get(k)).push([r.week, r.actual]); }
for (const r of all) { const aw = ANCHOR[r.key]?.w || 0; const pr = (hist.get(`${r.season}|${r.player_id}|${r.stat}`) || []).filter(([w]) => w < r.week); if (aw && pr.length >= 2) { const avg = pr.reduce((a, [, v]) => a + v, 0) / pr.length; r.cal = Math.max(0, r.cal + aw * (avg - r.cal)); } }
const recs = { 2024: await buildRecords([2023, 2024]), 2025: await buildRecords([2024, 2025]) };
const rcache = new Map();
const ratingsAt = (season, week) => { const k = `${season}|${week}`; if (!rcache.has(k)) rcache.set(k, ratingsFrom(recs[season], season, week)); return rcache.get(k); };
const data = [];
for (const r of all) {
  if (!(r.season === 2024 || r.season === 2025) || r.week < 3 || !STATS[r.pos]?.includes(r.stat)) continue;
  const gs = ids.byEspn.get(String(r.player_id))?.gsis; if (!gs) continue;
  const p = ratingsAt(r.season, r.week).players.get(gs); if (!p || p.pos !== r.pos) continue;
  data.push({ key: r.key, season: r.season, res: r.actual - r.cal, x: SKILLS[r.pos].map(([k]) => ((p.skills[k]?.rating ?? 50) - 50) / 50), ov: ((p.overall ?? 50) - 50) / 50 });
}
function ridge(L, lam) { const P = L[0].x.length + 1, A = Array.from({ length: P }, () => new Array(P).fill(0)), b = new Array(P).fill(0);
  for (const r of L) { const x = [1, ...r.x]; for (let i = 0; i < P; i++) { b[i] += x[i] * r.res; for (let j = 0; j < P; j++) A[i][j] += x[i] * x[j]; } }
  for (let i = 1; i < P; i++) A[i][i] += lam * L.length;
  const M = A.map((row, i) => [...row, b[i]]); for (let c = 0; c < P; c++) { let p = c; for (let r = c + 1; r < P; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c]; for (let k = c; k <= P; k++) M[c][k] /= d; for (let r = 0; r < P; r++) if (r !== c) { const f = M[r][c]; for (let k = c; k <= P; k++) M[r][k] -= f * M[c][k]; } }
  return M.map((r) => r[P]); }
const pred = (b, r) => r.x.reduce((a, v, j) => a + v * b[j + 1], b[0]);
const mae = (L, b) => L.reduce((a, r) => a + Math.abs(r.res - (b ? pred(b, r) : 0)), 0) / L.length;
const out = {};
for (const key of [...new Set(data.map((d) => d.key))].sort()) {
  const D = data.filter((d) => d.key === key), A = D.filter((d) => d.season === 2024), B = D.filter((d) => d.season === 2025);
  if (A.length < 150 || B.length < 150) continue;
  let best = null;
  for (const lam of [0.01, 0.05, 0.2, 1]) {
    const f1 = { base: mae(B), with: mae(B, ridge(A, lam)) }, f2 = { base: mae(A), with: mae(A, ridge(B, lam)) };
    const gain = Math.min(1 - f1.with / f1.base, 1 - f2.with / f2.base); // must help in BOTH directions
    if (!best || gain > best.gain) best = { lam, gain, f1, f2 };
  }
  // Variants without an intercept (ratings move a player only relative to average, never shift everyone):
  const slopeOnly = (b) => [0, ...b.slice(1)];
  const ovFit = (L) => { let n = 0, d = 0; for (const r of L) { n += r.ov * r.res; d += r.ov * r.ov; } return d ? n / (d + 0.2 * L.length) : 0; };
  const maeOv = (L, c) => L.reduce((a, r) => a + Math.abs(r.res - c * r.ov), 0) / L.length;
  const so = { f1: mae(B, slopeOnly(ridge(A, best.lam))), f2: mae(A, slopeOnly(ridge(B, best.lam))) };
  const ov = { f1: maeOv(B, ovFit(A)), f2: maeOv(A, ovFit(B)), c: ovFit(D) };
  const pc = (w, b) => `${(((w - b) / b) * 100).toFixed(1)}%`;
  console.log(`   ${key.padEnd(14)} slopes-only ${pc(so.f1, best.f1.base)} / ${pc(so.f2, best.f2.base)} · overall-only ${pc(ov.f1, best.f1.base)} / ${pc(ov.f2, best.f2.base)} (coef ${ov.c.toFixed(2)})`);
  const ship = best.gain > 0.002; // at least 0.2% better in both directions
  out[key] = { ship, lambda: best.lam, beta: ridge(D, best.lam), overallCoef: ov.c, overallTest: { test2025: ov.f1, test2024: ov.f2 }, slopesTest: { test2025: so.f1, test2024: so.f2 }, skills: SKILLS[key.split('|')[0]].map(([k]) => k), test2025: best.f1, test2024: best.f2, n: D.length };
  console.log(`${key.padEnd(16)} n ${String(D.length).padStart(5)} | 2024→2025 MAE ${best.f1.base.toFixed(3)} → ${best.f1.with.toFixed(3)} | 2025→2024 ${best.f2.base.toFixed(3)} → ${best.f2.with.toFixed(3)} | ${ship ? 'SHIP' : 'no'} (worst-fold gain ${(best.gain * 100).toFixed(1)}%)`);
}
if (process.argv.includes('--write')) { fs.writeFileSync(new URL('../src/fitted_skill_projection.json', import.meta.url), JSON.stringify({ learnedAt: new Date().toISOString(), batch: BATCH, note: 'residual = b0 + Σ b_k·(rating_k−50)/50; shipped only where both walk-forward directions improved ≥0.2%', byStat: out }, null, 1)); console.log('wrote src/fitted_skill_projection.json'); }
