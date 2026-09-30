// Every-pick report for a sealed blind batch (read-only).
//   node --no-warnings scripts/picks_report.mjs <batch> [--calib src/fitted_v13.json]
// Writes data/picks_<batch>.csv (one row per prediction) and data/picks_<batch>_summary.json.
// A "pick" = a prediction with a retained book line: the model's side is OVER if projection > line,
// UNDER if below. Reasons are rule-based descriptions of what differed (not causal proof).
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { seasonStatus } from '../src/blind.js';

const batch = Number(process.argv[2]);
const calibArg = process.argv.indexOf('--calib');
const calib = calibArg > 0 ? JSON.parse(fs.readFileSync(process.argv[calibArg + 1], 'utf8')) : null;
const db = new DatabaseSync(new URL('../data/ledger.sqlite', import.meta.url).pathname, { readOnly: true });
const rows = db.prepare(`
  SELECT p.*, s.actual, s.status, l.line, l.open_line, l.line_updated, pr.over_price, pr.under_price, pr.provider, pr.alternates,
         m.home, m.away, pc.context_json AS pctx, ac.context_json AS actx
  FROM blind_predictions p
  JOIN blind_manifests m ON m.batch_id = p.batch_id AND m.game_id = p.game_id
  LEFT JOIN blind_scores s ON s.batch_id = p.batch_id AND s.game_id = p.game_id AND s.player_id = p.player_id AND s.stat = p.stat
  LEFT JOIN blind_lines l ON l.batch_id = p.batch_id AND l.game_id = p.game_id AND l.player_id = p.player_id AND l.stat = p.stat
  LEFT JOIN blind_line_prices pr ON pr.batch_id = p.batch_id AND pr.game_id = p.game_id AND pr.player_id = p.player_id AND pr.stat = p.stat
  LEFT JOIN blind_pred_context pc ON pc.batch_id = p.batch_id AND pc.game_id = p.game_id AND pc.player_id = p.player_id
  LEFT JOIN blind_actual_context ac ON ac.batch_id = p.batch_id AND ac.game_id = p.game_id AND ac.player_id = p.player_id
  WHERE p.batch_id = ? AND p.league = 'nfl' ORDER BY p.kickoff, p.game_id, p.team, p.player_name, p.stat`).all(batch);

const r1 = (x) => (x == null || !Number.isFinite(x) ? '' : Math.round(x * 10) / 10);
const sgn = (x) => (x > 0 ? `+${r1(x)}` : `${r1(x)}`);

/** Optional v1.3 calibration: projection' = a + b*proj; range widened by s around the median. */
function applyCalib(r) {
  if (!calib) return r;
  const c = calib.byStat?.[`${r.position}|${r.stat}`];
  if (!c) return r;
  const f = (x) => (x == null ? x : Math.max(0, c.a + c.b * x));
  const med = f(r.p50 ?? r.projection);
  const widen = (x) => (x == null ? x : Math.max(0, med + (c.s ?? 1) * (f(x) - med)));
  return { ...r, projection: f(r.projection), p10: widen(r.p10), p90: widen(r.p90) };
}

