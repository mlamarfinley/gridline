// Current-season snap evidence and possession challenger, always selected before the forecast week.
import {loadSnapData} from './snapData.js';
import {loadPlayerIds} from './pbp.js';
import {summarizeSnaps} from './snapAnalytics.js';
import {buildDriveLibrary,forecastDriveGame} from './driveModel.js';
import {ExpiringMap} from './expiringMap.js';
const cache=new ExpiringMap();
export const nflAbbr=a=>({WSH:'WAS',LAR:'LA'}[a]||a);
export async function deepContext(season,week,cutoff){
 const key=`${season}|${week}|${cutoff}`;if(cache.has(key))return cache.get(key);
 const promise=(async()=>{const [data,ids]=await Promise.all([loadSnapData(season),loadPlayerIds()]);
  const positions=Object.fromEntries(ids.posByGsis),names=Object.fromEntries(ids.nameByGsis),library=buildDriveLibrary(data.rows,{week,cutoff});
  const teams=new Map();
  return {source:{url:data.source,retrievedAt:data.sourceRetrievedAt,charting:data.charting,attribution:data.attribution,license:data.license},ids,library,
   team(abbr){const team=nflAbbr(abbr);if(!teams.has(team))teams.set(team,summarizeSnaps(data.rows,{team,week,cutoff,positions,names}));return teams.get(team);},
   forecast(home,away,seed){return forecastDriveGame({drives:library,home:nflAbbr(home),away:nflAbbr(away),seed,generatedAt:new Date().toISOString()});}};
 })();cache.set(key,promise);return promise;
}
