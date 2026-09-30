// Pull final box scores for every snapshotted game that has finished.
// Usage: npm run settle
import { settle } from '../src/services.js';

// --all re-settles every game (stat corrections / parser fixes); changes go to actual_revisions.
const out = await settle((l) => console.log(l), { all: process.argv.includes('--all') });
console.log(`done: ${out.filter((x) => x.settled).length} settled, ${out.filter((x) => !x.settled).length} still pending`);
