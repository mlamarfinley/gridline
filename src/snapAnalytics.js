/** Pure, as-of NFL play-by-play aggregation. Rates are fractions, never percentages. */
const number = value => typeof value === 'number' && Number.isFinite(value);
const yes = value => value === 1 || value === true;
const rate = (n, d) => d > 0 ? n / d : null;
const count = (rows, predicate) => rows.filter(predicate).length;
const dropback = p => yes(p.qb_dropback);
const carry = p => yes(p.rush_attempt);
const target = p => Boolean(p.receiver_player_id);
const redZone = p => number(p.yardline_100) && p.yardline_100 <= 20 && p.yardline_100 >= 0;
const endZone = p => number(p.air_yards) && number(p.yardline_100) && p.air_yards >= p.yardline_100;
const deep = p => number(p.air_yards) && p.air_yards >= 20;
const competitive = p => !['no_play','play_deleted','deleted','qb_kneel','qb_spike','two_point_attempt'].some(k => yes(p[k]))
 && !['no_play','qb_kneel','qb_spike'].includes(p.play_type)
 && (dropback(p) || carry(p) || ['pass','run'].includes(p.play_type));
const measured = (rows, field) => {
 const values = rows.map(p => p[field]).filter(number);
 const sum = values.length ? values.reduce((a,b)=>a+b,0) : null;
 return {sum,plays:values.length,perPlay:values.length ? sum / values.length : null};
};
function chartingMetrics(rows) {
 const binary = (field, predicate=()=>true, positive=v=>v===1) => {
  const covered=rows.filter(p=>predicate(p)&&number(p.charting?.[field]));
  const total=count(covered,p=>positive(p.charting[field]));
  return {count:total,plays:covered.length,rate:rate(total,covered.length)};
 };
 const average = field => measured(rows.filter(dropback).map(p=>p.charting||{}),field);
 return {
  coveredSnaps:count(rows,p=>p.charting&&Object.values(p.charting).some(number)),
  motion:binary('is_motion'),playAction:binary('is_play_action',dropback),
  screen:binary('is_screen_pass',dropback),rpo:binary('is_rpo'),
  throwAway:binary('is_throw_away',dropback),
  catchable:binary('is_catchable_ball',target),
  dropRate:binary('is_drop',p=>target(p)&&p.charting?.is_catchable_ball===1),
  blitz:binary('n_blitzers',dropback,v=>v>0),
  interceptionWorthy:binary('is_interception_worthy',dropback),
  qbFaultSack:binary('is_qb_fault_sack',p=>yes(p.sack)),
  passRushers:average('n_pass_rushers'),defendersInBox:measured(rows.map(p=>p.charting||{}),'n_defense_box'),
  pressureRate:null,
 };
}
function metrics(rows) {
 const epa = measured(rows,'epa');
 const successes = count(rows,p => number(p.epa) && p.epa > 0);
 const expected = rows.filter(p => number(p.xpass) && (dropback(p) || carry(p)));
 const expectedPasses = expected.length ? expected.reduce((a,p)=>a+p.xpass,0) : null;
 const actualPasses = count(expected,dropback);
 const dropbacks = count(rows,dropback), carries = count(rows,carry);
 const designedRushes = count(rows,p => carry(p) && !dropback(p) && !yes(p.qb_scramble));
 const conversionPlays=rows.filter(p=>(p.down===3||p.down===4)&&number(p.first_down)&&number(p.touchdown));
 const conversions=count(conversionPlays,p=>yes(p.first_down)||(yes(p.touchdown)&&p.td_team===p.posteam));
 const explosivePlays=rows.filter(p=>number(p.yards_gained));
 const explosives=count(explosivePlays,p=>p.yards_gained >= (carry(p)?10:20));
 const hitCovered = rows.filter(p=>dropback(p) && number(p.qb_hit) && number(p.sack));
 return {
  charting:chartingMetrics(rows),
  snaps:rows.length,games:new Set(rows.map(p=>p.game_id)).size,dropbacks,
  passAttempts:count(rows,p=>yes(p.pass_attempt) && !yes(p.sack)),carries,designedRushes,
  targets:count(rows,target),sacks:count(rows,p=>yes(p.sack)),qbHits:count(rows,p=>yes(p.qb_hit)),
  turnovers:count(rows,p=>yes(p.interception) || yes(p.fumble_lost)),
  epa,success:{count:successes,plays:epa.plays,rate:rate(successes,epa.plays)},
  conversions:{count:conversions,plays:conversionPlays.length,rate:rate(conversions,conversionPlays.length)},
  explosive:{count:explosives,plays:explosivePlays.length,rate:rate(explosives,explosivePlays.length)},
  passRate:rate(dropbacks,dropbacks+designedRushes),
  proe:{actualPasses,expectedPasses,plays:expected.length,value:expected.length ? (actualPasses-expectedPasses)/expected.length : null},
  sackHitProxy:{count:count(hitCovered,p=>yes(p.sack)||yes(p.qb_hit)),plays:hitCovered.length,rate:rate(count(hitCovered,p=>yes(p.sack)||yes(p.qb_hit)),hitCovered.length)},
  rushingYards:measured(rows.filter(carry),'rushing_yards'),
  passingYards:measured(rows.filter(p=>yes(p.pass_attempt)&&!yes(p.sack)),'passing_yards'),
 };
}
function teamMetrics(rows) {
 const result=metrics(rows);
 const bucket = selectors => Object.fromEntries(Object.entries(selectors).map(([key,predicate])=>[key,metrics(rows.filter(predicate))]));
 result.splits={
  down:bucket({'1':p=>p.down===1,'2':p=>p.down===2,'3':p=>p.down===3,'4':p=>p.down===4}),
  distance:bucket({short:p=>number(p.ydstogo)&&p.ydstogo<=3,medium:p=>p.ydstogo>=4&&p.ydstogo<=6,long:p=>p.ydstogo>=7}),
  score:bucket({trailing:p=>number(p.score_differential)&&p.score_differential < -7,close:p=>number(p.score_differential)&&Math.abs(p.score_differential)<=7,leading:p=>number(p.score_differential)&&p.score_differential>7}),
  redZone:metrics(rows.filter(redZone)),
  neutralEarlyDowns:metrics(rows.filter(p=>(p.down===1||p.down===2)&&number(p.score_differential)&&Math.abs(p.score_differential)<=7)),
 };
 return result;
}
function participants(rows,positions,names) {
 const ids = new Set(rows.flatMap(p=>[p.receiver_player_id,p.rusher_player_id,p.passer_player_id]).filter(Boolean));
 const denominators={targets:count(rows,target),carries:count(rows,carry),redZoneTargets:count(rows,p=>target(p)&&redZone(p)),endZoneTargets:count(rows,p=>target(p)&&endZone(p)),deepTargets:count(rows,p=>target(p)&&deep(p)),redZoneCarries:count(rows,p=>carry(p)&&redZone(p))};
 const summarize = member => {
  const targets=rows.filter(p=>target(p)&&member(p.receiver_player_id));
  const carries=rows.filter(p=>carry(p)&&member(p.rusher_player_id));
  const passes=rows.filter(p=>dropback(p)&&member(p.passer_player_id || (yes(p.qb_scramble)?p.rusher_player_id:null)));
  const air=measured(targets,'air_yards'),receiving=measured(targets,'receiving_yards'),rushing=measured(carries,'rushing_yards'),yac=measured(targets,'yards_after_catch');
  const completionCoverage=targets.filter(p=>number(p.complete_pass));
  const result={targets:targets.length,carries:carries.length,dropbacks:passes.length,receptions:count(targets,p=>yes(p.complete_pass)),catchRate:rate(count(completionCoverage,p=>yes(p.complete_pass)),completionCoverage.length),catchRatePlays:completionCoverage.length,
   redZoneTargets:count(targets,redZone),endZoneTargets:count(targets,endZone),deepTargets:count(targets,deep),redZoneCarries:count(carries,redZone),
   receivingYards:receiving.sum,receivingYardsPlays:receiving.plays,rushingYards:rushing.sum,rushingYardsPlays:rushing.plays,
   airYards:air.sum,airYardsTargets:air.plays,adot:air.perPlay,yac:yac.sum,yacReceptions:yac.plays,
   receivingEpa:measured(targets,'epa'),rushingEpa:measured(carries,'epa'),dropbackEpa:measured(passes,'epa'),
   routesRun:null,yprr:null,missing:'Play-by-play does not chart routes run; yards per route run is unavailable.',
   denominators:{...denominators},
  };
  for (const [field,denom] of Object.entries(denominators)) {
   const shareName={targets:'targetShare',carries:'carryShare',redZoneTargets:'redZoneTargetShare',endZoneTargets:'endZoneTargetShare',deepTargets:'deepTargetShare',redZoneCarries:'redZoneCarryShare'}[field];
   result[shareName]=rate(result[field],denom);
  }
  return result;
 };
 const playerPosition = id => positions[id] || 'UNKNOWN';
 const players=Object.fromEntries([...ids].map(id=>[id,{id,name:names[id]||id,position:playerPosition(id),...summarize(other=>other===id)}]));
 const groups=[...new Set([...ids].map(playerPosition))];
 return {players,positions:Object.fromEntries(groups.map(position=>[position,{position,...summarize(id=>id && playerPosition(id)===position)}]))};
}

