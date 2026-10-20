import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreTimeline,forecastScript,compareScript,quarterProfile} from '../src/gameScript.js';
const summary={header:{competitions:[{status:{type:{completed:true}},competitors:[{homeAway:'home',score:'7'},{homeAway:'away',score:'3'}]}]},scoringPlays:[{id:'a',period:{number:1},clock:{displayValue:'10:00'},homeScore:0,awayScore:3},{id:'b',period:{number:2},clock:{displayValue:'5:00'},homeScore:7,awayScore:3}],drives:{previous:[]}};
test('actual timeline measures time ahead and quarter scores from scoring clock',()=>{const r=scoreTimeline(summary);assert.equal(r.complete,true);assert.equal(r.leadSeconds.home,2100);assert.equal(r.leadSeconds.away,1200);assert.equal(r.leadSeconds.tie,300);assert.equal(r.points[15].away,3);assert.equal(r.points[30].home,7);assert.equal(r.leadChanges,1);});
test('missing and inconsistent score feeds are not graded as complete',()=>{assert.equal(scoreTimeline({...summary,scoringPlays:[]}).complete,false);assert.equal(scoreTimeline({}).available,false);});
test('forecast is seeded, normalized and separates generated time from game clock',()=>{const args={homePoints:24,awayPoints:20,homeProfile:[.1,.2,.3,.4],awayProfile:[.4,.3,.2,.1],seed:'fixture',generatedAt:'2026-10-17T12:00:00Z'};const r=forecastScript(args);assert.deepEqual(r,forecastScript(args));assert.equal(r.points.length,61);assert.equal(r.points[0].tieProbability,1);assert.equal(r.points[60].home,24);assert(r.points[15].away>r.points[15].home);assert(r.points[60].home>r.points[60].away);for(const p of r.points)assert(Math.abs(p.homeProbability+p.awayProbability+p.tieProbability-1)<1e-10);});
test('historical quarter profiles ignore target and future games',()=>{const g=[{eventId:'old',date:'2026-09-01',endTime:{end:'2026-09-02'},isHome:true,scoringEvents:[{elapsed:100,home:14,away:0}]}];assert.deepEqual(quarterProfile([...g,{...g[0],date:'2027-01-01',eventId:'future'}],'2026-10-01'),quarterProfile(g,'2026-10-01'));});
test('review never reconstructs an old minute forecast and can grade a saved one',()=>{const actual=scoreTimeline(summary);const old=compareScript({expectedHomeMargin:4},actual);assert.equal(old.checkpointAccuracy,null);assert.equal(old.finalWinnerCorrect,true);const forecast=forecastScript({homePoints:7,awayPoints:3,seed:'a'});assert.equal(compareScript({forecast,expectedHomeMargin:4},actual).checkpointCount,60);});

test('overtime affects final winner but not regulation clock accuracy or lead durations',()=>{
 const s=structuredClone(summary);s.header.competitions[0].competitors[0].score='10';s.header.competitions[0].competitors[1].score='7';
 s.scoringPlays.push({id:'c',period:{number:4},clock:{displayValue:'0:00'},homeScore:7,awayScore:7},{id:'d',period:{number:5},clock:{displayValue:'6:00'},homeScore:10,awayScore:7});
 const a=scoreTimeline(s);assert(a.complete);assert(a.overtime);assert.equal(a.points[60].leader,'tie');assert.equal(a.finalLeader,'home');assert.equal(Object.values(a.leadSeconds).reduce((x,y)=>x+y),3600);assert.equal(a.events[0].wallclock,null);
});

test('regulation-only challenger grading excludes overtime winner and margin',()=>{
 const actual={complete:true,finalHome:27,finalAway:24,finalLeader:'home',points:[{minute:60,home:24,away:24,leader:'tie'}]};
 const r=compareScript({expectedHomeMargin:0},actual,{regulationOnly:true});assert.equal(r.finalWinnerCorrect,true);assert.equal(r.actualHomeMargin,0);assert.equal(r.marginError,0);
});
