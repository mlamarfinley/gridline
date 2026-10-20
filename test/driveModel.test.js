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
