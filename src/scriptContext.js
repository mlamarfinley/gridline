// Auditable experimental context layer. Coefficients are fixed heuristics, not fitted accuracy claims.
import { analyticalScript } from './scriptProbability.js';
import { forecastScript } from './gameScript.js';
const finite=Number.isFinite;
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
export function scriptContextTeam(team) {
  const market=team.impliedPts;
  if(!finite(market)||market<0)return null;
  const groups=[];
  const independent=team.v12?.points?.team ?? team.context?.offense?.pointsShrunk;
  if(finite(independent)&&independent>0)groups.push({name:'Team scoring and opposing defense',weight:.35,logRatio:Math.log(independent/Math.max(1,market)),detail:`Historical scoring estimate ${independent.toFixed(1)} vs market/context total ${market.toFixed(1)}.`});
  // Passing + rushing only: receiving is the same passing production and must not be counted twice.
  const yardage=[],props=[];
  for(const c of team.cards||[])for(const key of c.pos==='QB'?['pass_yds','rush_yds']:c.pos==='RB'?['rush_yds']:[]) {
    const s=c.stats?.[key];if(!s?.available||!finite(s.proj)||s.proj<=0)continue;
    if(s.seasonAvg>0&&s.seasonGames>=2)yardage.push({ratio:s.proj/s.seasonAvg,weight:s.proj,name:c.name,key});
    if(finite(s.book?.line)&&s.book.line>0)props.push({ratio:s.book.line/s.proj,weight:s.proj,name:c.name,key,line:s.book.line});
  }
  const weighted=xs=>xs.reduce((a,x)=>a+x.weight*Math.log(x.ratio),0)/xs.reduce((a,x)=>a+x.weight,0);
  if(yardage.length)groups.push({name:'Player production and availability',weight:.15,logRatio:weighted(yardage),detail:'Passing/rushing forecasts relative to prior averages; includes baseline role, availability, efficiency and weather adjustments.',players:yardage});
  if(props.length)groups.push({name:'Posted player lines',weight:.10,logRatio:weighted(props),detail:'Available QB passing/rushing and RB rushing lines compared with player forecasts. Correlated with game lines; small weight.',players:props});
  const edges=(team.units?.edges||[]).filter(x=>finite(x.edge)&&/run game|pass protection/i.test(x.label));
  if(edges.length)groups.push({name:'Offensive line versus defensive front',weight:.05,logRatio:mean(edges.map(x=>x.edge))/100,detail:edges.map(x=>`${x.label}: ${x.edge}`).join('; ')});
  const raw=market*Math.exp(groups.reduce((s,g)=>s+g.weight*g.logRatio,0));
  const points=finite(raw)?Math.max(0,Math.round(raw*10)/10):market;
  return {marketPoints:market,points,groups,coverage:{playerProduction:yardage.length,playerLines:props.length,unitEdges:edges.length},tracked:{plays:team.params?.plays??null,passRate:team.params?.passRate??null,sackRate:team.params?.sackRate??null,intRate:team.params?.intRate??null},note:'Market-anchored heuristic. Ratings, roles, recent form, matchup and weather enter through existing player forecasts; receiving yards are not added again. Missing inputs are omitted, never treated as zero. Pace/turnover rates are disclosed but not independently converted into points without fitted evidence.'};
}
export function contextualScript(base,home,away){
  if(!base)return null;
  const h=scriptContextTeam(home),a=scriptContextTeam(away);if(!h||!a)return null;
  const f=forecastScript({homePoints:h.points,awayPoints:a.points,homeProfile:base.homeProfile,awayProfile:base.awayProfile,seed:base.seed||'context-script',generatedAt:base.generatedAt,history:base.history});
  const main={...f,version:'script-context-1',inputs:{home:h,away:a},note:'Experimental context script; not validated as an improvement. '+f.note};
  try{return {...main,challenger:analyticalScript(main)};}catch(e){return {...main,challengerUnavailable:e.message};}
}
