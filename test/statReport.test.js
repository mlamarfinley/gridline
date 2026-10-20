import test from 'node:test';import assert from 'node:assert/strict';
import { positionStatReport } from '../src/statReport.js';
const row=(position,stat,projection,actual,book_line=10)=>({league:'nfl',position,stat,projection,actual,book_line,season:2026,week:6,game_id:'g',p10:0,p90:20});
test('separates positions, pushes, missing lines/results and retired QB rushing',()=>{
 const report=positionStatReport([row('RB','rec_yds',12,15),row('RB','rec_yds',8,10),row('RB','rec_yds',8,null),row('WR','rec_yds',12,5),row('RB','rec_yds',8,5,null),row('QB','rush_yds',12,5)]);
 const rb=report.groups.find(g=>g.position==='RB'&&g.stat==='rec_yds');
 assert.equal(rb.wins,1);assert.equal(rb.losses,0);assert.equal(rb.pushes,1);assert.equal(rb.missingActual,1);assert.equal(rb.noLine,1);assert.equal(rb.accuracy,1);
 assert.equal(report.groups.find(g=>g.position==='WR'&&g.stat==='rec_yds').losses,1);
 assert.equal(report.groups.find(g=>g.position==='WR'&&g.stat==='rush_yds').n,0);
 assert(!report.groups.some(g=>g.position==='QB'&&g.stat==='rush_yds'));
});

test('candidate training excludes the evaluated week and requires earlier samples',()=>{
 const train=Array.from({length:30},(_,i)=>({...row('RB','rush_yds',20,10),week:5,game_id:'train'+i}));
 const latest=Array.from({length:10},(_,i)=>({...row('RB','rush_yds',20,15),week:6,game_id:'test'+i}));
 const g=positionStatReport([...train,...latest]).groups.find(g=>g.position==='RB'&&g.stat==='rush_yds');
 assert.equal(g.experiment.shift,-5);assert.equal(g.experiment.candidateMAE,0);assert.equal(g.experiment.baselineMAE,5);
 const altered=positionStatReport([...train,...latest.map(r=>({...r,actual:200}))]).groups.find(g=>g.position==='RB'&&g.stat==='rush_yds');
 assert.equal(altered.experiment.shift,-5,'test outcomes cannot change the fitted shift');
 assert.equal(positionStatReport(latest).groups.find(g=>g.position==='RB'&&g.stat==='rush_yds').experiment,null);
});
