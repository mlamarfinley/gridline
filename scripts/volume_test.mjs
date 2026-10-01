// Does context-aware volume beat the current model? Every 2024–26 team-game in the blind backtest.
//   node --no-warnings scripts/volume_test.mjs [--write]
// Old: the model's frozen pregame team plays / pass attempts (blind_pred_context).
// New: pass rate by score state = league + a·offPROE(team) + b·defPROE(opp) (src/volume.js), weighted by the
//      spread's game-script states; plays = model plays adjusted for BOTH teams' expected run share (runs drain
//      clock → the run-heavier side holds the ball longer) and the spread. a, b, c fitted on one season, tested on another.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildVolume, passRatesFor, STATES } from '../src/volume.js';
import { scenarioWeights } from '../src/model.js';

const NVT = { WSH: 'WAS', LAR: 'LA' }, nv = (a) => NVT[a] || a;
const db = new DatabaseSync(new URL('../data/ledger.sqlite', import.meta.url).pathname, { readOnly: true });
const raw = db.prepare(`SELECT DISTINCT p.season, p.week, p.game_id, p.team, p.opponent, c.context_json pc, a.context_json ac
  FROM blind_predictions p JOIN blind_pred_context c ON c.batch_id=p.batch_id AND c.game_id=p.game_id AND c.player_id=p.player_id
  LEFT JOIN blind_actual_context a ON a.batch_id=p.batch_id AND a.game_id=p.game_id AND a.player_id=p.player_id
  WHERE p.batch_id = 6 AND p.league = 'nfl'`).all();
