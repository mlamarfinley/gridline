// Market-blind historical evaluation over ALL completed current-season games.
// Usage: npm run blind [-- --leagues nfl,cfb] [--seasons 2024,2025,2026] [--limit N] [--score-only BATCH]
// Stage order is enforced: freeze params -> predict every game (immutable + manifest) -> seal
// -> only then fetch actuals and historical lines -> report (data/blind_report_<batch>.json).
import { runBlindPredictions, scoreBlind, saveReport } from '../src/blind.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const log = (l) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${l}`);
let batch = arg('score-only') ? Number(arg('score-only')) : null;
if (!batch) batch = await runBlindPredictions({ leagues: String(arg('leagues', 'nfl,cfb')).split(','), seasons: arg('seasons') ? String(arg('seasons')).split(',').map(Number) : [null], limit: arg('limit') ? Number(arg('limit')) : Infinity, log });
await scoreBlind(batch, { log });
const { file, report } = saveReport(batch);
log(`report saved: ${file}`);
console.log(JSON.stringify({ batch, games: report.games, counts: report.counts, overall: report.overall, bySplit: report.bySplit, market: report.market, skipReasons: report.skipReasons }, null, 1));
