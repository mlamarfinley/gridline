// When do the BOOKS miss big? Research + walk-forward model over every 2024–26 NFL pick with a line (blind batch).
//   node --no-warnings scripts/bigmiss.mjs <batch> [--write]
// A "big miss" is a real outlier, not one side of a coin flip:
//   BOOM  actual ≥ line + max(abs, rel·line)      BUST  actual ≤ line − max(abs, rel·line)
// Features are all pregame: model gap, the line vs his own recent production, usage trend, game script,
// explosiveness / style and player-vs-defense fit (src/profiles.js, built only from earlier weeks).
// Output: base rates, which signals matter, and out-of-sample lift (does the top decile really boom more?).
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildContext, playerFit } from '../src/profiles.js';
import { BIG, FEATS, threshold, bigMissX, oppUnitFor, relevantDriver } from '../src/bigmiss.js';
import { loadPlayerIds } from '../src/pbp.js';
import { fetchCached } from '../src/fetcher.js';
import { parseCsv } from '../src/baselines.js';
import { normName } from '../src/snaps.js';

const batch = Number(process.argv[2]);
const WRITE = process.argv.includes('--write');
const STATS = Object.keys(BIG);
const db = new DatabaseSync(new URL('../data/ledger.sqlite', import.meta.url).pathname, { readOnly: true });
const rows = db.prepare(`SELECT p.season, p.week, p.game_id, p.player_id, p.player_name, p.team, p.opponent, p.position pos, p.role, p.stat, p.projection proj, p.p10, p.p90, s.actual, l.line, c.context_json ctx
  FROM blind_predictions p JOIN blind_scores s USING (batch_id, game_id, player_id, stat) JOIN blind_lines l USING (batch_id, game_id, player_id, stat)
  LEFT JOIN blind_pred_context c USING (batch_id, game_id, player_id)
  WHERE p.batch_id = ? AND p.league = 'nfl' AND s.status = 'scored' AND l.line IS NOT NULL AND s.actual IS NOT NULL`).all(batch).filter((r) => STATS.includes(r.stat));

// Prior actuals for "line vs his own recent production" (earlier weeks of the same season, same batch).
const hist = new Map();
for (const r of db.prepare(`SELECT p.season, p.week, p.player_id, p.stat, s.actual FROM blind_predictions p JOIN blind_scores s USING (batch_id, game_id, player_id, stat)
  WHERE p.batch_id = ? AND p.league = 'nfl' AND s.status = 'scored' AND s.actual IS NOT NULL`).all(batch)) {
  const k = `${r.season}|${r.player_id}|${r.stat}`; (hist.get(k) || hist.set(k, []).get(k)).push({ w: r.week, v: r.actual });
}
const ids = await loadPlayerIds();

// Weekly player stats (who played, with how many opportunities) — to detect a same-position teammate being OUT.
// Inactives are announced before kickoff, so "a regular at his position is not playing" is pregame-knowable.
const WEEKLY = {}; // season -> team -> week -> [{name, pos, tgt, car}]
for (const season of [2024, 2025, 2026]) {
  const r = await fetchCached(`https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`, { ttl: 30 * 86400, as: 'text' });
  const T = (WEEKLY[season] = {});
  for (const row of parseCsv(typeof r.data === 'string' ? r.data : '')) {
    if (row.season_type !== 'REG') continue;
    const tw = ((T[row.team] ||= {})[Number(row.week)] ||= []);
    tw.push({ name: normName(row.player_display_name), pos: row.position === 'FB' ? 'RB' : row.position, tgt: Number(row.targets || 0), car: Number(row.carries || 0), att: Number(row.attempts || 0), rec: Number(row.receptions || 0), ry: Number(row.rushing_yards || 0), recy: Number(row.receiving_yards || 0) });
  }
}
/** Share of his team's per-game opportunities (targets or carries) held by same-group teammates who are absent this week. */
function freedShare(season, team, week, playerName, stat) {
  const T = WEEKLY[season]?.[nv(team)]; if (!T) return 0;
  const kind = /rush|carries/.test(stat) ? 'car' : 'tgt';
  const prior = Object.keys(T).map(Number).filter((w) => w < week).sort((a, b) => a - b).slice(-4);
  if (!prior.length) return 0;
  const me = normName(playerName);
  const avg = new Map(); let teamTot = 0;
  for (const w of prior) for (const p of T[w]) { if (p.name === me) continue; avg.set(p.name, (avg.get(p.name) || 0) + p[kind] / prior.length); teamTot += p[kind] / prior.length; }
  const present = new Set((T[week] || []).map((p) => p.name));
  if (!T[week]) return 0;
  let freed = 0;
  for (const [n, v] of avg) if (v >= 2 && !present.has(n)) freed += v;
  return teamTot > 0 ? freed / teamTot : 0;
}
/** After the fact: this game's actual volume for the player. */
function actualVolume(season, team, week, playerName, stat) {
  const p = (WEEKLY[season]?.[nv(team)]?.[week] || []).find((x) => x.name === normName(playerName));
  return p ? (/rush|carries/.test(stat) ? p.car : stat === 'pass_yds' || stat === 'completions' ? p.att : p.tgt) : null;
}
const NVT = { WSH: 'WAS', LAR: 'LA' };
const nv = (a) => NVT[a] || a;