/** Brief, rule-based reason for a losing pick or an out-of-range projection. */
export function reasonFor(r, P, A, lossDir) {
  if (r.status === 'no_box_row' || r.status === 'dnp') return 'No recorded stats: inactive/injured or did not play (participation unverified); blind mode has no injury report.';
  const st = A?.stats || {};
  const tm = A?.team;
  const script = tm && P?.expMargin != null ? `team ${tm.margin > 0 ? 'won' : tm.margin < 0 ? 'lost' : 'tied'} by ${Math.abs(tm.margin)} (model ${sgn(P.expMargin)})` : null;
  const vol = tm && P?.teamPlays ? `team ran ${tm.plays} plays (${r1(P.teamPlays)} proj)` : null;
  const pieces = [];
  const fam = r.stat;
  const workload = (actual, proj, label) => (proj != null && actual != null ? { actual, proj, label, rel: (actual - proj) / Math.max(1, proj) } : null);
  let W = null, E = null;
  if (fam === 'rush_yds' || fam === 'carries' || fam === 'long_rush') {
    W = workload(st.carries ?? 0, P?.carries, 'carries');
    if (st.carries) E = { actual: st.rush_yds / st.carries, proj: P?.ypc, label: 'yds/carry' };
  } else if (['rec_yds', 'receptions', 'long_rec'].includes(fam)) {
    W = workload(st.targets ?? st.receptions ?? 0, P?.targets, st.targets != null ? 'targets' : 'receptions');
    if (fam === 'receptions' && st.targets) E = { actual: (st.receptions || 0) / st.targets, proj: P?.catchRate, label: 'catch rate', pct: true };
    else if (st.receptions) E = { actual: st.rec_yds / st.receptions, proj: P?.ypCatch, label: 'yds/catch' };
  } else if (['pass_yds', 'completions', 'pass_att', 'pass_td', 'ints', 'long_cmp'].includes(fam)) {
    W = workload(st.pass_att ?? 0, P?.attempts, 'pass attempts');
    if (st.pass_att && fam === 'pass_yds') E = { actual: st.pass_yds / st.pass_att, proj: P?.attempts ? r.projection / P.attempts : null, label: 'yds/att' };
  }
  const long = fam.includes('rec') ? st.long_rec : fam.includes('rush') || fam === 'carries' ? st.long_rush : st.long_cmp;
  // Collapse of workload => availability / early exit
  if (W && W.proj >= 4 && W.actual < 0.25 * W.proj) return `Workload collapsed: ${W.actual} ${W.label} vs ${r1(W.proj)} projected — early exit, benching or in-game injury${script ? `; ${script}` : ''}.`;
  if (['pass_td', 'rush_td', 'rec_td', 'tds'].includes(fam)) return `Touchdown variance: ${r.actual} vs ${r1(r.projection)} projected (TDs are low-count and noisy)${script ? `; ${script}` : ''}.`;
  if (['xp_made', 'fg_made', 'k_pts'].includes(fam)) return `Kicking volume follows team scoring: team scored ${tm?.pts ?? '?'} (model ${r1(P?.teamPts)} pts).`;
  if (fam.startsWith('long_')) return `Longest play: ${r.actual} vs ${r1(r.projection)} projected — single-play outcome, mostly variance.`;
  if (lossDir === 'over-hit' && long != null && long >= 30 && r.line != null && r.actual - long < r.line) return `One big play: a ${long}-yd gain decided it (without it: ${r.actual - long} vs line ${r.line}).`;
  if (W) pieces.push(`${W.actual} ${W.label} vs ${r1(W.proj)} proj (${W.rel >= 0 ? '+' : ''}${Math.round(W.rel * 100)}%)`);
  if (E && E.proj != null && Number.isFinite(E.actual)) pieces.push(`${E.pct ? `${Math.round(E.actual * 100)}%` : r1(E.actual)} ${E.label} vs ${E.pct ? `${Math.round(E.proj * 100)}%` : r1(E.proj)} proj`);
  const wErr = W ? Math.abs(W.rel) : 0, eErr = E && E.proj ? Math.abs(E.actual - E.proj) / Math.max(0.1, E.proj) : 0;
  let lead = eErr > wErr ? 'Efficiency' : 'Workload';
  if (lead === 'Workload' && tm && P?.teamPlays && Math.abs(tm.plays - P.teamPlays) >= 10) lead = 'Team volume/game script';
  else if (lead === 'Workload' && tm && P?.expMargin != null && Math.abs(tm.margin - P.expMargin) >= 17) lead = 'Game script';
  else if (lead === 'Workload') lead = 'Role/share';
  const ctx = [vol, script].filter(Boolean).join(', ');
  return `${lead}: ${pieces.join('; ')}${ctx ? ` — ${ctx}` : ''}.`;
}

const out = [];
for (const raw of rows) {
  const r = applyCalib(raw);
  const P = r.pctx ? JSON.parse(r.pctx) : null;
  const A = r.actx ? JSON.parse(r.actx) : null;
  const hasLine = r.line != null;
  let side = '', result = hasLine ? 'NO RESULT' : 'NO LINE';
  if (hasLine && r.projection != null) side = r.projection > r.line ? 'OVER' : r.projection < r.line ? 'UNDER' : 'NO SIDE';
  if (hasLine && r.status === 'scored' && r.actual != null && (side === 'OVER' || side === 'UNDER')) result = r.actual === r.line ? 'PUSH' : (r.actual > r.line) === (side === 'OVER') ? 'WIN' : 'LOSS';
  if (hasLine && (r.status === 'no_box_row' || r.status === 'dnp')) result = 'NO STATS';
  const inRange = r.status === 'scored' && r.actual != null ? (r.actual >= r.p10 && r.actual <= r.p90 ? 'yes' : 'no') : '';
  const needReason = result === 'LOSS' || result === 'NO STATS' || inRange === 'no';
  const lossDir = result === 'LOSS' ? (side === 'UNDER' ? 'over-hit' : 'under-hit') : r.actual > r.p90 ? 'over-hit' : 'under-hit';
  out.push({
    season: r.season, week: r.week, game_id: r.game_id, matchup: `${r.away} @ ${r.home}`, kickoff: r.kickoff, team: r.team, opponent: r.opponent,
    player: r.player_name, pos: r.position, role: r.role, stat: r.stat, projection: r1(r.projection), p10: r1(r.p10), p90: r1(r.p90),
    line: r.line ?? '', open_line: r.open_line ?? '', over_price: r.over_price ?? '', under_price: r.under_price ?? '', line_source: r.provider || (hasLine ? 'DraftKings via ESPN' : ''), line_updated: r.line_updated || '',
    model_side: side, actual: r.actual ?? '', status: r.status || 'unscored', result, in_range: inRange,
    error: r.actual != null && r.projection != null ? r1(r.projection - r.actual) : '',
    reason: needReason ? reasonFor(r, P, A, lossDir) : '',
    season_status: seasonStatus('nfl', r.season, r.week),
  });
}
const cols = Object.keys(out[0] || {});
const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const suffix = calib ? '_v13' : '';
fs.writeFileSync(new URL(`../data/picks_${batch}${suffix}.csv`, import.meta.url), [cols.join(','), ...out.map((o) => cols.map((c) => esc(o[c])).join(','))].join('\n'));

