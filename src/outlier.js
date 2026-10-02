// OUTLIER PICK: a spot where the BOOK line is likely to miss BIG — a real outlier (e.g. a 90-yard line that
// ends at 178), not one side of a coin flip (a 0.5 TD line, a 1.5-catch line). Pure: it only reads projections.
//
// Ranking (fbm-1.5): the learned chance of a big miss in each direction (src/bigmiss.js, walk-forward on every
// 2024–26 pick with a line), relative to the typical rate for that stat ("lift"). The model's own gap from the
// line is NOT the ranking: in the backtest it did not predict big misses (AUC ≈ 0.46–0.50). A pick also needs
//   - a stat where a big miss is meaningful (no TDs / longest-play props) and a line that isn't tiny,
//   - the model's projection on that side of the line, and its own range reaching a big miss,
//   - the usual quality gates (sample, injury, stale line, role, skeptic).
// Nothing qualifies => no pick (stated plainly).
import { BIG, MIN_LINE, threshold } from './bigmiss.js';

// OUTLIERS (model vs line): a gap is "significant" when it clears EITHER bar for that stat — enough units OR
// enough of the line. 10 yds on a 97.5 rushing line is an outlier (units); 40 vs a 32 line is too (25%); 10 yds
// on a 239 passing line (one throw, 4%) is not; 6 vs 6.5 receptions (0.5, 8%) is a coin flip, not an outlier.
// Strength = the larger of |gap| / units and |gap| / (share × line): ≥ 1 = outlier, 0.6–1 = lean.
export const SIGNIFICANCE = { pass_yds: [20, 0.08], rush_yds: [9, 0.15], rec_yds: [9, 0.15], receptions: [1.0, 0.25], carries: [2.5, 0.15], completions: [2.5, 0.10] };
export const sigStrengthOf = (stat, line, proj) => { const s = SIGNIFICANCE[stat]; if (!s) return 0; const g = Math.abs(proj - line); return Math.max(g / s[0], g / Math.max(1e-9, s[1] * line)); };
/** The gap that counts as significant for this line (the smaller of the two bars). */
export const sigThreshold = (stat, line) => (SIGNIFICANCE[stat] ? Math.min(SIGNIFICANCE[stat][0], SIGNIFICANCE[stat][1] * line) : null);
// How picks with gaps this size actually did against the line, 2024–25 blind backtest (raw projections).
export const TIER_RECORD = { '1–1.5×': { all: [1523, 0.548], OVER: [488, 0.520], UNDER: [1035, 0.561] }, '1.5–2×': { all: [878, 0.516], OVER: [299, 0.505], UNDER: [579, 0.522] }, '2×+': { all: [1341, 0.509], OVER: [661, 0.490], UNDER: [680, 0.528] } };
export const tierOf = (strength) => (strength >= 2 ? '2×+' : strength >= 1.5 ? '1.5–2×' : strength >= 1 ? '1–1.5×' : strength >= 0.6 ? 'lean' : null);

export const OUTLIER_RULES = {
  minSig: 1,             // the gap from the line must clear the stat's significance bar (SIGNIFICANCE, OR rule)
  minLift: 1.5,          // learned P(big miss) ≥ 1.5× the typical rate for this stat (after quality adjustment),
                         // AND more likely our way than the other way. Out of sample (2024→2025 / 2025→2024): side
                         // won 55.4% of 112 / 55.5% of 137 one-per-game picks (break-even ≈ 52.4%) — suggestive, not proven.
  minScore: 0.45,        // (legacy z, still shown for reference)
  minSideProb: 0.58,     // model P(side) — simulation output, uncalibrated
  minGames: 2,           // current-season games for the player
  staleHours: 72,        // book line older than this => ineligible
  sdFloor: { yards: 6, count: 0.8, td: 0.35 },
  // An OVER needs the stat to be part of the player's job. Expected volume below `roleMin` = minor role
  // (score × minorRolePenalty); below half of it = not his role (ineligible). The same penalty again when the
  // model gives a real chance of a zero game (10th percentile ≤ 0) on a non-TD stat; the two stack. UNDERs are not affected:
  // in the 2024–26 blind backtest minor-role OVERs finished at 0 or less 36% of the time (vs 3% for core
  // roles); minor-role UNDERs won 55.8% of 274.
  roleMin: { carries: 4, targets: 3, attempts: 15 },
  minorRolePenalty: 0.6,
};

