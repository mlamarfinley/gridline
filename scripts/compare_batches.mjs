// Compare two sealed blind batches on identical NFL player-stat rows (read-only).
// Usage: node --no-warnings scripts/compare_batches.mjs 3 4
import { DatabaseSync } from 'node:sqlite';
const [A, B] = process.argv.slice(2).map(Number);
const db = new DatabaseSync(new URL('../data/ledger.sqlite', import.meta.url).pathname, { readOnly: true });
const rows = db.prepare(`SELECT a.game_id, a.week, a.player_id, a.player_name, a.position pos, a.stat, a.projection pa, a.p10 a10, a.p90 a90, b.projection pb, b.p10 b10, b.p90 b90, s.actual, s.status, l.open_line
  FROM blind_predictions a JOIN blind_predictions b ON b.batch_id=? AND b.game_id=a.game_id AND b.player_id=a.player_id AND b.stat=a.stat
  JOIN blind_scores s ON s.batch_id=a.batch_id AND s.game_id=a.game_id AND s.player_id=a.player_id AND s.stat=a.stat
  LEFT JOIN blind_lines l ON l.batch_id=a.batch_id AND l.game_id=a.game_id AND l.player_id=a.player_id AND l.stat=a.stat
  WHERE a.batch_id=? AND a.league='nfl' AND s.status='scored'`).all(B, A);
const mean = (x) => x.reduce((s, v) => s + v, 0) / (x.length || 1);
const corr = (x, y) => { const mx = mean(x), my = mean(y); let n = 0, p = 0, q = 0; for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); p += (x[i] - mx) ** 2; q += (y[i] - my) ** 2; } return n / Math.sqrt(p * q); };
const out = [];
for (const [pos, st] of [['QB', 'pass_yds'], ['QB', 'pass_att'], ['QB', 'completions'], ['QB', 'rush_yds'], ['RB', 'rush_yds'], ['RB', 'carries'], ['RB', 'rec_yds'], ['WR', 'rec_yds'], ['WR', 'receptions'], ['WR', 'targets'], ['TE', 'rec_yds'], ['PK', 'k_pts']]) {
  const r = rows.filter((x) => x.pos === pos && x.stat === st);
  if (!r.length) continue;
  const l = r.filter((x) => x.open_line != null);
  const cov = (lo, hi) => mean(r.map((x) => (x.actual >= x[lo] && x.actual <= x[hi] ? 1 : 0)));
  out.push({ stat: `${pos} ${st}`, n: r.length,
    maeA: mean(r.map((x) => Math.abs(x.pa - x.actual))), maeB: mean(r.map((x) => Math.abs(x.pb - x.actual))),
    corrA: corr(r.map((x) => x.pa), r.map((x) => x.actual)), corrB: corr(r.map((x) => x.pb), r.map((x) => x.actual)),
    biasA: mean(r.map((x) => x.pa - x.actual)), biasB: mean(r.map((x) => x.pb - x.actual)),
    covA: cov('a10', 'a90'), covB: cov('b10', 'b90'),
    nLine: l.length, lineMae: l.length ? mean(l.map((x) => Math.abs(x.open_line - x.actual))) : null, maeBline: l.length ? mean(l.map((x) => Math.abs(x.pb - x.actual))) : null });
}
// beta of (actual-line) on (model-line), pooled yardage+counts
const beta = (key) => { const l = rows.filter((x) => x.open_line != null); const X = l.map((x) => x[key] - x.open_line), Y = l.map((x) => x.actual - x.open_line); const sxx = X.reduce((s, v) => s + v * v, 0), sxy = X.reduce((s, v, i) => s + v * Y[i], 0); const b = sxy / sxx; const res = Y.map((v, i) => v - b * X[i]); const se = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / (l.length - 1) / sxx); return { n: l.length, beta: b, se, t: b / se }; };
console.log(JSON.stringify({ A, B, rowsCompared: rows.length, byStat: out, betaA: beta('pa'), betaB: beta('pb') }, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
