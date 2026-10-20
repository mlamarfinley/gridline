// Compound-Poisson score distribution: the existing 70% seven-point / 30% three-point model.
// Recurrence computes probabilities directly, eliminating Monte Carlo sampling noise.
function scoreDistribution(mean){
 if(!Number.isFinite(mean)||mean<0)throw Error('Invalid expected score');
 const rate=mean/5.8;
 if(rate>500)throw Error('Expected score too large for stable recurrence');
 const size=Math.ceil(mean+14*Math.sqrt(rate*(.7*49+.3*9))+100),p=new Float64Array(size+1);p[0]=Math.exp(-rate);
 for(let n=1;n<=size;n++)p[n]=((n>=3?3*rate*.3*p[n-3]:0)+(n>=7?7*rate*.7*p[n-7]:0))/n;
 return p;
}
export function scoringProbabilities(home,away){
 const h=scoreDistribution(home),a=scoreDistribution(away);let lowerA=0,hw=0,tie=0;
 for(let n=0;n<h.length;n++){hw+=h[n]*lowerA;tie+=h[n]*(a[n]||0);lowerA+=a[n]||0;}
 return {homeProbability:hw,awayProbability:Math.max(0,1-hw-tie),tieProbability:tie};
}
export function analyticalScript(f){
 const fraction=(p,m)=>p.reduce((s,w,q)=>s+w*Math.min(15,Math.max(0,m-q*15))/15,0);
 const points=f.points.map(p=>{const probs=scoringProbabilities(f.homePoints*fraction(f.homeProfile,p.minute),f.awayPoints*fraction(f.awayProfile,p.minute));const order=['home','away','tie'].sort((a,b)=>probs[b+'Probability']-probs[a+'Probability']);return {...p,...probs,likelyLeader:Math.abs(probs[order[0]+'Probability']-probs[order[1]+'Probability'])<1e-12?'uncertain':order[0]};});
 return {...f,version:'script-context-2',probabilityMethod:'analytic-compound-poisson',points,note:'Direct score-distribution calculation; no Monte Carlo noise in leader probabilities. '+f.note};
}
