import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDriveLibrary,forecastDriveGame,nextDriveField} from '../src/driveModel.js';
const row=(over={})=>({game_id:'2026_01_A_B',play_id:1,season_type:'REG',week:1,game_date:'2026-09-01',posteam:'A',defteam:'B',fixed_drive:1,qtr:1,game_seconds_remaining:3600,yardline_100:75,play_type:'run',posteam_score:0,defteam_score:0,posteam_score_post:0,defteam_score_post:0,drive_time_of_possession:'3:00',...over});
const rows=[row(),row({play_id:2,game_seconds_remaining:3420,yardline_100:3,posteam_score_post:6,touchdown:1,td_team:'A',fixed_drive_result:'Touchdown'}),row({play_id:3,game_seconds_remaining:3420,play_type:'extra_point',posteam_score:6,posteam_score_post:7,extra_point_result:'good'}),row({play_id:4,fixed_drive:2,posteam:'B',defteam:'A',game_seconds_remaining:3420,yardline_100:70,defteam_score:7,defteam_score_post:7}),row({play_id:5,fixed_drive:2,posteam:'B',defteam:'A',game_seconds_remaining:3300,yardline_100:45,defteam_score:7,defteam_score_post:7,interception:1,fixed_drive_result:'Turnover'})];
test('library excludes target week, late dates, postseason, duplicates; retains actual PAT',()=>{
 const lib=buildDriveLibrary([...rows,rows[0],row({game_id:'target',week:2}),row({game_id:'late',game_date:'2026-09-20'}),row({game_id:'post',season_type:'POST'})],{week:2,cutoff:'2026-09-10'});
 assert.equal(lib.drives.length,2);assert.equal(lib.evidence.games,1);assert.equal(lib.drives[0].offensivePoints,7);assert.equal(lib.drives[0].duration,180);assert.equal(lib.drives[1].turnover,true);
});
test('seeded regulation forecast is finite, reproducible and probabilities sum to one',()=>{
 const drives=buildDriveLibrary(rows,{week:2,cutoff:'2026-09-10'}),opts={drives,home:'A',away:'B',seed:'test',sims:50};const a=forecastDriveGame(opts);assert.deepEqual(a,forecastDriveGame(opts));assert.equal(a.points.length,61);assert.equal(a.points[0].home,0);assert.equal(a.points[0].tieProbability,1);
 for(const p of a.points){assert.ok(Number.isFinite(p.home)&&p.home>=0);assert.ok(Math.abs(p.homeProbability+p.awayProbability+p.tieProbability-1)<1e-9);}assert.ok(a.expectedTurnovers.away>0);assert.ok(a.expectedDrives.home>0);assert.ok(a.scoreQuantiles.home.p10<=a.scoreQuantiles.home.p90);
});
test('field flips on takeaways and downs; kickoffs reset and boundaries clamp',()=>{
 assert.equal(nextDriveField({outcome:'turnover',endField:20,startField:75},75),80);
 assert.equal(nextDriveField({outcome:'downs',endField:30,startField:75},65),80);
 assert.equal(nextDriveField({outcome:'touchdown'},10),70);
 assert.equal(nextDriveField({outcome:'turnover',endField:99,startField:50},99),1);
});
test('empty library is unavailable, never synthetic evidence; sparse teams fall back to league',()=>{
 assert.equal(forecastDriveGame({drives:[],home:'A',away:'B'}).available,false);
 const f=forecastDriveGame({drives:buildDriveLibrary(rows,{week:2,cutoff:'2026-09-10'}),home:'X',away:'Y',sims:5});assert.equal(f.available,true);assert.equal(f.evidence.home.offense,0);assert.ok(Number.isFinite(f.homePoints));
});
test('defensive touchdown returns next possession to original offense after kickoff',()=>{
 const d={duration:300,startField:70,endField:50,offense:'A',defense:'B',startMargin:0,offensivePoints:0,defensivePoints:7,turnover:true,outcome:'turnover',gameId:'one'};
 assert.equal(nextDriveField(d,60),70);
 const f=forecastDriveGame({drives:[d],home:'A',away:'B',seed:'pick6',sims:1});
 // One recipient handles each entire half: six drives and six returned touchdowns.
 assert.equal(f.homePoints,42);assert.equal(f.awayPoints,42);assert.equal(f.points[15].tieProbability,0);
});
test('regulation censors outcomes beyond a half boundary and resets possession',()=>{
 const f=forecastDriveGame({drives:[{duration:1000,startField:70,endField:10,startMargin:0,offense:'A',defense:'B',offensivePoints:7,defensivePoints:0,outcome:'touchdown',gameId:'one'}],home:'A',away:'B',sims:1});
 assert.equal(f.homePoints+f.awayPoints,14);assert.equal(f.points[15].home+f.points[15].away,0);assert.equal(f.points[30].home+f.points[30].away,7);
});
test('defensive TD extra point belongs to scoring possession, never a separate try-only drive',()=>{
 const lib=buildDriveLibrary([row(),row({play_id:2,game_seconds_remaining:3420,interception:1,touchdown:1,td_team:'B',defteam_score_post:6}),row({play_id:3,game_seconds_remaining:3412,play_type:'extra_point',posteam:'B',defteam:'A',posteam_score:6,posteam_score_post:7,extra_point_attempt:1})],{week:2,cutoff:'2026-09-10'});
 assert.equal(lib.drives.length,1);assert.equal(lib.drives[0].offensivePoints,0);assert.equal(lib.drives[0].defensivePoints,7);
});
test('historical period-end censored possessions are excluded from sampling',()=>{
 const d={duration:120,startField:70,endField:50,startMargin:0,offense:'A',defense:'B',offensivePoints:0,defensivePoints:0,outcome:'period_end',gameId:'one'};
 assert.equal(forecastDriveGame({drives:[d],home:'A',away:'B',sims:1}).available,false);
 const lib=buildDriveLibrary([row({play_type:'qb_kneel',qb_kneel:1}),row({play_id:2,play_type:'qb_kneel',qb_kneel:1,game_seconds_remaining:3420})],{week:2,cutoff:'2026-09-10'});
 assert.equal(lib.drives[0].outcome,'period_end');
});

