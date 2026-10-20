import test from 'node:test';import assert from 'node:assert/strict';import{experimentalForecast}from'../src/experimental.js';
test('measured snap share trend enters workload evidence without duplicate legacy share votes',()=>{
 const s={key:'rec_yds',proj:60,seasonGames:6};const c={pos:'WR',deepUsage:{season:{targetShare:.15,targets:30},last3:{targetShare:.3,targets:20}},shareTrend:[{target:.1},{target:.2},{target:.8}]};
 const out=experimentalForecast(s,c,{});assert(out.projection>60);const group=out.signals.find(s=>s.group==='Workload trend');assert(group.evidence.some(x=>x.includes('snap-derived')));assert.equal(group.evidence.filter(x=>x.includes('share')).length,1);
});
