import { fetchCached } from './fetcher.js';

// SITUATIONAL MULTIPLIER MODEL (fbm-1.5): how a player's output changes with the game situation, learned from
// 2022–25 nflverse games and applied as PERCENTAGES to each player's own baseline — never as fixed numbers.
//
//   expected stat = baseline × exp(β · x)          (Poisson regression with log(baseline) as an offset)
//
// baseline = his average this season (games before this one), padded with last season's average early on.
// x (all known before kickoff):
//   favPts   — points favored (0 if underdog) / 7
//   dogPts   — points underdog (0 if favored) / 7
//   blowFav  — points favored beyond 7 / 7      (a likely blowout, where backups take late work)
//   blowDog  — points underdog beyond 7 / 7
//   teamTot  — (implied team points − 22.5) / 7  (more scoring → more plays / red-zone work)
//   oppAllow — log of what this defense allows in this stat to this position per game vs league (shrunk)
//   home, wind15 (outdoors, 15+ mph), cold (outdoors, ≤ 32°F)
// exp(β_k) is "×1.06 per 7 points favored" etc. — the multipliers are shown on the cards.

export const FEATS = ['favPts', 'dogPts', 'blowFav', 'blowDog', 'teamTot', 'oppAllow', 'home', 'wind15', 'cold'];
export const LABEL = {
  favPts: 'per 7 pts favored', dogPts: 'per 7 pts underdog', blowFav: 'per 7 pts favored beyond 7 (blowout)', blowDog: 'per 7 pts underdog beyond 7',
  teamTot: 'per 7 more implied team points', oppAllow: 'per 1× (log) more allowed by this defense', home: 'home', wind15: 'wind 15+ mph', cold: '32°F or colder',
};

/** Feature vector from pregame facts. spread = team expected margin (+ favored). */
export function situationX({ spread = 0, impliedPts = 22.5, oppAllowLog = 0, home = 0, wind = null, temp = null, outdoors = true }) {
  const s = Number.isFinite(spread) ? spread : 0;
  return [Math.max(s, 0) / 7, Math.max(-s, 0) / 7, Math.max(s - 7, 0) / 7, Math.max(-s - 7, 0) / 7, ((impliedPts ?? 22.5) - 22.5) / 7,
    oppAllowLog || 0, home ? 1 : 0, outdoors && wind != null && wind >= 15 ? 1 : 0, outdoors && temp != null && temp <= 32 ? 1 : 0];
}

/** Multiplier and its per-factor breakdown. m = fitted model {beta:[...]} for this pos|stat. */
export function situationMultiplier(m, x) {
  if (!m?.beta) return { mult: 1, parts: [] };
  let eta = m.beta[0];
  const parts = [];
  FEATS.forEach((f, i) => { const c = m.beta[i + 1] * x[i]; eta += c; if (Math.abs(c) >= 0.005) parts.push({ feat: f, mult: Math.exp(c) }); });
  return { mult: Math.exp(eta), base: Math.exp(m.beta[0]), parts };
}

/** Shrunk opponent allowance (per game, this stat, this position) relative to league, as a log ratio. */
export function oppAllowLog(allowedPerGame, games, leaguePerGame, k = 4) {
  if (!(leaguePerGame > 0)) return 0;
  const g = games || 0;
  const v = (g * (allowedPerGame ?? leaguePerGame) + k * leaguePerGame) / (g + k);
  return Math.log(Math.max(1e-6, v) / leaguePerGame);
}

/** Player baseline: this season's average, padded with K games of last season's average (if any). */
export function baselineOf(curVals, prevMean, K = 2) {
  const n = curVals.length, sum = curVals.reduce((a, b) => a + b, 0);
  if (prevMean == null) return n ? sum / n : null;
  return (sum + K * prevMean) / (n + K);
}

// position|stat → [nflverse weekly column, minimum baseline to use the model]
export const STAT_COL = {
  'RB|carries': ['carries', 4], 'RB|rush_yds': ['rushing_yards', 15], 'RB|targets': ['targets', 1.5], 'RB|receptions': ['receptions', 1], 'RB|rec_yds': ['receiving_yards', 8],
  'WR|targets': ['targets', 3], 'WR|receptions': ['receptions', 2], 'WR|rec_yds': ['receiving_yards', 20],
  'TE|targets': ['targets', 2], 'TE|receptions': ['receptions', 1.5], 'TE|rec_yds': ['receiving_yards', 12],
  'QB|pass_att': ['attempts', 20], 'QB|pass_yds': ['passing_yards', 150], 'QB|completions': ['completions', 12], 'QB|rush_yds': ['rushing_yards', 5], 'QB|carries': ['carries', 2],
};
const COLS = [...new Set(Object.values(STAT_COL).map((m) => m[0]))];
export const posGroup = (p) => (p === 'FB' ? 'RB' : ['QB', 'RB', 'WR', 'TE'].includes(p) ? p : null);

