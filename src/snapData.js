// Full source CSV is retained on disk; the typed event view retains every row, including penalties/special teams.
import fs from 'node:fs';
import path from 'node:path';
import {CACHE_DIR} from './config.js';
import {download,streamRows} from './pbp.js';
const BASE='https://github.com/nflverse/nflverse-data/releases/download';
const TEXT=`game_id season_type home_team away_team posteam defteam game_date desc play_type passer_player_id passer_player_name receiver_player_id receiver_player_name rusher_player_id rusher_player_name pass_location run_location run_gap field_goal_result extra_point_result two_point_conv_result td_team drive_end_transition fixed_drive_result drive_time_of_possession drive_start_yard_line drive_end_yard_line start_time time_of_day penalty_type penalty_team` .split(' ');
const NUM=`season week play_id drive fixed_drive qtr game_seconds_remaining half_seconds_remaining quarter_seconds_remaining yardline_100 down ydstogo yards_gained qb_dropback qb_scramble qb_kneel qb_spike pass_attempt rush_attempt sack qb_hit interception fumble fumble_lost safety touchdown pass_touchdown rush_touchdown return_touchdown complete_pass incomplete_pass air_yards yards_after_catch receiving_yards rushing_yards passing_yards epa success cpoe xpass pass_oe shotgun no_huddle penalty penalty_yards first_down first_down_penalty third_down_converted third_down_failed fourth_down_converted fourth_down_failed two_point_attempt extra_point_attempt field_goal_attempt kickoff_attempt punt_attempt special_teams_play play_deleted aborted_play posteam_score defteam_score posteam_score_post defteam_score_post score_differential total_home_score total_away_score home_score away_score return_yards kick_distance drive_play_count drive_inside20 drive_ended_with_score drive_quarter_start drive_quarter_end` .split(' ');
const numeric=x=>x==null||x===''||x==='NA'||!Number.isFinite(Number(x))?null:Number(x);
export function normalizeSnapRow(row){return Object.fromEntries([...TEXT.map(k=>[k,row[k]||null]),...NUM.map(k=>[k,numeric(row[k])])]);}
const CHART=`is_motion is_play_action is_screen_pass is_rpo is_throw_away is_drop is_catchable_ball is_contested_ball is_trick_play is_interception_worthy is_qb_fault_sack n_blitzers n_pass_rushers n_defense_box n_offense_backfield` .split(' ');
export function normalizeChartingRow(row){return Object.fromEntries(CHART.map(k=>[k,row[k]==='TRUE'?1:row[k]==='FALSE'?0:numeric(row[k])]));}
const cache=new Map();
export async function loadSnapData(season){
 const previous=cache.get(season);if(previous&&Date.now()-previous.at<1800000)return previous.promise;
 const promise=(async()=>{
  const source=`${BASE}/pbp/play_by_play_${season}.csv.gz`,raw=path.join(CACHE_DIR,'nflverse',`play_by_play_${season}.csv.gz`);
  await download(source,raw,season>=new Date().getUTCFullYear()-1?1800000:null);
  const rows=[],cols=[...TEXT,...NUM];await streamRows(raw,true,cols,values=>rows.push(normalizeSnapRow(Object.fromEntries(cols.map((k,i)=>[k,values[i]])))));
  const chartSource=`${BASE}/ftn_charting/ftn_charting_${season}.csv`;let charting={available:false,source:chartSource,rows:0,joined:0,license:'CC-BY-SA-4.0',attribution:'FTN Data via nflverse'};
  try{
   const file=path.join(CACHE_DIR,'nflverse',`ftn_charting_${season}.csv`);await download(chartSource,file,1800000);const map=new Map(),fields=['nflverse_game_id','nflverse_play_id',...CHART];
   await streamRows(file,false,fields,values=>{const row=Object.fromEntries(fields.map((k,i)=>[k,values[i]]));map.set(`${row.nflverse_game_id}|${Number(row.nflverse_play_id)}`,normalizeChartingRow(row));});
   let joined=0;for(const row of rows){row.charting=map.get(`${row.game_id}|${row.play_id}`)||null;if(row.charting)joined++;}
   charting={...charting,available:true,rows:map.size,joined,retrievedAt:fs.statSync(file).mtime.toISOString()};
  }catch(e){charting.error=e.status===404?'Current charting not published':e.message;}
  return {rows,source,sourceRetrievedAt:fs.statSync(raw).mtime.toISOString(),charting,license:'CC-BY-4.0',attribution:'nflverse',fields:cols,rawEvents:rows.length};
 })();cache.set(season,{at:Date.now(),promise});try{return await promise;}catch(e){cache.delete(season);throw e;}
}