const thr = (r) => threshold(r.stat, r.line);
const data = [];
for (const r of rows) {
  const c = r.ctx ? JSON.parse(r.ctx) : {};
  const prior = (hist.get(`${r.season}|${r.player_id}|${r.stat}`) || []).filter((g) => g.w < r.week).sort((a, b) => a.w - b.w);
  if (prior.length < 2) continue;
  const ctx = await buildContext(r.season, r.week);
  const gs = ids.byEspn.get(String(r.player_id))?.gsis;
  const pl = gs ? ctx.players.get(gs) : null;
  const def = ctx.teams[nv(r.opponent)]?.def;
  const fit = pl && def ? playerFit(pl, def, ctx.league) : null;
  const T = thr(r);
  const freed = freedShare(r.season, r.team, r.week, r.player_name, r.stat);
  const x = bigMissX({ stat: r.stat, line: r.line, proj: r.proj, p10: r.p10, p90: r.p90, recent: prior.map((g) => g.v), freed,
    share: c.targetShare ?? c.carryShare ?? 0, expMargin: c.expMargin, teamPts: c.teamPts,
    explRel: pl ? pl.explRate / ctx.league.expl - 1 : 0, deepShare: pl ? pl.share.deepOut + pl.share.deepMid : 0, fit,
    oppUnit: oppUnitFor(r.stat, r.pos, ctx.teams[nv(r.opponent)]?.ratings?.def) });
  const boom = r.actual >= r.line + T ? 1 : 0, bust = r.actual <= r.line - T ? 1 : 0;
  const expVol = /rush|carries/.test(r.stat) ? c.carries : r.stat === 'pass_yds' || r.stat === 'completions' ? c.attempts : c.targets;
  data.push({ ...r, x, boom, bust, T, freed, expVol, actVol: actualVolume(r.season, r.team, r.week, r.player_name, r.stat), fitReasons: (fit?.reasons || []).filter((fr) => (/rush|carries/.test(r.stat) ? fr.kind === 'run' : fr.kind === 'rec')).map((fr) => fr.text), style: pl?.style || [], recentVals: prior.slice(-4).map((g) => g.v) });
}

// ---------- base rates ----------
const rate = (L, k) => (L.length ? L.filter((d) => d[k]).length / L.length : 0);
console.log(`rows with a line and ≥2 prior games: ${data.length}`);
for (const st of STATS) { const L = data.filter((d) => d.stat === st); if (L.length) console.log(`${st.padEnd(12)} n ${String(L.length).padStart(5)}  boom ${(100 * rate(L, 'boom')).toFixed(1)}%  bust ${(100 * rate(L, 'bust')).toFixed(1)}%  (threshold e.g. line ${L[0].line} → ±${L[0].T.toFixed(1)})`); }