const TD_STATS = new Set(['pass_td', 'rush_td', 'rec_td', 'tds', 'ints']);
const YARD_STATS = new Set(['pass_yds', 'rush_yds', 'rec_yds', 'long_rush', 'long_rec', 'long_cmp']);
const RATIO = new Set(['ypc', 'ypr']);
const VOLUME_OF = { rush_yds: 'carries', carries: 'carries', long_rush: 'carries', rush_td: 'carries', rec_yds: 'targets', receptions: 'targets', targets: 'targets', long_rec: 'targets', rec_td: 'targets', pass_yds: 'attempts', completions: 'attempts', pass_att: 'attempts', long_cmp: 'attempts', pass_td: 'attempts', ints: 'attempts' };
const VOL_WORD = { carries: 'carries', targets: 'targets', attempts: 'pass attempts' };

const pct = (x) => `${Math.round(x * 100)}%`;
const round1 = (x) => Math.round(x * 10) / 10;
const fmtT = (stat, T) => (/yds/.test(stat) ? `${Math.round(T)} yds` : `${round1(T)} ${stat === 'receptions' ? 'catches' : stat}`);

export function sdFloor(stat) {
  if (TD_STATS.has(stat)) return OUTLIER_RULES.sdFloor.td;
  if (YARD_STATS.has(stat)) return OUTLIER_RULES.sdFloor.yards;
  return OUTLIER_RULES.sdFloor.count;
}

/**
 * candidate: { playerId, name, team, pos, role, stat, label, proj, p10, p50, p90, line,
 *   probOver, seasonAvg, seasonGames, last5:[values], lineUpdated, lineSource, retrievedAt,
 *   injuryStatus, returning, smallSample, notes:[...], opportunity, isDisplayed }
 */
