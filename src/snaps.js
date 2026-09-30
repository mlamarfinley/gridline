// NFL offensive snap shares from nflverse (sourced from Pro-Football-Reference snap counts).
import { fetchCached } from './fetcher.js';
import { parseCsv } from './baselines.js';

// ESPN -> nflverse team abbreviations where they differ.
const TEAM_MAP = { WSH: 'WAS', LAR: 'LA' };
export const normName = (n) => String(n || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');

let mem = { season: null, byKey: null, meta: null };
export async function loadSnaps(season, prov) {
  if (mem.season === season && mem.byKey) { prov.add(mem.meta); return mem.byKey; }
  const r = await fetchCached(`https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${season}.csv`, { ttl: 6 * 3600, as: 'text', label: 'nflverse snap counts' });
  prov.add(r.meta);
  if (!r.data) return null;
  const byKey = new Map();
  for (const row of parseCsv(r.data)) {
    if (row.game_type && row.game_type !== 'REG' && row.game_type !== 'POST') continue;
    const k = `${row.team}|${normName(row.player)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ week: Number(row.week), opp: row.opponent, snaps: Number(row.offense_snaps || 0), pct: Number(row.offense_pct || 0) });
  }
  mem = { season, byKey, meta: r.meta };
  return byKey;
}
export function snapsFor(byKey, espnTeamAbbr, name) {
  if (!byKey) return null;
  const t = TEAM_MAP[espnTeamAbbr] || espnTeamAbbr;
  return (byKey.get(`${t}|${normName(name)}`) || []).sort((a, b) => a.week - b.week);
}