// ---------- WHY big misses happened (after the fact) ----------
console.log('\nWhy big misses happened (after the fact):');
for (const kind of ['boom', 'bust']) {
  const B = data.filter((d) => d[kind] && d.expVol > 0 && d.actVol != null && d.stat !== 'pass_yds' && d.stat !== 'completions');
  const volDriven = B.filter((d) => (kind === 'boom' ? d.actVol >= 1.4 * d.expVol : d.actVol <= 0.6 * d.expVol)).length;
  console.log(`  ${kind.toUpperCase()}: ${B.length} rush/receiving big misses — volume way ${kind === 'boom' ? 'up' : 'down'} (≥40% vs expected) in ${(100 * volDriven / B.length).toFixed(0)}%; the rest were per-touch efficiency (long plays / bad day).`);
}
for (const [lo, hi, lab] of [[0, 0.001, 'no teammate out'], [0.001, 0.15, 'teammate out, <15% freed'], [0.15, 9, 'teammate out, ≥15% freed']]) {
  const G = data.filter((d) => d.freed >= lo && d.freed < hi && d.stat !== 'pass_yds' && d.stat !== 'completions');
  if (G.length) console.log(`  ${lab.padEnd(28)} n ${String(G.length).padStart(5)}  boom ${(100 * rate(G, 'boom')).toFixed(1)}%  bust ${(100 * rate(G, 'bust')).toFixed(1)}%  OVER won ${(100 * G.filter((d) => d.actual > d.line).length / G.length).toFixed(1)}%`);
}

