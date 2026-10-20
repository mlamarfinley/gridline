// Active pick scope. Historical ledger rows remain immutable.
const QB_RUSH = new Set(['carries', 'rush_yds', 'rush_td', 'long_rush', 'ypc']);
export const trackedPlayerStat = (league, position, stat) => !(league === 'nfl' && position === 'QB' && QB_RUSH.has(stat));
export function applyTrackingScope(m) {
 if (m.league !== 'nfl') return m;
 for (const t of [m.home, m.away]) for (const c of t?.cards || []) {
  c.compact = c.compact.filter(k => trackedPlayerStat(m.league, c.pos, k));
  c.statOrder = c.statOrder.filter(k => trackedPlayerStat(m.league, c.pos, k));
 }
 return m;
}
