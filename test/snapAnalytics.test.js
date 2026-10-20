import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSnaps } from '../src/snapAnalytics.js';
const options = {team:'BUF',week:6,cutoff:'2026-10-15',positions:{q:'QB',w:'WR',r:'RB'},names:{w:'Wide Receiver'}};
const play = (id, extra={}) => ({game_id:'g1',play_id:id,game_date:'2026-09-10',season_type:'REG',week:1,posteam:'BUF',defteam:'NYJ',play_type:'pass',qb_dropback:1,pass_attempt:1,rush_attempt:0,down:1,ydstogo:10,score_differential:0,yardline_100:50,epa:0, ...extra});

test('dropbacks include sacks and scrambles while shares use identified targets and carries',()=>{
 const data=summarizeSnaps([
 play(1,{passer_player_id:'q',receiver_player_id:'w',complete_pass:1,receiving_yards:25,air_yards:20,yards_after_catch:5,epa:2,xpass:.6}),
 play(2,{passer_player_id:'q',receiver_player_id:'r',complete_pass:0,air_yards:0,epa:-1,xpass:.6}),
 play(3,{passer_player_id:'q',sack:1,pass_attempt:1,epa:-2,xpass:.6}),
 play(4,{passer_player_id:null,rusher_player_id:'q',qb_scramble:1,rush_attempt:1,pass_attempt:0,epa:1,xpass:.6}),
 play(5,{play_type:'run',qb_dropback:0,pass_attempt:0,rush_attempt:1,rusher_player_id:'r',rushing_yards:4,epa:null,xpass:null}),
 play(6,{no_play:1}),play(7,{qb_kneel:1}),play(8,{qb_spike:1}),play(9,{two_point_attempt:1})
 ],options).season;
 assert.equal(data.offense.snaps,5);assert.equal(data.offense.dropbacks,4);assert.equal(data.offense.passAttempts,2);
 assert.equal(data.offense.carries,2);assert.equal(data.offense.designedRushes,1);
 assert.deepEqual(data.offense.epa,{sum:0,plays:4,perPlay:0});
 assert.deepEqual(data.offense.success,{count:2,plays:4,rate:.5});
 assert.equal(data.offense.proe.plays,4); assert.ok(Math.abs(data.offense.proe.value-.4)<1e-12);
 assert.equal(data.players.w.targetShare,.5);assert.equal(data.players.r.carryShare,.5);
 assert.equal(data.players.q.dropbacks,4);assert.equal(data.players.w.adot,20);
 assert.equal(data.players.w.name,'Wide Receiver');assert.equal(data.positions.WR.targets,1);
 assert.equal(data.players.w.routesRun,null);assert.equal(data.players.w.yprr,null);
});

test('excludes duplicates, future weeks, cutoff dates and postseason; last3 uses team games',()=>{
 const rows=[play(1),play(1),play(2,{week:6}),play(3,{game_date:'2026-10-15'}),play(4,{season_type:'POST'}),
 play(1,{game_id:'g2',week:2,game_date:'2026-09-17'}),play(1,{game_id:'g3',week:3,game_date:'2026-09-24'}),play(1,{game_id:'g4',week:4,game_date:'2026-10-01',posteam:'NYJ',defteam:'BUF'})];
 const data=summarizeSnaps(rows,options);
 assert.equal(data.season.offense.snaps,3);assert.equal(data.season.defense.snaps,1);
 assert.equal(data.last3.offense.snaps,2);assert.equal(data.last3.defense.snaps,1);
 assert.deepEqual(data.last3.gameIds,['g2','g3','g4']);
});

test('missing data remains distinct from measured zero and unknown positions remain accounted for',()=>{
 const data=summarizeSnaps([play(1,{receiver_player_id:'u',epa:null,air_yards:null,xpass:null})],options).season;
 assert.deepEqual(data.offense.epa,{sum:null,plays:0,perPlay:null});assert.equal(data.offense.success.rate,null);
 assert.equal(data.offense.proe.value,null);assert.equal(data.players.u.adot,null);
 assert.equal(data.positions.UNKNOWN.targets,1);assert.equal(data.players.u.targetShare,1);
 assert.equal(data.players.u.carryShare,null);assert.equal(data.players.u.receivingYards,null);
 assert.doesNotThrow(()=>JSON.stringify(data));
});

