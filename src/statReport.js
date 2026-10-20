import { STAT_LISTS, STAT_DEFS } from './stats.js';
import { trackedPlayerStat } from '../public/trackingPolicy.js';
const finite = Number.isFinite;
const avg = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
function record(rows, project=r=>r.projection) {
 let wins=0,losses=0,pushes=0,noSide=0;
 for(const r of rows){const p=project(r);if(!finite(r.book_line)||!finite(r.actual)||!finite(p))continue;if(p===r.book_line){noSide++;continue;}if(r.actual===r.book_line){pushes++;continue;}(p>r.book_line)===(r.actual>r.book_line)?wins++:losses++;}
 return {wins,losses,pushes,noSide,decisions:wins+losses,accuracy:wins+losses?wins/(wins+losses):null};
}
export function positionStatReport(input, { kind = 'pregame' } = {}) {
 const rows=input.filter(r=>r.league==='nfl'&&trackedPlayerStat('nfl',r.position,r.stat));
 const catalog=new Map();for(const [position,stats]of Object.entries(STAT_LISTS.nfl))for(const stat of stats)if(trackedPlayerStat('nfl',position,stat))catalog.set(`${position}|${stat}`,{position,stat});
 for(const r of rows)catalog.set(`${r.position}|${r.stat}`,{position:r.position,stat:r.stat});
 const groups=[...catalog.values()].map(({position,stat})=>{
  const all=rows.filter(r=>r.position===position&&r.stat===stat),scored=all.filter(r=>finite(r.actual)&&finite(r.projection)),lined=scored.filter(r=>finite(r.book_line));
  const coverage=scored.filter(r=>finite(r.p10)&&finite(r.p90));
  const seasonsWeeks=[...new Set(scored.map(r=>`${r.season}-${String(r.week).padStart(2,'0')}`))].sort();
  // Development replay: train only on earlier weeks; never tune on the test week's outcomes.
  const latest=seasonsWeeks.at(-1),train=scored.filter(r=>`${r.season}-${String(r.week).padStart(2,'0')}`<latest),test=scored.filter(r=>`${r.season}-${String(r.week).padStart(2,'0')}`===latest);
  let experiment=null;
  if(train.length>=20&&test.length>=10){
   const bias=avg(train.map(r=>r.projection-r.actual)),shift=-bias*train.length/(train.length+30);
   const adjusted=r=>STAT_DEFS[stat]?.ratio?Math.max(0,r.projection+shift):stat==='rush_yds'?r.projection+shift:Math.max(0,r.projection+shift);
   experiment={name:'Shrunk position/stat bias correction',trainN:train.length,testN:test.length,testWeek:latest,shift,baselineMAE:avg(test.map(r=>Math.abs(r.projection-r.actual))),candidateMAE:avg(test.map(r=>Math.abs(adjusted(r)-r.actual))),baseline:record(test),candidate:record(test,adjusted),note:'Development replay on already-inspected results; not independent validation or a live forecast.'};
  }
  const rec=record(scored);
  return {position,stat,label:STAT_DEFS[stat]?.label||stat,total:all.length,n:scored.length,games:new Set(scored.map(r=>r.game_id)).size,missingActual:all.length-scored.length,noLine:scored.length-lined.length,...rec,over:record(lined.filter(r=>r.projection>r.book_line)),under:record(lined.filter(r=>r.projection<r.book_line)),mae:avg(scored.map(r=>Math.abs(r.projection-r.actual))),bias:avg(scored.map(r=>r.projection-r.actual)),coverage:avg(coverage.map(r=>+(r.actual>=r.p10&&r.actual<=r.p90))),marketMAE:avg(lined.map(r=>Math.abs(r.book_line-r.actual))),modelMAEOnLines:avg(lined.map(r=>Math.abs(r.projection-r.actual))),status:!all.length?'Not tracked yet':!scored.length?'Awaiting results':rec.decisions<30?'Small pick sample':'Descriptive results; correlated picks',experiment};
 });
 return {groups,scope:`NFL only; QB rushing excluded. ${kind === 'pregame' ? 'Latest saved pregame run per game/model.' : 'Reconstructed backtests; not original pregame forecasts.'} Picks use projection above/below the saved book line; pushes and equal-to-line projections excluded from win rate. Missing box-score rows excluded. Multiple stats from a player/game are correlated. Catalog gaps are not historical predictions.`,weeks:[...new Set(rows.map(r=>`${r.season} week ${r.week}`))],generatedAt:new Date().toISOString()};
}
