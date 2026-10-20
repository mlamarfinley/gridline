// Empirical possession resampling challenger. No future game or target score inputs.
import {clockLabel} from './gameScript.js';
export const DRIVE_VERSION='empirical-drive-2';
const isTry=p=>p.play_type==='extra_point'||p.extra_point_attempt===1||p.two_point_attempt===1;
const finite=Number.isFinite,clamp=(x,a,b)=>Math.min(b,Math.max(a,x)),leader=(h,a)=>h>a?'home':h<a?'away':'tie';
const possessionSeconds=s=>{if(typeof s!=='string'||!/^\d+:\d{2}$/.test(s))return null;const [m,v]=s.split(':').map(Number);return v<60?m*60+v:null;};
export function buildDriveLibrary(rows,{week,cutoff}={}){
 const limit=Date.parse(cutoff),groups=new Map(),seen=new Set(),lastTouchdown=new Map();let rejectedRows=0,duplicates=0;
 for(const r of [...(rows||[])].sort((a,b)=>String(a.game_id).localeCompare(String(b.game_id))||a.play_id-b.play_id)){
  const date=Date.parse(r.game_date),id=r.fixed_drive??r.drive;
  // Dates are day precision: require the whole source day to precede cutoff.
  if(r.season_type!=='REG'||!finite(week)||!(r.week<week)||!finite(limit)||!finite(date)||date+86400000>limit||!(r.qtr>=1&&r.qtr<=4)||!r.posteam||!r.defteam||id==null||r.play_id==null||!r.game_id){rejectedRows++;continue;}
  const unique=`${r.game_id}:${r.play_id}`;if(seen.has(unique)){duplicates++;continue;}seen.add(unique);
  if(!isTry(r)&&['kickoff','pass','run','punt','field_goal','qb_kneel','qb_spike'].includes(r.play_type))lastTouchdown.delete(r.game_id);
  if(['kickoff','no_play'].includes(r.play_type))continue;
  let key=`${r.game_id}:${id}:${r.posteam}`;
  if(isTry(r)){const td=lastTouchdown.get(r.game_id);if(!td||r.game_seconds_remaining>td.clock||td.qtr!==r.qtr)continue;key=td.key;}
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
  if(r.touchdown===1&&!isTry(r))lastTouchdown.set(r.game_id,{key,clock:r.game_seconds_remaining,qtr:r.qtr});
 }
 const drives=[];
 for(const [id,plays] of groups){plays.sort((a,b)=>a.play_id-b.play_id);const first=plays.find(p=>!isTry(p)&&finite(p.yardline_100)&&finite(p.game_seconds_remaining)),last=plays.at(-1);if(!first)continue;
  const time=plays.map(p=>possessionSeconds(p.drive_time_of_possession)).find(x=>finite(x)&&x>0);
  const clocks=plays.map(p=>p.game_seconds_remaining).filter(finite);const duration=time??(Math.max(...clocks)-Math.min(...clocks));
  if(!(duration>0&&duration<=1800))continue;
  let offensivePoints=0,defensivePoints=0;
  for(const p of plays){const own=finite(p.posteam_score_post)&&finite(p.posteam_score)?Math.max(0,p.posteam_score_post-p.posteam_score):0,other=finite(p.defteam_score_post)&&finite(p.defteam_score)?Math.max(0,p.defteam_score_post-p.defteam_score):0;offensivePoints+=p.posteam===first.posteam?own:other;defensivePoints+=p.posteam===first.posteam?other:own;}
  if(offensivePoints>8||defensivePoints>8)continue;
  const result=String(plays.findLast(p=>p.fixed_drive_result)?.fixed_drive_result||last.drive_end_transition||'').toLowerCase();
  const turnover=plays.some(p=>p.interception===1||p.fumble_lost===1);
  const kneelOnly=plays.filter(p=>!isTry(p)).every(p=>p.qb_kneel===1||p.play_type==='qb_kneel');
  const outcome=kneelOnly?'period_end':turnover?'turnover':plays.some(p=>p.safety===1)?'safety':offensivePoints>=6?'touchdown':plays.some(p=>p.field_goal_result==='made')?'field_goal':/downs/.test(result)?'downs':plays.some(p=>p.play_type==='punt')?'punt':plays.some(p=>p.field_goal_result==='missed'||p.field_goal_result==='blocked')?'missed_field_goal':/half|game|quarter/.test(result)?'period_end':'other';
  const calls=plays.filter(p=>!isTry(p)&&!['no_play','qb_kneel','qb_spike'].includes(p.play_type)&&p.qb_kneel!==1&&p.qb_spike!==1&&p.play_deleted!==1&&(p.qb_dropback===1||(p.rush_attempt===1&&p.qb_dropback===0&&p.qb_scramble!==1))).map(p=>({playId:p.play_id,down:p.down??null,distance:p.ydstogo??null,field:p.yardline_100??null,run:p.qb_dropback!==1,dropback:p.qb_dropback===1,family:p.qb_dropback===1?'dropback':'designed_run'}));
  const endField=plays.findLast(p=>finite(p.yardline_100))?.yardline_100??first.yardline_100;
  drives.push({id,gameId:first.game_id,week:first.week,date:first.game_date,offense:first.posteam,defense:first.defteam,startClock:first.game_seconds_remaining,endClock:Math.min(...clocks),startField:first.yardline_100,endField,startMargin:(first.posteam_score??0)-(first.defteam_score??0),duration,calls,plays:plays.filter(p=>!isTry(p)).length,yards:first.yardline_100-endField,offensivePoints,defensivePoints,turnover,outcome});
 }
 // The next possession includes punt/turnover return yards when source ordering permits it.
 const ordered=[...drives].sort((a,b)=>a.gameId.localeCompare(b.gameId)||b.startClock-a.startClock);
 for(let i=0;i<ordered.length-1;i++){const d=ordered[i],n=ordered[i+1];if(d.gameId===n.gameId&&d.offense===n.defense&&!(d.startClock>1800&&n.startClock<=1800))d.nextField=n.startField;}
 return {version:DRIVE_VERSION,week,cutoff,drives,evidence:{games:new Set(drives.map(d=>d.gameId)).size,drives:drives.length,rejectedRows,duplicates}};
}
export function nextDriveField(d,startField){
 if(d.defensivePoints>=6||['touchdown','field_goal','safety'].includes(d.outcome))return 70;
 if(finite(d.nextField))return clamp(d.nextField-(startField-d.startField),1,99);
 const end=clamp(d.endField+(startField-d.startField),1,99);
 if(d.outcome==='punt')return clamp(100-end+40,20,99);
 return clamp(100-end,1,99);
}
function rng(seed){let state=2166136261;for(const c of String(seed))state=Math.imul(state^c.charCodeAt(0),16777619)>>>0;return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return(state+.5)/4294967296;};}
const fieldBin=f=>f<35?0:f<65?1:2,scoreBin=m=>m< -7?-1:m>7?1:0;
const SITUATIONS=['firstDown','secondDown','thirdLong','thirdShort','thirdMedium','fourthDown'];
const FIELD_ZONES=['redZone','openField','backedUp'];
const CALL_BUCKETS=[...SITUATIONS,...FIELD_ZONES];
const JOINT_BUCKETS=SITUATIONS.flatMap(s=>FIELD_ZONES.map(f=>`${s}:${f}`));
const allCallBuckets=[...CALL_BUCKETS,...JOINT_BUCKETS];
const emptyCounts=()=>({runs:0,dropbacks:0,plays:0});
const emptyCallTable=()=>Object.fromEntries(allCallBuckets.map(k=>[k,emptyCounts()]));
function callContext(c){
 if(!Number.isInteger(c.down)||c.down<1||c.down>4||!finite(c.distance)||c.distance<0||!finite(c.field)||c.field<0||c.field>100||typeof c.run!=='boolean'||typeof c.dropback!=='boolean'||c.run===c.dropback)return null;
 const situation=c.down===1?'firstDown':c.down===2?'secondDown':c.down===3?(c.distance>=7?'thirdLong':c.distance<=3?'thirdShort':'thirdMedium'):'fourthDown';
 const zone=c.field<=20?'redZone':c.field>=80?'backedUp':'openField';
 return {situation,zone,joint:`${situation}:${zone}`};
}
function shiftedCallContext(c,d,startField){
 if(!callContext(c))return null;
 return callContext({...c,field:clamp(c.field+(startField-d.startField),0,100)});
}
function driveCallCounts(d,startField=d.startField){
 const table=emptyCallTable(),overall=emptyCounts();
 for(const c of d.calls||[]){const context=shiftedCallContext(c,d,startField);if(!context)continue;for(const key of [context.situation,context.zone,context.joint]){table[key].plays++;table[key][c.run?'runs':'dropbacks']++;}overall.plays++;overall[c.run?'runs':'dropbacks']++;}
 return {table,overall};
}
function callModel(drives,offense,defense){
 const league=emptyCallTable(),own=emptyCallTable(),opponent=emptyCallTable();
 for(const d of drives){const counts=driveCallCounts(d);for(const k of allCallBuckets)for(const field of ['runs','dropbacks','plays']){league[k][field]+=counts.table[k][field];if(d.offense===offense)own[k][field]+=counts.table[k][field];if(d.defense===defense)opponent[k][field]+=counts.table[k][field];}}
 const observed=n=>({...n,runRate:n.plays?n.runs/n.plays:null});
 const estimates=Object.fromEntries(allCallBuckets.map(k=>{
  const l=league[k],o=own[k],a=opponent[k];
  // Beta(1,1) league smoothing makes likelihoods finite; 20 pseudo-calls
  // shrink each team to that league rate without inventing observed samples.
  const leagueProbability=l.plays?(l.runs+1)/(l.plays+2):null;
  const posterior=n=>(n.runs+20*leagueProbability)/(n.plays+20);
  const probability=leagueProbability==null?null:.45*posterior(o)+.35*posterior(a)+.2*leagueProbability;
  return [k,{runProbability:probability,dropbackProbability:probability==null?null:1-probability,leagueProbability,own:observed(o),opponentDefense:observed(a),league:observed(l)}];
 }));
 const weight=(d,startField)=>{let logRatio=0,n=0;for(const c of d.calls||[]){const context=shiftedCallContext(c,d,startField);if(!context)continue;const joint=estimates[context.joint],b=joint.runProbability==null?estimates[context.situation]:joint;const p=c.run?b.runProbability:b.dropbackProbability,q=c.run?b.leagueProbability:1-b.leagueProbability;logRatio+=Math.log(p/q);n++;}return n?Math.exp(.25*logRatio/n):1;};
 const profile={...Object.fromEntries(CALL_BUCKETS.map(k=>[k,estimates[k]])),fieldContexts:Object.fromEntries(JOINT_BUCKETS.map(k=>[k,estimates[k]])),method:{leagueBetaPrior:[1,1],teamLeaguePseudoCalls:20,likelihoodStrength:.25,definitions:'Samples use eligible non-period-end historical drives with observed down, distance, field and call type. Third-long is third down with at least 7 yards to go; third-short is 0–3 and third-medium is 4–6. Red zone is at most 20 yards to goal; backed up is at least 80; open field is between. Run means designed rush; sacks and scrambles count as dropbacks. Marginal probabilities describe their buckets; joint situation/field estimates weight sampling after translating call field by simulated start minus historical start, clamped to 0–100. Joint cells with no source calls fall back to the situation estimate.',description:'Joint down/distance and field-zone run/dropback likelihood ratio against the league, geometric mean per drive at quarter strength. This modest extra conditioning reuses the existing team evidence; it is a heuristic, not an independently fitted effect. No fixed multiplier cap.'}};
 return {profile,weight};
}
function conditionalPools(drives,offense,defense){
 const own=drives.filter(d=>d.offense===offense).length,opp=drives.filter(d=>d.defense===defense).length,pools=new Map(),fieldWeights=new Map(),calls=callModel(drives,offense,defense);
 const mixture=drives.map(d=>(d.offense===offense ? .45/own : 0)+(d.defense===defense ? .35/opp : 0)+(.2+(!own ? .45 : 0)+(!opp ? .35 : 0))/drives.length);
 // Cache per actual simulated start and score band. Each start's translated
 // call likelihoods are computed once, never rescanned for each draw.
 const pool=(field,margin)=>{const s=scoreBin(margin),key=`${field}:${s}`;if(pools.has(key))return pools.get(key);
  if(!fieldWeights.has(field))fieldWeights.set(field,drives.map((d,i)=>mixture[i]*Math.exp(-Math.abs(fieldBin(field)-fieldBin(d.startField)))*calls.weight(d,field)));
  const weights=fieldWeights.get(field);let total=0;const cumulative=drives.map((d,i)=>{total+=weights[i]*(scoreBin(d.startMargin)===s?1:.5);return total;});const result={total,cumulative};pools.set(key,result);return result;
 };
 return {own,opp,calls,pick:(field,margin,random)=>{const {total,cumulative}=pool(field,margin);const v=random()*total;let lo=0,hi=cumulative.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(cumulative[mid]<v)lo=mid+1;else hi=mid;}return drives[lo];}};
}
export function forecastDriveGame({drives:input,home,away,seed='drive',generatedAt=null,sims=1000}={}){
 const drives=(Array.isArray(input)?input:input?.drives||[]).filter(d=>d.outcome!=='period_end'&&finite(d.duration)&&d.duration>0&&finite(d.startField)&&finite(d.endField)&&finite(d.offensivePoints)&&finite(d.defensivePoints));
 const limitations=['Experimental, uncalibrated empirical drive challenger; not a full snap or 22-player simulation.','Resamples observed drive outcomes and possession time conditional on coarse field/score bands and league-shrunk situational run/dropback tendencies. This is heuristic drive weighting, not a forecast of exact plays, coach intent, or independently established improvement; injuries and in-drive tactics are not simulated.','Historical period-end and kneel-only drives are retained in the archive but excluded from resampling. Points arrive at drive end; partial drives at halftime or regulation end are censored. No overtime.','Coin toss is random; kickoffs reset to own 30. Return position uses observed next possession when available, otherwise bounded field heuristics. End field is the last recorded pre-snap position when no next possession exists.'];
 if(!drives.length)return {available:false,version:DRIVE_VERSION,points:[],reason:'No eligible historical drives.',limitations};
 sims=clamp(Math.floor(sims)||1000,1,10000);const random=rng(seed),hp=conditionalPools(drives,home,away),ap=conditionalPools(drives,away,home),counts=Array.from({length:61},()=>({home:0,away:0,homeLead:0,awayLead:0,tie:0})),scores={home:[],away:[]},totals={home:0,away:0},turnovers={home:0,away:0};
 const simulatedCalls={home:{overall:emptyCounts(),table:emptyCallTable(),completedDrives:0},away:{overall:emptyCounts(),table:emptyCallTable(),completedDrives:0}};
 for(let sim=0;sim<sims;sim++){
  let h=0,a=0,time=0,field=70,nextMinute=1;const first=random()<.5?'home':'away';let side=first;counts[0].tie++;
  const fill=until=>{while(nextMinute<=60&&nextMinute*60<=until){const c=counts[nextMinute++];c.home+=h;c.away+=a;c[h>a?'homeLead':a>h?'awayLead':'tie']++;}};
  while(time<3600){const boundary=time<1800?1800:3600,d=(side==='home'?hp:ap).pick(field,side==='home'?h-a:a-h,random),end=time+d.duration;totals[side]++;
   if(end>boundary){fill(boundary);time=boundary;if(time===1800){side=first==='home'?'away':'home';field=70;}continue;}
   const selected=driveCallCounts(d,field),simulated=simulatedCalls[side];simulated.completedDrives++;for(const key of ['runs','dropbacks','plays']){simulated.overall[key]+=selected.overall[key];for(const bucket of allCallBuckets)simulated.table[bucket][key]+=selected.table[bucket][key];}
   fill(end-.001);if(side==='home'){h+=d.offensivePoints;a+=d.defensivePoints;}else{a+=d.offensivePoints;h+=d.defensivePoints;}if(d.turnover)turnovers[side]++;
   time=end;fill(time);field=nextDriveField(d,field);if(d.defensivePoints<6)side=side==='home'?'away':'home';if(time===1800){side=first==='home'?'away':'home';field=70;}
  }
  fill(3600);scores.home.push(h);scores.away.push(a);
 }
 const points=counts.map((c,minute)=>{const home=c.home/sims,away=c.away/sims,probs={home:c.homeLead/sims,away:c.awayLead/sims,tie:c.tie/sims},sorted=Object.keys(probs).sort((a,b)=>probs[b]-probs[a]);return {minute,clock:clockLabel(minute*60),home,away,margin:home-away,homeLead:probs.home,awayLead:probs.away,tie:probs.tie,homeProbability:probs.home,awayProbability:probs.away,tieProbability:probs.tie,expectedLeader:leader(home,away),likelyLeader:probs[sorted[0]]===probs[sorted[1]]?'uncertain':sorted[0]};});
 const simulatedSummary=side=>{const s=simulatedCalls[side],average=n=>({runs:n.runs/sims,dropbacks:n.dropbacks/sims,plays:n.plays/sims,runRate:n.plays?n.runs/n.plays:null});return {...average(s.overall),completedDrives:s.completedDrives/sims,bySituation:Object.fromEntries(CALL_BUCKETS.map(k=>[k,average(s.table[k])])),note:'Expected counts per game from complete sampled historical drives with observed down, distance, field and call flags; field zones use the translated simulated starting position. Censored partial drives and unknown call attributes are excluded; these are not exact future plays.'};};
 const situationalCalls={home:{...hp.calls.profile,simulated:simulatedSummary('home')},away:{...ap.calls.profile,simulated:simulatedSummary('away')}};
 const quantiles=values=>{values.sort((a,b)=>a-b);const q=p=>values[Math.floor((values.length-1)*p)];return {p10:q(.1),p50:q(.5),p90:q(.9)};};
 return {available:true,version:DRIVE_VERSION,seed,generatedAt,sims,homePoints:points[60].home,awayPoints:points[60].away,points,situationalCalls,expectedDrives:{home:totals.home/sims,away:totals.away/sims},expectedTurnovers:{home:turnovers.home/sims,away:turnovers.away/sims},scoreQuantiles:{home:quantiles(scores.home),away:quantiles(scores.away)},evidence:{...input?.evidence,leagueDrives:drives.length,home:{offense:hp.own,opponentDefense:hp.opp},away:{offense:ap.own,opponentDefense:ap.opp},sourceGames:[...new Set(drives.map(d=>d.gameId))].sort(),cutoff:input?.cutoff??null,week:input?.week??null},mixture:{ownOffense:.45,opponentDefense:.35,league:.2},limitations,note:limitations.join(' ')};
}