export function scoreCandidate(c, now = Date.now()) {
  const flags = [];
  if (c.line == null || !Number.isFinite(c.line)) return { ...c, eligible: false, reason: 'no book line' };
  if (c.skepticVeto) return { ...c, eligible: false, reason: `skeptic: ${c.skepticVeto}` };
  if (RATIO.has(c.stat)) return { ...c, eligible: false, reason: 'ratio stat not offered as a prop' };
  if (c.proj == null || c.p10 == null || c.p90 == null) return { ...c, eligible: false, reason: 'no projection' };
  // Model assigns this player no role for the stat (range 0–0) while the book posts a line:
  // that is a role/availability conflict to verify, not a credible statistical disagreement.
  if (c.p90 === 0 && c.proj < 0.5 && c.line > 0) return { ...c, eligible: false, roleConflict: true, reason: 'role conflict: model gives no role for this stat, book posts a line' };
  const sd = Math.max((c.p90 - c.p10) / 2.563, sdFloor(c.stat));
  const gap = c.proj - c.line;
  const z = gap / sd;
  if (!BIG[c.stat]) return { ...c, eligible: false, reason: 'not an outlier stat — TDs and longest-play props are decided by a single play', z };
  if (c.line < MIN_LINE[c.stat]) return { ...c, eligible: false, reason: `line ${c.line} is too low for a real outlier (min ${MIN_LINE[c.stat]})`, z };
  if (!c.bigMiss) return { ...c, eligible: false, reason: 'no big-miss estimate available', z };
  const bm = c.bigMiss;
  const liftOver = bm.baseBoom ? bm.boom / bm.baseBoom : 0, liftUnder = bm.baseBust ? bm.bust / bm.baseBust : 0;
  const direction = liftOver >= liftUnder ? 'OVER' : 'UNDER';
  const bigProb = direction === 'OVER' ? bm.boom : bm.bust, baseProb = direction === 'OVER' ? bm.baseBoom : bm.baseBust, lift = direction === 'OVER' ? liftOver : liftUnder;
  const againstProb = direction === 'OVER' ? bm.bust : bm.boom; // chance the line misses big the OTHER way
  const T = threshold(c.stat, c.line);
  const sigT = sigThreshold(c.stat, c.line), sigStrength = sigStrengthOf(c.stat, c.line, c.proj), gapDir = gap >= 0 ? 'OVER' : 'UNDER';
  const sideProb = c.probOver == null ? null : direction === 'OVER' ? c.probOver : 1 - c.probOver;
  let quality = 1, roleQuality = 1;
  if (direction === 'OVER') {
    const vk = VOLUME_OF[c.stat];
    const v = vk && c.expVolume ? c.expVolume[vk] : null;
    const min = vk ? OUTLIER_RULES.roleMin[vk] : null;
    if (v != null && min != null && v < min / 2) return { ...c, eligible: false, reason: `not his role: ${v.toFixed(1)} expected ${VOL_WORD[vk]} — an OVER would need an unusual role`, z, direction };
    const minor = v != null && min != null && v < min;
    const zeroRisk = !TD_STATS.has(c.stat) && c.p10 <= 0;
    // The two risks are separate and stack: a minor role AND a real zero-game chance needs a huge gap.
    if (minor) { quality *= OUTLIER_RULES.minorRolePenalty; roleQuality *= OUTLIER_RULES.minorRolePenalty; flags.push(`minor role for this stat (${v.toFixed(1)} expected ${VOL_WORD[vk]})`); }
    if (zeroRisk) { quality *= OUTLIER_RULES.minorRolePenalty; roleQuality *= OUTLIER_RULES.minorRolePenalty; flags.push('real chance of a zero game (10th percentile is 0)'); }
  }
  if ((c.seasonGames ?? 0) < OUTLIER_RULES.minGames) return { ...c, eligible: false, reason: `only ${c.seasonGames ?? 0} game(s) this season`, z, direction };
  if (c.seasonGames < 4) { quality *= 0.85; flags.push(`small sample (${c.seasonGames} games)`); }
  const inj = String(c.injuryStatus || '').toLowerCase();
  if (/out|doubtful|reserve/.test(inj)) return { ...c, eligible: false, reason: `listed ${c.injuryStatus}`, z, direction };
  if (/questionable/.test(inj)) { quality *= 0.7; flags.push(`listed ${c.injuryStatus} — model assumes he plays`); }
  if (c.returning) { quality *= 0.75; flags.push('returning from absence — workload uncertain'); }
  if (c.roleChange) { quality *= 0.9; flags.push('recent role change'); }
  const upd = c.lineUpdated ? Date.parse(c.lineUpdated) : NaN;
  const ref = c.retrievedAt ? Date.parse(c.retrievedAt) : now;
  if (c.lineUpdated && (!Number.isFinite(upd) || upd > ref + 60e3)) {
    // A line "updated" after we retrieved it is an impossible timestamp: freshness unknown.
    quality *= 0.85; flags.push(`line timestamp ${c.lineUpdated} is after retrieval — impossible, freshness unverified`);
  } else if (c.lineUpdated) {
    const ageH = (ref - upd) / 3600e3;
    if (ageH > OUTLIER_RULES.staleHours) return { ...c, eligible: false, reason: `book line ${Math.round(ageH)}h old`, z, direction };
    if (ageH > 24) { quality *= 0.9; flags.push(`line last updated ${Math.round(ageH)}h ago`); }
  } else flags.push('line timestamp not published');
  // The rule was validated on lift alone; only the (evidence-backed) role penalties change the score. Sample size,
  // questionable status, returning player and line age are shown as flags, not folded into the score.
  const score = lift * roleQuality;
  const agrees = direction === 'OVER' ? gap > 0 : gap < 0;
  const tailReaches = direction === 'OVER' ? c.p90 >= c.line + T : c.p10 <= c.line - T;
  const bigText = `${direction === 'OVER' ? `${fmtT(c.stat, T)}+ over` : `${fmtT(c.stat, T)}+ under`} the line`;
  let reason = null;
  if (score < OUTLIER_RULES.minLift) reason = `big-miss chance ${pct(bigProb)} is ${lift.toFixed(2)}× typical (${pct(baseProb)})${roleQuality < 1 ? `, ${score.toFixed(2)}× after the role penalty` : ''}; needs ${OUTLIER_RULES.minLift}×`;
  else if (bigProb <= againstProb) reason = `a big miss is about as likely the other way (${pct(againstProb)} vs ${pct(bigProb)}) — volatile, not one-sided`;
  else if (!agrees) reason = `the model's own projection (${round1(c.proj)}) is on the other side of the line`;
  else if (!tailReaches) reason = `the model's range doesn't reach ${bigText}`;
  // An edge has to be a real disagreement with the book: the gap must clear the same stat-specific bar as an outlier
  // (e.g. 4.2 vs a 4.5 catch line is 0.3× the bar — not an edge, however volatile the line).
  else if (sigStrength < OUTLIER_RULES.minSig) reason = `the gap from the line (${round1(c.proj)} vs ${c.line}) is only ${sigStrength.toFixed(2)}× the significance bar for this stat — too small to call an edge`;
  return {
    ...c, eligible: true, qualifies: reason == null, direction, gap, gapPct: c.line !== 0 ? gap / Math.abs(c.line) : null,
    sd, z, quality, roleQuality, score, lift, bigProb, againstProb, baseProb, bigThreshold: T, sigThreshold: sigT, sigStrength, sigTier: tierOf(sigStrength), gapDir, bigText, sideProb, flags, reason,
  };
}

