// Download the current Madden NFL ratings (public EA ratings site, 100 players per page) for a side-by-side comparison
// spreadsheet. COMPARISON ONLY — nothing in the model reads this file.
//   node --no-warnings scripts/madden_ratings.mjs   → reports/madden_ratings.json
import fs from 'node:fs';
const base = 'https://www.ea.com/games/madden-nfl/ratings';
const out = [];
let total = null, iteration = null;
for (let page = 1; page <= 40; page++) {
  const html = await (await fetch(`${base}?page=${page}`, { headers: { 'user-agent': 'Mozilla/5.0 (football-dashboard research; comparison only)' } })).text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  const rd = m ? JSON.parse(m[1])?.props?.pageProps?.ratingDetails : null;
  const items = rd?.items || [];
  total ??= rd?.totalItems ?? null;
  if (!items.length) break;
  for (const x of items) {
    iteration ??= x.iteration?.label || null;
    const st = x.stats || {}; const v = (k) => st[k]?.value ?? null;
    out.push({ name: `${x.firstName} ${x.lastName}`, team: x.team?.label || null, pos: x.position?.shortLabel || null, overall: x.overallRating,
      archetype: x.archetype?.label || null, age: x.age, yearsPro: x.yearsPro,
      speed: v('speed'), acceleration: v('acceleration'), awareness: v('awareness'), carrying: v('carrying'), bcVision: v('bCVision'), breakTackle: v('breakTackle'), elusiveness: v('elusiveness'), trucking: v('trucking'),
      catching: v('catching'), catchInTraffic: v('catchInTraffic'), spectacularCatch: v('spectacularCatch'), shortRouteRunning: v('shortRouteRunning'), mediumRouteRunning: v('mediumRouteRunning'), deepRouteRunning: v('deepRouteRunning'), release: v('release'),
      throwPower: v('throwPower'), throwAccuracyShort: v('throwAccuracyShort'), throwAccuracyMid: v('throwAccuracyMid'), throwAccuracyDeep: v('throwAccuracyDeep'), throwOnTheRun: v('throwOnTheRun'), throwUnderPressure: v('throwUnderPressure'), breakSack: v('breakSack'), playAction: v('playAction') });
  }
  process.stdout.write(`page ${page}: ${items.length} (${out.length}/${total})\n`);
  await new Promise((r) => setTimeout(r, 400));
}
fs.writeFileSync(new URL('../reports/madden_ratings.json', import.meta.url), JSON.stringify({ source: base, iteration, retrievedAt: new Date().toISOString(), total, players: out }, null, 1));
console.log(`saved ${out.length} players (${iteration})`);
