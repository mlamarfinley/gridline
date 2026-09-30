// Classify every out-of-range NFL yardage miss of a sealed batch by primary cause (descriptive,
// rule-based; not causal proof). Usage: node --no-warnings scripts/nfl_misses.mjs 4
import fs from 'node:fs';
const batch = Number(process.argv[2] || 4);
const D = JSON.parse(fs.readFileSync(new URL(`../data/nfl_diagnosis_rows_${batch}.json`, import.meta.url)));
const yard = D.rows.filter((r) => ['pass_yds', 'rush_yds', 'rec_yds'].includes(r.stat));
const out = [];
for (const r of yard) {
  if (r.actual == null && !r.noRow) continue;
  const inRange = r.actual != null && r.actual >= r.p10 && r.actual <= r.p90;
  if (inRange) continue;
  let cause, detail;
  const exit = (r.pos === 'QB' && r.projAtt > 15 && r.actAtt <= 10) || (r.pos !== 'QB' && ((r.projCar || 0) + (r.projTgt || 0)) >= 4 && ((r.actCar || 0) + (r.actTgt ?? r.actRec ?? 0)) < 0.25 * ((r.projCar || 0) + (r.projTgt || 0)));
  if (r.noRow) { cause = 'Availability'; detail = 'no box-score row (inactive/injured — participation unverified; blind mode has no injury report)'; }
  else if (exit) { cause = 'Availability'; detail = `workload collapsed (${r.pos === 'QB' ? `${r.actAtt} att vs ${r.projAtt?.toFixed(0)} proj` : `${r.actCar} car + ${r.actTgt ?? r.actRec} tgt vs ${((r.projCar || 0) + (r.projTgt || 0)).toFixed(1)} proj`}) — early exit, benching or injury`; }
  else {
    const above = r.actual > r.p90;
    const long = r.stat === 'rush_yds' ? r.actLongRush : r.stat === 'rec_yds' ? r.actLongRec : r.actLongCmp;
    let W, E, opp, projOpp, actOpp, projEff, actEff;
    if (r.stat === 'rush_yds') { projOpp = r.projCar; actOpp = r.actCar; projEff = r.effYpc; actEff = r.actCar ? r.actRushYds / r.actCar : projEff; opp = 'carries'; var unit = 'carry'; }
    else if (r.stat === 'rec_yds') { projOpp = r.projTgt; actOpp = r.actTgt ?? r.actRec; projEff = r.projTgt ? r.proj / r.projTgt : 0; actEff = actOpp ? r.actRecYds / actOpp : projEff; opp = 'targets'; var unit = 'target'; }
    else { projOpp = r.projAtt; actOpp = r.actAtt; projEff = r.projAtt ? r.proj / r.projAtt : 0; actEff = r.actAtt ? r.actPassYds / r.actAtt : projEff; opp = 'attempts'; var unit = 'attempt'; }
    W = (projOpp - actOpp) * projEff; E = actOpp * (projEff - actEff);
    const withoutLong = long != null ? r.actual - long : null;
    const teamVol = r.pos === 'QB' ? Math.abs((r.teamActAtt ?? actOpp) - (r.teamProjAtt ?? projOpp)) >= 8 : Math.abs(r.teamActPlays - r.teamProjPlays) >= 10;
    const scriptMiss = Math.abs(r.teamActMargin - r.teamExpMargin) >= 17;
    if (above && long != null && long >= 30 && withoutLong <= r.p90) { cause = 'Single big play'; detail = `one ${long}-yd play; without it ${withoutLong} yds would have been inside the range`; }
    else if (Math.abs(E) > Math.abs(W)) { cause = 'Efficiency'; detail = `${actEff.toFixed(1)} yds/${unit} vs ${projEff.toFixed(1)} proj (on ${actOpp} ${opp}; ${projOpp?.toFixed(1)} proj) — per-touch yardage was the larger part of the miss`; }
    else if (teamVol || scriptMiss) { cause = 'Team volume / game script'; detail = `${actOpp} ${opp} vs ${projOpp?.toFixed(1)} proj; team ran ${r.teamActPlays} plays (${r.teamProjPlays.toFixed(0)} proj), final margin ${r.teamActMargin > 0 ? '+' : ''}${r.teamActMargin} (model ${r.teamExpMargin >= 0 ? '+' : ''}${r.teamExpMargin.toFixed(1)})`; }
    else {
      cause = 'Player share / role';
      const sh = r.stat === 'pass_yds' ? `share of team dropbacks, not team volume` : r.stat === 'rush_yds' ? `carry share ${(r.actCarShare * 100).toFixed(0)}% vs ${(r.projCarShare * 100).toFixed(0)}% proj` : `target share ${r.actTgtShare != null ? (r.actTgtShare * 100).toFixed(0) : '?'}% vs ${(r.projTgtShare * 100).toFixed(0)}% proj`;
      detail = `${actOpp} ${opp} vs ${projOpp?.toFixed(1)} proj while team volume was near projection (${sh})`;
    }
  }
  out.push({ game: r.game, week: r.week, team: r.team, player: r.player, pos: r.pos, stat: r.stat, proj: r.proj, p10: r.p10, p90: r.p90, actual: r.actual, dir: r.actual == null ? 'no stats' : r.actual > r.p90 ? 'above' : 'below', cause, detail });
}
const total = yard.filter((r) => r.actual != null || r.noRow).length;
const byCause = {}; for (const m of out) byCause[m.cause] = (byCause[m.cause] || 0) + 1;
const byPosCause = {}; for (const m of out) { const k = `${m.pos}`; (byPosCause[k] ||= {})[m.cause] = (byPosCause[k][m.cause] || 0) + 1; }
fs.writeFileSync(new URL(`../data/nfl_misses_${batch}.json`, import.meta.url), JSON.stringify({ batch, total, misses: out, byCause, byPosCause }, null, 1));
console.log(JSON.stringify({ totalYardagePredictions: total, outOfRange: out.length, byCause, byPosCause, dir: { above: out.filter((m) => m.dir === 'above').length, below: out.filter((m) => m.dir === 'below').length, noStats: out.filter((m) => m.dir === 'no stats').length } }));
