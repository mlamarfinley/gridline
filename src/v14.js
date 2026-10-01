// fbm-1.4.0 "learned from every miss" correction (NFL). Shared by the learner (scripts/learn_v14.mjs) and the live
// model (src/matchup.js) so both build EXACTLY the same pregame feature vector.
//   correction = β·standardize(x), x = frozen pregame inputs + recent-usage trend (strictly prior weeks).
//   Applied to the raw simulated sample: out = mean + correction + s·(sample − mean), floored at 0.
// Positions/stats without a learned correction fall back to the v1.3 calibration (src/calibrate.js).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { fetchCached } from './fetcher.js';
import { parseCsv } from './baselines.js';
import { normName } from './snaps.js';

export const FEATS = ['projection', 'range width', 'exp targets', 'exp carries', 'exp pass att', 'target share', 'carry share', 'yds/carry', 'catch rate', 'yds/catch', 'team plays', 'team pass att', 'exp margin', 'exp team pts', 'QB yds/att', 'week', 'role #1', 'role #2', 'small sample', 'role change', 'volume inputs present',
  'usage data present', 'last-game targets vs season', 'last-3 targets vs season', 'last-game carries vs season', 'last-3 carries vs season', 'last-3 opportunities vs season', 'last-game snap% vs season', 'last-3 snap% vs season'];

const num = (v) => (Number.isFinite(v) ? v : 0);
const has = (v) => (Number.isFinite(v) ? 1 : 0);

/** ctx has the same shape as blind_pred_context.context_json. usage = usageFeatures(...) (8 numbers). */
export function buildX({ proj, p10, p90, week, role, ctx: c = {}, usage }) {
  const notes = (c.notes || []).join(' ');
  const roleRank = /1$/.test(role || '') ? 1 : /2$/.test(role || '') ? 2 : /Starting/.test(role || '') ? 1 : 3;
  return [
    proj, Math.max(1, num(p90) - num(p10)),
    num(c.targets), num(c.carries), num(c.attempts), num(c.targetShare), num(c.carryShare),
    num(c.ypc), num(c.catchRate), num(c.ypCatch), num(c.teamPlays), num(c.teamAtt), num(c.expMargin), num(c.teamPts), num(c.qbYpa),
    week, roleRank === 1 ? 1 : 0, roleRank === 2 ? 1 : 0,
    /Small sample/.test(notes) ? 1 : 0, /Role change/.test(notes) ? 1 : 0, has(c.targets) + has(c.carries) + has(c.attempts),
    ...(usage || [0, 0, 0, 0, 0, 0, 0, 0]),
  ];
}

