export function validScriptRecord(r){return !!r&&Number.isFinite(Date.parse(r.forecastTimestamp))&&Date.parse(r.forecastTimestamp)<Date.parse(r.kickoff)&&Array.isArray(r.forecast?.points)&&r.forecast.points.length===61;}
export function archiveScript(m,now=new Date()){
  if(m.mode!=='pregame'||!m.gameScript||now.getTime()>=Date.parse(m.kickoff))return null;
  const timestamp=now.toISOString();
  return {runId:`site-${timestamp}`,forecastTimestamp:timestamp,kickoff:m.kickoff,modelVersion:m.modelVersion,home:m.home.abbr,away:m.away.abbr,week:m.week,expectedHomeMargin:m.gameScript.homePoints-m.gameScript.awayPoints,forecast:m.gameScript,weights:m.home.scriptWeights,actual:null,review:null,status:'pending'};
}
export function latestScript(a,b){if(!validScriptRecord(a))return validScriptRecord(b)?b:null;if(!validScriptRecord(b))return a;return Date.parse(a.forecastTimestamp)>Date.parse(b.forecastTimestamp)?a:b;}