/**
 * Season-to-date state before `week`, built exactly as in training (scripts/learn_situational.mjs):
 * player values this season, last season's per-game means (4+ games), what each defense allowed per position,
 * league totals per team-game. curRows/prevRows = parsed nflverse weekly rows (regular season).
 */
export function seasonState(curRows, prevRows, week) {
  const hist = new Map(), prevMean = new Map(), allowed = new Map(), defGames = new Map(), lg = new Map(), prevAllowed = new Map(), prevLg = new Map();
  const acc = new Map();
  for (const r of prevRows) {
    const p = posGroup(r.position);
    for (const col of COLS) {
      const v = +r[col] || 0;
      const k = `${r.player_id}|${col}`; const a = acc.get(k) || acc.set(k, [0, 0]).get(k); a[0] += v; a[1]++;
      if (p) { prevAllowed.set(`${r.opponent_team}|${p}|${col}`, (prevAllowed.get(`${r.opponent_team}|${p}|${col}`) || 0) + v); prevLg.set(`${p}|${col}`, (prevLg.get(`${p}|${col}`) || 0) + v); }
    }
  }
  for (const [k, [s, n]] of acc) if (n >= 4) prevMean.set(k, s / n);
  const before = curRows.filter((r) => +r.week < week);
  for (const r of before) {
    const p = posGroup(r.position);
    (defGames.get(r.opponent_team) || defGames.set(r.opponent_team, new Set()).get(r.opponent_team)).add(r.game_id);
    for (const col of COLS) {
      const v = +r[col] || 0;
      const hk = `${r.player_id}|${col}`; (hist.get(hk) || hist.set(hk, []).get(hk)).push(v);
      if (p) { allowed.set(`${r.opponent_team}|${p}|${col}`, (allowed.get(`${r.opponent_team}|${p}|${col}`) || 0) + v); lg.set(`${p}|${col}`, (lg.get(`${p}|${col}`) || 0) + v); }
    }
  }
  return { hist, prevMean, allowed, defGames, lg, prevAllowed, prevLg, teamGames: new Set(before.map((r) => `${r.game_id}|${r.opponent_team}`)).size, prevTeamGames: new Set(prevRows.map((r) => `${r.game_id}|${r.opponent_team}`)).size };
}

/** Baseline and situation features for one player-stat (team/opp in nflverse abbreviations). null if no model input. */
export function situationInput(st, { key, playerId, opp, spread, impliedPts, home, wind, temp, outdoors }) {
  const [col, minBase] = STAT_COL[key] || [];
  if (!col) return null;
  const p = key.split('|')[0];
  const h = st.hist.get(`${playerId}|${col}`) || [];
  if (h.length < 2) return null;
  const base = baselineOf(h, st.prevMean.get(`${playerId}|${col}`) ?? null);
  if (!(base >= minBase)) return null;
  const dg = st.defGames.get(opp)?.size || 0;
  const lgCur = st.lg.get(`${p}|${col}`);
  const lgPer = lgCur && st.teamGames ? lgCur / st.teamGames : (st.prevLg.get(`${p}|${col}`) || 0) / Math.max(1, st.prevTeamGames);
  const prevPer = (st.prevAllowed.get(`${opp}|${p}|${col}`) || 0) / 17;
  const allowPer = ((st.allowed.get(`${opp}|${p}|${col}`) || 0) + 3 * prevPer) / (dg + 3);
  const oal = oppAllowLog(allowPer, dg + 3, lgPer, 4);
  return { base, games: h.length, oppAllowPer: allowPer, leaguePer: lgPer, x: situationX({ spread, impliedPts, oppAllowLog: oal, home, wind, temp, outdoors }) };
}

const csvRows = (t) => { const L = t.trim().split('\n'); const H = L[0].split(','); return L.slice(1).map((l) => { const v = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { v.push(cur); cur = ''; } else cur += ch; } v.push(cur); return Object.fromEntries(H.map((h, i) => [h, v[i]])); }); };
/** nflverse weekly player rows (regular season) for a season. */
export async function loadWeekly(season) {
  const r = await fetchCached(`https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`, { ttl: 6 * 3600, as: 'text', label: `nflverse ${season} weekly (situational model)` });
  return csvRows(r.data).filter((x) => x.season_type === 'REG');
}
