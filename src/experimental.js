// Heuristic second opinion. No fitting, market-line input, or target-game actuals.
// Correlated measurements are averaged within evidence groups, not counted as independent votes.
export const EXPERIMENT_VERSION = 'context-experiment-2';
const SUPPORTED = new Set(['pass_yds','pass_att','completions','rush_yds','carries','rec_yds','receptions','targets']);
const finite = Number.isFinite;
const clip = (x, lo=-1, hi=1) => Math.max(lo, Math.min(hi,x));
const mean = xs => xs.reduce((a,b)=>a+b,0)/xs.length;
const round = x => Math.round(x*10)/10;
export function experimentalForecast(s, c={}, t={}) {
  if(!SUPPORTED.has(s.key)||!finite(s.proj)||s.proj<0) return null;
  const run=['rush_yds','carries'].includes(s.key), recv=['rec_yds','receptions','targets'].includes(s.key);
  const signals=[];
  const group=(name,weight,parts)=>{const usable=parts.filter(x=>finite(x.score));if(usable.length)signals.push({group:name,weight,score:round(mean(usable.map(x=>x.score))*100)/100,evidence:usable.map(x=>x.text)});};
  const last=(s.last5||[]).filter(x=>finite(x.value)).slice(-3);
  group('Recent form',0.20,last.length>=2&&s.seasonAvg>0?[{score:(mean(last.map(x=>x.value))/s.seasonAvg-1)/0.4,text:`Last ${last.length} average ${round(mean(last.map(x=>x.value)))} vs season ${s.seasonAvg}.`}]:[]);
  const u=c.usageHistory,uk=run?'carries':recv?'targets':'passAtt',role=[];
  if(u?.games>=2&&u[uk]>0&&finite(u.last?.[uk]))role.push({score:(u.last[uk]/u[uk]-1)/0.5,text:`Latest ${uk} ${u.last[uk]} vs recent average ${round(u[uk])}.`});
  const shares=(c.shareTrend||[]).map(x=>run?x.carry:recv?x.target:null).filter(finite);
  if(shares.length>=3&&mean(shares)>0)role.push({score:(mean(shares.slice(-2))/mean(shares)-1)/0.3,text:`Recent ${run?'carry':'target'} share ${round(mean(shares.slice(-2))*100)}% vs ${round(mean(shares)*100)}% average.`});
  const snaps=(c.snapTrend||[]).map(x=>x.pct).filter(finite);
  if(snaps.length>=3&&mean(snaps)>0)role.push({score:(mean(snaps.slice(-2))/mean(snaps)-1)/0.3,text:`Recent snap share ${round(mean(snaps.slice(-2))*100)}% vs ${round(mean(snaps)*100)}% average.`});
  group('Workload trend',0.30,role);
  const matchup=[],labels=run?['Run game','Explosive runs vs explosive-run defense']:recv?[c.pos==='TE'?'TEs vs TE coverage':c.pos==='RB'?'RB receiving vs RB coverage':'WRs vs outside coverage (CBs)','Pass protection vs pass rush']:['Passing vs pass defense','Pass protection vs pass rush'];
  for(const e of t.units?.edges||[])if(labels.includes(e.label)&&finite(e.edge))matchup.push({score:e.edge/30,text:`${e.label}: ${e.edge>0?'+':''}${e.edge} rating points.`});
  const fit=c.matchup?.fit;
  for(const k of run?['runFit','explFit']:recv?['zoneFit','posFit','covFit']:[])if(finite(fit?.[k]))matchup.push({score:fit[k]/0.2,text:`${k}: ${round(fit[k]*100)}%.`});
  const eff=run?c.efficiency?.ypc:c.efficiency?.ypCatch;
  if((run||recv)&&finite(eff?.oppMult))matchup.push({score:(eff.oppMult-1)/0.2,text:`Opponent efficiency multiplier ${round(eff.oppMult*100)/100}.`});
  for(const [name,h] of [['Head-to-head',s.h2h],['Position vs opponent',s.vsPos]]) {
    const n=(h?.games||[]).filter(g=>finite(g.value)).length;
    if(n>=2&&finite(h.avg)&&s.proj>0)matchup.push({score:(h.avg/s.proj-1)/0.5*Math.min(1,n/5),text:`${name}: ${h.avg} over ${n} games; small samples downweighted.`});
  }
  group('Matchup',0.25,matchup);
  const skillKeys=run?(c.pos==='QB'?['scramble','run']:['ryoe','success','explosive']):recv?(c.pos==='RB'?['recv']:['earn','sep','yac','hands','deep','eff']):['epa','cpoe','sack','deep'];
  const skills=(c.ratings?.skills||[]).filter(x=>!x.noData&&finite(x.rating)&&(!x.key||skillKeys.includes(x.key)));
  group('Player skills',0.10,skills.map(x=>({score:(x.rating-50)/50*(finite(x.reliability)?clip(x.reliability,0,1):0.5),text:`${x.label||x.key||'Skill'} rating ${x.rating}; reliability ${finite(x.reliability)?round(x.reliability*100)+'%':'unknown, half weight'}.`})));
  group('Game situation',0.15,finite(s.situational?.value)&&s.proj>0?[{score:(s.situational.value/s.proj-1)/0.4,text:`Situation estimate ${s.situational.value} vs baseline ${s.proj}; includes scoring, opponent and game context.`}]:[]);
  const positive=signals.filter(x=>x.score>0.1).length,negative=signals.filter(x=>x.score< -0.1).length;
  const support=Math.max(positive,negative),score=signals.reduce((n,x)=>n+x.weight*x.score,0);
  const sample=finite(s.seasonGames)?clip(s.seasonGames/5,0.2,1):0.2;
  const availability=/questionable|doubtful|out|injured reserve/i.test(c.injury?.status||'')?0.5:1;
  // Sensitivity is weighted, but there is no percentage or baseline-range cap.
  const adjustment=score*(support>=3?1.3:1)*sample*availability*0.25;
  const rawProjection=s.proj*(1+adjustment);
  if(!finite(rawProjection)) return null;
  const projection=Math.max(0,round(rawProjection));
  return {version:EXPERIMENT_VERSION,baseline:s.proj,projection,adjustmentPct:s.proj?round((projection/s.proj-1)*100):0,signals,groupsAvailable:signals.length,groupsPossible:5,sampleFactor:sample,availabilityFactor:availability,probability:null,note:'Unvalidated contextual point forecast; no fixed adjustment cap. Injuries, weather, pace and game script also enter through the baseline; overlapping signals are grouped. Baseline ranges/probabilities do not describe this forecast.'};
}
export function addExperimental(team){
  for(const c of team.cards||[])for(const s of Object.values(c.stats||{}))if(s.available)s.experimental=experimentalForecast(s,c,team);
  const qb=(team.cards||[]).find(c=>c.pos==='QB');
  for(const [receiverKey,qbKey]of [['rec_yds','pass_yds'],['receptions','completions']]){
    const ceiling=qb?.stats?.[qbKey]?.experimental?.projection;if(!finite(ceiling))continue;
    const es=(team.cards||[]).filter(c=>c!==qb).map(c=>c.stats?.[receiverKey]?.experimental).filter(Boolean);
    const total=es.reduce((n,e)=>n+e.projection,0);if(total<=ceiling)continue;
    const factor=ceiling/total;
    for(const e of es){e.projection=Math.max(0,Math.floor(e.projection*factor*10)/10);e.adjustmentPct=e.baseline?round((e.projection/e.baseline-1)*100):0;e.constraint='Receiving totals reconciled with experimental QB passing output.';}
  }
}
