import test from 'node:test';
import assert from 'node:assert/strict';
import {matchupUnitData,matchupUnitsBlock} from '../public/matchupUnits.js';
const fixture=()=>({mode:'pregame',kickoff:'2026-10-25',away:{abbr:'AWY',units:{ratings:{off:{wr:70,passing:80},def:{coverage:50}}}},home:{abbr:'HME',units:{ratings:{off:{wr:52},def:{coverage:55}}}},lineGrades:{away:{olPass:{score:80},dlPass:{score:60},olRun:{score:40}},home:{dlPass:{score:45},olPass:{score:50},dlRun:{score:65}}}});
test('duels compare opposing units with the correct direction and benefit',()=>{
 const d=matchupUnitData(fixture());
 const protection=d.duels.find(x=>x.side==='away'&&x.label.startsWith('Protection'));
 assert.equal(protection.gap,35);assert.equal(protection.winner,'AWY');assert.match(protection.note,/More time/);
 const run=d.duels.find(x=>x.side==='away'&&x.label.startsWith('Run'));
 assert.equal(run.gap,-25);assert.equal(run.winner,'HME');assert.match(run.note,/squeeze/);
 const close=d.duels.find(x=>x.side==='home'&&x.label.startsWith('Receivers'));
 assert.equal(close.gap,2);assert.match(close.note,/no clear advantage/);
});
test('missing or invalid ratings produce no invented edges; zero stays valid',()=>{
 const m=fixture();m.lineGrades.away.olPass.score=null;m.lineGrades.home.olPass.score=NaN;m.away.units.ratings.off.wr=0;
 const d=matchupUnitData(m);assert.ok(!d.duels.some(x=>x.label.startsWith('Protection')));
 assert.equal(d.duels.find(x=>x.side==='away'&&x.label.startsWith('Receivers')).gap,-55);
 assert.equal(matchupUnitData({away:{},home:{}}),null);
});
test('game comparison shows only the matchup teams and labels retrospective context',()=>{
 const m=fixture();m.mode='retrospective';const html=matchupUnitsBlock(m);
 assert.match(html,/When AWY has the ball/);assert.match(html,/When HME has the ball/);assert.match(html,/Rebuilt pregame ratings/);
 assert.match(html,/QB \/ passing/);assert.match(html,/not win probabilities/);assert.doesNotMatch(html,/unit-category/);
 m.away.abbr='<img>';assert.doesNotMatch(matchupUnitsBlock(m),/<img>/);
});
