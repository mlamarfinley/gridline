// OUTLIER PICK: the largest *credible* disagreement between the model and an actual posted
// book line, in either direction (OVER or UNDER). Pure and side-effect free: it only reads
// projections that were already computed and never changes them.
//
// Ranking: standardized gap z = (model mean - line) / model SD (SD from the simulated 10-90
// range, with a per-stat floor so discrete stats can't produce huge z from a zero-width range),
// multiplied by a quality factor from sample size / availability / line freshness.
// A pick is only made when the adjusted score and the model's probability for that side both
// clear minimum thresholds. No book line => not a candidate. Nothing clears => no pick.

export const OUTLIER_RULES = {
  minScore: 0.45,        // |z| after quality adjustment
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
  const direction = gap >= 0 ? 'OVER' : 'UNDER';
  const sideProb = c.probOver == null ? null : direction === 'OVER' ? c.probOver : 1 - c.probOver;
  let quality = 1;
  if (direction === 'OVER') {
    const vk = VOLUME_OF[c.stat];
    const v = vk && c.expVolume ? c.expVolume[vk] : null;
    const min = vk ? OUTLIER_RULES.roleMin[vk] : null;
    if (v != null && min != null && v < min / 2) return { ...c, eligible: false, reason: `not his role: ${v.toFixed(1)} expected ${VOL_WORD[vk]} — an OVER would need an unusual role`, z, direction };
    const minor = v != null && min != null && v < min;
    const zeroRisk = !TD_STATS.has(c.stat) && c.p10 <= 0;
    // The two risks are separate and stack: a minor role AND a real zero-game chance needs a huge gap.
    if (minor) { quality *= OUTLIER_RULES.minorRolePenalty; flags.push(`minor role for this stat (${v.toFixed(1)} expected ${VOL_WORD[vk]})`); }
    if (zeroRisk) { quality *= OUTLIER_RULES.minorRolePenalty; flags.push('real chance of a zero game (10th percentile is 0)'); }
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
  const score = Math.abs(z) * quality;
  const pass = score >= OUTLIER_RULES.minScore && (sideProb == null || sideProb >= OUTLIER_RULES.minSideProb);
  return {
    ...c, eligible: true, qualifies: pass, direction, gap, gapPct: c.line !== 0 ? gap / Math.abs(c.line) : null,
    sd, z, quality, score, sideProb, flags,
    reason: pass ? null : score < OUTLIER_RULES.minScore ? `adjusted gap ${score.toFixed(2)} SD < ${OUTLIER_RULES.minScore}` : `model P(${direction.toLowerCase()}) ${(sideProb * 100).toFixed(0)}% < ${Math.round(OUTLIER_RULES.minSideProb * 100)}%`,
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
  const withLines = scored.filter((c) => c.line != null).length;
  let noPickReason = null;
  if (!pick) {
    if (!withLines) noPickReason = 'No player prop lines are posted for this game, so there is nothing to compare against.';
    else if (!eligible.length) noPickReason = 'Book lines exist, but none passed the sample/availability/freshness checks.';
    else noPickReason = `No credible disagreement: the largest adjusted gap is ${eligible[0].score.toFixed(2)} SD (${eligible[0].name} ${eligible[0].label}); a pick needs ≥ ${OUTLIER_RULES.minScore} SD and model P(side) ≥ ${Math.round(OUTLIER_RULES.minSideProb * 100)}%.`;
  }
  return {
    pick: pick ? { ...pick, evidence: evidenceFor(pick) } : null,
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
