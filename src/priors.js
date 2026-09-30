// fbm-1.2.0 prior-season inputs (NFL only). Everything here is from the season BEFORE the one being
// predicted (nflverse weekly team + player stats), so it is always pre-kickoff information.
// Constants come from src/fitted_v12.json (fit on 2024 -> 2025 history; see scripts/fit_v12.js).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { fetchCached } from './fetcher.js';
import { parseCsv } from './baselines.js';
import { normName } from './snaps.js';
import * as espn from './espn.js';

export const FIT = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'fitted_v12.json'), 'utf8'));
const NV = 'https://github.com/nflverse/nflverse-data/releases/download';
export const TEAM_MAP = { WSH: 'WAS', LAR: 'LA' };
const nv = (abbr) => TEAM_MAP[abbr] || abbr;
const N = (x) => Number(x || 0);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

const mem = new Map();
export async function loadPriorSeason(season, prov) {
  if (mem.has(season)) return mem.get(season);
  // NOTE: deliberately NOT the nflverse schedules file — it also contains current-season results
  // and closing lines. Prior-season points come from ESPN prior-season team schedules instead.
  const [tr, pr] = await Promise.all([
    fetchCached(`${NV}/stats_team/stats_team_week_${season}.csv`, { ttl: 30 * 86400, as: 'text', label: `nflverse ${season} team weekly (prior season)` }),
    fetchCached(`${NV}/stats_player/stats_player_week_${season}.csv`, { ttl: 30 * 86400, as: 'text', label: `nflverse ${season} player weekly (prior season)` }),
  ]);
  for (const r of [tr, pr]) prov?.add(r.meta);
  if (!tr.data || !pr.data) { mem.set(season, null); return null; }
  const pts = new Map();
  const team = new Map(), allowed = new Map(), teamWeek = new Map();
  for (const r of parseCsv(tr.data)) {
    if (r.season_type !== 'REG') continue;
    const p = pts.get(`${r.week}|${r.team}`) || {};
    const row = { plays: N(r.attempts) + N(r.sacks_suffered) + N(r.carries), att: N(r.attempts), passYds: N(r.passing_yards), rushYds: N(r.rushing_yards), carries: N(r.carries), targets: N(r.targets), pf: p.pf, pa: p.pa };
    teamWeek.set(`${r.week}|${r.team}`, row);
    (team.get(r.team) || team.set(r.team, []).get(r.team)).push(row);
    (allowed.get(r.opponent_team) || allowed.set(r.opponent_team, []).get(r.opponent_team)).push(row);
  }
  const players = new Map(); // normName -> [{team, week, ...}]
  for (const r of parseCsv(pr.data)) {
    if (r.season_type !== 'REG') continue;
    const k = normName(r.player_display_name || r.player_name);
    (players.get(k) || players.set(k, []).get(k)).push({ team: r.team, week: N(r.week), pos: r.position, att: N(r.attempts), passYds: N(r.passing_yards), carries: N(r.carries), targets: N(r.targets) });
  }
  const avg = (rows, key) => mean(rows.map((x) => x[key]).filter((v) => v != null && !Number.isNaN(v)));
  const out = {
    season,
    team: (abbr, key) => avg(team.get(nv(abbr)) || [], key),
    allowed: (abbr, key) => avg(allowed.get(nv(abbr)) || [], key),
    qb: (name) => {
      const rows = (players.get(normName(name)) || []).filter((x) => x.att > 0);
      return { att: rows.reduce((s, x) => s + x.att, 0), yds: rows.reduce((s, x) => s + x.passYds, 0) };
    },
    share: (name, abbr) => {
      const rows = (players.get(normName(name)) || []).filter((x) => x.team === nv(abbr));
      const ts = [], cs = [];
      for (const x of rows) { const t = teamWeek.get(`${x.week}|${x.team}`); if (!t) continue; if (t.targets) ts.push(x.targets / t.targets); if (t.carries) cs.push(x.carries / t.carries); }
      return { games: rows.length, target: mean(ts), carry: mean(cs) };
    },
  };
  mem.set(season, out);
  return out;
}

/** Shrunk estimator used throughout v1.2: current-season mean pulled toward a (regressed) prior. */
export function blendTeam(key, curMean, n, priorMean, league) {
  const f = FIT.team[key]?.best;
  if (!f) return curMean ?? league;
  const pr = priorMean == null ? league : league + f.r * (priorMean - league);
  return ((n || 0) * (curMean ?? 0) + f.k * pr) / ((n || 0) + f.k);
}

/** Prior-season points for/against per game for one team (ESPN schedule of that earlier season). */
export async function priorPoints(teamId, season, prov) {
  const r = await espn.getSchedule('nfl', teamId, season);
  prov?.add(r.meta);
  const g = espn.parseSchedule(r.data).filter((x) => x.completed && x.seasonType === 2);
  const pf = [], pa = [];
  for (const x of g) {
    const me = x.competitors.find((c) => String(c.id) === String(teamId)), op = x.competitors.find((c) => String(c.id) !== String(teamId));
    if (me?.score == null || op?.score == null) continue;
    pf.push(Number(me.score)); pa.push(Number(op.score));
  }
  return { games: pf.length, pf: mean(pf), pa: mean(pa) };
}