/** week and cutoff are exclusive; caller supplies one season of canonical rows. */
export function summarizeSnaps(rows,{team,week,cutoff,positions={},names={}}={}) {
 const seen=new Set();
 const cutoffDate=cutoff ? String(cutoff).slice(0,10) : null;
 const eligible=rows.filter(p=>{
  if (p.season_type!=='REG' || (week!=null && !(p.week < week)) || (cutoffDate && (!p.game_date || String(p.game_date).slice(0,10)>=cutoffDate))) return false;
  if (p.posteam!==team && p.defteam!==team) return false;
  const key=`${p.game_id}:${p.play_id}`;
  if (seen.has(key)) return false;
  seen.add(key);return true;
 });
 const games=[...new Map(eligible.map(p=>[p.game_id,{id:p.game_id,date:p.game_date,week:p.week}])).values()].sort((a,b)=>String(a.date).localeCompare(String(b.date)) || a.week-b.week || String(a.id).localeCompare(String(b.id)));
 const recent=new Set(games.slice(-3).map(g=>g.id));
 const snaps=eligible.filter(competitive);
 const period=selected=>{
  const offense=selected.filter(p=>p.posteam===team),defense=selected.filter(p=>p.defteam===team);
  return {offense:teamMetrics(offense),defense:teamMetrics(defense),...participants(offense,positions,names)};
 };
 return {team,week:week??null,cutoff:cutoffDate,season:{gameIds:games.map(g=>g.id),...period(snaps)},last3:{gameIds:[...recent],...period(snaps.filter(p=>recent.has(p.game_id)))},
  coverage:{eligibleEvents:eligible.length,competitiveSnaps:snaps.length,excludedEvents:eligible.length-snaps.length,games:games.length},
  definitions:{conversions:'Third/fourth down first down or offensive touchdown (td_team equals posteam) among plays with both outcome flags observed.',explosive:'At least 10 yards on a carry or 20 yards on other offensive plays, among observed yards_gained.',charting:'FTN Data via nflverse, CC-BY-SA 4.0. Rates exclude uncharted fields; motion/RPO use competitive snaps, play action/screens/blitz use dropbacks. Blitz means n_blitzers > 0, not pressure. Drops use catchable targets with observed drop status.',rates:'Fractions; null denotes an unavailable denominator.',success:'EPA > 0 among plays with observed EPA.',dropbacks:'qb_dropback, including sacks and scrambles; excludes kneels, spikes and two-point attempts.',targets:'Competitive plays with receiver_player_id; target shares use identified team targets.',carries:'rush_attempt including quarterback scrambles; shares use team carries.',proe:'Mean qb_dropback minus xpass on covered dropback or rush plays.',defense:'Opponent production allowed; positive EPA is favorable to the opposing offense.',neutralEarlyDowns:'First or second down with pre-play score differential within seven points.',redZone:'Pre-play yardline_100 from 0 through 20.',endZoneTargets:'Air yards reach or exceed the distance to the goal line; requires both fields.',deepTargets:'Air yards >= 20.',sackHitProxy:'Union of sacks and QB hits where both fields are observed; not charted pressures.',routes:'Routes run and yards per route run require external charting and are unavailable.'},
 };
}
