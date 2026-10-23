import test from 'node:test';import assert from 'node:assert/strict';
import {summaryRows} from '../public/matchupLayout.js';
test('summary preserves zero, missing experimental values, actuals and original input',()=>{
 const m={away:{abbr:'A',cards:[{id:'1',name:'Player',pos:'RB',primary:'rush_yds',stats:{rush_yds:{available:true,label:'Rushing yards',proj:0,experimental:{projection:0},book:{line:0}}},actual:{rush_yds:0}}]},home:{abbr:'B',cards:[{id:'2',name:'Other',pos:'WR',primary:'rec_yds',stats:{rec_yds:{available:true,proj:3}}}]}};
 const before=JSON.stringify(m),rows=summaryRows(m);assert.equal(rows[0].experimental,0);assert.equal(rows[0].actual,0);assert.equal(rows[0].line,0);assert.equal(rows[1].experimental,null);assert.equal(rows[1].actual,null);assert.equal(JSON.stringify(m),before);
});
test('summary skips unavailable stats and deduplicates repeated player cards',()=>{const c={id:'1',primary:'rec_yds',stats:{rec_yds:{available:true,proj:2}}};assert.equal(summaryRows({away:{cards:[c,c]},home:{cards:[{id:'2',stats:{}}]}}).length,1);});
