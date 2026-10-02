// Madden 25 (2024 season) weekly rating releases, for testing how well Madden predicts on-field production.
// COMPARISON / RESEARCH ONLY — kept local (gitignored). → reports/madden25_iterations.json
import fs from 'node:fs';
const ITER = { 4: '5-week-4', 7: '8-week-7', 10: '11-week-10', 13: '14-week-13' };
const out = {};
for (const [week, it] of Object.entries(ITER)) {
  const rows = [];
  for (let off = 0; off < 3000; off += 100) {
    const d = await (await fetch(`https://drop-api.ea.com/rating/madden-nfl?limit=100&offset=${off}&iteration=${it}`, { headers: { 'user-agent': 'Mozilla/5.0 (research; comparison only)' } })).json();
    const items = d.items || []; if (!items.length) break;
    for (const x of items) rows.push({ name: `${x.firstName} ${x.lastName}`, overall: x.overallRating, archetype: x.archetype?.label || null, speed: x.stats?.speed?.value ?? null });
    await new Promise((r) => setTimeout(r, 250));
  }
  out[week] = rows; console.log(`week ${week} (${it}): ${rows.length} players`);
}
fs.writeFileSync(new URL('../reports/madden25_iterations.json', import.meta.url), JSON.stringify(out));