// ---------- recent usage trend from nflverse weekly player stats + snap counts ----------
const NV = 'https://github.com/nflverse/nflverse-data/releases/download';
const TEAM_MAP = { WSH: 'WAS', LAR: 'LA' };
const usageMem = new Map();
export async function loadUsage(season, prov = null) {
  if (usageMem.has(season)) return usageMem.get(season);
  const [ps, sn] = await Promise.all([
    fetchCached(`${NV}/stats_player/stats_player_week_${season}.csv`, { ttl: 6 * 3600, as: 'text', label: `nflverse ${season} player weekly (usage trend)` }),
    fetchCached(`${NV}/snap_counts/snap_counts_${season}.csv`, { ttl: 6 * 3600, as: 'text', label: `nflverse ${season} snap counts (usage trend)` }),
  ]);
  prov?.add?.(ps.meta); prov?.add?.(sn.meta);
  const snaps = new Map();
  for (const r of parseCsv(typeof sn.data === 'string' ? sn.data : '')) if (r.game_type === 'REG') snaps.set(`${r.team}|${normName(r.player)}|${r.week}`, Number(r.offense_pct || 0));
  const byName = new Map();
  for (const r of parseCsv(typeof ps.data === 'string' ? ps.data : '')) {
    if (r.season_type !== 'REG') continue;
    const k = normName(r.player_display_name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push({ week: Number(r.week), team: r.team, tgt: Number(r.targets || 0), car: Number(r.carries || 0), att: Number(r.attempts || 0), snap: snaps.get(`${r.team}|${k}|${r.week}`) ?? null });
  }
  usageMem.set(season, byName);
  return byName;
}

/** 8 usage-trend numbers from games STRICTLY before `week` for this player on this team. */
export function usageFeatures(byName, week, espnTeam, name) {
  if (!byName || week == null) return [0, 0, 0, 0, 0, 0, 0, 0];
  const team = TEAM_MAP[espnTeam] || espnTeam;
  const games = (byName.get(normName(name)) || []).filter((g) => g.week < week && g.team === team).sort((a, b) => a.week - b.week);
  if (!games.length) return [0, 0, 0, 0, 0, 0, 0, 0];
  const avg = (L, f) => L.reduce((s, g) => s + f(g), 0) / L.length;
  const last = games[games.length - 1], last3 = games.slice(-3);
  const vol = (g) => g.tgt + g.car + g.att;
  const sk = games.filter((g) => g.snap != null), sk3 = sk.slice(-3);
  return [
    1,
    last.tgt - avg(games, (g) => g.tgt), avg(last3, (g) => g.tgt) - avg(games, (g) => g.tgt),
    last.car - avg(games, (g) => g.car), avg(last3, (g) => g.car) - avg(games, (g) => g.car),
    avg(last3, vol) - avg(games, vol),
    sk.length ? sk[sk.length - 1].snap - avg(sk, (g) => g.snap) : 0,
    sk3.length ? avg(sk3, (g) => g.snap) - avg(sk, (g) => g.snap) : 0,
  ];
}

/**
 * Same 8 usage-trend numbers, built from the model's own prior-game box-score rows (already verified finished
 * before kickoff) plus optional snap shares [{week, pct}]. Used by the live/blind model so it never has to read a
 * file that contains the target game. Without snap data the snap deltas are 0 = "same as season", i.e. neutral.
 */
export function usageFromRows(rows, week, snapSeries = null) {
  const games = (rows || []).filter((x) => week == null || x.week == null || x.week < week).map((x) => ({
    week: x.week, tgt: x.stats?.targets || 0, car: x.stats?.carries || 0, att: x.stats?.pass_att || 0,
    snap: snapSeries?.find((s) => s.week === x.week)?.pct ?? null,
  }));
  if (!games.length) return [0, 0, 0, 0, 0, 0, 0, 0];
  const avg = (L, f) => L.reduce((s, g) => s + f(g), 0) / L.length;
  const last = games[games.length - 1], last3 = games.slice(-3);
  const vol = (g) => g.tgt + g.car + g.att;
  const sk = games.filter((g) => g.snap != null), sk3 = sk.slice(-3);
  return [
    1,
    last.tgt - avg(games, (g) => g.tgt), avg(last3, (g) => g.tgt) - avg(games, (g) => g.tgt),
    last.car - avg(games, (g) => g.car), avg(last3, (g) => g.car) - avg(games, (g) => g.car),
    avg(last3, vol) - avg(games, vol),
    sk.length ? sk[sk.length - 1].snap - avg(sk, (g) => g.snap) : 0,
    sk3.length ? avg(sk3, (g) => g.snap) - avg(sk, (g) => g.snap) : 0,
  ];
}

// ---------- fbm-1.5 matchup inputs (src/profiles.js): percentage effects, so each enters as projection × fit ----------
export const MATCHUP_FEATS = ['proj × zone fit', 'proj × position fit', 'proj × man/zone fit', 'proj × run-side fit', 'proj × explosive fit', 'proj × opp unit (rel)', 'proj × OL/DL-type edge'];
/** fit = playerFit(...) or null; oppUnit = relevant defensive unit rating (0–100, 50 avg); edge = offense−defense rating of the relevant head-to-head (0 avg). */
export function matchupX(proj, fit, oppUnit, edge) {
  const f = fit || {};
  return [proj * (f.zoneFit || 0), proj * (f.posFit || 0), proj * (f.covFit || 0), proj * (f.runFit || 0), proj * (f.explFit || 0),
    proj * (oppUnit != null ? (50 - oppUnit) / 100 : 0), proj * (edge != null ? edge / 100 : 0)];
}

export const predictCorr = (m, x) => m.beta[0] + x.reduce((s, v, j) => s + (m.sd[j] ? ((v - m.mu[j]) / m.sd[j]) * m.beta[j + 1] : 0), 0);

let V14 = null;
try { V14 = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'fitted_v14.json'), 'utf8')).byStat; } catch { V14 = null; }
export function v14For(lg, pos, stat, role = null) {
  if (lg !== 'nfl' || !V14) return null;
  const m = V14[`${pos}|${stat}`];
  if (!m?.beta) return null;
  // Only for roles it saw in training; anything else falls back to v1.3.
  if (m.domain?.roles && role != null && m.domain.roles[role] == null) return null;
  return m;
}

/** Apply the learned correction to a raw simulated sample. Returns {arr, correction}. */
export function applyV14(arr, m, x) {
  if (!m || !arr?.length) return { arr, correction: null };
  let mean = 0; for (const v of arr) mean += v; mean /= arr.length;
  // Outside the projection range it was trained on (e.g. a backup QB projected for 0 attempts): no correction.
  if (m.domain?.minProj != null && mean < 0.5 * m.domain.minProj) return { arr, correction: null };
  const corr = predictCorr(m, x);
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Math.max(0, mean + corr + m.s * (arr[i] - mean));
  return { arr: out, correction: corr };
}
