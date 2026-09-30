// Rebuild COMPLETED games with a strict kickoff data cutoff and store them as kind='backtest'
// (kept separate from true pregame snapshots in every ledger view), then settle.
// Usage: npm run backtest -- --league nfl --week 3 [--limit 5]
import { backtestWeek, settle } from '../src/services.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const lg = arg('league', 'nfl');
const weeks = String(arg('week', '')).split(',').filter(Boolean).map(Number);
if (!weeks.length) { console.error('--week required (e.g. --week 2,3)'); process.exit(1); }
for (const w of weeks) {
  console.log(`== ${lg} week ${w}`);
  await backtestWeek(lg, w, (l) => console.log('  ' + l), { limit: arg('limit') ? Number(arg('limit')) : 999 });
}
await settle((l) => console.log('  settle ' + l));
