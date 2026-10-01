// "Who he is" anchor (fbm-1.4.3): blend the calibrated projection toward the player's own season average.
//   node --no-warnings scripts/learn_anchor.mjs <batch> [--write]
// The simulation builds a player from shares × team volume × shrunk efficiency, which can drift from what a
// player has actually been producing (a workhorse back, a WR1 who sees 10 targets every week). The blend weight w
// per position|stat is learned walk-forward on the market-blind ledger:
//   learn on 2024 → test on 2025, and learn on 2025 → test on 2024 (reverse; 2026 has too few weeks for a season
//   average). A weight ships only if it beat w=0 in BOTH directions; the shipped weight is fitted on 2024+2025. Rows whose role changed because a teammate is out or
// questionable are excluded (his season average describes a different role), and so are they live.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const batch = Number(process.argv[2]);
const WRITE = process.argv.includes('--write');
const db = new DatabaseSync(new URL('../data/ledger.sqlite', import.meta.url).pathname, { readOnly: true });
const V13 = JSON.parse(fs.readFileSync(new URL('../src/fitted_v13.json', import.meta.url), 'utf8')).byStat;
const rows = db.prepare(`SELECT p.season, p.week, p.player_id, p.position pos, p.stat, p.projection proj, s.actual, c.context_json pc
  FROM blind_predictions p JOIN blind_scores s USING (batch_id, game_id, player_id, stat)
  LEFT JOIN blind_pred_context c USING (batch_id, game_id, player_id)
  WHERE p.batch_id = ? AND p.league = 'nfl' AND s.status = 'scored' AND s.actual IS NOT NULL`).all(batch);
const hist = new Map();
for (const r of rows) { const k = `${r.season}|${r.player_id}|${r.stat}`; (hist.get(k) || hist.set(k, []).get(k)).push([r.week, r.actual]); }
const data = [];
for (const r of rows) {
  const prior = (hist.get(`${r.season}|${r.player_id}|${r.stat}`) || []).filter(([w]) => w < r.week);
  if (prior.length < 2) continue;
  const notes = (JSON.parse(r.pc || '{}').notes || []).join(' ');
  if (/absence|questionable/i.test(notes)) continue;
  const a = V13[`${r.pos}|${r.stat}`]?.a || 0;
  data.push({ k: `${r.pos}|${r.stat}`, s: r.season, proj: Math.max(0, r.proj + a), avg: prior.reduce((x, [, v]) => x + v, 0) / prior.length, act: r.actual });
}
const W = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
const mae = (D, w) => D.reduce((x, d) => x + Math.abs((1 - w) * d.proj + w * d.avg - d.act), 0) / D.length;
const best = (D) => W.reduce((b, w) => (mae(D, w) < mae(D, b) - 1e-9 ? w : b), 0);
const out = {};
for (const k of [...new Set(data.map((d) => d.k))].sort()) {
  const D = data.filter((d) => d.k === k);
  const t24 = D.filter((d) => d.s === 2024), t25 = D.filter((d) => d.s === 2025), t2425 = D.filter((d) => d.s <= 2025);
  if (t24.length < 150 || t25.length < 150) continue;
  const wA = best(t24), wB = best(t25), wF = best(t2425);
  const f1 = { w: wA, base: mae(t25, 0), blended: mae(t25, wA) }, fF = { w: wB, base: mae(t24, 0), blended: mae(t24, wB) };
  const ship = wF > 0 && f1.blended < f1.base && fF.blended < fF.base;
  out[k] = { w: ship ? wF : 0, n: D.length, forward: f1, reverse: fF };
  console.log(`${k.padEnd(18)} 2024→2025 w=${wA} ${f1.base.toFixed(3)}→${f1.blended.toFixed(3)} | 2025→2024 w=${wB} ${fF.base.toFixed(3)}→${fF.blended.toFixed(3)} | ${ship ? `SHIP w=${wF}` : 'no'}`);
}
if (WRITE) { fs.writeFileSync(new URL('../src/fitted_anchor.json', import.meta.url), JSON.stringify({ batch, learnedAt: new Date().toISOString(), method: 'walk-forward blend toward own season average', byStat: out }, null, 1)); console.log('wrote src/fitted_anchor.json'); }