test('situational buckets and specialty shares use pre-play fields with covered denominators',()=>{
 const data=summarizeSnaps([
 play(1,{receiver_player_id:'w',down:3,ydstogo:2,yardline_100:10,air_yards:12,score_differential:10,epa:1}),
 play(2,{receiver_player_id:'r',down:2,ydstogo:5,yardline_100:20,air_yards:0,score_differential:-10,epa:-1}),
 play(3,{receiver_player_id:'w',down:1,ydstogo:10,yardline_100:80,air_yards:25,epa:0}),
 play(4,{play_type:'run',qb_dropback:0,rush_attempt:1,pass_attempt:0,rusher_player_id:'r',yardline_100:5}),
 ],options).season;
 assert.equal(data.players.w.redZoneTargetShare,.5);assert.equal(data.players.w.endZoneTargets,1);assert.equal(data.players.w.deepTargets,1);
 assert.equal(data.players.r.redZoneCarryShare,1);assert.equal(data.offense.splits.down['3'].snaps,1);
 assert.equal(data.offense.splits.distance.short.snaps,1);assert.equal(data.offense.splits.score.trailing.snaps,1);
 assert.equal(data.offense.splits.redZone.snaps,3);assert.equal(data.offense.splits.neutralEarlyDowns.snaps,2);
});

test('FTN charting excludes unknowns and separates blitz from pressure',()=>{
 const offense=summarizeSnaps([
 play(1,{receiver_player_id:'w',charting:{is_motion:1,is_play_action:1,n_blitzers:2,is_catchable_ball:1,is_drop:1}}),
 play(2,{receiver_player_id:'w',charting:{is_motion:0,is_play_action:0,n_blitzers:0,is_catchable_ball:0,is_drop:0}}),
 play(3,{charting:{is_motion:null,is_play_action:null,n_blitzers:null}}),
 play(4,{play_type:'run',qb_dropback:0,rush_attempt:1,pass_attempt:0,charting:{is_motion:1,is_play_action:1}})
 ],options).season.offense;
 assert.deepEqual(offense.charting.motion,{count:2,plays:3,rate:2/3});
 assert.deepEqual(offense.charting.playAction,{count:1,plays:2,rate:.5});
 assert.deepEqual(offense.charting.blitz,{count:1,plays:2,rate:.5});
 assert.deepEqual(offense.charting.dropRate,{count:1,plays:1,rate:1});
 assert.deepEqual(offense.charting.screen,{count:0,plays:0,rate:null});
 assert.equal(offense.charting.pressureRate,null);
});

test('conversion and explosive rates require observed outcome fields',()=>{
 const offense=summarizeSnaps([
 play(1,{down:3,first_down:1,touchdown:0,yards_gained:20}),
 play(2,{down:4,first_down:0,touchdown:0,yards_gained:3}),
 play(3,{down:3,first_down:null,touchdown:null,yards_gained:null}),
 play(4,{play_type:'run',qb_dropback:0,pass_attempt:0,rush_attempt:1,yards_gained:10}),
 ],options).season.offense;
 assert.deepEqual(offense.conversions,{count:1,plays:2,rate:.5});
 assert.deepEqual(offense.explosive,{count:2,plays:3,rate:2/3});
});

test('defensive touchdowns do not convert an offensive third down',()=>{
 const offense=summarizeSnaps([
 play(1,{down:3,first_down:0,touchdown:1,td_team:'NYJ',interception:1}),
 play(2,{down:3,first_down:0,touchdown:1,td_team:'BUF'}),
 play(3,{down:3,first_down:1,touchdown:0}),
 ],options).season.offense;
 assert.deepEqual(offense.conversions,{count:2,plays:3,rate:2/3});
});

test('canonical play_deleted events cannot contribute competitive snaps',()=>{
 const data=summarizeSnaps([play(1,{play_deleted:1,receiver_player_id:'w'}),play(2,{play_deleted:0,receiver_player_id:'r'})],options);
 assert.equal(data.season.offense.snaps,1);assert.equal(data.season.players.w,undefined);
 assert.equal(data.season.players.r.targetShare,1);
});