test('ordinary touchdown PAT follows elapsed touchdown snap time',()=>{const data=rows.slice(0,3).map(p=>p.play_id===3?{...p,game_seconds_remaining:3412}:p);const lib=buildDriveLibrary(data,{week:2,cutoff:'2026-09-10'});assert.equal(lib.drives[0].offensivePoints,7);});

const call=(run,down=1,distance=10,field=70)=>({down,distance,field,run,dropback:!run});
const empiricalDrive=(over={})=>({gameId:'past',offense:'A',defense:'Z',duration:300,startField:70,endField:20,startMargin:0,offensivePoints:0,defensivePoints:0,outcome:'punt',...over});
test('v2 archives only competitive observed calls, treating sacks and scrambles as dropbacks',()=>{
 const data=[row({down:1,ydstogo:10,rush_attempt:1,qb_dropback:0,qb_scramble:0}),row({play_id:2,down:3,ydstogo:9,play_type:'pass',qb_dropback:1,sack:1}),row({play_id:3,down:2,ydstogo:7,play_type:'run',qb_dropback:1,rush_attempt:1,qb_scramble:1}),row({play_id:4,down:1,ydstogo:10,qb_dropback:0,rush_attempt:1,qb_kneel:1})];
 const lib=buildDriveLibrary(data,{week:2,cutoff:'2026-09-10'});assert.equal(lib.drives[0].calls.length,3);assert.deepEqual(lib.drives[0].calls.map(c=>[c.run,c.dropback]),[[true,false],[false,true],[false,true]]);assert.equal(lib.drives[0].calls[1].distance,9);
});
test('first-down and third-long probabilities preserve observed distinctions with league shrinkage',()=>{
 const own=[...Array.from({length:80},(_,i)=>call(i<60)),...Array.from({length:20},(_,i)=>call(i<3,3,8,15))];
 const other=[...Array.from({length:80},(_,i)=>call(i<20)),...Array.from({length:20},(_,i)=>call(i<10,3,8,15))];
 const f=forecastDriveGame({drives:[empiricalDrive({calls:own}),empiricalDrive({offense:'C',calls:other})],home:'A',away:'B',sims:10});
 assert.equal(f.version,'empirical-drive-2');const s=f.situationalCalls.home;
 assert.equal(s.firstDown.own.runRate,.75);assert.equal(s.thirdLong.own.runRate,.15);assert.ok(s.firstDown.runProbability>s.thirdLong.runProbability);assert.ok(s.firstDown.runProbability<.75);assert.equal(s.redZone.own.plays,20);
 for(const b of Object.values(s.fieldContexts))if(b.runProbability!=null)assert.ok(Math.abs(b.runProbability+b.dropbackProbability-1)<1e-12);
 assert.ok(s.simulated.plays>0);assert.equal(s.simulated.runs+s.simulated.dropbacks,s.simulated.plays);
});
test('observed tendency history changes sampling and absent call attributes preserve fallback',()=>{
 const drives=Array.from({length:8},(_,i)=>{const run=i<3||i===7;return empiricalDrive({offense:i<4?'A':'C',offensivePoints:run?7:0,outcome:run?'touchdown':'punt',calls:[call(run)]});});
 const options={home:'A',away:'B',sims:2000,seed:'tendency'};
 const conditioned=forecastDriveGame({...options,drives});const fallback=forecastDriveGame({...options,drives:drives.map(({calls,...d})=>d)});
 assert.ok(conditioned.homePoints>fallback.homePoints);assert.equal(fallback.situationalCalls.home.firstDown.runProbability,null);
 const unknown=forecastDriveGame({...options,drives:drives.map(d=>({...d,calls:[{run:true,dropback:false,down:null,distance:null,field:null}]}))});
 assert.deepEqual(unknown.points,fallback.points);
});
test('third-down distance buckets distinguish short medium and long',()=>{
 const f=forecastDriveGame({drives:[empiricalDrive({calls:[call(true,3,3),call(false,3,4),call(false,3,6),call(false,3,7)]})],home:'A',away:'B',sims:1});
 const s=f.situationalCalls.home;assert.equal(s.thirdShort.own.plays,1);assert.equal(s.thirdMedium.own.plays,2);assert.equal(s.thirdLong.own.plays,1);
});
test('simulated call field zones translate from actual sampled starting position',()=>{
 const d=empiricalDrive({startField:20,calls:[call(true,1,10,20)],outcome:'touchdown',offensivePoints:7});
 const f=forecastDriveGame({drives:[d],home:'A',away:'B',sims:1});
 assert.equal(f.situationalCalls.home.redZone.own.plays,1); // observed source remains unchanged
 assert.equal(f.situationalCalls.home.simulated.bySituation.redZone.plays,0);
 assert.equal(f.situationalCalls.home.simulated.bySituation.openField.plays,6);
 assert.equal(d.calls[0].field,20);
});
test('joint call weighting responds to translated field rather than historical field alone',()=>{
 const drives=[];for(const field of [20,70])for(const offense of ['A','C'])for(let i=0;i<4;i++){
  const runs=field===20?(offense==='A'?3:1):(offense==='A'?1:3),run=i<runs;
  drives.push(empiricalDrive({offense,startField:70,calls:[call(run,1,10,field)],outcome:run?'touchdown':'field_goal',offensivePoints:run?7:3}));
 }
 const options={home:'A',away:'B',sims:1000,seed:'translated-field'};
 const original=forecastDriveGame({...options,drives}),translated=forecastDriveGame({...options,drives:drives.map(d=>({...d,startField:20}))});
 assert.deepEqual(original.situationalCalls.home.firstDown,translated.situationalCalls.home.firstDown);
 assert.notEqual(original.homePoints,translated.homePoints);
});
