// LINE-BLIND CHECK: build every game twice — with player prop lines, and with them never fetched — and compare every
// projected number. Proves the projections come only from game context (spread/total) and player history.
//   node --no-warnings scripts/line_blind_check.mjs [nfl|cfb]
import fs from 'node:fs';
import { getSlate } from '../src/services.js';
import { buildMatchup } from '../src/matchup.js';
const lg = process.argv.find((a) => a === 'nfl' || a === 'cfb') || 'nfl';
const slate = await getSlate(lg, {});
const out = { league: lg, week: slate.week, checkedAt: new Date().toISOString(), games: [], stats: 0, differing: 0, maxAbsDiff: 0, withLines: 0 };
for (const g of slate.games) {
  let a, b;
  try { a = await buildMatchup(lg, g.id); b = await buildMatchup(lg, g.id, { noPlayerLines: true }); } catch (e) { out.games.push({ id: g.id, error: e.message }); continue; }
  const idx = new Map();
  for (const side of ['away', 'home']) for (const c of [...b[side].cards]) for (const [k, s] of Object.entries(c.stats)) idx.set(`${c.id}|${k}`, s);
  let n = 0, d = 0, mx = 0, wl = 0;
  for (const side of ['away', 'home']) for (const c of [...a[side].cards]) for (const [k, s] of Object.entries(c.stats)) {
    const t = idx.get(`${c.id}|${k}`); if (!t || s.proj == null) continue;
    n++; if (s.book?.line != null) wl++;
    const diff = Math.max(Math.abs((s.proj ?? 0) - (t.proj ?? 0)), Math.abs((s.p10 ?? 0) - (t.p10 ?? 0)), Math.abs((s.p90 ?? 0) - (t.p90 ?? 0)));
    if (diff > 1e-9) d++; mx = Math.max(mx, diff);
  }
  out.games.push({ id: g.id, matchup: `${a.away.abbr} @ ${a.home.abbr}`, stats: n, withLines: wl, differing: d, maxAbsDiff: mx, linesInBlindRun: b.away.cards.concat(b.home.cards).some((c) => Object.values(c.stats).some((s) => s.book)) });
  out.stats += n; out.differing += d; out.maxAbsDiff = Math.max(out.maxAbsDiff, mx); out.withLines += wl;
  console.log(`${a.away.abbr} @ ${a.home.abbr}: ${n} projected stats (${wl} have a book line) — ${d} differ, max diff ${mx}`);
}
console.log(`\nTOTAL: ${out.stats} projected stats compared, ${out.withLines} with book lines; ${out.differing} differ (max abs diff ${out.maxAbsDiff}).`);
fs.mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL(`../reports/line_blind_check_${lg}.json`, import.meta.url), JSON.stringify(out, null, 1));
