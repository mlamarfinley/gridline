import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeSnapRow,normalizeChartingRow} from '../src/snapData.js';
test('snap normalization retains IDs and missing numeric fields without inventing zero',()=>{
 const r=normalizeSnapRow({game_id:'2026_06_A_B',play_id:'22',week:'6',posteam:'A',qb_dropback:'1',epa:'NA',air_yards:'',yards_gained:'0',receiver_player_id:'00-001',desc:'a play'});
 assert.equal(r.play_id,22);assert.equal(r.receiver_player_id,'00-001');assert.equal(r.qb_dropback,1);assert.equal(r.epa,null);assert.equal(r.air_yards,null);assert.equal(r.yards_gained,0);assert.equal(r.desc,'a play');
});
test('FTN false is a measured zero and blank is missing',()=>{const r=normalizeChartingRow({is_motion:'FALSE',is_rpo:'TRUE',is_drop:'',n_blitzers:'2'});assert.equal(r.is_motion,0);assert.equal(r.is_rpo,1);assert.equal(r.is_drop,null);assert.equal(r.n_blitzers,2);});
