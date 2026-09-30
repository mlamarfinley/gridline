// Build PICKS_REPORT.md from data/picks_<batch>.csv, its summary, and src/fitted_v13.json.
//   node --no-warnings scripts/picks_markdown.mjs <batch>
import fs from 'node:fs';
const batch = Number(process.argv[2]);
const U = (p) => new URL(p, import.meta.url);
const S = JSON.parse(fs.readFileSync(U(`../data/picks_${batch}_summary.json`), 'utf8'));
const L = JSON.parse(fs.readFileSync(U('../src/fitted_v13.json'), 'utf8'));
const csv = fs.readFileSync(U(`../data/picks_${batch}.csv`), 'utf8').split('\n');
const head = csv[0].split(',');
const parse = (line) => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return Object.fromEntries(head.map((h, i) => [h, out[i]])); };
const rows = csv.slice(1).filter(Boolean).map(parse);
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const f = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));

let md = `# Every pick, 2024–2026 NFL: predictions vs actual lines, why they missed, what was learned

**Batch #${batch}**: market-blind, frozen \`fbm-1.2.0\` (params hash in the Ledger).

**Coverage:** every NFL regular-season game of 2024, 2025 and 2026 through week 3, predicted using **only games verified finished before kickoff**. Nothing about the game itself was used: no box score, no betting lines, no injuries or depth charts, no current rosters.

**Order of operations:** predictions and their reasoning were sealed **before** any result or line was fetched. Results and lines were attached afterward.

**Full list of every pick:** \`data/picks_${batch}.csv\` (${rows.length.toLocaleString()} rows). Each row has the projection and range, the actual main line (with prices where the book kept them), the model's side, the actual stat, WIN/LOSS/PUSH, and a brief reason for every loss or out-of-range result.

## Read this first

| Season | Status |
|---|---|
| **2024** | **The honest test.** No fitted constant used 2024 outcomes as a target. |
| **2025** | **In-sample.** The v1.2 constants were fitted on 2025 outcomes, so 2025 flatters the model. |
| **2026** | Weeks 2–3 were already inspected during development. |

**Lines:**
- They are what ESPN still serves today (DraftKings for 2026, ESPN BET for 2024–25; main line only, alternates ignored). They were retrieved **after** the games, and their timestamps can't prove they were pregame, so every win/loss below is an **unverified reconstruction**. No ROI is claimed.
- A pick = a prediction with a line. The model's side is OVER if the projection is above the line, UNDER if below.
- Break-even at typical −110 prices is **52.4%**.

## Results by season

| Season | Games | Predictions | Picks with a line | W–L–P | Win rate | Model MAE vs line MAE (same rows) | 10–90 coverage |
|---|---|---|---|---|---|---|---|
`;
for (const [season, v] of Object.entries(S.seasons)) md += `| ${season} | ${v.games} | ${v.predictions.toLocaleString()} | ${v.withLine.toLocaleString()} | ${v.w}–${v.l}–${v.p} | ${pct(v.winRate)} | ${f(v.lineVsModel.modelMae, 2)} vs **${f(v.lineVsModel.lineMae, 2)}** | ${pct(v.accuracy.coverage)} |\n`;

md += `\n### OVER vs UNDER picks\n\n| Season | OVER picks | UNDER picks |\n|---|---|---|\n`;
for (const [season, v] of Object.entries(S.seasons)) md += `| ${season} | ${v.over.w}–${v.over.l} (${pct(v.over.winRate)}) | ${v.under.w}–${v.under.l} (${pct(v.under.winRate)}) |\n`;

md += `\n### Do bigger disagreements with the line win more?\n\nGap is measured in standard deviations of the model's own range.\n\n| Season | ${Object.values(S.seasons)[0].gapBins.map((b) => `gap ${b.gapSD} SD`).join(' | ')} |\n|---|${Object.values(S.seasons)[0].gapBins.map(() => '---').join('|')}|\n`;
for (const [season, v] of Object.entries(S.seasons)) md += `| ${season} | ${v.gapBins.map((b) => `${b.w}–${b.l} (${pct(b.winRate)})`).join(' | ')} |\n`;

md += `\n### By stat (all three seasons pooled)\n\n| Pos · stat | Picks | W–L | Win rate | Model MAE | Line MAE |\n|---|---|---|---|---|---|\n`;
const pooled = {};
for (const v of Object.values(S.seasons)) for (const [k, x] of Object.entries(v.byStat)) { const p = (pooled[k] ||= { picks: 0, w: 0, l: 0, mm: 0, lm: 0, n: 0 }); p.picks += x.picks; p.w += x.w; p.l += x.l; if (x.n) { p.mm += x.modelMae * x.n; p.lm += x.lineMae * x.n; p.n += x.n; } }
for (const [k, p] of Object.entries(pooled).filter(([, p]) => p.picks >= 30).sort((a, b) => b[1].picks - a[1].picks)) md += `| ${k.replace('|', ' · ')} | ${p.picks} | ${p.w}–${p.l} | ${pct(p.w / Math.max(1, p.w + p.l))} | ${f(p.mm / Math.max(1, p.n), 2)} | ${f(p.lm / Math.max(1, p.n), 2)} |\n`;

