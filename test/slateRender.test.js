import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('home renders the slate without matchup-only state',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('async function renderSlate(');
  const end=source.indexOf('\nfunction setStatus(',start);
  const app={innerHTML:''};const week={innerHTML:''};
  const game={id:'example',date:'2026-10-25',away:{abbr:'A',name:'Away'},home:{abbr:'H',name:'Home'},status:{state:'pre'}};
  const requests=[];
  const context=vm.createContext({state:{routeSeq:1},app,$:()=>week,loading:()=>{},fail:e=>{throw e;},setTitle:()=>{},setStatus:()=>{},esc:String,etDay:String,etStamp:String,etTime:String,am:String,api:async url=>{requests.push(url);return {league:'nfl',week:7,calendar:[],games:[game],meta:{}};}});
  await vm.runInContext(`${source.slice(start,end)}\nrenderSlate('nfl',7)`,context);
  assert.match(app.innerHTML,/NFL · Week 7/);
  assert.match(app.innerHTML,/#\/nfl\/game\/example/);
  assert.deepEqual(requests,['/api/slate?league=nfl&week=7']);
});
