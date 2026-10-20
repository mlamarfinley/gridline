#!/usr/bin/env node
// Reconstructed, chronological diagnostic only. Does not write reports or prediction ledgers.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadSnapData} from '../src/snapData.js';
import {buildDriveLibrary,forecastDriveGame,DRIVE_VERSION} from '../src/driveModel.js';
import {compareScript} from '../src/gameScript.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=process.argv[2];
assert.ok(destination&&path.isAbsolute(destination),'Usage: node scripts/replay-drive-model.mjs /absolute/output.json [--all]');
assert.ok(!destination.startsWith(path.join(root,'reports')+path.sep),'Output must not overwrite immutable reports.');
assert.ok(!destination.startsWith(path.join(root,'data')+path.sep),'Output must not overwrite data or ledger files.');
const sourceFile=path.join(root,'reports/game_scripts_nfl.json'),sourceBytes=fs.readFileSync(sourceFile),digest=b=>createHash('sha256').update(b).digest('hex'),sourceHash=digest(sourceBytes),report=JSON.parse(sourceBytes);
const targets=Object.entries(report.games).filter(([,g])=>g.actual?.complete&&(g.week===6||(process.argv.includes('--all')&&g.week===4))).sort((a,b)=>a[1].kickoff.localeCompare(b[1].kickoff)||a[0].localeCompare(b[0]));
const source=await loadSnapData(2026),generatedAt=new Date().toISOString();
const alias=t=>({WSH:'WAS',LAR:'LA'}[t]||t),win=(h,a)=>h>a?'home':h<a?'away':'tie';
const games=[];
for(const [id,g] of targets){
 const cutoff=g.forecastTimestamp||g.kickoff;
 assert.ok(Date.parse(cutoff)<Date.parse(g.kickoff),`${id}: reconstructed cutoff must precede kickoff`);
 const home=alias(g.home),away=alias(g.away),library=buildDriveLibrary(source.rows,{week:g.week,cutoff});
 const targetIds=new Set(source.rows.filter(r=>r.week===g.week&&r.home_team===home&&r.away_team===away).map(r=>r.game_id));
 assert.ok(targetIds.size>0,`${id}: source target mapping not found`);
 assert.ok(library.drives.every(d=>d.week<g.week&&!targetIds.has(d.gameId)),`${id}: target or target-week leakage`);
 const forecast=forecastDriveGame({drives:library,home,away,seed:`chronological-replay:${DRIVE_VERSION}:${id}`,generatedAt,sims:1000});
 assert.ok(forecast.available,`${id}: no training drives`);
 const end=g.actual.points.find(p=>p.minute===60);assert.ok(end,`${id}: no regulation endpoint`);
 const actual={...g.actual,finalHome:end.home,finalAway:end.away,finalLeader:win(end.home,end.away)};
 const grade=(forecast,expectedScore)=>{
  const terminal=forecast?.points.find(p=>p.minute===60)||expectedScore;
  if(!terminal)return null;
  const margin=terminal.home-terminal.away;
  const timeline=compareScript({forecast,expectedHomeMargin:margin},actual,{regulationOnly:true});
  return {...timeline,finalRegulationScoreMAE:(Math.abs(terminal.home-end.home)+Math.abs(terminal.away-end.away))/2,finalRegulationMarginMAE:Math.abs(margin-(end.home-end.away)),expectedScore:{home:terminal.home,away:terminal.away}};
 };
 games.push({id,week:g.week,home:g.home,away:g.away,kickoff:g.kickoff,cutoff,targetNflverseGameIds:[...targetIds],training:{...library.evidence,sourceGames:forecast.evidence.sourceGames,maximumWeek:Math.max(...library.drives.map(d=>d.week)),targetAbsent:true},actualRegulation:{home:end.home,away:end.away,overtime:g.actual.overtime},candidate:{version:DRIVE_VERSION,seed:forecast.seed,sims:forecast.sims,metrics:grade(forecast),forecast},frozenWeek6Baseline:g.week===6&&g.forecast?{runId:g.runId,forecastTimestamp:g.forecastTimestamp,version:g.forecast.version,metrics:grade(g.forecast),forecast:g.forecast}:null,savedContextExpectedScore:g.expectedScore?{provenance:'Saved game-context expectedScore; report does not establish this as a market line.',metrics:grade(null,g.expectedScore)}:null});
}
const keys=['checkpointAccuracy','scoreMAE','brier','finalRegulationScoreMAE','finalRegulationMarginMAE'];
const aggregate=metrics=>Object.fromEntries(keys.map(k=>{const valid=metrics.map(m=>m?.[k]).filter(Number.isFinite);return[k,{games:valid.length,mean:valid.length?valid.reduce((a,b)=>a+b,0)/valid.length:null}];}));
const paired=games.filter(g=>g.frozenWeek6Baseline),candidate=aggregate(paired.map(g=>g.candidate.metrics)),baseline=aggregate(paired.map(g=>g.frozenWeek6Baseline.metrics));
const result={label:'Reconstructed chronological diagnostic — not an original forecast and not an independent test',generatedAt,season:2026,version:DRIVE_VERSION,scope:process.argv.includes('--all')?'Completed saved Weeks 4 and 6':'Completed saved Week 6',limitations:['Model was developed after these outcomes were available; this is a diagnostic, not untouched validation.','Training uses current revised source rows filtered to weeks and dates preceding each saved forecast timestamp, not a historical data-vintage snapshot.','Saved Week 6 baseline forecasts are preserved verbatim; scores use ESPN regulation minute 60 and exclude overtime.','Saved expectedScore is a game-context comparator; a separate verified market-line comparator is unavailable in this report.','Checkpoint accuracy and Brier use minutes 1–60 with home/away/tie states. Aggregate means weight each game equally.'],source:{report:sourceFile,reportSha256:sourceHash,playByPlay:source.source,playByPlayRetrievedAt:source.sourceRetrievedAt},summary:{games:games.length,pairedWeek6Games:paired.length,candidateAll:aggregate(games.map(g=>g.candidate.metrics)),pairedWeek6:{candidate,baseline,candidateMinusBaseline:Object.fromEntries(keys.map(k=>[k,candidate[k].mean-baseline[k].mean]))},savedContextExpectedScore:aggregate(games.map(g=>g.savedContextExpectedScore?.metrics))},games};
assert.equal(digest(fs.readFileSync(sourceFile)),sourceHash,'Source report changed during replay');
fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(result,null,2)+'\n');
console.log(`${result.label}\n${games.length} games; ${paired.length} paired Week 6 games.`);
for(const key of keys)console.log(`${key}: drive ${candidate[key].mean?.toFixed(6)} | frozen ${baseline[key].mean?.toFixed(6)}`);
console.log(`Output: ${destination}`);
