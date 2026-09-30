// Record immutable pregame snapshots for every not-yet-started game in a week.
// Usage: npm run snapshot -- --league nfl [--week 4]
import { snapshotSlate } from '../src/services.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const lg = arg('league', 'nfl');
const week = arg('week') ? Number(arg('week')) : undefined;
const out = await snapshotSlate(lg, week, (l) => console.log(l));
console.log(`done: ${out.filter((x) => x.ok && !x.duplicate).length} new runs, ${out.filter((x) => x.duplicate).length} unchanged, ${out.filter((x) => !x.ok).length} skipped`);