md += `\n## Why picks lost (reason of every loss, by season)\n\n| Season | ${['Workload', 'Role/share', 'Team volume/game script', 'Game script', 'Efficiency', 'One big play', 'Touchdown variance', 'Workload collapsed', 'No recorded stats', 'Kicking volume follows team scoring', 'Longest play'].map((k) => k).join(' | ')} |\n|---|${new Array(11).fill('---').join('|')}|\n`;
const keys = ['Workload', 'Role/share', 'Team volume/game script', 'Game script', 'Efficiency', 'One big play', 'Touchdown variance', 'Workload collapsed', 'No recorded stats', 'Kicking volume follows team scoring', 'Longest play'];
for (const [season, v] of Object.entries(S.seasons)) {
  const r = v.lossReasons; const tot = Object.values(r).reduce((a, b) => a + b, 0);
  const get = (k) => Object.entries(r).filter(([kk]) => kk && kk.startsWith(k.trim())).reduce((a, [, n]) => a + n, 0);
  md += `| ${season} | ${keys.map((k) => `${get(k)} (${pct(get(k) / Math.max(1, tot))})`).join(' | ')} |\n`;
}

// Learning
const F1 = L.fold1, FN = L.final;
const row = (name, o) => `| ${name} | ${f(o.mae, 2)} | ${f(o.bias, 2)} | ${pct(o.coverage)} | ${o.wins}–${o.losses} (${pct(o.winRate)}) | ${f(o.maeOnLineRows, 2)} vs ${f(o.lineMae, 2)} |`;
md += `\n## What was learned from every pick (walk-forward, so it can't grade itself)\n\nLearned per position/stat: (1) a shrunk correction of the projection's centre, (2) a range-width multiplier targeting 80% coverage, (3) whether larger gaps to the line win more.\n\n| Learned on → tested on | MAE | Bias | 10–90 coverage | Picks W–L | Model vs line MAE (line rows) |\n|---|---|---|---|---|---|\n`;
md += `${row('— (none) → 2025', F1.test2025.before)}\n${row('**2024 → 2025**', F1.test2025.after)}\n${row('— (none) → 2026', F1.test2026.before)}\n${row('**2024 → 2026**', F1.test2026.after)}\n${row('**2024+2025 → 2026**', FN.test2026.after)}\n`;
const pr = (o) => o.after.pickRules;
md += `\n### Learned pick rules: did they hold up on seasons they never saw?\n\n| Rule (learned on) | Tested on | Record | Win rate |\n|---|---|---|---|\n`;
md += `| Only bet stats that beat 52.4% in training (2024: ${pr(F1.test2025).onlyStatsThatBeat524InTraining.stats.join(', ')}) | 2025 | ${pr(F1.test2025).onlyStatsThatBeat524InTraining.w}–${pr(F1.test2025).onlyStatsThatBeat524InTraining.l} | **${pct(pr(F1.test2025).onlyStatsThatBeat524InTraining.rate)}** |\n`;
md += `| same rule (2024) | 2026 | ${pr(F1.test2026).onlyStatsThatBeat524InTraining.w}–${pr(F1.test2026).onlyStatsThatBeat524InTraining.l} | ${pct(pr(F1.test2026).onlyStatsThatBeat524InTraining.rate)} |\n`;
md += `| Follow the model's side (2024 β = ${L.fold1ByStat.__market.beta}, t = ${L.fold1ByStat.__market.t}) | 2025 | ${pr(F1.test2025).fadeModelIfTrainingBetaNegative.w}–${pr(F1.test2025).fadeModelIfTrainingBetaNegative.l} | ${pct(pr(F1.test2025).fadeModelIfTrainingBetaNegative.rate)} |\n`;
md += `\nPooled over 2024+2025, the model's disagreement with the line carries almost no signal (β = ${L.byStat.__market.beta}, t = ${L.byStat.__market.t}, n = ${L.byStat.__market.n}). **No learned pick rule beat the 52.4% break-even on a season it wasn't learned from, so none is used.**\n`;
md += `\nLearned corrections (final, 2024+2025), largest adjustments first:\n\n| Pos · stat | n | centre shift (median residual) | range × | training win rate vs line |\n|---|---|---|---|---|\n`;
for (const [k, c] of Object.entries(L.byStat).filter(([k]) => k !== '__market').sort((a, b) => Math.abs(b[1].a) / Math.max(1, b[1].n ** 0) + Math.abs(1 - b[1].s) * 5 - Math.abs(a[1].a) - Math.abs(1 - a[1].s) * 5).slice(0, 18)) md += `| ${k.replace('|', ' · ')} | ${c.n} | ${c.a > 0 ? '+' : ''}${f(c.a, 2)} | ${f(c.s, 2)} | ${c.trainWinRate != null ? `${pct(c.trainWinRate)} (${c.trainPicks})` : '—'} |\n`;

// Examples
const losses = rows.filter((r) => r.result === 'LOSS' && r.reason && Number(r.season) === 2024);
const pick = (pred) => losses.filter(pred).sort((a, b) => Math.abs(b.actual - b.line) - Math.abs(a.actual - a.line)).slice(0, 4);
md += `\n## Examples of losing picks and why (2024, the out-of-sample season)\n\n| Wk | Game | Player | Stat | Model (side) | Line | Actual | Why |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of [...pick((r) => /^(Workload|Role)/.test(r.reason)), ...pick((r) => /^Efficiency/.test(r.reason)), ...pick((r) => /script/i.test(r.reason.split(':')[0])), ...pick((r) => /^One big play/.test(r.reason))]) md += `| ${r.week} | ${r.matchup} | ${r.player} | ${r.stat} | ${r.projection} (${r.model_side}) | ${r.line} | ${r.actual} | ${r.reason} |\n`;

fs.writeFileSync(U('../PICKS_REPORT.md'), md);
console.log('PICKS_REPORT.md written', md.length);
