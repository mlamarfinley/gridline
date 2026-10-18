import test from 'node:test';import assert from 'node:assert/strict';
import {scriptContextTeam,contextualScript} from '../src/scriptContext.js';
import {forecastScript} from '../src/gameScript.js';
const t={impliedPts:24,v12:{points:{team:28}},cards:[{pos:'QB',name:'QB',stats:{pass_yds:{available:true,proj:250,seasonAvg:220,seasonGames:4,book:{line:270}}}}],units:{edges:[{label:'Pass protection vs pass rush',edge:20}]}};
test('context uses team scoring, player forecasts, posted lines and unit matchups with attribution',()=>{const r=scriptContextTeam(t);assert(r.points>24);assert.equal(r.groups.length,4);assert.equal(r.coverage.playerLines,1);});
test('receiving totals are not double counted and unavailable inputs do not invent an adjustment',()=>{assert.equal(scriptContextTeam({impliedPts:24}).points,24);assert.deepEqual(scriptContextTeam({...t,cards:[...t.cards,{pos:'WR',stats:{rec_yds:{available:true,proj:900,seasonAvg:1,seasonGames:5}}}]}),scriptContextTeam(t));});
test('context remains separate from immutable baseline timeline',()=>{const base=forecastScript({homePoints:24,awayPoints:20});const copy=structuredClone(base);const c=contextualScript(base,t,{impliedPts:20});assert.deepEqual(base,copy);assert.equal(c.version,'script-context-1');assert.equal(c.points.length,61);assert.equal(c.points[60].home,c.inputs.home.points);});
