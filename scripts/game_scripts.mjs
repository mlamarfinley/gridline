// Review immutable pregame scripts against ESPN scoring clocks. Never regenerate old forecasts.
import fs from 'node:fs';
import {openLedger} from '../src/ledger.js';
import {MODEL_VERSION,ROOT} from '../src/config.js';
import {getSummary,extractPlays,summaryTeams} from '../src/espn.js';
import {stateOf} from '../src/history.js';
import {scoreTimeline,compareScript} from '../src/gameScript.js';
const lg=process.argv.includes('cfb')?'cfb':'nfl',d=openLedger();
const runs=d.prepare(`SELECT * FROM runs WHERE id IN (SELECT max(id) FROM runs WHERE kind='pregame' AND league=? AND model_version=? GROUP BY game_id) ORDER BY kickoff`).all(lg,MODEL_VERSION);
const games={};
for(const r of runs){
 const original=JSON.parse(r.game_json),home=original.teams?.find(t=>t.abbr===r.home);
 const saved={runId:r.id,forecastTimestamp:r.created_at,kickoff:r.kickoff,modelVersion:r.model_version,home:r.home,away:r.away,week:r.week,expectedHomeMargin:home?.expMargin??null,expectedScore:original.implied||null,forecast:original.gameScript||null,weights:home?.scriptWeights||null};
 if(Date.parse(r.created_at)>=Date.parse(r.kickoff))throw Error('Invalid pregame timestamp');
 const entry={...saved,actual:null,review:null,observedStates:null,expectedEffectiveStates:saved.weights?Object.fromEntries(Object.entries(saved.weights).map(([k,v])=>[k,.6*v+(k==='close'?.4:0)])):null,status:'pending'};
 if(Date.parse(r.kickoff)<=Date.now()){
  try{
   const response=await getSummary(lg,r.game_id);if(!response.data)throw Error(response.meta?.error||'No summary');
   const actual=scoreTimeline(response.data);entry.actual=actual;entry.source=response.meta;entry.review=compareScript(saved,actual);entry.status=actual.complete?'reviewed':'incomplete';
   if(actual.complete){const teams=summaryTeams(response.data),plays=extractPlays(response.data);const counts={blowTrail:0,trail:0,close:0,lead:0,blowLead:0};for(const p of plays){const margin=p.offenseId===teams.home.id?p.margin:-p.margin;counts[stateOf(margin,lg)]++;}entry.observedStates=plays.length?Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,v/plays.length])):null;entry.observedPlayCount=plays.length;}
  }catch(e){entry.status='error';entry.error=e.message;}
 }
 games[r.game_id]=entry;console.log(`${r.away} @ ${r.home}: ${entry.status}${entry.review?.finalWinnerCorrect!=null?' · final leader '+(entry.review.finalWinnerCorrect?'correct':'wrong'):''}`);
}
const reviewed=Object.values(games).filter(g=>g.status==='reviewed');const graded=reviewed.filter(g=>g.review.finalWinnerCorrect!=null);
const result={updatedAt:new Date().toISOString(),league:lg,modelVersion:MODEL_VERSION,summary:{savedGames:runs.length,reviewed:reviewed.length,pending:Object.values(games).filter(g=>g.status==='pending').length,incomplete:Object.values(games).filter(g=>['error','incomplete'].includes(g.status)).length,finalWinnerCorrect:graded.filter(g=>g.review.finalWinnerCorrect).length,finalWinnerGraded:graded.length,meanAbsoluteMarginError:graded.length?graded.reduce((n,g)=>n+g.review.marginError,0)/graded.length:null,savedMinuteForecasts:reviewed.filter(g=>g.forecast).length},note:'Latest original pregame run per game for current model. Old scenario weights are compared descriptively with play-state frequencies; they were not minute forecasts. Leading time is regulation game-clock time, not wallclock time. Forecast probabilities are not calibrated.',games};
fs.writeFileSync(`${ROOT}/reports/game_scripts_${lg}.json`,JSON.stringify(result));
console.log(JSON.stringify(result.summary,null,2));
