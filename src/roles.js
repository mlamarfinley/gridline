// Role selection + availability. Pure functions (tested in test/roles.test.js).
//
// Rules:
//  * Nobody is assigned a role without evidence: NFL starting QB/K come from ESPN's depth chart
//    (cross-checked with the last start); RBs and receivers are ranked by actual recent usage.
//  * A player must be on the team's CURRENT roster (pregame) and not ruled Out/Doubtful/IR.
//  * College: ESPN publishes no depth charts or injury feed, so roles come from box-score usage
//    and that limitation is surfaced in `notes`.
import { injurySeverity } from './espn.js';
import { normPos } from './history.js';

export function availability(athleteId, { injuries, roster, rosterCheck }) {
  const inj = injuries.get(athleteId) || null;
  const sev = inj ? injurySeverity(inj.status) : null;
  let onRoster = true, rosterGroup = null;
  if (rosterCheck && roster) {
    const r = roster.get(athleteId);
    onRoster = !!r;
    rosterGroup = r?.group || null;
  }
  const inactiveGroup = rosterGroup === 'injuredReserveOrOut' || rosterGroup === 'practiceSquad' || rosterGroup === 'suspended';
  const available = onRoster && !inactiveGroup && sev !== 'out' && sev !== 'doubtful';
  let reason = null;
  if (!onRoster) reason = 'Not on current roster';
  else if (inactiveGroup) reason = rosterGroup === 'practiceSquad' ? 'Practice squad' : rosterGroup === 'suspended' ? 'Suspended' : 'Injured reserve / out';
  else if (sev === 'out' || sev === 'doubtful') reason = inj.status;
  return { available, injury: inj, severity: sev, reason };
}

/** Recency-weighted usage over the last `n` team games. */
export function recentUsage(rows, teamTotals, n = 3) {
  const lastIds = teamTotals.slice(-n).map((t) => t.eventId);
  const w = (eid) => { const i = lastIds.indexOf(eid); return i < 0 ? 0 : Math.pow(0.8, lastIds.length - 1 - i); };
  let carries = 0, targets = 0, att = 0, recYds = 0, games = 0, fg = 0;
  for (const r of rows || []) {
    const ww = w(r.eventId);
    if (!ww) continue;
    games++;
    carries += ww * (r.stats.carries || 0);
    targets += ww * (r.stats.targets || 0);
    att += ww * (r.stats.pass_att || 0);
    recYds += ww * (r.stats.rec_yds || 0);
    fg += ww * ((r.stats.fg_att || 0) + (r.stats.xp_att || 0));
  }
  return { carries, targets, att, recYds, games, kicks: fg, touches: carries + targets };
}

/**
 * Select core players for one team.
 * ctx: { lg, rows: Map<id,rows>, teamTotals, rosterById: Map, depth: {qb,rb,wr,te,pk}|null,
 *        injuries: Map<id,inj>, rosterCheck: bool, nameOf: Map<id,name>, posOf: (id)=>pos }
 */
