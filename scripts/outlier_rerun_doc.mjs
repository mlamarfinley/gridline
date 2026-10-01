// Markdown chunks (≤ ~28 KB each) of the per-game outlier rerun, for the report doc.
//   node scripts/outlier_rerun_doc.mjs <season> <outDir>
import fs from 'node:fs';
const [season, outDir] = [Number(process.argv[2]), process.argv[3]];
const all = JSON.parse(fs.readFileSync(new URL('../reports/outlier_rerun_2024_2026.json', import.meta.url), 'utf8')).filter((g) => g.season === season);
const LABEL = { pass_yds: 'pass yds', rush_yds: 'rush yds', rec_yds: 'rec yds', receptions: 'receptions', carries: 'carries', completions: 'completions' };
const VOL = { pass_yds: 'pass att', completions: 'pass att', rush_yds: 'carries', carries: 'carries', rec_yds: 'targets', receptions: 'targets' };
const pct = (x) => `${Math.round(x * 100)}%`;
const f1 = (x) => (x == null ? '—' : Math.round(x * 10) / 10);
const esc = (s) => String(s).replace(/\|/g, '/');
const rows = [];
for (const g of all) {
  if (!g.pick) { rows.push({ week: g.week, line: `| ${g.week} | ${g.teams} | No real outlier${g.strongest ? ` (strongest: ${esc(g.strongest.name)} ${LABEL[g.strongest.stat]} ${g.strongest.dir} ${g.strongest.line}, ${g.strongest.lift}× typical)` : ''} |  |  |  |  |  |  |` }); continue; }
  const p = g.pick;
  const res = `${p.won ? 'Won' : 'Lost'}${p.bigOurWay ? ' — big miss our way' : p.bigAgainst ? ' — big miss the other way' : ''}`;
  const why = [
    p.drivers.length ? `Signals: ${p.drivers.join(', ')}` : null,
    p.recent?.length ? `Recent: ${p.recent.map(f1).join(', ')}` : null,
    p.expVol != null ? `Exp. ${VOL[p.stat]} ${f1(p.expVol)}${p.actVol != null ? ` (got ${p.actVol})` : ''}` : null,
    p.fitReasons?.[0] ? `Matchup: ${p.fitReasons[0]}` : null,
  ].filter(Boolean).map(esc).join('. ');
  rows.push({ week: g.week, line: `| ${g.week} | ${g.teams} | **${esc(p.name)}** (${p.team} ${p.pos}) ${LABEL[p.stat]} **${p.dir} ${p.line}** | ${f1(p.proj)} | ${f1(p.actual)} | ${res} | ${pct(p.ourP)} / ${pct(p.othP)} / ${pct(p.base)} | ±${f1(p.threshold)} | ${why} |` });
}
const HEAD = '| Wk | Game | Pick | Model | Actual | Result | Big-miss odds: ours / other way / typical | Big-miss size | Why |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
let chunk = [], size = 0, n = 0, firstWeek = null;
const flush = (lastWeek) => { if (!chunk.length) return; n++; fs.writeFileSync(`${outDir}/${season}_${n}.md`, `### Weeks ${firstWeek}–${lastWeek}\n\n${HEAD}${chunk.join('\n')}\n`); console.log(`${season}_${n}.md weeks ${firstWeek}-${lastWeek} ${size} bytes`); chunk = []; size = 0; firstWeek = null; };
let prevWeek = null;
for (const r of rows) {
  if (size + Buffer.byteLength(r.line) > 27000 && r.week !== prevWeek) flush(prevWeek);
  if (firstWeek == null) firstWeek = r.week;
  chunk.push(r.line); size += Buffer.byteLength(r.line) + 1; prevWeek = r.week;
}
flush(prevWeek);
