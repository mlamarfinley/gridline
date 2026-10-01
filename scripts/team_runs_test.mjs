// How strongly should a team's run volume be regressed to league average? nflverse 2022–25.
// Target: a team's rushing attempts in a game (all ball-carriers, as box scores count them).
// Estimate before the game: off = (n·this-season mean + k·prior) / (n + k), prior = L + r·(last season − L);
// same for what the opponent allowed; est = off + b·(def − L) + c·spread. Fit grid on 2022–24, test on 2025.
import { fetchCached } from '../src/fetcher.js';
import { loadWeekly } from '../src/situational.js';
const csv = (t) => { const L = t.trim().split('\n'); const H = L[0].split(','); return L.slice(1).map((l) => { const v = l.split(','); return Object.fromEntries(H.map((h, i) => [h, v[i]])); }); };
const games = new Map();
for (const g of csv((await fetchCached('https://github.com/nflverse/nfldata/raw/master/data/games.csv', { ttl: 86400, as: 'text' })).data)) if (+g.season >= 2021 && g.game_type === 'REG') games.set(g.game_id, g);
const TG = {}; // season -> [{team, opp, week, runs, spread}]
for (const s of [2021, 2022, 2023, 2024, 2025]) {
  const rows = await loadWeekly(s);
  const m = new Map();
  for (const r of rows) { const k = `${r.game_id}|${r.team}`; const x = m.get(k) || m.set(k, { gid: r.game_id, team: r.team, opp: r.opponent_team, week: +r.week, runs: 0 }).get(k); x.runs += +r.carries || 0; }
  TG[s] = [...m.values()].map((x) => { const g = games.get(x.gid); const sp = g && g.spread_line !== '' ? (g.home_team === x.team ? +g.spread_line : -g.spread_line) : 0; return { ...x, spread: sp }; });
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
function rowsFor(s, k, r) {
  const T = TG[s], P = TG[s - 1], L = mean(P.map((x) => x.runs));
  const prevOff = new Map(), prevDef = new Map();
  for (const x of P) { (prevOff.get(x.team) || prevOff.set(x.team, []).get(x.team)).push(x.runs); (prevDef.get(x.opp) || prevDef.set(x.opp, []).get(x.opp)).push(x.runs); }
  const out = [];
  for (const x of T) {
    if (x.week < 2) continue;
    const before = T.filter((y) => y.week < x.week);
    const cur = before.filter((y) => y.team === x.team).map((y) => y.runs), curD = before.filter((y) => y.opp === x.opp).map((y) => y.runs);
    const pr = L + r * (mean(prevOff.get(x.team) || [L]) - L), prD = L + r * (mean(prevDef.get(x.opp) || [L]) - L);
    const off = (cur.length * (cur.length ? mean(cur) : 0) + k * pr) / (cur.length + k), def = (curD.length * (curD.length ? mean(curD) : 0) + k * prD) / (curD.length + k);
    out.push({ y: x.runs, off, def, L, spread: x.spread, n: cur.length });
  }
  return out;
}
const fitC = (R, b) => { let sxy = 0, sxx = 0; for (const z of R) { const res = z.y - (z.off + b * (z.def - z.L)); sxy += res * z.spread; sxx += z.spread * z.spread; } return sxy / sxx; };
const err = (R, b, c) => { let a = 0; for (const z of R) a += Math.abs(z.off + b * (z.def - z.L) + c * z.spread - z.y); return a / R.length; };
let best = { mae: 1e9 }, bestNo = { mae: 1e9 };
for (const k of [1, 2, 3, 4, 6, 8, 12, 20]) for (const r of [0, 0.25, 0.5, 0.75]) {
  const tr = [2022, 2023, 2024].flatMap((s) => rowsFor(s, k, r));
  for (const b of [0, 0.25, 0.5, 0.75]) {
    const c = fitC(tr, b), m1 = err(tr, b, c), m0 = err(tr, b, 0);
    if (m1 < best.mae) best = { k, r, b, c, mae: m1 };
    if (m0 < bestNo.mae) bestNo = { k, r, b, c: 0, mae: m0 };
  }
}
const cur = { k: 12, r: 0.25, b: 0.75, c: 0 };
for (const [label, p] of [['current fitted estimator (k 12, no spread)', cur], ['best without spread', bestNo], ['best with spread', best]]) {
  const te = rowsFor(2025, p.k, p.r);
  const early = te.filter((z) => z.n <= 4);
  console.log(`${label.padEnd(44)} k=${p.k} r=${p.r} b=${p.b} spread×${(p.c || 0).toFixed(3)} | 2025 MAE ${err(te, p.b, p.c).toFixed(3)} (weeks with ≤4 prior games: ${err(early, p.b, p.c).toFixed(3)})`);
}
