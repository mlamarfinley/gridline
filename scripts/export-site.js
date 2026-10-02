// Build a READ-ONLY static copy of Gridline (for GitHub Pages).
//
//   node scripts/export-site.js --ledger     # local only: dump ledger + blind results -> static-data/ (commit it)
//   node scripts/export-site.js --out site   # build site/: UI + fresh slates/matchups + committed static-data
//
// The static site never writes anything: POST endpoints do not exist there and the UI hides every
// mutation control. Matchups are built with buildMatchup() directly, so no ledger snapshot is taken.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, MODEL_VERSION } from '../src/config.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? (process.argv[i + 1]?.startsWith('--') ? true : process.argv[i + 1] ?? true) : d; };
const STATIC_DATA = path.join(ROOT, 'static-data');
const write = (base, rel, obj) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); };
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

if (arg('ledger')) {
  const { ledgerOverview, openLedger } = await import('../src/ledger.js');
  const { openBlind, blindReport, latestBatch } = await import('../src/blind.js');
  const d = openLedger();
  fs.rmSync(path.join(STATIC_DATA, 'api'), { recursive: true, force: true });
  const versions = d.prepare('SELECT DISTINCT model_version FROM runs').all().map((r) => r.model_version);
  if (!versions.includes(MODEL_VERSION)) versions.push(MODEL_VERSION);
  for (const kind of ['pregame', 'backtest']) for (const v of versions) write(STATIC_DATA, `api/ledger/${kind}-${v}.json`, ledgerOverview({ kind, modelVersion: v }));
  const bd = openBlind(d);
  const batches = bd.prepare(`SELECT b.id, b.created_at, b.model_version, b.params_hash, b.leagues,
    (SELECT COUNT(*) FROM blind_manifests m WHERE m.batch_id=b.id AND m.status='predicted') AS predicted,
    (SELECT COUNT(*) FROM blind_manifests m WHERE m.batch_id=b.id) AS games,
    (SELECT group_concat(event, ' → ') FROM blind_events e WHERE e.batch_id=b.id) AS events FROM blind_batches b ORDER BY b.id DESC`).all();
  const latest = latestBatch(bd);
  write(STATIC_DATA, 'api/blind.json', { batches, report: latest ? blindReport(latest, bd) : null });
  for (const b of batches) if (/scored/.test(b.events || '')) write(STATIC_DATA, `api/blind-${b.id}.json`, { batches, report: blindReport(b.id, bd) });
  write(STATIC_DATA, 'ledger-meta.json', { exportedAt: new Date().toISOString(), versions });
  log(`ledger + blind results exported to static-data/ (${versions.length} model versions, ${batches.length} blind batches)`);
  process.exit(0);
}

const OUT = path.resolve(ROOT, String(arg('out', 'site')));
const { getSlate } = await import('../src/services.js');
const { buildMatchup } = await import('../src/matchup.js');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. UI assets, flagged as static.
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(OUT, f));
const generatedAt = new Date().toISOString();
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8')
  .replace('<script type="module"', `<script>window.GRIDLINE_STATIC = { generatedAt: ${JSON.stringify(generatedAt)} };</script>\n  <script type="module"`);
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '404.html'), html);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// 2. Committed ledger/blind data.
if (fs.existsSync(path.join(STATIC_DATA, 'api'))) fs.cpSync(path.join(STATIC_DATA, 'api'), path.join(OUT, 'api'), { recursive: true });
else log('no static-data/api — ledger pages will show as not included');
let ledgerMeta = null;
try { ledgerMeta = JSON.parse(fs.readFileSync(path.join(STATIC_DATA, 'ledger-meta.json'), 'utf8')); } catch { /* none */ }
write(OUT, 'api/status.json', { modelVersion: MODEL_VERSION, keys: { oddsApi: false, cfbd: false }, db: 'read-only static snapshot', counts: [], now: generatedAt, autoSnapshot: false, static: true, ledgerExportedAt: ledgerMeta?.exportedAt || null });

// 3. Fresh slates (every regular-season week) and matchups (current week; NFL also completed weeks).
async function pool(items, n, fn) { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); }
const summary = { generatedAt, matchups: 0, failed: [] };
for (const lg of ['nfl', 'cfb']) {
  const cur = await getSlate(lg);
  write(OUT, `api/slate/${lg}.json`, cur);
  const weeks = cur.calendar.filter((c) => c.seasontype === 2).map((c) => c.week);
  const ids = new Set(cur.games.map((g) => g.id));
  for (const w of weeks) {
    const s = w === cur.week ? cur : await getSlate(lg, { week: w });
    write(OUT, `api/slate/${lg}-w${w}.json`, s);
    if (lg === 'nfl' && w < cur.week) for (const g of s.games) if (g.status.completed) ids.add(g.id);
  }
  if (lg === 'nfl') { try { const { ratingsBoard } = await import('../src/playerRatings.js'); for (const pos of ['QB', 'RB', 'WR', 'TE']) write(OUT, `api/ratings/${pos}.json`, await ratingsBoard(cur.season, cur.week, pos)); } catch (e) { summary.failed.push({ ratings: true, error: e.message }); } }
  try { write(OUT, `api/lineblind/${lg}.json`, JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', `line_blind_check_${lg}.json`), 'utf8'))); } catch { /* check not run for this league */ }
  try { const { statLeaders } = await import('../src/leaders.js'); write(OUT, `api/leaders/${lg}.json`, await statLeaders(lg, cur.season)); } catch (e) { summary.failed.push({ lg, leaders: true, error: e.message }); }
  log(`${lg}: ${weeks.length} week slates; building ${ids.size} matchups`);
  await pool([...ids], 3, async (id) => {
    try {
      const m = await buildMatchup(lg, id);
      const { projections, ...rest } = m;
      write(OUT, `api/matchup/${lg}/${id}.json`, rest);
      summary.matchups++;
    } catch (e) { summary.failed.push({ lg, id, error: e.message }); }
  });
}
write(OUT, 'api/build.json', summary);
log(`site built in ${path.relative(ROOT, OUT)}/: ${summary.matchups} matchups, ${summary.failed.length} failed`);
