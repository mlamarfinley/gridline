import {trackedPlayerStat} from '../public/trackingPolicy.js';
const valid=r=>!!r&&Number.isFinite(Date.parse(r.savedAt))&&Date.parse(r.savedAt)<Date.parse(r.kickoff)&&Array.isArray(r.rows)&&r.rows.length>0;
export function latestPlayerForecast(a,b){if(!valid(a))return valid(b)?b:null;if(!valid(b))return a;return Date.parse(a.savedAt)>Date.parse(b.savedAt)?a:b;}
export function archivePlayerForecast(m,now=new Date()){
 if(m.mode!=='pregame'||now.getTime()>=Date.parse(m.kickoff))return null;
 const rows=(m.projections||[]).filter(p=>trackedPlayerStat('nfl',p.position,p.stat)&&Number.isFinite(p.experimental?.projection)).map(p=>({playerId:String(p.playerId),team:p.team,stat:p.stat,baseline:p.projection,line:p.bookLine??null,forecast:p.experimental}));
 const r={gameId:String(m.eventId),kickoff:m.kickoff,savedAt:now.toISOString(),runId:`site-${now.toISOString()}`,modelVersion:m.modelVersion,rows};return valid(r)?r:null;
}
export function attachPlayerForecast(teams,record,gameId,kickoff){
 if(!valid(record)||String(record.gameId)!==String(gameId)||Date.parse(record.kickoff)!==Date.parse(kickoff))return 0;
 let count=0;for(const t of teams)for(const c of [...(t.cards||[]),...(t.kicker?[t.kicker]:[])])for(const [key,s] of Object.entries(c.stats||{})){
  if(!trackedPlayerStat('nfl',c.pos,key))continue;
  const row=record.rows.find(r=>String(r.playerId)===String(c.id)&&r.team===t.abbr&&r.stat===key);
  if(!Number.isFinite(row?.forecast?.projection))continue;
  s.experimental={...row.forecast,savedAt:record.savedAt,savedRunId:record.runId,savedBaseline:row.baseline,savedLine:row.line??null};count++;
 }return count;
}
