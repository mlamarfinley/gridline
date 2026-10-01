// Per-game comparison rows (QB pass yds, RB1 rush yds, Receiver 1 rec yds per team) from a sealed batch.
// Usage: node --no-warnings scripts/doc_games.mjs 6  -> data/doc_games_<batch>.json
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const batch = Number(process.argv[2] || 6);
const db = new DatabaseSync(new URL('../data/ledger.sqlite', import.meta.url).pathname, { readOnly: true });
const rows = db.prepare(`SELECT p.season, p.week, p.game_id, p.kickoff, p.team, p.player_name, p.role, p.stat, p.projection, s.actual, s.status, l.line, m.home, m.away
  FROM blind_predictions p JOIN blind_manifests m ON m.batch_id=p.batch_id AND m.game_id=p.game_id
  LEFT JOIN blind_scores s ON s.batch_id=p.batch_id AND s.game_id=p.game_id AND s.player_id=p.player_id AND s.stat=p.stat
  LEFT JOIN blind_lines l ON l.batch_id=p.batch_id AND l.game_id=p.game_id AND l.player_id=p.player_id AND l.stat=p.stat
  WHERE p.batch_id=? AND p.league='nfl' AND ((p.role='Starting QB' AND p.stat='pass_yds') OR (p.role='RB1' AND p.stat='rush_yds') OR (p.role='Receiver 1' AND p.stat='rec_yds'))
  ORDER BY p.kickoff, p.game_id`).all(batch);
const scores = new Map();
for (const r of db.prepare('SELECT game_id, context_json FROM blind_actual_context WHERE batch_id=? GROUP BY game_id').all(batch)) {
  const t = JSON.parse(r.context_json).teams || {}; scores.set(r.game_id, t);
}
const games = new Map();
for (const r of rows) {
  if (!games.has(r.game_id)) games.set(r.game_id, { season: r.season, week: r.week, id: r.game_id, kickoff: r.kickoff, away: r.away, home: r.home, rows: [] });
  games.get(r.game_id).rows.push({ team: r.team, player: r.player_name, stat: r.stat, proj: r.projection, line: r.line, actual: r.status === 'scored' ? r.actual : null, noStats: r.status === 'no_box_row' });
}
const order = { pass_yds: 0, rush_yds: 1, rec_yds: 2 };
for (const g of games.values()) {
  g.rows.sort((a, b) => (a.team === g.away ? 0 : 1) - (b.team === g.away ? 0 : 1) || order[a.stat] - order[b.stat]);
  const t = scores.get(g.id); g.score = t ? { away: t[g.away]?.pts, home: t[g.home]?.pts } : null;
}
fs.writeFileSync(new URL(`../data/doc_games_${batch}.json`, import.meta.url), JSON.stringify([...games.values()]));
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
for (const season of [2024, 2025, 2026]) {
  const R = [...games.values()].filter((g) => g.season === season).flatMap((g) => g.rows).filter((r) => r.actual != null);
  const L = R.filter((r) => r.line != null);
  const closer = L.filter((r) => Math.abs(r.proj - r.actual) < Math.abs(r.line - r.actual)).length, ties = L.filter((r) => Math.abs(r.proj - r.actual) === Math.abs(r.line - r.actual)).length;
  console.log(season, 'games', [...games.values()].filter((g) => g.season === season).length, 'rows', R.length, 'projMiss', mean(R.map((r) => Math.abs(r.proj - r.actual))).toFixed(1),
    '| with line', L.length, 'projMiss', mean(L.map((r) => Math.abs(r.proj - r.actual))).toFixed(1), 'lineMiss', mean(L.map((r) => Math.abs(r.line - r.actual))).toFixed(1), 'model closer', (100 * closer / L.length).toFixed(1) + '%', 'ties', ties,
    '| by stat', ['pass_yds', 'rush_yds', 'rec_yds'].map((st) => { const S = L.filter((r) => r.stat === st); return `${st} ${mean(S.map((r) => Math.abs(r.proj - r.actual))).toFixed(1)}/${mean(S.map((r) => Math.abs(r.line - r.actual))).toFixed(1)}`; }).join(' '));
}