// ---------- logistic regression (ridge), walk-forward ----------
function fitLogit(D, y, lambda = 1) {
  const d = D[0].x.length, mu = Array(d).fill(0), sd = Array(d).fill(1);
  for (let j = 0; j < d; j++) { const v = D.map((r) => r.x[j]); mu[j] = v.reduce((a, b) => a + b, 0) / v.length; const s = Math.sqrt(v.reduce((a, b) => a + (b - mu[j]) ** 2, 0) / v.length); sd[j] = s > 1e-9 ? s : 0; }
  const Z = D.map((r) => [1, ...r.x.map((v, j) => (sd[j] ? (v - mu[j]) / sd[j] : 0))]);
  let b = Array(d + 1).fill(0);
  for (let it = 0; it < 300; it++) {
    const g = Array(d + 1).fill(0);
    for (let i = 0; i < Z.length; i++) { const p = 1 / (1 + Math.exp(-Z[i].reduce((s, v, j) => s + v * b[j], 0))); for (let j = 0; j <= d; j++) g[j] += (p - D[i][y]) * Z[i][j]; }
    for (let j = 1; j <= d; j++) g[j] += lambda * b[j];
    for (let j = 0; j <= d; j++) b[j] -= 0.5 * g[j] / Z.length * 10;
  }
  return { mu, sd, b };
}
const predict = (m, x) => 1 / (1 + Math.exp(-(m.b[0] + x.reduce((s, v, j) => s + (m.sd[j] ? ((v - m.mu[j]) / m.sd[j]) * m.b[j + 1] : 0), 0))));
function auc(scores, labels) {
  const idx = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let rank = 0, pos = 0, sumR = 0;
  for (const [, l] of idx) { rank++; if (l) { pos++; sumR += rank; } }
  const neg = idx.length - pos;
  return pos && neg ? (sumR - pos * (pos + 1) / 2) / (pos * neg) : null;
}
function evaluate(train, test, y, label) {
  // Scored WITHIN each stat (receptions vs receptions, yards vs yards) so the model can't look good just by
  // knowing which stat busts more often. Lift is vs that stat's average predicted probability.
  const m = fitLogit(train, y, 2);
  const per = {}; let wAuc = 0, wGap = 0, nW = 0, topHit = 0, topN = 0, topBase = 0, sideW = 0, sideAll = 0, allN = 0;
  for (const st of Object.keys(BIG)) {
    const T = test.filter((d) => d.stat === st); if (T.length < 40) continue;
    const s = T.map((d) => predict(m, d.x)), lab = T.map((d) => d[y]);
    const a = auc(s, lab), aGap = auc(T.map((d) => (y === 'boom' ? 1 : -1) * (d.proj - d.line)), lab);
    if (a != null) { wAuc += a * T.length; wGap += (aGap ?? 0.5) * T.length; nW += T.length; }
    const sorted = T.map((d, i) => [s[i], d]).sort((p2, q) => q[0] - p2[0]);
    const top = sorted.slice(0, Math.max(1, Math.floor(T.length * 0.1))).map(([, d]) => d);
    const base = rate(T, y);
    topHit += top.filter((d) => d[y]).length; topN += top.length; topBase += base * top.length;
    sideW += top.filter((d) => (y === 'boom' ? d.actual > d.line : d.actual < d.line)).length;
    sideAll += T.filter((d) => (y === 'boom' ? d.actual > d.line : d.actual < d.line)).length; allN += T.length;
    per[st] = { n: T.length, auc: a && +a.toFixed(3), aucGapOnly: aGap && +aGap.toFixed(3), base: +base.toFixed(3), top10: +(top.filter((d) => d[y]).length / top.length).toFixed(3) };
  }
  const out = { aucWithinStat: +(wAuc / nW).toFixed(3), aucGapOnlyWithinStat: +(wGap / nW).toFixed(3), top10Hit: +(topHit / topN).toFixed(3), top10Base: +(topBase / topN).toFixed(3), top10SideWin: +(sideW / topN).toFixed(3), allSideWin: +(sideAll / allN).toFixed(3), perStat: per };
  console.log(`${label.padEnd(30)} ${y.toUpperCase().padEnd(4)} within-stat AUC ${out.aucWithinStat} (gap-only ${out.aucGapOnlyWithinStat})  top-10% per stat: big-miss ${(100 * out.top10Hit).toFixed(1)}% vs ${(100 * out.top10Base).toFixed(1)}% base  ${y === 'boom' ? 'OVER' : 'UNDER'} won ${(100 * out.top10SideWin).toFixed(1)}% (all ${(100 * out.allSideWin).toFixed(1)}%)`);
  for (const [st, v] of Object.entries(per)) console.log(`     ${st.padEnd(12)} n ${String(v.n).padStart(4)}  AUC ${v.auc} (gap ${v.aucGapOnly})  top-10% ${(100 * v.top10).toFixed(0)}% vs base ${(100 * v.base).toFixed(0)}%`);
  return out;
}
const by = (s) => data.filter((d) => d.season === s);
const d24 = by(2024), d25 = by(2025), d26 = by(2026);
console.log('\nWalk-forward (never tested on a season it trained on):');
const res = {};
for (const y of ['boom', 'bust']) {
  res[y] = {
    forward_2024_to_2025: evaluate(d24, d25, y, 'learn 2024 → test 2025'),
    reverse_2025_to_2024: evaluate(d25, d24, y, 'learn 2025 → test 2024 (rev.)'),
  };
}
const fin = { boom: fitLogit([...d24, ...d25], 'boom', 2), bust: fitLogit([...d24, ...d25], 'bust', 2) };
console.log('\nWhat predicts a BOOM (learned on 2024–25; standardized weights, biggest first):');
fin.boom.b.slice(1).map((w, j) => [FEATS[j], w]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8).forEach(([f, w]) => console.log(`  ${w > 0 ? '+' : '−'}${Math.abs(w).toFixed(2)}  ${f}`));
console.log('What predicts a BUST:');
fin.bust.b.slice(1).map((w, j) => [FEATS[j], w]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8).forEach(([f, w]) => console.log(`  ${w > 0 ? '+' : '−'}${Math.abs(w).toFixed(2)}  ${f}`));
if (WRITE) { fs.writeFileSync(new URL('../src/fitted_bigmiss.json', import.meta.url), JSON.stringify({ batch, learnedAt: new Date().toISOString(), BIG, FEATS, boom: fin.boom, bust: fin.bust, walkForward: res, baseRates: Object.fromEntries(Object.keys(BIG).map((st) => { const L = data.filter((d) => d.stat === st && d.season < 2026); return [st, { boom: +rate(L, 'boom').toFixed(4), bust: +rate(L, 'bust').toFixed(4), n: L.length }]; })) }, null, 1)); console.log('wrote src/fitted_bigmiss.json'); }

