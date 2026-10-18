import {compareScript,scoreTimeline} from './gameScript.js';
import {validScriptRecord} from './scriptArchive.js';
export function reviewTrackedGame(saved,actual=null){
 if(!validScriptRecord(saved))throw Error('Tracker requires a valid pregame minute forecast');
 return {...saved,actual,review:compareScript(saved,actual),status:actual?.complete?'reviewed':actual?'incomplete':'pending'};
}
export function trackerSummary(games){const graded=games.filter(g=>g.status==='reviewed');const checks=graded.reduce((s,g)=>s+g.review.checkpointCount,0),correct=graded.reduce((s,g)=>s+Math.round(g.review.checkpointAccuracy*g.review.checkpointCount),0);return {games:games.length,reviewed:graded.length,pending:games.length-graded.length,checks,correct,accuracy:checks?correct/checks:null};}
export async function loadMinuteTracker(){
 const fs=await import('node:fs');const {ROOT}=await import('./config.js');const {getSummary}=await import('./espn.js');
 const cohort=JSON.parse(fs.readFileSync(`${ROOT}/reports/nfl_minute_cohort.json`,'utf8')),games=[];
 for(const saved of cohort.games){try{let actual=null,source=null;if(Date.parse(saved.kickoff)<=Date.now()){const r=await getSummary('nfl',saved.id);if(!r.data)throw Error(r.meta?.error||'No game data');actual=scoreTimeline(r.data);source=r.meta;}games.push({...reviewTrackedGame(saved,actual),source});}catch(e){games.push({...saved,status:'error',error:e.message,review:null,actual:null});}}
 return {...cohort,updatedAt:new Date().toISOString(),summary:trackerSummary(games),games};
}
