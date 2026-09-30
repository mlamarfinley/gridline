import fs from 'node:fs';
const D = JSON.parse(fs.readFileSync(new URL('../data/nfl_diagnosis_rows_3.json', import.meta.url)));
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const c = (x, y) => { const mx = mean(x), my = mean(y); let n = 0, p = 0, q = 0; for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); p += (x[i] - mx) ** 2; q += (y[i] - my) ** 2; } return n / Math.sqrt(p * q); };
// availability outliers, per player-game
const key = (r) => `${r.game}|${r.id}`;
const byPG = new Map();
for (const r of D.rows) { const k = key(r); if (!byPG.has(k)) byPG.set(k, r); }
const outlier = new Set();
let nNoRow = 0, nExit = 0;
for (const [k, r] of byPG) {
  if (r.noRow) { outlier.add(k); nNoRow++; continue; }
  if (r.pos === 'QB' && r.projAtt > 15 && r.actAtt <= 10) { outlier.add(k); nExit++; continue; }
  const projW = (r.projCar || 0) + (r.projTgt || 0), actW = (r.actCar || 0) + (r.actTgt ?? r.actRec ?? 0);
  if (r.pos !== 'QB' && r.pos !== 'K' && r.pos !== 'PK' && projW >= 4 && actW < 0.25 * projW) { outlier.add(k); nExit++; }
}
const clean = D.rows.filter((r) => r.actual != null && !outlier.has(key(r)));
console.log('player-games', byPG.size, 'no box row', nNoRow, 'in-game exit/benched (heuristic)', nExit);
const mae = (a, f) => mean(a.map((r) => Math.abs(f(r) - r.actual)));
for (const [pos, st] of [['QB', 'pass_yds'], ['QB', 'pass_att'], ['QB', 'rush_yds'], ['RB', 'rush_yds'], ['RB', 'carries'], ['RB', 'rec_yds'], ['WR', 'rec_yds'], ['WR', 'targets'], ['WR', 'receptions'], ['TE', 'rec_yds']]) {
  const a = clean.filter((r) => r.pos === pos && r.stat === st);
  const l = a.filter((r) => r.openLine != null);
  const cov = mean(a.map((r) => (r.actual >= r.p10 && r.actual <= r.p90 ? 1 : 0)));
  console.log(`${pos} ${st}: n=${a.length} MAE ${mae(a, (r) => r.proj).toFixed(2)} bias ${mean(a.map((r) => r.proj - r.actual)).toFixed(2)} corr ${c(a.map((r) => r.proj), a.map((r) => r.actual)).toFixed(2)} cov ${cov.toFixed(2)} | lines n=${l.length}: model ${l.length ? mae(l, (r) => r.proj).toFixed(2) : '—'} vs open ${l.length ? mae(l, (r) => r.openLine).toFixed(2) : '—'} corr(line) ${l.length > 5 ? c(l.map((r) => r.openLine), l.map((r) => r.actual)).toFixed(2) : '—'}`);
}
// team-level on clean QBs: attempts driven by script?
const T = D.teamRows;
const qbs = clean.filter((r) => r.pos === 'QB' && r.stat === 'pass_att');
const tm = new Map(T.map((t) => [`${t.game}|${t.team}`, t]));
const x = [], y = [], z = [];
for (const r of qbs) { const t = tm.get(`${r.game}|${r.team}`); if (!t) continue; x.push(r.actual - r.proj); y.push(-t.actMargin); z.push(t.actPlays - t.projPlays); }
console.log('QB attempts error vs actual trailing margin corr', c(x, y).toFixed(2), '| vs team plays error corr', c(x, z).toFixed(2), 'n', x.length);
// how much of team margin was predictable by the book spread? (use market-informed backtest rows' expMargin from ledger)
