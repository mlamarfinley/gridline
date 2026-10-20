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
