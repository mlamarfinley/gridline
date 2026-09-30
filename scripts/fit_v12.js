// Fit the fbm-1.2.0 constants on HISTORICAL data only: predict each 2025 regular-season week w
// (w >= 2) from 2024 (prior season) + 2025 weeks < w. 2026 data is never read here.
// Output: src/fitted_v12.json (constants + fit diagnostics). Usage: node scripts/fit_v12.js
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { fetchCached } from '../src/fetcher.js';
import { parseCsv } from '../src/baselines.js';

const NV = 'https://github.com/nflverse/nflverse-data/releases/download';
const csv = async (u) => parseCsv((await fetchCached(u, { ttl: 30 * 86400, as: 'text' })).data);
const [team24, team25, pl24, pl25, games] = await Promise.all([
  csv(`${NV}/stats_team/stats_team_week_2024.csv`), csv(`${NV}/stats_team/stats_team_week_2025.csv`),
  csv(`${NV}/stats_player/stats_player_week_2024.csv`), csv(`${NV}/stats_player/stats_player_week_2025.csv`),
  csv(`${NV}/schedules/games.csv`),
]);
const N = (x) => Number(x || 0);
const REG = (r) => r.season_type === 'REG';
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

// ---------- team-week table ----------
const pts = new Map(); // `${season}|${week}|${team}` -> {for, against}
for (const g of games) {
  if (g.game_type !== 'REG' || g.home_score === '' || g.home_score == null) continue;
  pts.set(`${g.season}|${g.week}|${g.home_team}`, { for: N(g.home_score), against: N(g.away_score), spread: N(g.spread_line), total: N(g.total_line), home: 1 });
  pts.set(`${g.season}|${g.week}|${g.away_team}`, { for: N(g.away_score), against: N(g.home_score), spread: -N(g.spread_line), total: N(g.total_line), home: 0 });
}
const teamRow = (r) => {
  const p = pts.get(`${r.season}|${r.week}|${r.team}`) || {};
  return { season: N(r.season), week: N(r.week), team: r.team, opp: r.opponent_team, plays: N(r.attempts) + N(r.sacks_suffered) + N(r.carries), att: N(r.attempts), passYds: N(r.passing_yards), rushYds: N(r.rushing_yards), carries: N(r.carries), targets: N(r.targets), pf: p.for, pa: p.against, spread: p.spread, total: p.total };
};
const T24 = team24.filter(REG).map(teamRow), T25 = team25.filter(REG).map(teamRow);
const seasonAvg = (rows, team, key) => mean(rows.filter((r) => r.team === team).map((r) => r[key]));
const allowedAvg = (rows, team, key) => mean(rows.filter((r) => r.opp === team).map((r) => r[key]));
const league = (key) => mean(T24.map((r) => r[key]));

function fitTeam(key, { useOpp = true } = {}) {
  const L = league(key);
  const grid = [];
  for (const k of [0.5, 1, 2, 3, 4, 6, 8, 12]) for (const r of [0, 0.25, 0.4, 0.5, 0.6, 0.75, 1]) for (const b of useOpp ? [0, 0.25, 0.5, 0.75, 1] : [0]) {
    let se = 0, n = 0;
    for (const x of T25) {
      if (x.week < 2 || x[key] == null || Number.isNaN(x[key])) continue;
      const prev = T25.filter((y) => y.week < x.week);
      const cur = prev.filter((y) => y.team === x.team).map((y) => y[key]);
      const curA = prev.filter((y) => y.opp === x.opp).map((y) => y[key]);
      const pr = L + r * (seasonAvg(T24, x.team, key) - L);
      const prA = L + r * (allowedAvg(T24, x.opp, key) - L);
      const off = (cur.length * mean(cur) + k * pr) / (cur.length + k);
      const def = (curA.length * mean(curA) + k * prA) / (curA.length + k);
      const est = off + b * (def - L);
      se += (est - x[key]) ** 2; n++;
    }
    grid.push({ k, r, b, rmse: Math.sqrt(se / n), n });
  }
  grid.sort((a, b) => a.rmse - b.rmse);
  // Reference: the v1.1 approach (current season only, shrunk 3 games to league, 35% opp).
  let se = 0, n = 0;
  for (const x of T25) {
    if (x.week < 2) continue;
    const prev = T25.filter((y) => y.week < x.week);
    const cur = prev.filter((y) => y.team === x.team).map((y) => y[key]);
    const curA = prev.filter((y) => y.opp === x.opp).map((y) => y[key]);
    const off = (cur.length * mean(cur) + 3 * L) / (cur.length + 3), def = (curA.length * mean(curA) + 3 * L) / (curA.length + 3);
    se += (0.65 * off + 0.35 * def - x[key]) ** 2; n++;
  }
  return { key, league: L, best: grid[0], v11Rmse: Math.sqrt(se / n), naiveLeagueRmse: Math.sqrt(mean(T25.filter((x) => x.week >= 2).map((x) => (x[key] - L) ** 2))) };
}

