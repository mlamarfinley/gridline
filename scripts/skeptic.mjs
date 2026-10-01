// Run the SKEPTIC over a whole slate and print every finding.
//   node --no-warnings scripts/skeptic.mjs [nfl|cfb] [week]        (default: nfl, current week)
//   add --all to include informational notes.
import { getSlate } from '../src/services.js';
import { buildMatchup } from '../src/matchup.js';

const args = process.argv.slice(2);
const lg = args.find((a) => a === 'nfl' || a === 'cfb') || 'nfl';
const week = args.find((a) => /^\d+$/.test(a));
const all = args.includes('--all');
const slate = await getSlate(lg, week ? { week: Number(week) } : {});
const tally = { high: 0, medium: 0, info: 0 };
for (const g of slate.games || []) {
  let m;
  try { m = await buildMatchup(lg, g.id); } catch (e) { console.log(`${g.id}: could not build (${e.message})`); continue; }
  const k = m.skeptic;
  if (!k) continue;
  for (const s of Object.keys(tally)) tally[s] += k.counts[s];
  const shown = k.findings.filter((f) => all || f.severity !== 'info');
  console.log(`\n${m.away.abbr} @ ${m.home.abbr}  —  ${k.counts.high} high · ${k.counts.medium} medium · ${k.counts.info} info${shown.length ? '' : '  (clean)'}`);
  for (const f of shown) console.log(`  [${f.severity}] ${f.message}`);
}
console.log(`\nSlate total: ${tally.high} high · ${tally.medium} medium · ${tally.info} info`);
if (tally.high) process.exitCode = 1; // non-zero exit when a likely logic error exists (usable in CI)
