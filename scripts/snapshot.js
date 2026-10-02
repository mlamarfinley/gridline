// Record immutable pregame snapshots for every not-yet-started game in a week.
// Usage: npm run snapshot -- --league nfl [--week 4]
import { snapshotSlate, getSlate } from '../src/services.js';
import { refreshPlayerRatings } from '../src/playerRating.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const lg = arg('league', 'nfl');
const week = arg('week') ? Number(arg('week')) : undefined;
// NFL: refresh the derived Player Ratings (Madden + Production Monitor) for this week first, so the projections and the
// public site use the same ratings. Needs the local Madden file; without it the committed file is kept.
if (lg === 'nfl') { const sl = await getSlate('nfl', week ? { week } : {}); const r = await refreshPlayerRatings(sl.season, sl.week).catch(() => null); console.log(r ? `player ratings refreshed for ${sl.season} week ${sl.week} (${Object.keys(r.players).length} players)` : 'player ratings: local Madden data unavailable — kept the committed file'); }
const out = await snapshotSlate(lg, week, (l) => console.log(l));
console.log(`done: ${out.filter((x) => x.ok && !x.duplicate).length} new runs, ${out.filter((x) => x.duplicate).length} unchanged, ${out.filter((x) => !x.ok).length} skipped`);
