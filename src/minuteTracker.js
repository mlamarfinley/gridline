import {compareScript,scoreTimeline} from './gameScript.js';
import {validScriptRecord} from './scriptArchive.js';
export function reviewTrackedGame(saved,actual=null){
 if(!validScriptRecord(saved))throw Error('Tracker requires a valid pregame minute forecast');
 return {...saved,actual,review:compareScript(saved,actual),challengerReview:saved.forecast.challenger?compareScript({...saved,forecast:saved.forecast.challenger},actual):null,status:actual?.complete?'reviewed':actual?'incomplete':'pending'};
}
export function trackerSummary(games){
 const graded=games.filter(g=>g.status==='reviewed'),checks=graded.reduce((s,g)=>s+g.review.checkpointCount,0),correct=graded.reduce((s,g)=>s+Math.round(g.review.checkpointAccuracy*g.review.checkpointCount),0);
 const average=key=>graded.length?graded.reduce((s,g)=>s+g.review[key],0)/graded.length:null;
 const quarters=[1,2,3,4].map(quarter=>{let n=0,hits=0;for(const g of graded)for(const p of g.forecast.points.filter(p=>p.minute>(quarter-1)*15&&p.minute<=quarter*15)){const a=g.actual.points.find(a=>a.minute===p.minute);if(a){n++;hits+=p.likelyLeader===a.leader;}}return {quarter,checks:n,correct:hits,accuracy:n?hits/n:null};});
 const challenger=graded.filter(g=>g.challengerReview?.checkpointCount);
 return {games:games.length,reviewed:graded.length,pending:games.filter(g=>g.status==='pending').length,incomplete:games.filter(g=>g.status==='incomplete').length,errors:games.filter(g=>g.status==='error').length,checks,correct,accuracy:checks?correct/checks:null,scoreMAE:average('scoreMAE'),brier:average('brier'),finalWinnerCorrect:graded.filter(g=>g.review.finalWinnerCorrect).length,quarters,challenger:{games:challenger.length,accuracy:challenger.length?challenger.reduce((s,g)=>s+g.challengerReview.checkpointAccuracy,0)/challenger.length:null}};
}
export function mergeTrackedRecords(original,additional){const records=new Map();for(const g of [...original,...additional]){if(!g.id||!validScriptRecord(g))throw Error('Invalid tracked pregame record');if(!records.has(String(g.id)))records.set(String(g.id),g);}return [...records.values()];}
export async function loadMinuteTracker({records=[]}={}){
 const fs=await import('node:fs');const {ROOT}=await import('./config.js');const {getSummary}=await import('./espn.js');
 const cohort=JSON.parse(fs.readFileSync(`${ROOT}/reports/nfl_minute_cohort.json`,'utf8')),games=[];
 let local=[];try{local=JSON.parse(fs.readFileSync(`${ROOT}/reports/nfl_minute_forward.json`,'utf8')).games;}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const saved of mergeTrackedRecords(cohort.games,mergeTrackedRecords(local,records))){try{let actual=null,source=null;if(Date.parse(saved.kickoff)<=Date.now()){const r=await getSummary('nfl',saved.id);if(!r.data)throw Error(r.meta?.error||'No game data');actual=scoreTimeline(r.data);source=r.meta;}games.push({...reviewTrackedGame(saved,actual),source});}catch(e){games.push({...saved,status:'error',error:e.message,review:null,actual:null});}}
 return {...cohort,name:'NFL forward tests · frozen before kickoff',updatedAt:new Date().toISOString(),summary:trackerSummary(games),games};
}