// ---------- Simulate the actual OUTLIER PICK rule, one pick per game, out of sample ----------
import { MIN_LINE } from '../src/bigmiss.js';
function simulatePicks(train, test, label, { minLift = 1.5, needOurWay = false, margin = 1 } = {}) {
  const mB = fitLogit(train, 'boom', 2), mU = fitLogit(train, 'bust', 2);
  const base = {}; for (const st of Object.keys(BIG)) { const L = train.filter((d) => d.stat === st); base[st] = { boom: rate(L, 'boom'), bust: rate(L, 'bust') }; }
  const byGame = new Map(); for (const d of test) (byGame.get(d.game_id) || byGame.set(d.game_id, []).get(d.game_id)).push(d);
  const res = { newRule: [], oldRule: [] };
  for (const [, G] of byGame) {
    let best = null, bestOld = null;
    for (const d of G) {
      if (d.line < MIN_LINE[d.stat]) continue;
      const pb = predict(mB, d.x), pu = predict(mU, d.x);
      const lb = pb / Math.max(base[d.stat].boom, 1e-3), lu = pu / Math.max(base[d.stat].bust, 1e-3);
      const dir = lb >= lu ? 'OVER' : 'UNDER', lift = Math.max(lb, lu);
      const agrees = dir === 'OVER' ? d.proj > d.line : d.proj < d.line;
      const reach = dir === 'OVER' ? d.p90 >= d.line + d.T : d.p10 <= d.line - d.T;
      const ourWay = dir === 'OVER' ? pb > pu * margin : pu > pb * margin;
      if (lift >= minLift && agrees && reach && (!needOurWay || ourWay) && (!best || lift > best.lift)) best = { d, dir, lift };
      const sd = Math.max((d.p90 - d.p10) / 2.563, /yds/.test(d.stat) ? 6 : 0.8), z = (d.proj - d.line) / sd;
      if (Math.abs(z) >= 0.45 && (!bestOld || Math.abs(z) > Math.abs(bestOld.z))) bestOld = { d, dir: z > 0 ? 'OVER' : 'UNDER', z };
    }
    if (best) res.newRule.push(best); if (bestOld) res.oldRule.push(bestOld);
  }
  for (const [k, P] of Object.entries(res)) {
    const win = P.filter((p) => (p.dir === 'OVER' ? p.d.actual > p.d.line : p.d.actual < p.d.line)).length;
    const big = P.filter((p) => (p.dir === 'OVER' ? p.d.boom : p.d.bust)).length;
    const bigWrong = P.filter((p) => (p.dir === 'OVER' ? p.d.bust : p.d.boom)).length;
    const statMix = {}; for (const p of P) statMix[`${p.d.stat} ${p.dir}`] = (statMix[`${p.d.stat} ${p.dir}`] || 0) + 1;
    if (k === 'oldRule' && (minLift !== 1.5 || needOurWay)) continue;
    console.log(`${label.padEnd(30)} ${k === 'newRule' ? `NEW lift≥${minLift}${needOurWay ? ` our-way×${margin}` : ''}`.padEnd(24) : 'OLD gap rule'.padEnd(22)}  picks ${String(P.length).padStart(3)} of ${byGame.size} games  side won ${(100 * win / P.length).toFixed(1)}%  big miss our way ${(100 * big / P.length).toFixed(1)}%  big miss against ${(100 * bigWrong / P.length).toFixed(1)}%  mix ${JSON.stringify(Object.entries(statMix).sort((a, b) => b[1] - a[1]).slice(0, 4))}`);
  }
}
console.log('\nSimulated outlier picks (one per game, out of sample):');
for (const opt of [{}, { needOurWay: true }, { needOurWay: true, margin: 1.25 }, { needOurWay: true, margin: 1.5 }]) {
  simulatePicks(d24, d25, 'learn 2024 → pick 2025', opt);
  simulatePicks(d25, d24, 'learn 2025 → pick 2024 (rev.)', opt);
}