const tg = new Map();
for (const r of raw) {
  const k = `${r.game_id}|${r.team}`; if (tg.has(k)) { const g = tg.get(k); if (g.act == null && r.ac) { const t = JSON.parse(r.ac).team; if (t) g.act = t; } continue; }
  const pc = JSON.parse(r.pc), ac = r.ac ? JSON.parse(r.ac).team : null;
  if (!pc.teamPlays || !pc.teamAtt) continue;
  tg.set(k, { season: r.season, week: r.week, game: r.game_id, team: r.team, opp: r.opponent, plays: pc.teamPlays, att: pc.teamAtt, margin: pc.expMargin ?? 0, act: ac });
}
const G = [...tg.values()].filter((g) => g.act && g.act.rushes != null && g.act.passAtt != null && g.week >= 3);
for (const g of G) {
  const vol = await buildVolume(g.season, g.week);
  const w = scenarioWeights(g.margin, 'nfl'), wo = scenarioWeights(-g.margin, 'nfl');
  const pr = passRatesFor(vol, nv(g.team), nv(g.opp)), po = passRatesFor(vol, nv(g.opp), nv(g.team));
  g.lgShare = STATES.reduce((s, x) => s + w[x] * vol.leagueState[x], 0);
  g.offP = vol.teams[nv(g.team)]?.offPROE || 0; g.defP = vol.teams[nv(g.opp)]?.defPROE || 0;
  g.passShare1 = STATES.reduce((s, x) => s + w[x] * pr[x], 0);       // a=b=1
  g.oppPassShare = STATES.reduce((s, x) => s + wo[x] * po[x], 0);
  g.actPlays = g.act.rushes + g.act.passAtt;
}
const mae = (L, f) => L.reduce((s, x) => s + Math.abs(f(x)), 0) / L.length;
function fit(train) {
  // grid for a, b (pass-rate offsets), then least squares for the plays adjustment and the attempt/rush split.
  let best = null;
  for (const a of [0, 0.25, 0.5, 0.75, 1, 1.25]) for (const b of [0, 0.25, 0.5, 0.75, 1]) {
    // pass share of (rushes + attempts): calibrate intercept k so mean matches training
    const share = (x) => x.lgShare + a * x.offP + b * x.defP;
    const k = train.reduce((s, x) => s + x.act.passAtt / x.actPlays - share(x), 0) / train.length;
    const e = mae(train, (x) => (share(x) + k) * x.actPlays - x.act.passAtt);
    if (!best || e < best.e) best = { a, b, k, e };
  }
  // plays: actual ≈ c0·modelPlays + c1·(ownRunShare − 0.43) + c2·(oppRunShare − 0.43) + c3·margin  (OLS)
  const X = train.map((x) => { const own = 1 - (x.lgShare + best.a * x.offP + best.b * x.defP + best.k), opp = 1 - x.oppPassShare; return [x.plays, own - 0.43, opp - 0.43, x.margin]; });
  const y = train.map((x) => x.actPlays);
  const n = X[0].length, A = Array.from({ length: n }, () => Array(n).fill(0)), v = Array(n).fill(0);
  X.forEach((r, i) => { for (let j = 0; j < n; j++) { v[j] += r[j] * y[i]; for (let k = 0; k < n; k++) A[j][k] += r[j] * r[k]; } });
  for (let j = 0; j < n; j++) A[j][j] += 1e-6;
  const M = A.map((r, i) => [...r, v[i]]);
  for (let i = 0; i < n; i++) { let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k; [M[i], M[p]] = [M[p], M[i]]; for (let k = 0; k < n; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; } }
  const c = M.map((r, i) => r[n] / r[i]);
  // old-model calibration on the same basis (its plays include sacks/kneels; att excludes sacks): scale to training
  const sP = train.reduce((s, x) => s + x.actPlays, 0) / train.reduce((s, x) => s + x.plays, 0);
  const sA = train.reduce((s, x) => s + x.act.passAtt, 0) / train.reduce((s, x) => s + x.att, 0);
  return { ...best, c, sP, sA };
}
function evaluate(m, test, label) {
  const newPlays = (x) => { const own = 1 - (x.lgShare + m.a * x.offP + m.b * x.defP + m.k), opp = 1 - x.oppPassShare; return m.c[0] * x.plays + m.c[1] * (own - 0.43) + m.c[2] * (opp - 0.43) + m.c[3] * x.margin; };
  const newAtt = (x) => (x.lgShare + m.a * x.offP + m.b * x.defP + m.k) * newPlays(x);
  const oldAtt = (x) => x.att * m.sA, oldPlays = (x) => x.plays * m.sP, oldRush = (x) => oldPlays(x) - oldAtt(x);
  const r = {
    rushes: { old: mae(test, (x) => oldRush(x) - x.act.rushes), new: mae(test, (x) => newPlays(x) - newAtt(x) - x.act.rushes) },
    passAtt: { old: mae(test, (x) => oldAtt(x) - x.act.passAtt), new: mae(test, (x) => newAtt(x) - x.act.passAtt) },
    plays: { old: mae(test, (x) => oldPlays(x) - x.actPlays), new: mae(test, (x) => newPlays(x) - x.actPlays) },
  };
  const fav = test.filter((x) => x.margin >= 7);
  const bias = (L, f) => L.reduce((s, x) => s + f(x), 0) / L.length;
  r.bigFavoriteRushBias = { n: fav.length, old: bias(fav, (x) => oldRush(x) - x.act.rushes), new: bias(fav, (x) => newPlays(x) - newAtt(x) - x.act.rushes) };
  console.log(`${label.padEnd(26)} n ${test.length}  rushes ${r.rushes.old.toFixed(2)} → ${r.rushes.new.toFixed(2)}  passAtt ${r.passAtt.old.toFixed(2)} → ${r.passAtt.new.toFixed(2)}  plays ${r.plays.old.toFixed(2)} → ${r.plays.new.toFixed(2)}  | favorites (≥7) rush bias ${r.bigFavoriteRushBias.old.toFixed(2)} → ${r.bigFavoriteRushBias.new.toFixed(2)} (n ${fav.length})`);
  return r;
}
const by = (s) => G.filter((x) => x.season === s);
const m24 = fit(by(2024)), m25 = fit(by(2025)), m2425 = fit([...by(2024), ...by(2025)]);
console.log('fitted on 2024:', JSON.stringify({ a: m24.a, b: m24.b, plays: m24.c.map((v) => +v.toFixed(3)) }));
const res = {
  f2024_t2025: evaluate(m24, by(2025), 'learn 2024 → test 2025'),
  f2025_t2024: evaluate(m25, by(2024), 'learn 2025 → test 2024 (rev.)'),
  f2425_t2026: evaluate(m2425, by(2026), 'learn 2024–25 → test 2026'),
};
console.log('final (2024–25):', JSON.stringify({ a: m2425.a, b: m2425.b, k: +m2425.k.toFixed(4), plays: m2425.c.map((v) => +v.toFixed(4)) }));
if (process.argv.includes('--write')) fs.writeFileSync(new URL('../src/fitted_volume.json', import.meta.url), JSON.stringify({ learnedAt: new Date().toISOString(), a: m2425.a, b: m2425.b, k: m2425.k, plays: m2425.c, walkForward: res }, null, 1));
