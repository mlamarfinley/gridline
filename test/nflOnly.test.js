import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { openLedger, closeLedger } from '../src/ledger.js';

// Exercise the real HTTP boundary without fetching any upstream sports feeds.
test('active server rejects college requests and advertises only NFL providers', async t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridline-nfl-only-'));
 const fixture = openLedger(path.join(dir, 'ledger.sqlite'));
 for (const league of ['nfl','cfb']) fixture.prepare('INSERT INTO runs (created_at,kind,league,game_id,kickoff,model_version,input_cutoff,content_hash) VALUES (?,?,?,?,?,?,?,?)').run('2026-10-01T00:00:00Z','pregame',league,league+'-game','2026-10-04T17:00:00Z','test','2026-10-01T00:00:00Z','fixture');
 closeLedger();
 const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
 const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
 const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {cwd: path.resolve(import.meta.dirname, '..'), env: {...process.env, PORT: String(port), LEDGER_DB: path.join(dir, 'ledger.sqlite'), AUTO_SNAPSHOT: '0'}, stdio: ['ignore','pipe','pipe']});
 t.after(async () => {child.kill(); if(child.exitCode===null)await once(child,'exit');fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timed out')),10000);child.stdout.on('data',chunk=>{if(String(chunk).includes('dashboard →')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}`));});});
 const request = (p,options) => fetch(`http://127.0.0.1:${port}${p}`,options);
 for(const p of ['/api/slate','/api/matchup?id=123','/api/leaders','/api/ledger','/api/lineblind','/api/ratings','/api/blind']) {
  const response=await request(p+(p.includes('?')?'&':'?')+'league=cfb');
  assert.equal(response.status,400,`${p} must reject college before any data work`);
 }
 for(const p of ['/api/snapshot','/api/snapshot-slate','/api/backtest','/api/blind-run','/api/settle']) {
  const response=await request(p+'?league=cfb',{method:'POST'});assert.equal(response.status,400,`${p} must reject college mutations`);
 }
 assert.deepEqual(await (await request('/api/jobs')).json(),[]);
 const overview=await (await request('/api/ledger')).json();assert.deepEqual(overview.runs.map(r=>r.league),['nfl']);
 const status=await (await request('/api/status')).json();
 assert.equal(Object.hasOwn(status.keys,'cfbd'),false);
 assert.deepEqual(status.counts,[{kind:'pregame',runs:1}]);
 const html=await (await request('/')).text();assert(!html.includes('data-league="cfb"'));
});