// ---------- RERUN: the new outlier pick for EVERY game 2024–26, each from a model that never saw that season ----------
if (process.argv.includes('--rerun')) {
  const MIN_L = MIN_LINE;
  function picksFor(train, test, foldLabel) {
    const mB = fitLogit(train, 'boom', 2), mU = fitLogit(train, 'bust', 2);
    const base = {}; for (const st of Object.keys(BIG)) { const L = train.filter((d) => d.stat === st); base[st] = { boom: rate(L, 'boom'), bust: rate(L, 'bust') }; }
    const drivers = (m, x, stat) => x.map((v, j) => [FEATS[j], m.sd[j] ? ((v - m.mu[j]) / m.sd[j]) * m.b[j + 1] : 0]).filter(([f, c]) => c > 0.08 && relevantDriver(f, stat)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
    const byGame = new Map(); for (const d of test) (byGame.get(d.game_id) || byGame.set(d.game_id, []).get(d.game_id)).push(d);
    const out = [];
    for (const [gid, G] of byGame) {
      let best = null, top = null;
      for (const d of G) {
        if (d.line < MIN_L[d.stat]) continue;
        const pb = predict(mB, d.x), pu = predict(mU, d.x);
        const lb = pb / Math.max(base[d.stat].boom, 1e-3), lu = pu / Math.max(base[d.stat].bust, 1e-3);
        const dir = lb >= lu ? 'OVER' : 'UNDER', lift = Math.max(lb, lu);
        const ourP = dir === 'OVER' ? pb : pu, othP = dir === 'OVER' ? pu : pb;
        const agrees = dir === 'OVER' ? d.proj > d.line : d.proj < d.line, reach = dir === 'OVER' ? d.p90 >= d.line + d.T : d.p10 <= d.line - d.T;
        const cand = { d, dir, lift, ourP, othP, base: dir === 'OVER' ? base[d.stat].boom : base[d.stat].bust, drivers: drivers(dir === 'OVER' ? mB : mU, d.x, d.stat) };
        if (!top || lift > top.lift) top = cand;
        if (lift >= 1.5 && ourP > othP && agrees && reach && (!best || lift > best.lift)) best = cand;
      }
      const g0 = G[0];
      if (!best) { out.push({ fold: foldLabel, season: g0.season, week: g0.week, game: `${g0.team === g0.opponent ? '' : ''}${gid}`, teams: [...new Set(G.map((d) => d.team))].sort().join('–'), pick: null, strongest: top && { name: top.d.player_name, stat: top.d.stat, dir: top.dir, line: top.d.line, lift: +top.lift.toFixed(2) } }); continue; }
      const d = best.d;
      const won = best.dir === 'OVER' ? d.actual > d.line : d.actual < d.line;
      const big = best.dir === 'OVER' ? d.boom === 1 : d.bust === 1, bigAgainst = best.dir === 'OVER' ? d.bust === 1 : d.boom === 1;
      out.push({ fold: foldLabel, season: d.season, week: d.week, game: gid, teams: [...new Set(G.map((x) => x.team))].sort().join('–'), pick: {
        name: d.player_name, team: d.team, opp: d.opponent, pos: d.pos, stat: d.stat, dir: best.dir, line: d.line, proj: +d.proj.toFixed(1), threshold: +d.T.toFixed(1),
        ourP: +best.ourP.toFixed(3), othP: +best.othP.toFixed(3), base: +best.base.toFixed(3), lift: +best.lift.toFixed(2), drivers: best.drivers,
        recent: d.recentVals, expVol: d.expVol != null ? +d.expVol.toFixed(1) : null, actVol: d.actVol, fitReasons: d.fitReasons.slice(0, 2), style: d.style,
        actual: d.actual, won, bigOurWay: big, bigAgainst } });
    }
    return out;
  }
  const all = [
    ...picksFor(d25, d24, 'learned on 2025 (reverse — out of sample, not forward)'),
    ...picksFor(d24, d25, 'learned on 2024 (forward)'),
    ...picksFor([...d24, ...d25], d26, 'learned on 2024–25 (forward)'),
  ].sort((a, b) => a.season - b.season || a.week - b.week || a.teams.localeCompare(b.teams));
  fs.mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('../reports/outlier_rerun_2024_2026.json', import.meta.url), JSON.stringify(all, null, 1));
  const P = all.filter((x) => x.pick);
  for (const season of [2024, 2025, 2026]) {
    const S = P.filter((x) => x.season === season), G = all.filter((x) => x.season === season);
    if (!G.length) continue;
    console.log(`${season}: ${S.length} picks in ${G.length} games  won ${S.filter((x) => x.pick.won).length}-${S.filter((x) => !x.pick.won).length} (${(100 * S.filter((x) => x.pick.won).length / Math.max(1, S.length)).toFixed(1)}%)  big miss our way ${S.filter((x) => x.pick.bigOurWay).length}  against ${S.filter((x) => x.pick.bigAgainst).length}`);
  }
  console.log('wrote reports/outlier_rerun_2024_2026.json');
}
