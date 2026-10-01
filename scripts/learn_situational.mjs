// Learn the situational multiplier models (src/situational.js) from nflverse 2022–25.
//   node --no-warnings scripts/learn_situational.mjs [--write]
// Test: fit 2022–24 → score 2025 (MAE vs the player's own baseline alone). Shipped fit uses all of 2022–25.
// Everything per game uses only earlier weeks (baseline, opponent allowance), so nothing leaks from the game itself.
import fs from 'node:fs';
import { fetchCached } from '../src/fetcher.js';
import { FEATS, LABEL, STAT_COL, seasonState, situationInput, posGroup } from '../src/situational.js';

const WRITE = process.argv.includes('--write');
const NV = 'https://github.com/nflverse/nflverse-data/releases/download/stats_player';
const MODELS = STAT_COL;
const csv = (t) => { const L = t.trim().split('\n'); const H = L[0].split(','); return L.slice(1).map((l) => { const v = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { v.push(cur); cur = ''; } else cur += ch; } v.push(cur); return Object.fromEntries(H.map((h, i) => [h, v[i]])); }); };

const games = new Map();
for (const g of csv((await fetchCached('https://github.com/nflverse/nfldata/raw/master/data/games.csv', { ttl: 86400, as: 'text', label: 'nflverse games' })).data)) {
  if (+g.season < 2021) continue;
  games.set(g.game_id, { home: g.home_team, away: g.away_team, spread: g.spread_line === '' ? null : +g.spread_line, total: g.total_line === '' ? null : +g.total_line, outdoors: /outdoors|open/i.test(g.roof), temp: g.temp === '' ? null : +g.temp, wind: g.wind === '' ? null : +g.wind });
}
const seasons = {};
for (const s of [2021, 2022, 2023, 2024, 2025]) seasons[s] = csv((await fetchCached(`${NV}/stats_player_week_${s}.csv`, { ttl: 30 * 86400, as: 'text', label: `nflverse ${s} weekly` })).data).filter((r) => r.season_type === 'REG');

// Build rows with the SAME code the live model uses (src/situational.js seasonState + situationInput).
const rows = [];
for (const s of [2022, 2023, 2024, 2025]) {
  const cur = seasons[s], prev = seasons[s - 1];
  for (const w of [...new Set(cur.map((r) => +r.week))].sort((a, b) => a - b)) {
    const st = seasonState(cur, prev, w);
    for (const r of cur.filter((x) => +x.week === w)) {
      const p = posGroup(r.position); if (!p) continue;
      const g = games.get(r.game_id); if (!g || g.spread == null || g.total == null) continue;
      const isHome = r.team === g.home, spread = isHome ? g.spread : -g.spread;
      for (const key of Object.keys(MODELS)) {
        if (!key.startsWith(p + '|')) continue;
        const inp = situationInput(st, { key, playerId: r.player_id, opp: r.opponent_team, spread, impliedPts: g.total / 2 + spread / 2, home: isHome ? 1 : 0, wind: g.wind, temp: g.temp, outdoors: g.outdoors });
        if (inp) rows.push({ key, season: s, week: w, pid: r.player_id, base: inp.base, y: +r[MODELS[key][0]] || 0, x: inp.x });
      }
    }
  }
}

// Poisson regression with offset log(base), ridge on slopes (IRLS).
function fit(R, lambda = 2) {
  const P = FEATS.length + 1; let b = new Array(P).fill(0);
  for (let it = 0; it < 30; it++) {
    const A = Array.from({ length: P }, () => new Array(P).fill(0)), g = new Array(P).fill(0);
    for (const r of R) {
      const xv = [1, ...r.x]; const eta = Math.log(r.base) + xv.reduce((a, v, j) => a + v * b[j], 0); const mu = Math.exp(eta);
      for (let i = 0; i < P; i++) { g[i] += (r.y - mu) * xv[i]; for (let j = 0; j < P; j++) A[i][j] += mu * xv[i] * xv[j]; }
    }
    for (let i = 1; i < P; i++) { A[i][i] += lambda; g[i] -= lambda * b[i]; }
    // solve A·d = g
    const M = A.map((row, i) => [...row, g[i]]);
    for (let c = 0; c < P; c++) { let piv = c; for (let r = c + 1; r < P; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; const d = M[c][c] || 1e-9; for (let k = c; k <= P; k++) M[c][k] /= d; for (let r = 0; r < P; r++) if (r !== c) { const f = M[r][c]; for (let k = c; k <= P; k++) M[r][k] -= f * M[c][k]; } }
    const step = M.map((r) => r[P]); b = b.map((v, i) => v + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return b;
}
const pred = (b, r) => r.base * Math.exp(b[0] + r.x.reduce((a, v, j) => a + v * b[j + 1], 0));
const mae = (R, f) => R.reduce((a, r) => a + Math.abs(f(r) - r.y), 0) / R.length;

const out = {};
console.log(`rows: ${rows.length}`);
for (const key of Object.keys(MODELS)) {
  const R = rows.filter((r) => r.key === key);
  const tr = R.filter((r) => r.season <= 2024), te = R.filter((r) => r.season === 2025);
  if (tr.length < 300 || te.length < 100) continue;
  const b = fit(tr), bAll = fit(R);
  const mB = mae(te, (r) => r.base), mM = mae(te, (r) => pred(b, r));
  const ship = mM < mB;
  out[key] = { beta: bAll, beatsBaseline: ship, n: R.length, test2025: { baseline: +mB.toFixed(3), model: +mM.toFixed(3) }, multipliers: Object.fromEntries(FEATS.map((f, i) => [f, +Math.exp(bAll[i + 1]).toFixed(3)])), baseAdj: +Math.exp(bAll[0]).toFixed(3) };
  console.log(`\n${key}  n=${R.length}  2025 MAE: baseline ${mB.toFixed(2)} → model ${mM.toFixed(2)} (${(((mM - mB) / mB) * 100).toFixed(1)}%) ${ship ? 'SHIP' : 'no'}`);
  console.log(`   base adj ×${Math.exp(bAll[0]).toFixed(3)} | ` + FEATS.map((f, i) => `${f} ×${Math.exp(bAll[i + 1]).toFixed(3)}`).join(' · '));
}
// Out-of-sample situational forecasts for 2025 (model fit on 2022–24), for comparison with the full model.
const test25 = [];
for (const key of Object.keys(MODELS)) { const R = rows.filter((r) => r.key === key); const b = fit(R.filter((r) => r.season <= 2024)); for (const r of R.filter((x) => x.season === 2025)) test25.push({ key, week: r.week, pid: r.pid, base: +r.base.toFixed(3), sit: +pred(b, r).toFixed(3), y: r.y }); }
fs.writeFileSync(new URL('../reports/situational_2025.json', import.meta.url), JSON.stringify(test25));
if (WRITE) { fs.writeFileSync(new URL('../src/fitted_situational.json', import.meta.url), JSON.stringify({ learnedAt: new Date().toISOString(), data: 'nflverse 2022–25 regular season', feats: FEATS, labels: LABEL, byStat: out }, null, 1)); console.log('\nwrote src/fitted_situational.json'); }
