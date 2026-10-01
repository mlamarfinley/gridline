// Markdown week tables for the game-by-game document. Usage: node scripts/doc_chunks.mjs <season> <fromWeek> <toWeek>
import fs from 'node:fs';
const [season, from, to] = process.argv.slice(2).map(Number);
const G = JSON.parse(fs.readFileSync(new URL('../data/doc_games_6.json', import.meta.url))).filter((g) => g.season === season && g.week >= from && g.week <= to);
const STAT = { pass_yds: 'Pass yds', rush_yds: 'Rush yds', rec_yds: 'Rec yds' };
const r0 = (x) => (x == null ? '' : String(Math.round(x)));
const sg = (x) => { if (x == null) return ''; const v = Math.round(x); return v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0'; };
let md = `## Weeks ${from}–${to}\n`;
for (let w = from; w <= to; w++) {
  const WG = G.filter((g) => g.week === w);
  if (!WG.length) continue;
  md += `\n### Week ${w}\n\n| Game | Player | Stat | Proj | Line | Actual | Proj miss | Line miss | Closer |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  for (const g of WG) {
    const score = g.score && g.score.away != null ? ` (${g.score.away}–${g.score.home})` : '';
    g.rows.forEach((r, i) => {
      const pm = r.actual != null ? r.proj - r.actual : null, lm = r.actual != null && r.line != null ? r.line - r.actual : null;
      const closer = pm == null || lm == null ? '' : Math.abs(pm) < Math.abs(lm) ? 'Model' : Math.abs(pm) > Math.abs(lm) ? 'Line' : 'Tie';
      md += `| ${i === 0 ? `**${g.away} @ ${g.home}**${score}` : ''} | ${r.player} (${r.team}) | ${STAT[r.stat]} | ${r0(r.proj)} | ${r.line ?? ''} | ${r.noStats ? 'No stats' : r0(r.actual)} | ${sg(pm)} | ${sg(lm)} | ${closer} |\n`;
    });
  }
}
process.stdout.write(md);
