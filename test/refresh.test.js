import test from 'node:test';import assert from 'node:assert/strict';
import {fetchCached,setTransport} from '../src/fetcher.js';
import {summaryCacheTTL} from '../src/espn.js';
test('summary cache refreshes live games, recent finals and later corrections on bounded intervals',()=>{
 const now=Date.parse('2026-10-18T00:00:00Z');const s=(date,completed)=>({header:{competitions:[{date,status:{type:{completed}}}]}});
 assert.equal(summaryCacheTTL(s('2026-10-17',false),now),120);
 assert.equal(summaryCacheTTL(s('2026-10-17',true),now),300);
 assert.equal(summaryCacheTTL(s('2026-09-01',true),now),86400);
});
test('explicit revalidation bypasses old permanent entries and rejects cached nonfinal bodies',async()=>{
 const u=`https://example.com/refresh-test-${Date.now()}`;let calls=0;setTransport(async()=>({completed:++calls>1}));
 try{await fetchCached(u,{permanent:true});const fresh=await fetchCached(u,{ignorePermanent:true,ttl:3600,acceptCached:b=>b.completed});assert.equal(calls,2);assert.equal(fresh.data.completed,true);}finally{setTransport(null);}
});
import {ExpiringMap} from '../src/expiringMap.js';
test('long-running processes cannot hold derived results indefinitely',()=>{let now=0;const c=new ExpiringMap(100,()=>now);c.set('x',{score:1});now=99;assert(c.has('x'));now=100;assert.equal(c.get('x'),undefined);c.set('x',null);assert(c.has('x'));now=201;assert(!c.has('x'));});
