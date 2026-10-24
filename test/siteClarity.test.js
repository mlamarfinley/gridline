import test from 'node:test'; import assert from 'node:assert/strict';
import { leaderOutlook, countRate, collectTeamRatings } from '../public/siteClarity.js';
import { MATCHUP_TABS } from '../public/matchupLayout.js';
test('player cards are the default and sources tab is removed',()=>{assert.equal(MATCHUP_TABS[0][0],'players');assert.ok(!MATCHUP_TABS.some(t=>t[0]==='sources'));});
test('leader outlook uses forecast probabilities, distinguishes ties and missing data',()=>{assert.equal(leaderOutlook({homeProbability:.2,awayProbability:.6,tieProbability:.2},'A','H').team,'A');assert.equal(leaderOutlook({homeProbability:.3,awayProbability:.3,tieProbability:.4},'A','H').team,'Tied');assert.equal(leaderOutlook(null,'A','H'),null);assert.equal(leaderOutlook({homeProbability:.4,awayProbability:.4,tieProbability:.2},'A','H').team,'Even');});
test('count percentages use specified denominators and do not invent missing rates',()=>{assert.equal(countRate(75,100),'75 · 75.0%');assert.equal(countRate(0,100),'0 · 0.0%');assert.equal(countRate(0,0),'0 · —');assert.equal(countRate(null,100),'—');});
test('team ratings preserve existing units, choose newest snapshot, do not fill missing ratings',()=>{const team={abbr:'A',name:'Alpha',units:{ratings:{off:{passing:70},def:{runD:60,passRush:50,coverage:40}}}}; const m={kickoff:'2026-10-20',week:6,home:team,away:{abbr:'B'},lineGrades:{home:{olRun:{score:75}}}};const rows=collectTeamRatings([m,{...m,kickoff:'2026-10-10',home:{...team,units:null}}]);assert.equal(rows.find(r=>r.abbr==='A').scores.qb,70);assert.equal(rows.find(r=>r.abbr==='A').scores.defense,50);assert.equal(rows.find(r=>r.abbr==='A').scores.olRun,75);assert.equal(rows.find(r=>r.abbr==='B').scores.qb,null);});
test('ratings categories and forecast cards expose forecasts before result details',async()=>{
 const {forecastCard,teamRatingsBlock}=await import('../public/siteClarity.js');
 const p={minute:60,clock:'End Q4',away:20,home:10,awayProbability:.7,homeProbability:.2,tieProbability:.1};
 const html=forecastCard({id:'123',away:'A',home:'B',kickoff:'2026-10-25T17:00Z',forecast:{points:[p]},status:'pending'},'Minute details');
 assert.match(html,/Most likely regulation result/);assert.match(html,/70.0%/);assert.ok(html.indexOf('70.0%')<html.indexOf('Every minute'));
 assert.match(teamRatingsBlock([]),/Team ratings unavailable/);
 assert.match(teamRatingsBlock([{abbr:'A',scores:{qb:0}}]),/data-unit-group="offense"/);
});
test('minute detail pairs saved predictions with matching actual clocks',async()=>{
 const {minuteTrackTable}=await import('../public/siteClarity.js');
 const html=minuteTrackTable({away:'A',home:'H',forecast:{points:[{minute:0,clock:'Kickoff'},{minute:1,clock:'Q1 14:00',away:3,home:0,awayProbability:.6,homeProbability:.1,tieProbability:.3,likelyLeader:'away'}]},actual:{complete:true,points:[{minute:1,away:0,home:7,leader:'home'}]}});
 assert.match(html,/Q1 14:00/);assert.match(html,/60.0%/);assert.match(html,/Incorrect/);assert.doesNotMatch(html,/Kickoff/);
});
test('performance summary identifies original snapshot and denominators',async()=>{
 const {performanceBlock}=await import('../public/siteClarity.js');
 const m={home:{abbr:'CHI'},away:{abbr:'NE'},status:{completed:true}};
 const r={forecastTimestamp:'2026-10-20T17:22:07Z',forecast:{points:[{minute:60,home:24.9,away:23.5}]},review:{finalWinnerCorrect:true,checkpointAccuracy:47/60,checkpointCount:60,scoreMAE:3.518333}};
 const html=performanceBlock(m,r);assert.match(html,/47 \/ 60/);assert.match(html,/78.3%/);assert.match(html,/3.52/);assert.match(html,/First saved forecast/);assert.equal(performanceBlock({...m,status:{completed:false}},r),'');
});
test('ungraded result is pending, never an incorrect prediction',async()=>{const {performanceBlock}=await import('../public/siteClarity.js');const html=performanceBlock({status:{completed:true},away:{abbr:'A'},home:{abbr:'H'}},{forecastTimestamp:'2026-10-20',review:{finalWinnerCorrect:null,checkpointCount:0}});assert.match(html,/Pending/);assert.doesNotMatch(html,/Incorrect/);});
test('general ratings expose selectable line and defense views with matching selected controls',async()=>{
 const {teamRatingsBlock}=await import('../public/siteClarity.js');
 for(const category of ['offense','defense','lines','all']){const html=teamRatingsBlock([{abbr:'A',scores:{olRun:75,dlPass:60}}],category);assert.ok(html.includes(`data-category="${category}"`));assert.ok(html.includes(`<option value="${category}" selected>`));assert.match(html,/OL run/);assert.match(html,/DL pass rush/);}
 assert.match(teamRatingsBlock([], '<bad>'),/data-category="offense"/);
});
