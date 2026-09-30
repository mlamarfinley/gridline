// Disk-cached HTTP fetcher with provenance.
// Every response carries {url, source, fetchedAt, fromCache, stale, error} so the UI can show
// exactly where a number came from and how old it is. If the network fails we fall back to the
// last cached copy and mark it stale; we never substitute invented data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR } from './config.js';

const MAX_CONCURRENT = 6;
let active = 0;
const queue = [];
const inflight = new Map();

// Offline mode (used by tests): only the cache is consulted.
let offline = process.env.FBD_OFFLINE === '1';
export function setOffline(v) { offline = v; }

// Optional injectable transport (tests replace this with fixture lookups).
let transport = null;
export function setTransport(fn) { transport = fn; }

function acquire() {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENT) { active++; resolve(); } else queue.push(resolve);
  });
}
function release() {
  active--;
  const next = queue.shift();
  if (next) { active++; next(); }
}

function cachePath(url) {
  const h = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(CACHE_DIR, h.slice(0, 2), h + '.json');
}

function readCache(url) {
  try {
    const raw = fs.readFileSync(cachePath(url), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function writeCache(url, entry) {
  const p = cachePath(url);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entry));
  fs.renameSync(tmp, p);
}

export function sourceName(url) {
  if (url.includes('sports.core.api.espn')) return 'ESPN core API';
  if (url.includes('espn.com')) return 'ESPN public API';
  if (url.includes('nflverse')) return 'nflverse';
  if (url.includes('open-meteo')) return 'Open-Meteo';
  if (url.includes('the-odds-api')) return 'The Odds API';
  if (url.includes('collegefootballdata')) return 'CollegeFootballData';
  return new URL(url).host;
}

/**
 * fetchCached(url, {ttl, as:'json'|'text', headers, permanent})
 * ttl in seconds. permanent=true caches forever (e.g. summaries of FINAL games).
 */
export async function fetchCached(url, opts = {}) {
  const { ttl = 600, as = 'json', headers = {}, label } = opts;
  const key = url;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const cached = readCache(url);
    const now = Date.now();
    const meta = (entry, extra) => ({
      url: redact(url), source: sourceName(url), label: label || null,
      fetchedAt: new Date(entry.fetchedAt).toISOString(), fromCache: true, stale: false, error: null, ...extra,
    });
    if (cached && (cached.permanent || now - cached.fetchedAt < ttl * 1000)) {
      return { data: cached.body, meta: meta(cached) };
    }
    if (offline) {
      if (cached) return { data: cached.body, meta: meta(cached, { stale: true, error: 'offline mode' }) };
      return { data: null, meta: { url: redact(url), source: sourceName(url), label: label || null, fetchedAt: null, fromCache: false, stale: false, error: 'offline and not cached' } };
    }
    await acquire();
    try {
      let body;
      if (transport) {
        body = await transport(url);
      } else {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        let res;
        try {
          res = await fetch(url, { headers: { 'user-agent': 'football-dashboard/1.0 (local research tool)', ...headers }, signal: ctrl.signal, redirect: 'follow' });
        } finally { clearTimeout(t); }
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          err.status = res.status;
          throw err;
        }
        body = as === 'text' ? await res.text() : await res.json();
      }
      const entry = { fetchedAt: Date.now(), body, permanent: !!opts.permanent };
      writeCache(url, entry);
      return { data: body, meta: { url: redact(url), source: sourceName(url), label: label || null, fetchedAt: new Date(entry.fetchedAt).toISOString(), fromCache: false, stale: false, error: null } };
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'timeout' : (e.message || String(e));
      if (cached) return { data: cached.body, meta: meta(cached, { stale: true, error: msg }) };
      return { data: null, meta: { url: redact(url), source: sourceName(url), label: label || null, fetchedAt: null, fromCache: false, stale: false, error: msg, status: e.status || null } };
    } finally {
      release();
    }
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

// Never leak API keys into provenance shown in the UI.
export function redact(url) {
  return url.replace(/(apiKey|api_key|key)=([^&]+)/gi, '$1=REDACTED');
}

export class Provenance {
  constructor() { this.items = []; }
  add(meta) { if (meta) this.items.push(meta); return meta; }
  list() {
    const seen = new Map();
    for (const m of this.items) {
      const k = m.url;
      if (!seen.has(k)) seen.set(k, m);
    }
    return [...seen.values()];
  }
  latest() {
    const ts = this.items.map((m) => m.fetchedAt).filter(Boolean).sort();
    return ts[ts.length - 1] || null;
  }
}
