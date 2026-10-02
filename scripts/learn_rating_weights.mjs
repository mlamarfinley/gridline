// Learn how to combine skill ratings into an overall that PREDICTS production (instead of hand-picked weights).
// Fit (ridge OLS) on 2025 points → test on 2024 points (and vs/with Madden 25 there). Target = raw next-4-game
// production: QB EPA/dropback, RB yards/carry, WR/TE yards/target.   node --no-warnings scripts/learn_rating_weights.mjs [--write]
import fs from 'node:fs';
import { buildRecords, ratingsFrom, SKILLS } from '../src/playerRatings.js';
import { loadPlays, loadPlayerIds } from '../src/pbp.js';
const ids = await loadPlayerIds();
const M = JSON.parse(fs.readFileSync(new URL('../reports/madden25_iterations.json', import.meta.url), 'utf8'));
const norm = (n) => String(n).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’,]/g, '').replace(/-/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
const MINF = { QB: 40, RB: 15, WR: 8, TE: 6 };
async function points(season) {
  const recs = await buildRecords([season - 1, season]);
  const plays = (await loadPlays(season)).filter((p) => !p.post);
  const fut = (gs, pos, W) => { let n = 0, d = 0; for (const p of plays) { if (p.w < W || p.w >= W + 4) continue;
    if (pos === 'QB' && ((p.t === 'P' && p.qb === gs) || (p.scr && p.ru === gs)) && p.epa != null) { n += p.epa; d++; }
    else if (pos === 'RB' && p.t === 'R' && !p.scr && p.ru === gs) { n += p.y; d++; }
    else if ((pos === 'WR' || pos === 'TE') && p.t === 'P' && !p.sk && p.rec === gs) { n += p.y; d++; } }
    return d >= MINF[pos] ? [n / d, d] : null; };
  const out = { QB: [], RB: [], WR: [], TE: [] };
  for (const W of [4, 7, 10, 13]) {
    const res = ratingsFrom(recs, season, W);
    const mad = new Map(), dup = new Set(); if (season === 2024) for (const x of M[W]) { const k = norm(x.name); if (mad.has(k)) dup.add(k); mad.set(k, x.overall); }
    for (const pos of Object.keys(out)) for (const p of res.byPos[pos]) {
      const f = fut(p.gsis, pos, W); if (!f) continue;
      const nm = norm(ids.nameByGsis.get(p.gsis) || '');
      out[pos].push({ W, x: SKILLS[pos].map(([k]) => (p.skills[k]?.rating ?? 50) / 100 - 0.5), oldOverall: p.overall, madden: season === 2024 && !dup.has(nm) ? mad.get(nm) ?? null : null, y: f[0], w: f[1] });
    }
  }
  return out;
}
const tr = await points(2025), te = await points(2024);
function ridge(L, lambda = 2) {
  const P = L[0].x.length + 1, A = Array.from({ length: P }, () => new Array(P).fill(0)), b = new Array(P).fill(0);
  for (const r of L) { const x = [1, ...r.x]; for (let i = 0; i < P; i++) { b[i] += r.w * x[i] * r.y; for (let j = 0; j < P; j++) A[i][j] += r.w * x[i] * x[j]; } }
  const W = L.reduce((a, r) => a + r.w, 0); for (let i = 1; i < P; i++) A[i][i] += lambda * W / 100;
  const Mx = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < P; c++) { let p = c; for (let r = c + 1; r < P; r++) if (Math.abs(Mx[r][c]) > Math.abs(Mx[p][c])) p = r; [Mx[c], Mx[p]] = [Mx[p], Mx[c]]; const d = Mx[c][c]; for (let k = c; k <= P; k++) Mx[c][k] /= d; for (let r = 0; r < P; r++) if (r !== c) { const f = Mx[r][c]; for (let k = c; k <= P; k++) Mx[r][k] -= f * Mx[c][k]; } }
  return Mx.map((r) => r[P]);
}
const wcorr = (L, f) => { const W = L.reduce((a, r) => a + r.w, 0), mx = L.reduce((a, r) => a + r.w * f(r), 0) / W, my = L.reduce((a, r) => a + r.w * r.y, 0) / W; let sxy = 0, sxx = 0, syy = 0; for (const r of L) { const dx = f(r) - mx, dy = r.y - my; sxy += r.w * dx * dy; sxx += r.w * dx * dx; syy += r.w * dy * dy; } return sxy / Math.sqrt(sxx * syy); };
const result = { fitOn: 2025, testOn: 2024, byPos: {} };
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  const beta = ridge(tr[pos]);
  const pred = (r) => r.x.reduce((a, v, j) => a + v * beta[j + 1], beta[0]);
  const T = te[pos], TM = T.filter((r) => r.madden != null);
  const z = (L, f) => { const v = L.map(f), m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1; return (r) => (f(r) - m) / sd; };
  const zl = z(TM, pred), zm = z(TM, (r) => r.madden);
  const grid = []; for (let w = 0; w <= 1.0001; w += 0.1) grid.push({ w: +w.toFixed(1), r: wcorr(TM, (r) => w * zl(r) + (1 - w) * zm(r)) });
  const best = grid.reduce((a, b) => (b.r > a.r ? b : a));
  result.byPos[pos] = { skills: SKILLS[pos].map(([k]) => k), beta, test: { handWeightsOverall: wcorr(TM, (r) => r.oldOverall), learnedOverall: wcorr(TM, pred), madden: wcorr(TM, (r) => r.madden), bestBlend: best, n: TM.length } };
  const wts = SKILLS[pos].map(([k], j) => `${k} ${beta[j + 1] >= 0 ? '+' : ''}${beta[j + 1].toFixed(2)}`).join(', ');
  console.log(`${pos}: 2024 test (n ${TM.length}) — hand-weighted overall r=${wcorr(TM, (r) => r.oldOverall).toFixed(3)} · learned overall r=${wcorr(TM, pred).toFixed(3)} · Madden r=${wcorr(TM, (r) => r.madden).toFixed(3)} · best blend ${Math.round(best.w * 100)}% ours/${Math.round((1 - best.w) * 100)}% Madden r=${best.r.toFixed(3)}\n     learned weights (per rating point/100 → target): ${wts}`);
}
if (process.argv.includes('--write')) { fs.writeFileSync(new URL('../src/fitted_rating_weights.json', import.meta.url), JSON.stringify({ learnedAt: new Date().toISOString(), ...result }, null, 1)); console.log('wrote src/fitted_rating_weights.json'); }
