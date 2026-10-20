// Read-only standalone-report calculations. Resample whole games, not individual picks.
export const primaryRole = r => (r.position === 'QB' && r.stat === 'pass_yds') || (r.position === 'WR' && r.stat === 'rec_yds') || (r.position === 'RB' && r.stat === 'rush_yds');
export const decided = r => Number.isFinite(r.projection) && Number.isFinite(r.actual) && Number.isFinite(r.book_line) && r.projection !== r.book_line && r.actual !== r.book_line;
export const won = r => (r.projection > r.book_line) === (r.actual > r.book_line);
const difference=(a,b)=>a.length&&b.length?mean(a.map(won))-mean(b.map(won)):null;
const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
export function pickRecord(rows) {const a=rows.filter(decided),wins=a.filter(won).length;return {wins,losses:a.length-wins,n:a.length,rate:a.length?wins/a.length:null,games:new Set(a.map(r=>r.game_id)).size};}
export function correlation(rows) {const a=rows.filter(r=>Number.isFinite(r.actual)&&Number.isFinite(r.projection));if(a.length<3)return null;const x=mean(a.map(r=>r.projection)),y=mean(a.map(r=>r.actual));let xy=0,xx=0,yy=0;for(const r of a){xy+=(r.projection-x)*(r.actual-y);xx+=(r.projection-x)**2;yy+=(r.actual-y)**2;}return xx&&yy?xy/Math.sqrt(xx*yy):null;}
export function clusterInterval(a,b=null,reps=2000) {
 const aa=a.filter(decided),bb=b?.filter(decided);const ids=[...new Set([...aa,...(bb||[])].map(r=>r.game_id))];if(ids.length<2||!aa.length||(bb&&!bb.length))return null;
 const bins=new Map(ids.map(id=>[id,{a:aa.filter(r=>r.game_id===id),b:bb?.filter(r=>r.game_id===id)||[]}]));
 let seed=7919;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};const values=[];
 for(let j=0;j<reps;j++){let aw=0,an=0,bw=0,bn=0;for(let k=0;k<ids.length;k++){const bin=bins.get(ids[Math.floor(random()*ids.length)]);an+=bin.a.length;aw+=bin.a.filter(won).length;bn+=bin.b.length;bw+=bin.b.filter(won).length;}if(an&&(!bb||bn))values.push(aw/an-(bb?bw/bn:0));}
 values.sort((a,b)=>a-b);return values.length?[values[Math.floor(.025*(values.length-1))],values[Math.floor(.975*(values.length-1))]]:null;
}
export function roleHypothesis(rows) {
 const p=rows.filter(decided),over=r=>r.projection>r.book_line;
 const a=p.filter(r=>primaryRole(r)&&over(r)),b=p.filter(r=>primaryRole(r)&&!over(r)),c=p.filter(r=>!primaryRole(r)&&over(r));
 return {primaryOver:pickRecord(a),primaryUnder:pickRecord(b),otherOver:pickRecord(c),overVsUnder:{difference:difference(a,b),interval:clusterInterval(a,b)},primaryVsOther:{difference:difference(a,c),interval:clusterInterval(a,c)}};
}
