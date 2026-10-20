import test from 'node:test';
import assert from 'node:assert/strict';
import { trackedPlayerStat, applyTrackingScope } from '../public/trackingPolicy.js';
test('NFL QB rushing is excluded without affecting passing, RB rushing, or college',()=>{
 for(const stat of ['carries','rush_yds','rush_td','long_rush','ypc'])assert.equal(trackedPlayerStat('nfl','QB',stat),false);
 assert.equal(trackedPlayerStat('nfl','QB','pass_yds'),true);
 assert.equal(trackedPlayerStat('nfl','RB','rush_yds'),true);
 assert.equal(trackedPlayerStat('cfb','QB','rush_yds'),true);
});
test('active NFL picks follow planned roles and exclude incidental extremes',()=>{
 for(const p of ['QB','WR','TE'])for(const k of ['rush_yds','carries','rush_td','long_rush','ypc'])assert.equal(trackedPlayerStat('nfl',p,k),false);
 for(const p of ['QB','RB','WR','TE'])for(const k of ['fumbles','fumbles_lost','long_rec','long_cmp','long_rush','ints'])assert.equal(trackedPlayerStat('nfl',p,k),false);
 for(const k of ['rush_yds','rec_yds','receptions','targets','carries','rush_td'])assert.equal(trackedPlayerStat('nfl','RB',k),true);
 assert.equal(trackedPlayerStat('nfl','WR','rec_yds'),true);assert.equal(trackedPlayerStat('nfl','QB','pass_td'),true);
});

test('player visibility filtering preserves incidental model data and game script inputs',()=>{
 const stats={pass_yds:{projection:240},ints:{projection:0.8},fumbles_lost:{projection:0.2},rush_yds:{projection:15}};
 const params={intRate:0.02,qbFumblePerSack:0.1};const gameScript={inputs:{home:{tracked:{intRate:0.02}}}};
 const matchup={league:'nfl',home:{params,cards:[{pos:'QB',stats,compact:Object.keys(stats),statOrder:Object.keys(stats)}]},away:{cards:[]},gameScript};
 const before=structuredClone({stats,params,gameScript});applyTrackingScope(matchup);
 assert.deepEqual(matchup.home.cards[0].statOrder,['pass_yds']);
 assert.deepEqual({stats:matchup.home.cards[0].stats,params:matchup.home.params,gameScript:matchup.gameScript},before);
});
