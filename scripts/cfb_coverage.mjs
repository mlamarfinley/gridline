// College ledger check: latest pre-kickoff projection per game vs the final box score — bias, MAE, 10–90 coverage.
//   node --no-warnings scripts/cfb_coverage.mjs
import { DatabaseSync } from 'node:sqlite';
import * as espn from '../src/espn.js';
const db = new DatabaseSync(new URL('../data/ledger.sqlite', import.meta.url).pathname, { readOnly: true });
const rows = db.prepare("SELECT s.* FROM snapshots s WHERE league='cfb' AND kind='pregame' AND run_id IN (SELECT max(run_id) FROM snapshots WHERE league='cfb' AND kind='pregame' GROUP BY game_id) AND stat IN ('carries','rush_yds','rec_yds','receptions','targets','long_rush','pass_yds','pass_att')").all();
const box = new Map();
for (const g of new Set(rows.map((r) => r.game_id))) { try { const s = await espn.getSummary('cfb', g, { final: true }); if (!espn.summaryTeams(s.data).completed) continue; box.set(g, espn.parseBoxscore(s.data)); } catch { /* skip */ } }
const st = {};
for (const r of rows) {
  const b = box.get(r.game_id); if (!b) continue; const p = b.get(String(r.player_id)); const a = p ? (p.stats[r.stat] ?? 0) : 0;
  const k = `${r.position}|${r.stat}`; const x = (st[k] ||= { n: 0, in: 0, hi: 0, lo: 0, bias: 0, ae: 0 });
  x.n++; if (a >= r.p10 && a <= r.p90) x.in++; if (a > r.p90) x.hi++; if (a < r.p10) x.lo++; x.bias += a - r.projection; x.ae += Math.abs(a - r.projection);
}
console.log(`games scored: ${box.size} (versions: ${[...new Set(rows.map((r) => r.model_version))].join(', ')})`);
for (const [k, x] of Object.entries(st).sort()) if (x.n >= 15) console.log(`${k.padEnd(16)} n ${String(x.n).padStart(4)} | 10–90 coverage ${(x.in / x.n * 100).toFixed(0)}% (above p90 ${(x.hi / x.n * 100).toFixed(0)}%, below p10 ${(x.lo / x.n * 100).toFixed(0)}%) | bias ${(x.bias / x.n).toFixed(1)} | MAE ${(x.ae / x.n).toFixed(1)}`);
