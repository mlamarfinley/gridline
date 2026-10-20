import test from 'node:test';
import assert from 'node:assert/strict';
import { trackedPlayerStat } from '../public/trackingPolicy.js';
test('NFL QB rushing is excluded without affecting passing, RB rushing, or college',()=>{
 for(const stat of ['carries','rush_yds','rush_td','long_rush','ypc'])assert.equal(trackedPlayerStat('nfl','QB',stat),false);
 assert.equal(trackedPlayerStat('nfl','QB','pass_yds'),true);
 assert.equal(trackedPlayerStat('nfl','RB','rush_yds'),true);
 assert.equal(trackedPlayerStat('cfb','QB','rush_yds'),true);
});