// ---------- summary ----------
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const rec = (list) => { const w = list.filter((x) => x.result === 'WIN').length, l = list.filter((x) => x.result === 'LOSS').length, p = list.filter((x) => x.result === 'PUSH').length; return { w, l, p, winRate: w + l ? w / (w + l) : null }; };
const acc = (list) => { const s = list.filter((x) => x.status === 'scored' && x.actual !== '' && x.projection !== ''); return { n: s.length, mae: mean(s.map((x) => Math.abs(x.projection - x.actual))), bias: mean(s.map((x) => x.projection - x.actual)), coverage: mean(s.map((x) => (x.in_range === 'yes' ? 1 : 0))) }; };
const lineAcc = (list) => { const s = list.filter((x) => x.status === 'scored' && x.line !== '' && x.actual !== ''); return { n: s.length, modelMae: mean(s.map((x) => Math.abs(x.projection - x.actual))), lineMae: mean(s.map((x) => Math.abs(x.line - x.actual))) }; };
const reasonKind = (s) => (s ? s.split(':')[0] : null);
const summary = { batch, calibrated: !!calib, generatedAt: new Date().toISOString(), seasons: {} };
for (const season of [...new Set(out.map((o) => o.season))].sort()) {
  const S = out.filter((o) => o.season === season);
  const picks = S.filter((o) => o.line !== '');
  const byStat = {};
  for (const st of [...new Set(picks.map((o) => `${o.pos}|${o.stat}`))]) { const L = picks.filter((o) => `${o.pos}|${o.stat}` === st); byStat[st] = { picks: L.length, ...rec(L), ...lineAcc(L) }; }
  const losses = S.filter((o) => o.result === 'LOSS');
  const reasons = {}; for (const o of losses) { const k = reasonKind(o.reason); reasons[k] = (reasons[k] || 0) + 1; }
  // Does a bigger model-vs-line gap win more often? (standardized by the model's own range)
  const gapBins = [[0, 0.25], [0.25, 0.5], [0.5, 1], [1, 99]].map(([lo, hi]) => { const L = picks.filter((o) => { const z = Math.abs(o.projection - o.line) / Math.max(1, (o.p90 - o.p10) / 2.563); return z >= lo && z < hi; }); return { gapSD: `${lo}–${hi === 99 ? '∞' : hi}`, ...rec(L) }; });
  summary.seasons[season] = {
    status: [...new Set(S.map((o) => o.season_status))],
    predictions: S.length, games: new Set(S.map((o) => o.game_id)).size,
    withLine: picks.length, ...rec(picks), noStats: picks.filter((o) => o.result === 'NO STATS').length,
    accuracy: acc(S), lineVsModel: lineAcc(picks), byStat, lossReasons: reasons, gapBins,
    over: rec(picks.filter((o) => o.model_side === 'OVER')), under: rec(picks.filter((o) => o.model_side === 'UNDER')),
  };
}
fs.writeFileSync(new URL(`../data/picks_${batch}${suffix}_summary.json`, import.meta.url), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(summary.seasons).map(([k, v]) => [k, { games: v.games, predictions: v.predictions, withLine: v.withLine, record: `${v.w}-${v.l}-${v.p}`, winRate: v.winRate && +v.winRate.toFixed(3), mae: v.accuracy.mae && +v.accuracy.mae.toFixed(2), cov: v.accuracy.coverage && +v.accuracy.coverage.toFixed(3), lineMae: v.lineVsModel.lineMae && +v.lineVsModel.lineMae.toFixed(2), modelMaeOnLines: v.lineVsModel.modelMae && +v.lineVsModel.modelMae.toFixed(2) }]))));
