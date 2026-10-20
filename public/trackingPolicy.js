// Player-pick visibility/evaluation only. Keep all simulator stats and game-script inputs.
// Historical ledger rows remain immutable.
const CORE = {
 QB: ['pass_yds', 'completions', 'pass_att', 'pass_td'],
 RB: ['rush_yds', 'carries', 'rush_td', 'ypc', 'rec_yds', 'targets', 'receptions', 'rec_td', 'ypr', 'tds'],
 WR: ['rec_yds', 'targets', 'receptions', 'rec_td', 'ypr', 'tds'],
 TE: ['rec_yds', 'targets', 'receptions', 'rec_td', 'ypr', 'tds'],
 K: ['k_pts', 'xp_made', 'fg_made'],
};
export const trackedPlayerStat = (league, position, stat) => league !== 'nfl' || !!CORE[position]?.includes(stat);
export function applyTrackingScope(m) {
 if (m.league !== 'nfl') return m;
 for (const t of [m.home, m.away]) for (const c of t?.cards || []) {
  c.compact = c.compact.filter(k => trackedPlayerStat(m.league, c.pos, k));
  c.statOrder = c.statOrder.filter(k => trackedPlayerStat(m.league, c.pos, k));
 }
 return m;
}