export function selectRoles(ctx) {
  const { lg, rows, teamTotals, rosterById, depth, injuries, rosterCheck } = ctx;
  const notes = [];
  const excluded = [];
  const pos = (id) => normPos(ctx.posOf(id)) || (ctx.posOf(id) === 'PK' || ctx.posOf(id) === 'K' ? 'K' : null);
  const avail = (id) => availability(id, { injuries, roster: rosterById, rosterCheck });
  const usage = new Map();
  for (const [id, r] of rows) usage.set(id, recentUsage(r, teamTotals, 3));
  const candidates = [...new Set([...rows.keys(), ...(depth ? Object.values(depth).flat() : [])])];

  const pickFrom = (ids, want, label) => {
    const chosen = [];
    for (const id of ids) {
      if (chosen.length >= want) break;
      const a = avail(id);
      if (!a.available) { if (!excluded.find((e) => e.id === id)) excluded.push({ id, pos: label, reason: a.reason }); continue; }
      chosen.push(id);
    }
    return chosen;
  };

  // --- QB ---
  let qb = null, qbSource = null;
  const lastGame = teamTotals[teamTotals.length - 1];
  const lastStarter = lastGame ? [...rows].filter(([, r]) => r.some((x) => x.eventId === lastGame.eventId && (x.stats.pass_att || 0) > 0))
    .sort((a, b) => (b[1].find((x) => x.eventId === lastGame.eventId).stats.pass_att || 0) - (a[1].find((x) => x.eventId === lastGame.eventId).stats.pass_att || 0))[0]?.[0] : null;
  if (lg === 'nfl' && depth?.qb?.length) {
    qb = pickFrom(depth.qb, 1, 'QB')[0] || null;
    qbSource = 'ESPN depth chart';
    if (qb && lastStarter && qb !== lastStarter && avail(lastStarter).available) {
      notes.push({ kind: 'qb-mismatch', text: `Depth chart QB1 differs from last game's leading passer — depth chart used; verify before kickoff.`, ids: [qb, lastStarter] });
    }
    if (depth.qb[0] && qb !== depth.qb[0]) notes.push({ kind: 'qb-change', text: `Listed QB1 unavailable (${avail(depth.qb[0]).reason}); next on depth chart used.`, ids: [depth.qb[0], qb] });
  }
  if (!qb) {
    const byAtt = candidates.filter((id) => pos(id) === 'QB').sort((a, b) => (usage.get(b)?.att || 0) - (usage.get(a)?.att || 0));
    qb = pickFrom(byAtt, 1, 'QB')[0] || null;
    qbSource = 'Recent pass attempts (box scores)';
  }

  // --- RBs by usage (carries + targets) ---
  const wantRb = 2;
  const rbIds = candidates.filter((id) => pos(id) === 'RB').sort((a, b) => (usage.get(b)?.touches || 0) - (usage.get(a)?.touches || 0));
  let rbs = pickFrom(rbIds.filter((id) => (usage.get(id)?.touches || 0) > 0), wantRb, 'RB');
  if (rbs.length < wantRb && lg === 'nfl' && depth?.rb) {
    for (const id of pickFrom(depth.rb, wantRb + 2, 'RB')) if (rbs.length < wantRb && !rbs.includes(id)) rbs.push(id);
    if (rbs.length) notes.push({ kind: 'rb-depth', text: 'Fewer than two RBs with recent usage; depth chart used to fill.' });
  }

  // --- Receivers (WR/TE) ---
  const wantRec = lg === 'nfl' ? 2 : 1;
  const recKey = lg === 'nfl' ? 'targets' : 'recYds';
  const recIds = candidates.filter((id) => pos(id) === 'WR' || pos(id) === 'TE')
    .sort((a, b) => (usage.get(b)?.[recKey] || 0) - (usage.get(a)?.[recKey] || 0) || (usage.get(b)?.recYds || 0) - (usage.get(a)?.recYds || 0));
  const recs = pickFrom(recIds.filter((id) => (usage.get(id)?.[recKey] || 0) > 0), wantRec, 'WR/TE');

  // --- Kicker (NFL only in the spec) ---
  let k = null;
  if (lg === 'nfl') {
    if (depth?.pk?.length) k = pickFrom(depth.pk, 1, 'K')[0] || null;
    if (!k) k = pickFrom(candidates.filter((id) => pos(id) === 'K').sort((a, b) => (usage.get(b)?.kicks || 0) - (usage.get(a)?.kicks || 0)), 1, 'K')[0] || null;
  }

  // --- Additional card: a skill player outside the core with a real, recent role ---
  const core = new Set([qb, ...rbs, ...recs].filter(Boolean));
  let extra = null;
  if (lastGame) {
    const lastT = lastGame.teamTargets || 0, lastC = lastGame.teamCarries || 0;
    const cands = candidates
      .filter((id) => !core.has(id) && ['QB', 'RB', 'WR', 'TE'].includes(pos(id)) && avail(id).available)
      .map((id) => {
        const r = (rows.get(id) || []).find((x) => x.eventId === lastGame.eventId);
        const ts = r && lastT ? (r.stats.targets || 0) / lastT : 0;
        const cs = r && lastC ? (r.stats.carries || 0) / lastC : 0;
        const prev = (rows.get(id) || []).filter((x) => x.eventId !== lastGame.eventId);
        const prevTs = prev.length ? prev.reduce((s, x) => s + (x.share.target || 0), 0) / prev.length : 0;
        return { id, ts, cs, rising: ts - prevTs, recYds: r?.stats.rec_yds || 0, rushYds: r?.stats.rush_yds || 0 };
      })
      .filter((c) => c.ts >= 0.15 || c.cs >= 0.25 || (c.rising >= 0.1 && c.ts >= 0.1));
    cands.sort((a, b) => (b.ts + b.cs) - (a.ts + a.cs));
    if (cands[0]) {
      const c = cands[0];
      const why = c.cs >= 0.25 ? `${Math.round(c.cs * 100)}% of carries last game` : `${Math.round(c.ts * 100)}% target share last game${c.rising >= 0.1 ? ` (up ${Math.round(c.rising * 100)} pts)` : ''}`;
      extra = { id: c.id, reason: why };
    }
  }
  // Next-man-up: an excluded core-caliber player creates a role change worth flagging.
  for (const e of excluded) {
    const u = usage.get(e.id);
    if (!u || !(u.touches >= 8 || u.att >= 10)) continue;
    const nm = ctx.nameOf.get(e.id) || e.id;
    if (lg === 'cfb') notes.push({ kind: 'absence-unverified', text: `${nm} (${e.pos}) not selected: ${e.reason === 'Not on current roster' ? "not listed on ESPN's current roster" : e.reason}. Unverified (no college injury report; roster data can lag) — no absence assumed and no workload redistributed.`, ids: [e.id] });
    else notes.push({ kind: 'absence', text: `${nm} (${e.pos}) unavailable — ${e.reason} (${e.reason === 'Not on current roster' ? 'ESPN roster' : 'ESPN injury report / roster designation'}). Usage redistributed.`, ids: [e.id] });
  }
  if (lg === 'cfb') notes.push({ kind: 'cfb-roles', text: 'College roles are inferred from recent box-score usage: ESPN publishes no college depth chart or injury report.' });

  return { qb, qbSource, rbs, recs, k, extra, excluded, notes, usage };
}

/** Identify "key" teammates whose presence meaningfully changes others' usage. */
export function keyPlayers(rows, teamTotals) {
  const keys = new Set();
  for (const [id, r] of rows) {
    for (const x of r) {
      if ((x.share.carry || 0) >= 0.2 || (x.share.target || 0) >= 0.14 || (x.stats.pass_att || 0) >= 12) { keys.add(id); break; }
    }
  }
  return keys;
}

/**
 * Game weights for estimating a player's usage THIS week: recency decay times a context
 * penalty for each key teammate whose presence in that game differs from this week's
 * expectation (e.g. games without a now-returning starter are down-weighted).
 */
export function contextWeights(playerId, teamTotals, keys, expectedPresent) {
  const n = teamTotals.length;
  return teamTotals.map((t, i) => {
    let w = Math.pow(0.82, n - 1 - i);
    const mism = [];
    for (const k of keys) {
      if (k === playerId) continue;
      const was = t.appeared.has(k);
      const will = expectedPresent(k);
      if (was !== will) { w *= 0.4; mism.push(k); }
    }
    return { eventId: t.eventId, w: Math.max(w, 0.04), mismatches: mism };
  });
}
