// Does the situational multiplier model add to the full model? 2025 out of sample for both:
// model = RAW market-blind batch → live calibration (scripts/lib/pipeline.mjs) → season anchor, exactly as live;
// situational = baseline × multipliers fit on 2022–24. Blend weight w learned on 2025 weeks 2–9, tested on weeks 10–18.
import fs from 'node:fs';
import { loadPlayerIds } from '../src/pbp.js';
import { calibratedRows } from './lib/pipeline.mjs';
const BATCH = Number(process.argv[2] || 9);
const ANCHOR = JSON.parse(fs.readFileSync(new URL('../src/fitted_anchor.json', import.meta.url))).byStat;
const sit = JSON.parse(fs.readFileSync(new URL('../reports/situational_2025.json', import.meta.url)));
const S = new Map(sit.map((r) => [`${r.key}|${r.pid}|${r.week}`, r]));
const { byEspn } = await loadPlayerIds();
const rows = (await calibratedRows(BATCH)).filter((r) => r.season === 2025);
const hist = new Map(); for (const r of rows) { const k = `${r.player_id}|${r.stat}`; (hist.get(k) || hist.set(k, []).get(k)).push([r.week, r.actual]); }
const data = [];
for (const r of rows) {
  const key = `${r.pos}|${r.stat}`, gs = byEspn.get(String(r.player_id))?.gsis;
  const s = gs ? S.get(`${key}|${gs}|${r.week}`) : null; if (!s) continue;
  let m = r.cal; // live calibrated projection (v1.4 / v1.3), then the season anchor as live
  const pr = (hist.get(`${r.player_id}|${r.stat}`) || []).filter(([w]) => w < r.week);
  const aw = ANCHOR[key]?.w || 0; if (aw && pr.length >= 2) { const avg = pr.reduce((a, [, v]) => a + v, 0) / pr.length; m = Math.max(0, m + aw * (avg - m)); }
  data.push({ key, week: r.week, m, s: s.sit, y: r.actual, line: r.line });
}
const W = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1];
const mae = (D, w) => D.reduce((a, d) => a + Math.abs((1 - w) * d.m + w * d.s - d.y), 0) / D.length;
const side = (D, w) => { let k = 0, n = 0; for (const d of D) { if (d.line == null || d.y === d.line) continue; const p = (1 - w) * d.m + w * d.s; if (p === d.line) continue; n++; if ((p > d.line) === (d.y > d.line)) k++; } return n ? `${k}-${n - k}` : '—'; };
const out = {};
console.log(`joined rows: ${data.length}`);
for (const key of [...new Set(data.map((d) => d.key))].sort()) {
  const D = data.filter((d) => d.key === key), tr = D.filter((d) => d.week <= 9), te = D.filter((d) => d.week >= 10);
  if (tr.length < 80 || te.length < 80) continue;
  const w = W.reduce((b, x) => (mae(tr, x) < mae(tr, b) - 1e-9 ? x : b), 0);
  const lineRec = (w2) => { const [k2, l2] = side(te, w2).split('-').map(Number); return Number.isFinite(k2) ? k2 - l2 : 0; };
  const gain = mae(te, w) < mae(te, 0) && lineRec(w) >= lineRec(0); // fewer misses AND no worse against posted lines
  out[key] = { w: gain ? w : 0, test: { model: +mae(te, 0).toFixed(3), blended: +mae(te, w).toFixed(3), situational: +mae(te, 1).toFixed(3) } };
  console.log(`${key.padEnd(16)} n ${String(D.length).padStart(4)} | wk10–18 MAE: model ${mae(te, 0).toFixed(3)} · situational ${mae(te, 1).toFixed(3)} · blend w=${w} ${mae(te, w).toFixed(3)} | vs line model ${side(te, 0)} blend ${side(te, w)} | ${gain && w > 0 ? 'SHIP' : 'no'}`);
}
if (process.argv.includes('--write')) { fs.writeFileSync(new URL('../src/fitted_situational_blend.json', import.meta.url), JSON.stringify({ batch: BATCH, learnedAt: new Date().toISOString(), method: 'blend weight learned on 2025 wk 2–9, kept only if it beat the model on wk 10–18', byStat: out }, null, 1)); console.log('wrote src/fitted_situational_blend.json'); }
