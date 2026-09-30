// Local HTTP server: static UI + JSON API. Zero dependencies (Node >= 22.13).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, ROOT, MODEL_VERSION, ODDS_API_KEY, CFBD_API_KEY, DB_PATH, LEAGUES } from './src/config.js';
import { getSlate, getMatchup, snapshotGame, snapshotSlate, backtestWeek, settle, ledger } from './src/services.js';
import { openLedger } from './src/ledger.js';
import { requestAllowed } from './src/security.js';
import { blindReport, latestBatch, runBlindPredictions, scoreBlind, saveReport, openBlind } from './src/blind.js';

const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const jobs = new Map(); // long-running POST jobs: id -> {status, log, result}
let jobSeq = 0;

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const league = (q) => { const l = q.get('league') || 'nfl'; if (!LEAGUES[l]) throw Object.assign(new Error('league must be nfl or cfb'), { status: 400 }); return l; };

function startJob(label, fn) {
  const id = String(++jobSeq);
  const job = { id, label, status: 'running', log: [], result: null, started: new Date().toISOString() };
  jobs.set(id, job);
  fn((line) => job.log.push(line)).then((r) => { job.status = 'done'; job.result = r; }).catch((e) => { job.status = 'error'; job.error = e.message; });
  return job;
}

async function api(req, res, url) {
  const q = url.searchParams;
  const p = url.pathname;
  if (p === '/api/status') {
    const d = openLedger();
    const counts = d.prepare('SELECT kind, COUNT(*) AS runs FROM runs GROUP BY kind').all();
    return send(res, 200, { modelVersion: MODEL_VERSION, keys: { oddsApi: !!ODDS_API_KEY, cfbd: !!CFBD_API_KEY }, db: path.relative(ROOT, DB_PATH), counts, now: new Date().toISOString(), autoSnapshot: process.env.AUTO_SNAPSHOT !== '0' });
  }
  if (p === '/api/slate') {
    const week = q.get('week') ? Number(q.get('week')) : undefined;
    return send(res, 200, await getSlate(league(q), { week, seasontype: q.get('seasontype') ? Number(q.get('seasontype')) : undefined }));
  }
  if (p === '/api/matchup') {
    const id = q.get('id');
    if (!/^\d+$/.test(id || '')) return send(res, 400, { error: 'id required' });
    const m = await getMatchup(league(q), id, { fresh: q.get('fresh') === '1' });
    const { projections, ...rest } = m; // flat projection list is for the ledger only
    return send(res, 200, rest);
  }
  if (p === '/api/ledger') return send(res, 200, ledger({ league: q.get('league') || undefined, kind: q.get('kind') || 'pregame', modelVersion: q.get('model') || MODEL_VERSION }));
  if (p === '/api/blind') {
    const d = openBlind();
    const batches = d.prepare(`SELECT b.id, b.created_at, b.model_version, b.params_hash, b.leagues,
      (SELECT COUNT(*) FROM blind_manifests m WHERE m.batch_id=b.id AND m.status='predicted') AS predicted,
      (SELECT COUNT(*) FROM blind_manifests m WHERE m.batch_id=b.id) AS games,
      (SELECT group_concat(event, ' → ') FROM blind_events e WHERE e.batch_id=b.id) AS events FROM blind_batches b ORDER BY b.id DESC`).all();
    const id = q.get('batch') ? Number(q.get('batch')) : latestBatch(d);
    return send(res, 200, { batches, report: id ? blindReport(id, d) : null });
  }
  if (p === '/api/jobs') return send(res, 200, [...jobs.values()].slice(-20).reverse());
  if (p.startsWith('/api/jobs/')) { const j = jobs.get(p.split('/').pop()); return j ? send(res, 200, j) : send(res, 404, { error: 'no such job' }); }
  if (req.method === 'POST') {
    if (p === '/api/snapshot') return send(res, 200, await snapshotGame(league(q), q.get('id')));
    if (p === '/api/snapshot-slate') { const lg = league(q); const w = q.get('week') ? Number(q.get('week')) : undefined; return send(res, 202, startJob(`Snapshot ${lg} week ${w ?? 'current'}`, (log) => snapshotSlate(lg, w, log))); }
    if (p === '/api/backtest') { const lg = league(q); const w = Number(q.get('week')); const lim = q.get('limit') ? Number(q.get('limit')) : 999; return send(res, 202, startJob(`Backtest ${lg} week ${w}`, (log) => backtestWeek(lg, w, log, { limit: lim }))); }
    if (p === '/api/blind-run') return send(res, 202, startJob('Blind historical evaluation (all completed games)', async (log) => { const b = await runBlindPredictions({ log }); await scoreBlind(b, { log }); return saveReport(b).file; }));
    if (p === '/api/settle') return send(res, 202, startJob('Settle finished games', (log) => settle(log)));
  }
  return send(res, 404, { error: 'not found' });
}

const HOST = '127.0.0.1';

const server = http.createServer(async (req, res) => {
  if (!requestAllowed(req.method, req.headers, PORT)) return send(res, 403, { error: 'Forbidden: unexpected Host/Origin for this local-only server' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    return send(res, e.status || 500, { error: e.message || String(e) });
  }
});

server.listen(PORT, HOST, () => {
  openLedger();
  console.log(`Football dashboard → http://localhost:${PORT}  (bound to ${HOST} only; model ${MODEL_VERSION}, ledger ${path.relative(ROOT, DB_PATH)})`);
});
