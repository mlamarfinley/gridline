import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeDistribution, targetChance, targetDistributions, formatChance } from '../public/playerTargets.js';

test('reaching includes ties and preserves negative and zero outcomes', () => {
 const d=outcomeDistribution([-2,0,40,40,80]);
 assert.equal(targetChance(d,40).hits,3);
 assert.equal(targetChance(d,40.5).hits,1);
 assert.equal(targetChance(d,0).hits,4);
 assert.equal(targetChance(d,40).probability,3.5/6);
});
test('chance decreases with higher target and never claims finite-sample certainty', () => {
 const d=outcomeDistribution([0,20,40,80]);
 const ps=[-10,0,20,40,80,100].map(t=>targetChance(d,t).probability);
 assert.ok(ps.every((p,i)=>p>0&&p<1&&(!i||p<=ps[i-1])));
 assert.equal(formatChance(.99999),'>99.9%');
 assert.equal(formatChance(.00001),'<0.1%');
});
test('experimental distribution uses model projection, preserves zeros, ignores book odds', () => {
 const a=targetDistributions([0,40,80],{experimental:{projection:80},book:{line:10,overPrice:-900}});
 const b=targetDistributions([0,40,80],{experimental:{projection:80},book:{line:90,overPrice:500}});
 assert.deepEqual(a,b);
 assert.deepEqual(a.experimental.bins,[[0,1],[80,1],[160,1]]);
 assert.equal(targetChance(a.baseline,80).hits,1);
 assert.equal(targetChance(a.experimental,80).hits,2);
});
test('missing and zero-only samples cannot invent experimental production', () => {
 assert.equal(outcomeDistribution([]),null);
 assert.equal(outcomeDistribution([1,NaN]),null);
 assert.equal(targetChance(null,40),null);
 assert.equal(targetChance(outcomeDistribution([1]),NaN),null);
 assert.equal(targetDistributions([0,0],{experimental:{projection:30}}).experimental,null);
 assert.equal(targetDistributions([1,2],{}).experimental,null);
});

test('controls use model defaults and explain reach semantics without modifying archived games', async () => {
 const {playerTargetBlock}=await import('../public/playerTargets.js');
 const stat={key:'rush_yds',label:'Rushing yards',proj:40,experimental:{projection:80},book:{line:99.5},targetDistribution:targetDistributions([0,40,80],{experimental:{projection:80}})};
 const html=playerTargetBlock({eventId:'game',status:{state:'pre'}},{id:'bijan',name:'Bijan Robinson'},stat);
 assert.match(html,/value="80"/);
 assert.match(html,/type="range"/);
 assert.match(html,/not over 40/);
 assert.match(html,/not been validated/);
 assert.doesNotMatch(html,/99.5/);
 assert.match(playerTargetBlock({status:{state:'post'}},{},stat),/Rebuilt estimate/);
});
