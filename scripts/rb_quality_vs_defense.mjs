// Do better backs lose less to good run defenses? nflverse pbp 2022–25 (RB designed runs).
// For each RB-game (8+ carries; back has 40+ prior carries this season or last; defense has prior games this season):
//   resid = his YPC this game − his own prior YPC (this season + last season, carry-weighted)
//   dev   = defense's RB YPC allowed before this game − league        (negative = tough run D)
//   q     = his prior YPC − league                                     (positive = better back)
// Fit (carry-weighted): resid = a + b·dev + c·dev·q + d·q. c < 0 would mean the defense matters LESS for better backs
// (dev is negative for tough defenses, so dev·q > 0 for good back vs tough D; a negative c shrinks the penalty).
// Also: the same split by quality tercile, and a walk-forward check of whether adding c reduces YPC error.
import { loadPlays, loadPlayerIds } from '../src/pbp.js';
import zlib from 'node:zlib';
import { fetchCached } from '../src/fetcher.js';
// NGS rushing yards over expected (season totals = week 0): a back's "creates yards on his own" quality.
const ngsTxt = zlib.gunzipSync(Buffer.from(await (await fetch('https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats/ngs_rushing.csv.gz')).arrayBuffer())).toString();
const NG = new Map(); { const L = ngsTxt.trim().split('\n'), H = L[0].split(','); const ix = (k) => H.indexOf(k);
  for (const l of L.slice(1)) { const v = l.split(','); if (v[ix('season_type')] !== 'REG' || v[ix('week')] !== '0') continue; const att = +v[ix('rush_attempts')], r = v[ix('rush_yards_over_expected_per_att')]; if (att >= 50 && r !== '') NG.set(`${v[ix('season')]}|${v[ix('player_gsis_id')]}`, +r); } }
const { posByGsis } = await loadPlayerIds();
const rows = [];
let prevSeasonPlayer = new Map();
for (const season of [2021, 2022, 2023, 2024, 2025]) {
  const runs = (await loadPlays(season)).filter((p) => !p.post && p.t === 'R' && !p.scr && p.ru && posByGsis.get(p.ru) === 'RB');
  const G = new Map(); for (const p of runs) { const k = `${p.g}|${p.ru}`; const x = G.get(k) || G.set(k, { w: p.w, d: p.d, ru: p.ru, c: 0, y: 0 }).get(k); x.c++; x.y += p.y; }
  const games = [...G.values()].sort((a, b) => a.w - b.w);
  const D = new Map(), P = new Map(); let L = [0, 0];
  for (const w of [...new Set(games.map((g) => g.w))]) {
    const wk = games.filter((g) => g.w === w);
    if (season >= 2022) for (const g of wk) {
      if (g.c < 8) continue;
      const d = D.get(g.d); if (!d || d.c < 30 || L[0] < 500) continue;
      const cur = P.get(g.ru) || { c: 0, y: 0 }, pv = prevSeasonPlayer.get(g.ru) || { c: 0, y: 0 };
      const pc = cur.c + 0.5 * pv.c; if (pc < 40) continue;
      const lg = L[1] / L[0], pYpc = (cur.y + 0.5 * pv.y) / pc;
      rows.push({ season, c: g.c, resid: g.y / g.c - pYpc, dev: d.y / d.c - lg, q: pYpc - lg, r: NG.get(`${season - 1}|${g.ru}`) ?? null });
    }
    for (const g of wk) { const d = D.get(g.d) || D.set(g.d, { c: 0, y: 0 }).get(g.d); d.c += g.c; d.y += g.y; const p = P.get(g.ru) || P.set(g.ru, { c: 0, y: 0 }).get(g.ru); p.c += g.c; p.y += g.y; L[0] += g.c; L[1] += g.y; }
  }
  prevSeasonPlayer = new Map([...P]);
}
function wls(R, cols) {
  const X = R.map((r) => cols.map((f) => f(r))), Y = R.map((r) => r.resid), W = R.map((r) => r.c), P = cols.length;
  const A = Array.from({ length: P }, () => new Array(P).fill(0)), b = new Array(P).fill(0);
  X.forEach((x, i) => { for (let a = 0; a < P; a++) { b[a] += W[i] * x[a] * Y[i]; for (let c = 0; c < P; c++) A[a][c] += W[i] * x[a] * x[c]; } });
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < P; c++) { let p = c; for (let r = c + 1; r < P; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c]; for (let k = c; k <= P; k++) M[c][k] /= d; for (let r = 0; r < P; r++) if (r !== c) { const f = M[r][c]; for (let k = c; k <= P; k++) M[r][k] -= f * M[c][k]; } }
  const beta = M.map((r) => r[P]);
  // standard errors (weighted, approximate)
  const res = X.map((x, i) => Y[i] - x.reduce((a, v, j) => a + v * beta[j], 0)); const sw = W.reduce((a, b2) => a + b2, 0);
  const s2 = res.reduce((a, r, i) => a + W[i] * r * r, 0) / (sw - P);
  const Ainv = (() => { const n = P, M2 = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]); for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M2[r][c]) > Math.abs(M2[p][c])) p = r; [M2[c], M2[p]] = [M2[p], M2[c]]; const d = M2[c][c]; for (let k = 0; k < 2 * n; k++) M2[c][k] /= d; for (let r = 0; r < n; r++) if (r !== c) { const f = M2[r][c]; for (let k = 0; k < 2 * n; k++) M2[r][k] -= f * M2[c][k]; } } return M2.map((r) => r.slice(n)); })();
  return { beta, se: beta.map((_, j) => Math.sqrt(s2 * Ainv[j][j])) };
}
const cols = [() => 1, (r) => r.dev, (r) => r.dev * r.q, (r) => r.q];
const f = wls(rows, cols);
console.log(`RB-games: ${rows.length}`);
console.log(`resid YPC = ${f.beta[0].toFixed(3)} + ${f.beta[1].toFixed(3)}·defDev + ${f.beta[2].toFixed(3)}·defDev×backQuality + ${f.beta[3].toFixed(3)}·backQuality`);
console.log(`   defDev ${f.beta[1].toFixed(3)} ± ${f.se[1].toFixed(3)} | interaction ${f.beta[2].toFixed(3)} ± ${f.se[2].toFixed(3)} (z ${(f.beta[2] / f.se[2]).toFixed(1)})`);
// By quality tercile: how much of the defense's deviation shows up?
const qs = rows.map((r) => r.q).sort((a, b) => a - b), t1 = qs[Math.floor(qs.length / 3)], t2 = qs[Math.floor((2 * qs.length) / 3)];
for (const [lbl, fn] of [['bottom third (weaker backs)', (r) => r.q < t1], ['middle third', (r) => r.q >= t1 && r.q < t2], ['top third (best backs)', (r) => r.q >= t2]]) {
  const R = rows.filter(fn), g = wls(R, [() => 1, (r) => r.dev]);
  console.log(`   ${lbl.padEnd(28)} n ${String(R.length).padStart(4)} prior YPC vs league ${(R.reduce((a, r) => a + r.q, 0) / R.length >= 0 ? '+' : '')}${(R.reduce((a, r) => a + r.q, 0) / R.length).toFixed(2)} → share of defense deviation that shows up: ${g.beta[1].toFixed(3)} ± ${g.se[1].toFixed(3)}`);
}
// Walk-forward: does the interaction reduce YPC error on a held-out season?
for (const test of [2024, 2025]) {
  const tr = rows.filter((r) => r.season < test), te = rows.filter((r) => r.season === test);
  const m0 = wls(tr, [() => 1, (r) => r.dev, (r) => r.q]), m1 = wls(tr, cols);
  const err = (m, cs) => te.reduce((a, r) => a + r.c * Math.abs(r.resid - cs.reduce((s, f2, j) => s + f2(r) * m.beta[j], 0)), 0) / te.reduce((a, r) => a + r.c, 0);
  console.log(`walk-forward ${test}: YPC error without interaction ${err(m0, [() => 1, (r) => r.dev, (r) => r.q]).toFixed(4)} → with ${err(m1, cols).toFixed(4)}`);
}

