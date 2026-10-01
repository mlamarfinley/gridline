// Reproduce the LIVE calibrated projection (mean) offline from a RAW market-blind batch, so every post-simulation
// layer is learned and evaluated on exactly what the live model would have shown. Order, as in src/matchup.js:
//   1. v1.4 learned correction where one applies (role/projection domain guarded), else v1.3 shift-and-stretch
// Later layers (season anchor, situational blend) are applied by their own learners on top of `cal`.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildX, loadUsage, usageFeatures, predictCorr } from '../../src/v14.js';

const SRC = new URL('../../src/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, SRC), 'utf8'));

export async function calibratedRows(batch, { stats = null } = {}) {
  const V13 = read('fitted_v13.json').byStat, V14 = read('fitted_v14.json').byStat;
  const db = new DatabaseSync(new URL('../../data/ledger.sqlite', import.meta.url).pathname, { readOnly: true });
  const raw = db.prepare(`SELECT p.season, p.week, p.game_id, p.player_id, p.player_name, p.team, p.position pos, p.role, p.stat, p.projection proj, p.p10, p.p50, p.p90,
      s.actual, l.line, c.context_json ctx
    FROM blind_predictions p JOIN blind_scores s USING (batch_id, game_id, player_id, stat)
    LEFT JOIN blind_lines l USING (batch_id, game_id, player_id, stat)
    LEFT JOIN blind_pred_context c USING (batch_id, game_id, player_id)
    WHERE p.batch_id = ? AND p.league = 'nfl' AND s.status = 'scored' AND s.actual IS NOT NULL AND p.projection IS NOT NULL`).all(batch)
    .filter((r) => !stats || stats.includes(r.stat));
  const USE = {};
  for (const s of new Set(raw.map((r) => r.season))) USE[s] = await loadUsage(s);
  return raw.map((r) => {
    const key = `${r.pos}|${r.stat}`, c = r.ctx ? JSON.parse(r.ctx) : {};
    let cal, path;
    const m = V14[key];
    const inDomain = m?.beta && !(m.domain?.roles && r.role != null && m.domain.roles[r.role] == null) && !(m.domain?.minProj != null && r.proj < 0.5 * m.domain.minProj);
    if (inDomain) {
      const x = buildX({ proj: r.proj, p10: r.p10, p90: r.p90, week: r.week, role: r.role, ctx: c, usage: usageFeatures(USE[r.season], r.week, r.team, r.player_name) });
      cal = Math.max(0, r.proj + predictCorr(m, x)); path = 'v14';
    } else if (V13[key] && Number.isFinite(V13[key].a) && r.p90 > 0) {
      const a = V13[key].a, sc = V13[key].s ?? 1, med = r.p50 ?? r.proj;
      cal = Math.max(0, med + a + sc * (r.proj - med)); path = 'v13';
    } else { cal = r.proj; path = 'raw'; }
    return { ...r, key, cal, path, c };
  });
}