// ---------- market mapping (closing lines archived in nflverse schedules) ----------
function fitMarket(key) {
  // key ~ a + b * impliedTeamPoints   (implied = total/2 + spread/2 from this team's perspective)
  const xs = [], ys = [];
  for (const x of [...T24, ...T25]) { if (!x.total || x[key] == null) continue; xs.push(x.total / 2 + x.spread / 2); ys.push(x[key]); }
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxy / sxx;
  return { key, perImpliedPoint: b, atMean: my, meanImplied: mx, n: xs.length, note: 'fit on 2024+2025 archived closing lines (nflverse schedules)' };
}

// ---------- player tables ----------
const pl = (rows, season) => rows.filter(REG).map((r) => ({ season, week: N(r.week), id: r.player_id, name: r.player_display_name, team: r.team, pos: r.position, att: N(r.attempts), passYds: N(r.passing_yards), carries: N(r.carries), rushYds: N(r.rushing_yards), targets: N(r.targets), rec: N(r.receptions), recYds: N(r.receiving_yards) }));
const P24 = pl(pl24, 2024), P25 = pl(pl25, 2025);
const teamWeek = new Map(T25.map((t) => [`${t.week}|${t.team}`, t]));
const teamWeek24 = new Map(T24.map((t) => [`${t.week}|${t.team}`, t]));

function fitQbYpa() {
  const qbs = P25.filter((r) => r.pos === 'QB' && r.att >= 10);
  const L = mean(P24.filter((r) => r.pos === 'QB' && r.att >= 10).map((r) => r.passYds / r.att));
  const grid = [];
  for (const m of [50, 100, 200, 400, 800]) for (const k of [25, 50, 100, 200, 400, 800]) {
    let se = 0, w = 0;
    for (const x of qbs) {
      if (x.week < 2) continue;
      const p = P24.filter((y) => y.id === x.id && y.att > 0);
      const a24 = p.reduce((s, y) => s + y.att, 0), y24 = p.reduce((s, y) => s + y.passYds, 0);
      const prior = (y24 + m * L) / (a24 + m);
      const c = P25.filter((y) => y.id === x.id && y.week < x.week && y.att > 0);
      const ac = c.reduce((s, y) => s + y.att, 0), yc = c.reduce((s, y) => s + y.passYds, 0);
      const est = (yc + k * prior) / (ac + k);
      se += x.att * (est - x.passYds / x.att) ** 2; w += x.att;
    }
    grid.push({ m, k, wrmse: Math.sqrt(se / w) });
  }
  grid.sort((a, b) => a.wrmse - b.wrmse);
  return { league: L, best: grid[0], worst: grid[grid.length - 1] };
}