test('joint situations overlap and use called plays rather than scramble carries as run denominators',()=>{
 const rows=[
 play(101,{down:1,ydstogo:10,play_type:'run',qb_dropback:0,pass_attempt:0,rush_attempt:1,yardline_100:15}),
 play(102,{down:1,ydstogo:10,play_type:'run',qb_dropback:0,pass_attempt:0,rush_attempt:1,yardline_100:85}),
 play(103,{down:1,ydstogo:5,play_type:'run',qb_dropback:0,pass_attempt:0,rush_attempt:1,yardline_100:5}),
 play(104,{down:1,ydstogo:10,qb_scramble:1,rush_attempt:1,pass_attempt:0,yardline_100:60}),
 play(105,{down:3,ydstogo:8,yardline_100:80,qtr:2,quarter_seconds_remaining:120}),
 play(106,{down:3,ydstogo:8,yardline_100:40,qtr:4,quarter_seconds_remaining:121}),
 play(107,{down:3,ydstogo:3,yardline_100:20}),play(108,{down:3,ydstogo:6,yardline_100:50}),
 play(109,{down:2,ydstogo:7,yardline_100:null,qtr:4,quarter_seconds_remaining:null}),
 play(110,{down:4,ydstogo:1,yardline_100:null,qtr:1,quarter_seconds_remaining:30}),
 ];
 const s=summarizeSnaps(rows,options).season.offense.situations;
 assert.equal(s.firstDown.runRate,.75);assert.equal(s.firstDown.playCallPlays,4);
 assert.equal(s.firstAnd10.runRate,2/3);assert.equal(s.firstDownRedZone.snaps,2);
 assert.equal(s.thirdAndLong.snaps,2);assert.equal(s.thirdAndLong.runRate,0);
 assert.equal(s.thirdLongOwnHalf.snaps,1);assert.equal(s.thirdAndShort.snaps,1);assert.equal(s.thirdAndMedium.snaps,1);
 assert.equal(s.backedUp.snaps,2);assert.equal(s.opponentTerritory.snaps,4);
 assert.equal(s.redZone.snaps,3);assert.equal(s.goalLine.snaps,1);assert.equal(s.twoMinute.snaps,1);
 assert.equal(s.secondAndLong.snaps,1);assert.equal(s.fourthDown.snaps,1);
 const defense=summarizeSnaps(rows.map(p=>({...p,posteam:'NYJ',defteam:'BUF'})),options).season.defense.situations;
 assert.equal(defense.firstDown.runRate,.75);
});

test('situational play families exclude unknown charting and classify observed run gaps and air yards',()=>{
 const run=(id,x)=>play(id,{play_type:'run',qb_dropback:0,pass_attempt:0,rush_attempt:1,...x});
 const s=summarizeSnaps([
 run(201,{run_location:'middle',shotgun:0,no_huddle:1}),run(202,{run_location:'left',run_gap:'guard'}),
 run(203,{run_location:'right',run_gap:'tackle'}),run(204,{run_location:'left',run_gap:'end'}),run(205,{run_location:'left',run_gap:null}),
 play(206,{receiver_player_id:'w',air_yards:20,shotgun:1,no_huddle:0,charting:{is_play_action:1,is_screen_pass:0,is_rpo:1}}),
 play(207,{receiver_player_id:'w',air_yards:-2,charting:{is_play_action:0,is_screen_pass:1,is_rpo:0}}),
 play(208,{sack:1,air_yards:null}),play(209,{qb_scramble:1,rush_attempt:1,air_yards:null,run_location:'middle'}),
 ],options).season.offense.situations;
 assert.deepEqual(s.firstDown.playFamilies.insideRun,{count:3,plays:4,rate:.75});
 assert.deepEqual(s.firstDown.playFamilies.outsideRun,{count:1,plays:4,rate:.25});
 assert.deepEqual(s.firstDown.playFamilies.deepPass,{count:1,plays:2,rate:.5});
 assert.deepEqual(s.firstDown.playFamilies.shortPass,{count:1,plays:2,rate:.5});
 assert.deepEqual(s.firstDown.playFamilies.shotgun,{count:1,plays:2,rate:.5});
 assert.deepEqual(s.firstDown.playFamilies.noHuddle,{count:1,plays:2,rate:.5});
 assert.deepEqual(s.firstDown.playFamilies.playAction,{count:1,plays:2,rate:.5});
 assert.deepEqual(s.firstDown.playFamilies.screen,{count:1,plays:2,rate:.5});
 assert.deepEqual(s.firstDown.playFamilies.rpo,{count:1,plays:2,rate:.5});
 assert.equal(s.thirdAndLong.runRate,null);assert.deepEqual(s.thirdAndLong.playFamilies.deepPass,{count:0,plays:0,rate:null});
});
