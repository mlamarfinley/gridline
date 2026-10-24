import { collectTeamRatings, UNIT_COLUMNS } from './siteClarity.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite=Number.isFinite;
// Compare interacting units, not one team's offense with the other offense.
const DUELS=[
 ['Protection vs pass rush','olPass','dlPass','More time to throw could help longer routes develop.','Pressure could force quicker throws and disrupt longer routes.'],
 ['Run blocking vs run front','olRun','dlRun','Blocking could create cleaner rushing lanes and help sustain drives.','The defensive front could squeeze rushing lanes and create longer third downs.'],
 ['Receivers vs coverage','wr','coverage','Receivers could find more room and support gains through the air.','Coverage could limit receiver production and push targets underneath.'],
];
export function matchupUnitData(m){
 const rows=collectTeamRatings([m]);
 const away=rows.find(t=>t.abbr===m.away?.abbr),home=rows.find(t=>t.abbr===m.home?.abbr);
 if(!away||!home)return null;
 const duels=[];
 for(const [attack,defense,side] of [[away,home,'away'],[home,away,'home']])for(const [label,offKey,defKey,positive,negative] of DUELS){
  const offense=attack.scores[offKey],opponent=defense.scores[defKey];
  if(!finite(offense)||!finite(opponent))continue;
  const gap=Math.round((offense-opponent)*10)/10;
  duels.push({label,side,attack:attack.abbr,defense:defense.abbr,offense,opponent,gap,winner:gap>0?attack.abbr:gap<0?defense.abbr:null,note:Math.abs(gap)<5?'Closely matched ratings; no clear advantage in this area.':gap>0?positive:negative});
 }
 return {away,home,duels};
}
export function matchupUnitsBlock(m){
 const data=matchupUnitData(m);if(!data)return '';
 const {away,home,duels}=data;
 const score=v=>finite(v)?v:'—';
 const table=UNIT_COLUMNS.map(([key,label])=>{
  const a=away.scores[key],h=home.scores[key],gap=finite(a)&&finite(h)?Math.round(Math.abs(a-h)*10)/10:null;
  return `<tr><th scope="row">${label}</th><td class="${finite(a)&&finite(h)&&a>h?'unit-higher':''}">${score(a)}</td><td class="${finite(a)&&finite(h)&&h>a?'unit-higher':''}">${score(h)}</td><td>${gap==null?'—':gap===0?'Even':`${esc(a>h?away.abbr:home.abbr)} +${gap}`}</td></tr>`;
 }).join('');
 return `<section class="matchup-units" aria-labelledby="matchup-unit-title"><div class="section-heading"><div><h2 id="matchup-unit-title">${esc(away.abbr)} vs ${esc(home.abbr)} · unit comparison</h2><p>Higher is stronger · 50 is average · gaps are rating points.</p></div></div>
 <div class="unit-duels">${['away','home'].map(side=>{const attack=side==='away'?away:home;const items=duels.filter(d=>d.side===side).sort((a,b)=>Math.abs(b.gap)-Math.abs(a.gap));return `<article><h3>When ${esc(attack.abbr)} has the ball</h3>${items.length?items.map(d=>`<div class="unit-duel"><div><strong>${d.label}</strong><span>${Math.abs(d.gap)<5?'Closely matched':`${esc(d.winner)} edge · +${Math.abs(d.gap)}`}</span></div><small>${esc(d.attack)} ${d.offense} vs ${esc(d.defense)} ${d.opponent}</small><p>${d.note}</p></div>`).join(''):'<p>Not enough unit data to compare this offense.</p>'}</article>`;}).join('')}</div>
 <details class="unit-breakdown"><summary>Compare every unit · ${esc(away.abbr)} / ${esc(home.abbr)}</summary><div class="scroll"><table><thead><tr><th scope="col">Unit</th><th scope="col">${esc(away.abbr)}</th><th scope="col">${esc(home.abbr)}</th><th scope="col">Rating gap</th></tr></thead><tbody>${table}</tbody></table></div></details>
 <p class="unit-comparison-note">${m.mode==='pregame'?'Ratings for this matchup':'Rebuilt pregame ratings'} · Unit gaps suggest matchup pressure points, not win probabilities or expected scoring margins. Line ratings reflect play results, scheme and teammates.</p></section>`;
}