// ---------- Same test with NGS RYOE per carry (last season) as the quality measure ----------
const RR = rows.filter((r) => r.r != null);
const colsR = [() => 1, (r) => r.dev, (r) => r.dev * r.r, (r) => r.r];
const fr = wls(RR, colsR);
console.log(`\nwith RYOE (last season) as quality — RB-games ${RR.length}`);
console.log(`   defDev ${fr.beta[1].toFixed(3)} ± ${fr.se[1].toFixed(3)} | defDev×RYOE ${fr.beta[2].toFixed(3)} ± ${fr.se[2].toFixed(3)} (z ${(fr.beta[2] / fr.se[2]).toFixed(1)}) | RYOE ${fr.beta[3].toFixed(3)} ± ${fr.se[3].toFixed(3)}`);
const rs = RR.map((r) => r.r).sort((a, b) => a - b), r1 = rs[Math.floor(rs.length / 3)], r2 = rs[Math.floor((2 * rs.length) / 3)];
for (const [lbl, fn] of [['low RYOE (below-avg creators)', (r) => r.r < r1], ['middle', (r) => r.r >= r1 && r.r < r2], ['high RYOE (best creators)', (r) => r.r >= r2]]) {
  const R = RR.filter(fn), g = wls(R, [() => 1, (r) => r.dev]);
  console.log(`   ${lbl.padEnd(32)} n ${String(R.length).padStart(4)} avg RYOE/att ${(R.reduce((a, r) => a + r.r, 0) / R.length).toFixed(2)} → share of defense deviation that shows up: ${g.beta[1].toFixed(3)} ± ${g.se[1].toFixed(3)}`);
}
for (const test of [2024, 2025]) {
  const tr = RR.filter((r) => r.season < test), te = RR.filter((r) => r.season === test);
  const base = [() => 1, (r) => r.dev, (r) => r.r];
  const m0 = wls(tr, base), m1 = wls(tr, colsR);
  const err = (m, cs) => te.reduce((a, r) => a + r.c * Math.abs(r.resid - cs.reduce((s2, f2, j) => s2 + f2(r) * m.beta[j], 0)), 0) / te.reduce((a, r) => a + r.c, 0);
  console.log(`walk-forward ${test} (RYOE): without interaction ${err(m0, base).toFixed(4)} → with ${err(m1, colsR).toFixed(4)}`);
}
