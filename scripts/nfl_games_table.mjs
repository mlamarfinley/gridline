// Game-by-game markdown table for a sealed NFL blind batch (read-only).
// Usage: node --no-warnings scripts/nfl_games_table.mjs 4 > table.md
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const batch = Number(process.argv[2] || 4);
const D = JSON.parse(fs.readFileSync(new URL(`../data/nfl_diagnosis_rows_${batch}.json`, import.meta.url)));
const M = JSON.parse(fs.readFileSync(new URL(`../data/nfl_misses_${batch}.json`, import.meta.url)));
const db = new DatabaseSync(new URL('../data/ledger.sqlite', import.meta.url).pathname, { readOnly: true });
const man = new Map(db.prepare("SELECT game_id, home, away FROM blind_manifests WHERE batch_id=? AND league='nfl'").all(batch).map((m) => [m.game_id, m]));
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const last = (n) => { const p = n.replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/, '').split(' '); return p[p.length - 1]; };
const lines = ['| Wk | Game (ID) | Final (model exp.) | QBs pass yds proj→act | RB1 rush yds | Top receiver rec yds | Yardage MAE | In range | Out-of-range misses (cause) |', '|---|---|---|---|---|---|---|---|---|'];
const games = [...new Set(D.teamRows.map((t) => t.game))].sort((a, b) => (D.teamRows.find((t) => t.game === a).week - D.teamRows.find((t) => t.game === b).week) || a.localeCompare(b));
const summary = [];
for (const g of games) {
  const mm = man.get(g); const ts = D.teamRows.filter((t) => t.game === g);
  const A = ts.find((t) => t.team === mm.away), H = ts.find((t) => t.team === mm.home);
  const rows = D.rows.filter((r) => r.game === g);
  const f = (team, role, stat, pick) => { let R = rows.filter((r) => r.team === team && role.test(r.role) && r.stat === stat); if (pick) R = R.sort((a, b) => (b.actual ?? -1) - (a.actual ?? -1)); const r = R[0]; return r ? `${last(r.player)} ${Math.round(r.proj)}→${r.actual ?? 'no stats'}` : '—'; };
  const yard = rows.filter((r) => ['pass_yds', 'rush_yds', 'rec_yds'].includes(r.stat) && r.actual != null);
  const inr = mean(yard.map((r) => (r.actual >= r.p10 && r.actual <= r.p90 ? 1 : 0)));
  const miss = M.misses.filter((m) => m.game === g).map((m) => `${last(m.player)} ${m.stat.replace('_yds', '')} (${m.cause.toLowerCase()})`);
  const mae = mean(yard.map((r) => Math.abs(r.proj - r.actual)));
  summary.push({ g, wk: A.week, matchup: `${mm.away} @ ${mm.home}`, mae });
  lines.push(`| ${A.week} | ${mm.away} @ ${mm.home} (${g}) | ${A.actPts}–${H.actPts} (${A.projPts.toFixed(0)}–${H.projPts.toFixed(0)}) | ${f(mm.away, /Starting QB/, 'pass_yds')}; ${f(mm.home, /Starting QB/, 'pass_yds')} | ${f(mm.away, /^RB1$/, 'rush_yds')}; ${f(mm.home, /^RB1$/, 'rush_yds')} | ${f(mm.away, /Receiver/, 'rec_yds', true)}; ${f(mm.home, /Receiver/, 'rec_yds', true)} | ${mae.toFixed(1)} | ${(inr * 100).toFixed(0)}% | ${miss.join('; ') || '—'} |`);
}
console.log(lines.join('\n'));
summary.sort((a, b) => a.mae - b.mae);
console.error('best', summary.slice(0, 3).map((s) => `${s.matchup} ${s.mae.toFixed(1)}`).join(' | '), '|| worst', summary.slice(-3).reverse().map((s) => `${s.matchup} ${s.mae.toFixed(1)}`).join(' | '));
