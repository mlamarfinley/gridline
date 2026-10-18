// Clock-aware script forecast and retrospective scoring. Pure functions; no network/database.
export const SCRIPT_VERSION='script-timeline-1';
const finite=Number.isFinite;
const round=x=>Math.round(x*10)/10;
const winner=(h,a)=>h>a?'home':a>h?'away':'tie';
export function clockLabel(seconds){
  if(seconds===0)return 'Kickoff';if(seconds===3600)return 'End Q4';
  if(seconds%900===0)return `End Q${seconds/900}`;
  const q=Math.floor(seconds/900)+1,r=900-seconds%900;
  return `Q${q} ${Math.floor(r/60)}:${String(r%60).padStart(2,'0')}`;
}
export function scoringEvents(sum){
  const wall=new Map((sum?.drives?.previous||[]).flatMap(d=>d.plays||[]).map(p=>[String(p.id),p.wallclock||null]));
  const out=[];
  for(const p of sum?.scoringPlays||[]){
    const period=p.period?.number,parts=p.clock?.displayValue?.split(':').map(Number);
    const remaining=parts?.length===2?parts[0]*60+parts[1]:p.clock?.value;
    if(!finite(period)||!finite(remaining)||remaining<0||remaining>900||!finite(p.homeScore)||!finite(p.awayScore))continue;
    out.push({id:String(p.id),period,clock:p.clock?.displayValue||`${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`,elapsed:period<=4?(period-1)*900+900-remaining:null,home:p.homeScore,away:p.awayScore,wallclock:p.wallclock||wall.get(String(p.id))||null,text:p.text||''});
  }
  return out.sort((a,b)=>a.period-b.period||(a.elapsed??0)-(b.elapsed??0));
}
export function scoreTimeline(sum){
  const comp=sum?.header?.competitions?.[0],events=scoringEvents(sum),done=!!comp?.status?.type?.completed;
  const finalFor=side=>{const v=comp?.competitors?.find(c=>c.homeAway===side)?.score;return v==null||v===''?null:Number(v);};
  const finalHome=finalFor('home'),finalAway=finalFor('away');
  const last=events.at(-1),reg=events.filter(e=>e.period<=4);
  const available=events.length>0||(done&&finalHome===0&&finalAway===0);
  const complete=available&&done&&finite(finalHome)&&finite(finalAway)&&(last?.home??0)===finalHome&&(last?.away??0)===finalAway&&events.length===(sum?.scoringPlays||[]).length;
  const leadSeconds={home:0,away:0,tie:0},points=[];let home=0,away=0,prev=0,leadChanges=0,lastLeader=null;
  for(const e of reg){leadSeconds[winner(home,away)]+=e.elapsed-prev;home=e.home;away=e.away;prev=e.elapsed;const w=winner(home,away);if(w!=='tie'){if(lastLeader&&lastLeader!==w)leadChanges++;lastLeader=w;}}
  if(complete)leadSeconds[winner(home,away)]+=3600-prev;
  for(let minute=0;minute<=60;minute++){const e=reg.filter(e=>e.elapsed<=minute*60).at(-1);points.push({minute,clock:clockLabel(minute*60),home:e?.home??0,away:e?.away??0,leader:winner(e?.home??0,e?.away??0)});}
  return {available,complete,reason:complete?null:'Scoring feed missing, incomplete, or game not final; timeline not graded.',events,points:available?points:[],leadSeconds:complete?leadSeconds:null,leadChanges:complete?leadChanges:null,finalHome,finalAway,finalLeader:finite(finalHome)&&finite(finalAway)?winner(finalHome,finalAway):null,regulationHome:home,regulationAway:away,overtime:events.some(e=>e.period>4),note:'Clock is game time, not elapsed real time. Actual wallclock timestamps are shown only when provided. Regulation durations exclude overtime.'};
}
export function quarterProfile(games,cutoff,opponent=false){
  const totals=[25,25,25,25];let used=0;
  for(const g of games||[]){
    if(!finite(Date.parse(g.date))||!(Date.parse(g.date)<Date.parse(cutoff)))continue;
    const end=g.endTime?.end||new Date(Date.parse(g.date)+4.5*3600e3).toISOString();
    if(!(Date.parse(end)<Date.parse(cutoff))||!g.scoringEvents?.length)continue;
    let h=0,a=0;used++;
    for(const e of g.scoringEvents){if(e.elapsed==null||e.period>4)continue;const q=Math.min(3,Math.floor(Math.max(0,e.elapsed-1)/900));
      const ownHome=opponent?!g.isHome:g.isHome;totals[q]+=Math.max(0,ownHome?e.home-h:e.away-a);h=e.home;a=e.away;
    }
  }
  const total=totals.reduce((a,b)=>a+b,0);
  return {weights:totals.map(x=>x/total),games:used,prior:'25 pseudo-points per quarter (uniform scoring timing prior).'};
}
export function forecastScript({homePoints,awayPoints,homeProfile=[.25,.25,.25,.25],awayProfile=[.25,.25,.25,.25],seed='script',generatedAt=null,history=null}){
  if(!finite(homePoints)||!finite(awayPoints)||homePoints<0||awayPoints<0)return null;
  const norm=p=>{if(p.length!==4||p.some(x=>!finite(x)||x<0)||!p.some(x=>x>0))throw Error('Invalid quarter profile');const z=p.reduce((a,b)=>a+b,0);return p.map(x=>x/z);};
  const hp=norm(homeProfile),ap=norm(awayProfile);let state=2166136261;for(const c of String(seed))state=Math.imul(state^c.charCodeAt(0),16777619)>>>0;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return(state+.5)/4294967296;};
  const poisson=lambda=>{const limit=Math.exp(-lambda);let n=0,p=1;do{n++;p*=random();}while(p>limit);return n-1;};
  const sims=2000,counts=Array.from({length:61},()=>({home:0,away:0,tie:0}));
  for(let i=0;i<sims;i++){let h=0,a=0;counts[0].tie++;for(let minute=1;minute<=60;minute++){const q=Math.floor((minute-1)/15);for(let n=poisson(homePoints*hp[q]/15/5.8);n>0;n--)h+=random()<.7?7:3;for(let n=poisson(awayPoints*ap[q]/15/5.8);n>0;n--)a+=random()<.7?7:3;counts[minute][winner(h,a)]++;}}
  const fraction=(p,m)=>p.reduce((s,w,q)=>s+w*Math.min(15,Math.max(0,m-q*15))/15,0);
  const points=counts.map((c,minute)=>{const home=round(homePoints*fraction(hp,minute)),away=round(awayPoints*fraction(ap,minute));const order=Object.keys(c).sort((a,b)=>c[b]-c[a]);return {minute,clock:clockLabel(minute*60),home,away,expectedLeader:winner(home,away),likelyLeader:c[order[0]]===c[order[1]]?'uncertain':order[0],homeProbability:c.home/sims,awayProbability:c.away/sims,tieProbability:c.tie/sims};});
  return {version:SCRIPT_VERSION,seed,generatedAt,sims,homePoints,awayPoints,homeProfile:hp,awayProfile:ap,history,points,note:'Experimental pregame estimate, not a live win-probability model. Scores are expectations, not a predicted exact scoring sequence. Scoring timing blends own scoring and opponent concession profiles; totals come from the existing game-context model. Independent Poisson scoring events: 70% seven points, 30% three points, constant rate within each quarter. No possession, drive or overtime simulation; probabilities are uncalibrated.'};
}
export function compareScript(saved,actual){
  const valid=actual?.complete,margin=saved.expectedHomeMargin;
  const out={finalWinnerCorrect:valid&&finite(margin)?winner(margin,0)===actual.finalLeader:null,expectedHomeMargin:margin??null,actualHomeMargin:valid?actual.finalHome-actual.finalAway:null,marginError:valid&&finite(margin)?Math.abs(margin-(actual.finalHome-actual.finalAway)):null,checkpointAccuracy:null,checkpointCount:0,scoreMAE:null,brier:null};
  if(!valid||!saved.forecast?.points?.length)return out;
  let hits=0,scoreErr=0,brier=0,n=0;
  for(const p of saved.forecast.points.filter(p=>p.minute>0)){const a=actual.points.find(a=>a.minute===p.minute);if(!a)continue;n++;hits+=p.likelyLeader===a.leader;scoreErr+=(Math.abs(p.home-a.home)+Math.abs(p.away-a.away))/2;brier+=['home','away','tie'].reduce((s,k)=>s+(p[k+'Probability']-(a.leader===k?1:0))**2,0);}
  return {...out,checkpointAccuracy:n?hits/n:null,checkpointCount:n,scoreMAE:n?scoreErr/n:null,brier:n?brier/n:null};
}