/** Evidence bullets: why the model disagrees, stated descriptively. */
export function evidenceFor(c) {
  const ev = [];
  const fmt = (x) => (x == null ? '—' : Math.round(x * 10) / 10);
  if (c.seasonAvg != null) ev.push(`Season average ${fmt(c.seasonAvg)} over ${c.seasonGames} games vs line ${c.line}.`);
  const l5 = (c.last5 || []).filter((v) => v != null);
  if (l5.length) {
    const over = l5.filter((v) => v > c.line).length;
    ev.push(`Cleared ${c.line} in ${over} of last ${l5.length} games (${l5.join(', ')}).`);
  }
  if (c.opportunityText) ev.push(c.opportunityText);
  for (const n of c.notes || []) ev.push(n);
  return ev;
}

/** Rank all candidates; return the pick (or null with the reason) plus the ranked shortlist. */
export function selectOutlier(candidates, { now = Date.now(), top = 6 } = {}) {
  let scored = candidates.map((c) => scoreCandidate(c, now));
  // A role conflict on any stat makes ALL of that player's projections role-contaminated.
  const conflicted = new Set(scored.filter((c) => c.roleConflict).map((c) => c.playerId));
  scored = scored.map((c) => (conflicted.has(c.playerId) && !c.roleConflict ? { ...c, eligible: false, qualifies: false, reason: 'player has a role conflict on another stat — projections for him are role-contaminated' } : c));
  const eligible = scored.filter((c) => c.eligible).sort((a, b) => b.score - a.score);
  const pick = eligible.find((c) => c.qualifies) || null;
  // Every significant model-vs-line gap (minor-role OVERs excluded — e.g. a pocket QB's rushing).
  const significant = eligible.filter((c) => c.sigStrength >= 0.6 && !(c.gapDir === 'OVER' && c.roleQuality < 1))
    .sort((a, b) => b.sigStrength - a.sigStrength)
    .map((c) => ({ ...c, tierRecord: TIER_RECORD[c.sigTier]?.[c.gapDir] || null }));
  const outliers = significant.filter((c) => c.sigStrength >= 1), leans = significant.filter((c) => c.sigStrength < 1).slice(0, 5);
  const withLines = scored.filter((c) => c.line != null).length;
  let noPickReason = null;
  if (!pick) {
    if (!withLines) noPickReason = 'No player prop lines are posted for this game, so there is nothing to compare against.';
    else if (!eligible.length) noPickReason = 'Book lines exist, but none passed the sample/availability/freshness checks.';
    else noPickReason = `No pick this game. The strongest big-miss signal is ${eligible[0].name} ${eligible[0].label} ${eligible[0].direction} ${eligible[0].line} (${pct(eligible[0].bigProb)} chance of ${eligible[0].bigText}, ${eligible[0].lift.toFixed(2)}× typical) — ${eligible[0].reason}.`;
  }
  return {
    pick: pick ? { ...pick, evidence: evidenceFor(pick) } : null,
    outliers, leans,
    noPickReason,
    shortlist: eligible.slice(0, top),
    // Largest standardized gaps in each direction (for slate scans / reporting), eligible only.
    topOver: eligible.filter((c) => c.direction === 'OVER').slice(0, 3),
    topUnder: eligible.filter((c) => c.direction === 'UNDER').slice(0, 3),
    counted: { candidates: candidates.length, withLines, eligible: eligible.length },
    gapStats: { absZ: eligible.map((c) => Math.abs(c.z)), absGapPct: eligible.map((c) => Math.abs(c.gapPct ?? 0)), over: eligible.filter((c) => c.direction === 'OVER').length, under: eligible.filter((c) => c.direction === 'UNDER').length },
    roleConflicts: scored.filter((c) => c.roleConflict).map((c) => ({ playerId: c.playerId, name: c.name, team: c.team, pos: c.pos, stat: c.stat, label: c.label, line: c.line, lineUpdated: c.lineUpdated })),
    rules: OUTLIER_RULES,
  };
}