function fitShare(kind) {
  const [num, den] = kind === 'target' ? ['targets', 'targets'] : ['carries', 'carries'];
  const cand = P25.filter((r) => (kind === 'target' ? ['WR', 'TE', 'RB'] : ['RB']).includes(r.pos));
  const grid = [];
  for (const k of [0, 0.5, 1, 2, 3, 4, 6]) {
    let se = 0, n = 0, seCur = 0;
    for (const x of cand) {
      if (x.week < 2) continue;
      const tw = teamWeek.get(`${x.week}|${x.team}`); if (!tw || !tw[den]) continue;
      const cur = P25.filter((y) => y.id === x.id && y.team === x.team && y.week < x.week).map((y) => { const t = teamWeek.get(`${y.week}|${y.team}`); return t && t[den] ? y[num] / t[den] : null; }).filter((v) => v != null);
      if (!cur.length) continue;
      const pr = P24.filter((y) => y.id === x.id && y.team === x.team).map((y) => { const t = teamWeek24.get(`${y.week}|${y.team}`); return t && t[den] ? y[num] / t[den] : null; }).filter((v) => v != null);
      const actual = x[num] / tw[den];
      const curM = mean(cur);
      const est = pr.length ? (cur.length * curM + k * mean(pr)) / (cur.length + k) : curM;
      se += (est - actual) ** 2; seCur += (curM - actual) ** 2; n++;
    }
    grid.push({ k, rmse: Math.sqrt(se / n), currentOnlyRmse: Math.sqrt(seCur / n), n });
  }
  grid.sort((a, b) => a.rmse - b.rmse);
  return grid[0];
}

function fitEff(kind) {
  const isRun = kind === 'ypc';
  const cand = P25.filter((r) => (isRun ? r.pos === 'RB' && r.carries >= 5 : ['WR', 'TE'].includes(r.pos) && r.targets >= 3));
  const L = isRun ? mean(P24.filter((r) => r.pos === 'RB' && r.carries > 0).map((r) => r.rushYds / r.carries)) : mean(P24.filter((r) => ['WR', 'TE'].includes(r.pos) && r.targets > 0).map((r) => r.recYds / r.targets));
  const opp = (r) => (isRun ? r.carries : r.targets), yds = (r) => (isRun ? r.rushYds : r.recYds);
  const grid = [];
  for (const k of [20, 40, 60, 100, 150, 250, 400]) {
    let se = 0, w = 0;
    for (const x of cand) {
      if (x.week < 2) continue;
      const p = P24.filter((y) => y.id === x.id); const o24 = p.reduce((s, y) => s + opp(y), 0), y24 = p.reduce((s, y) => s + yds(y), 0);
      const prior = (y24 + k * L) / (o24 + k);
      const c = P25.filter((y) => y.id === x.id && y.week < x.week); const oc = c.reduce((s, y) => s + opp(y), 0), yc = c.reduce((s, y) => s + yds(y), 0);
      const est = (yc + k * prior) / (oc + k);
      se += opp(x) * (est - yds(x) / opp(x)) ** 2; w += opp(x);
    }
    grid.push({ k, wrmse: Math.sqrt(se / w) });
  }
  grid.sort((a, b) => a.wrmse - b.wrmse);
  return { league: L, best: grid[0], grid };
}

const out = {
  fittedAt: new Date().toISOString(),
  fitSet: 'NFL 2025 regular season, weeks 2–18 (walk-forward: only 2024 + 2025 weeks < w). No 2026 data used.',
  team: { plays: fitTeam('plays'), att: fitTeam('att'), passYds: fitTeam('passYds'), rushYds: fitTeam('rushYds'), pf: fitTeam('pf'), carries: fitTeam('carries') },
  market: { passYds: fitMarket('passYds'), rushYds: fitMarket('rushYds'), plays: fitMarket('plays'), att: fitMarket('att') },
  qbYpa: fitQbYpa(),
  share: { target: fitShare('target'), carry: fitShare('carry') },
  eff: { ypc: fitEff('ypc'), ypt: fitEff('ypt') },
};
fs.writeFileSync(path.join(ROOT, 'src', 'fitted_v12.json'), JSON.stringify(out, null, 1));
const show = (x) => JSON.stringify(x);
for (const [k, v] of Object.entries(out.team)) console.log(`team ${k}: best ${show(v.best)} | v1.1 rmse ${v.v11Rmse.toFixed(2)} | league-only ${v.naiveLeagueRmse.toFixed(2)}`);
for (const [k, v] of Object.entries(out.market)) console.log(`market ${k}: ${v.perImpliedPoint.toFixed(2)} per implied pt (n ${v.n})`);
console.log('qb ypa', show(out.qbYpa.best), 'worst', show(out.qbYpa.worst), 'league', out.qbYpa.league.toFixed(2));
console.log('share target', show(out.share.target), 'carry', show(out.share.carry));
console.log('eff ypc', show(out.eff.ypc.best), 'ypt', show(out.eff.ypt.best));
