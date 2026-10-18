import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentalForecast, addExperimental } from '../src/experimental.js';
const stat={key:'rush_yds',proj:60,p10:10,p90:150,seasonAvg:60,seasonGames:5,last5:[50,60,70,80,90].map(value=>({value}))};
const card={pos:'RB',usageHistory:{games:5,carries:12,last:{carries:18}},ratings:{skills:[{rating:70,noData:false}]}};
const team={units:{edges:[{label:'Run game',edge:20}]}};
test('aligned evidence increases forecast within cap and preserves baseline',()=>{const r=experimentalForecast(stat,card,team);assert(r.projection>60&&r.projection<=75);assert.equal(stat.proj,60);assert(r.signals.length>=3);});
test('negative evidence can lower a projection',()=>{const s={...stat,last5:[60,50,40,30,20].map(value=>({value}))};const c={...card,usageHistory:{games:5,carries:15,last:{carries:5}},ratings:{skills:[{rating:30}]}};assert(experimentalForecast(s,c,{units:{edges:[{label:'Run game',edge:-30}]}}).projection<60);});
test('no data means no invented adjustment and unsupported stats stay out',()=>{assert.equal(experimentalForecast({key:'rush_yds',proj:60},{},{}).projection,60);assert.equal(experimentalForecast({...stat,key:'rush_td'},card,team),null);});
test('target outcomes and book line cannot influence forecast',()=>{const a=experimentalForecast(stat,card,team);const b=experimentalForecast({...stat,book:{line:999},actual:999},{...card,actual:{rush_yds:999}},team);assert.deepEqual(a,b);});
test('thin history and questionable availability reduce adjustment',()=>{const a=experimentalForecast(stat,card,team);const b=experimentalForecast({...stat,seasonGames:1},{...card,injury:{status:'Questionable'}},team);assert(Math.abs(b.projection-60)<Math.abs(a.projection-60));});

test('experimental receiving totals cannot exceed the quarterback forecast',()=>{
  const t={cards:[{pos:'QB',stats:{pass_yds:{...stat,key:'pass_yds',available:true,proj:100,seasonAvg:100,last5:[],situational:{value:60}}}},{...card,pos:'WR',stats:{rec_yds:{...stat,key:'rec_yds',available:true,proj:65}}},{...card,pos:'WR',stats:{rec_yds:{...stat,key:'rec_yds',available:true,proj:35}}}]};
  addExperimental(t);
  const total=t.cards.slice(1).reduce((n,c)=>n+c.stats.rec_yds.experimental.projection,0);
  assert(total<=t.cards[0].stats.pass_yds.experimental.projection+1e-9);
});
test('rounding never breaches the 25 percent cap for tiny forecasts',()=>{
  const s={...stat,proj:0.3,seasonAvg:0.1};const x=experimentalForecast(s,card,team);assert(x.projection<=0.375&&x.projection>=0.225);
});
