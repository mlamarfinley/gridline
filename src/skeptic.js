// SKEPTIC: an independent sanity audit of a finished matchup. It does not trust the code that produced the
// numbers — it re-checks the outputs against football common sense and basic arithmetic, and reports anything
// that looks like a logic bug (e.g. a QB absorbing an injured RB's carries, an OUT player still projected,
// a team projected for more carries than it runs). Pure: reads the matchup, never changes it.
//
// Severity:  high   = almost certainly a logic error; the player is vetoed as the OUTLIER PICK
//            medium = suspicious; shown with evidence, worth a human look
//            info   = notable but explained (e.g. a big role change the model says it saw)

export const SKEPTIC_RULES = {
  // Team volume conservation: displayed players' projected carries/targets may not exceed the team's
  // projected rushes/pass attempts by more than this (displayed cards are a subset of the roster).
  overAllocation: 1.05,
  // Volume vs the player's own history this season (needs >= 2 games).
  jump: { ratio: 1.6, carries: 3, targets: 2.5, passAtt: 8 },
  drop: { ratio: 0.5, carries: 6, targets: 4, passAtt: 20 },
  // Primary-stat projection vs everything he did in his last 5 games.
  band: { lowMult: 0.6, highMult: 1.4, minGames: 3 },
  // Learned (v1.4) correction bigger than this share of the projection.
  bigCorrection: 0.35,
  // Model team points vs book-implied points.
  pointsGap: 7,
  // Position sanity.
  qbTargetShare: 0.02, wrCarryShare: 0.12,
};

const R = SKEPTIC_RULES;
const f1 = (x) => (x == null || !Number.isFinite(x) ? '—' : Math.round(x * 10) / 10);
const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const RANGE_STATS = ['pass_yds', 'rush_yds', 'rec_yds', 'completions', 'pass_att', 'carries', 'targets', 'receptions'];
const NONNEG = new Set(['pass_yds', 'rec_yds', 'completions', 'pass_att', 'carries', 'targets', 'receptions', 'pass_td', 'rush_td', 'rec_td', 'ints', 'fg_made', 'xp_made', 'k_pts']);

export function skeptic(m) {
  const findings = [];
  const add = (severity, check, msg, extra = {}) => findings.push({ severity, check, message: msg, ...extra });
  const teams = [m.home, m.away].filter(Boolean);

  // ---------- duplicate players across teams ----------
  const seen = new Map();
  for (const t of teams) for (const c of [...(t.cards || []), ...(t.kicker ? [t.kicker] : [])]) {
    if (c?.id == null) continue;
    if (seen.has(c.id) && seen.get(c.id) !== t.abbr) add('high', 'duplicate-player', `${c.name} is projected for both ${seen.get(c.id)} and ${t.abbr}.`, { playerId: c.id, team: t.abbr });
    seen.set(c.id, t.abbr);
  }

  for (const t of teams) {
    const cards = t.cards || [];
    const opp = cards.find((c) => c.opportunity?.teamPlays)?.opportunity;

    // ---------- team-level ----------
    const qbs = cards.filter((c) => c.pos === 'QB' && /Starting/.test(c.role || ''));
    if (qbs.length !== 1) add('high', 'starting-qb-count', `${t.abbr} has ${qbs.length} starting QBs projected (expected exactly 1).`, { team: t.abbr });
    if (!t.kicker && m.league === 'nfl') add('medium', 'no-kicker', `${t.abbr} has no kicker projected.`, { team: t.abbr });

    if (opp) {
      const passRate = opp.teamPassRate ?? 0.55;
      const teamRush = opp.teamPlays * (1 - passRate), teamPass = opp.teamPlays * passRate;
      const sumC = cards.reduce((s, c) => s + (c.opportunity?.carries || 0), 0);
      const sumT = cards.reduce((s, c) => s + (c.opportunity?.targets || 0), 0);
      if (sumC > teamRush * R.overAllocation) add('high', 'carries-over-allocated', `${t.abbr} players are projected for ${f1(sumC)} carries but the team only runs about ${f1(teamRush)} times.`, { team: t.abbr, evidence: { sumCarries: sumC, teamRushes: teamRush } });
      if (sumT > teamPass * R.overAllocation) add('high', 'targets-over-allocated', `${t.abbr} players are projected for ${f1(sumT)} targets but the team only throws about ${f1(teamPass)} times.`, { team: t.abbr, evidence: { sumTargets: sumT, teamPassPlays: teamPass } });
      const shareC = cards.reduce((s, c) => s + (c.opportunity?.carryShare || 0), 0);
      const shareT = cards.reduce((s, c) => s + (c.opportunity?.targetShare || 0), 0);
      // Displayed shares are each player's share over the games HE played (pre-normalization), so they can sum past
      // 100%; the simulation renormalizes. The real conservation test is the carries/targets check above.
      if (shareC > 1.02) add('info', 'carry-share-display', `${t.abbr} displayed carry shares sum to ${pct(shareC)} (each measured over that player's own games; the simulation renormalizes — projected carries stay within team rushes).`, { team: t.abbr });
      if (shareT > 1.02) add('info', 'target-share-display', `${t.abbr} displayed target shares sum to ${pct(shareT)} (each measured over that player's own games; the simulation renormalizes — projected targets stay within team pass plays).`, { team: t.abbr });
    }
    const qb = qbs[0];
    if (qb) {
      const recYds = cards.filter((c) => c.pos !== 'QB').reduce((s, c) => s + (c.stats?.rec_yds?.proj || 0), 0);
      const rec = cards.filter((c) => c.pos !== 'QB').reduce((s, c) => s + (c.stats?.receptions?.proj || 0), 0);
      if (qb.stats?.pass_yds?.proj != null && recYds > qb.stats.pass_yds.proj * 1.05) add('high', 'receiving-exceeds-passing', `${t.abbr} receivers are projected for ${f1(recYds)} receiving yards but the QB only ${f1(qb.stats.pass_yds.proj)} passing yards.`, { team: t.abbr });
      if (qb.stats?.completions?.proj != null && rec > qb.stats.completions.proj * 1.05) add('high', 'receptions-exceed-completions', `${t.abbr} receivers are projected for ${f1(rec)} catches but the QB only ${f1(qb.stats.completions.proj)} completions.`, { team: t.abbr });
    }
    if (t.v12?.points?.team != null && t.impliedPts != null && Math.abs(t.v12.points.team - t.impliedPts) > R.pointsGap) add('info', 'points-vs-book', `${t.abbr}: model points ${f1(t.v12.points.team)} vs book-implied ${f1(t.impliedPts)}.`, { team: t.abbr });

    // ---------- injuries: listed OUT/IR/Doubtful but still projected with a real role ----------
    const injById = new Map((t.injuries || []).map((i) => [String(i.athleteId), i]));
    for (const c of cards) {
      const inj = c.injury || injById.get(String(c.id));
      const st = String(inj?.status || '').toLowerCase();
      if (/^out|injured reserve|reserve|^ir\b|suspend/.test(st) && (c.stats?.[c.primary]?.proj || 0) > 0) add('high', 'out-player-projected', `${c.name} is listed ${inj.status} but is projected for ${f1(c.stats[c.primary].proj)} ${c.stats[c.primary].label?.toLowerCase() || c.primary}.`, { playerId: c.id, team: t.abbr });
      else if (/doubtful/.test(st)) add('medium', 'doubtful-player-projected', `${c.name} is listed Doubtful; the projection assumes he plays a full role.`, { playerId: c.id, team: t.abbr });
    }

    // ---------- player-level ----------
    for (const c of cards) {
      const o = c.opportunity || {};
      const h = c.usageHistory || {};
      const who = `${c.name} (${t.abbr} ${c.pos})`;

      // Usage moved to the wrong position from an absent teammate.
      for (const r of c.redistribution || []) {
        if (r.addCarryShare > 0.01 && c.pos === 'QB' && r.fromPos !== 'QB') add('high', 'qb-absorbs-non-qb-carries', `${who} was given +${pct(r.addCarryShare)} carry share from ${r.from} (${r.fromPos}) being out — a QB's runs don't replace a ${r.fromPos}'s carries.`, { playerId: c.id, team: t.abbr });
        if (r.addCarryShare > 0.01 && (c.pos === 'WR' || c.pos === 'TE') && r.fromPos === 'RB') add('high', 'receiver-absorbs-rb-carries', `${who} was given +${pct(r.addCarryShare)} carry share from ${r.from} (RB) being out.`, { playerId: c.id, team: t.abbr });
        if (r.addTargetShare > 0.005 && c.pos === 'QB') add('high', 'qb-absorbs-targets', `${who} was given +${pct(r.addTargetShare)} target share from ${r.from}.`, { playerId: c.id, team: t.abbr });
      }
      if (c.pos === 'QB' && (o.targetShare || 0) > R.qbTargetShare) add('high', 'qb-target-share', `${who} has a ${pct(o.targetShare)} target share.`, { playerId: c.id, team: t.abbr });
      if ((c.pos === 'WR' || c.pos === 'TE') && (o.carryShare || 0) > R.wrCarryShare) add('medium', 'receiver-carry-share', `${who} has a ${pct(o.carryShare)} carry share — unusual for a ${c.pos}.`, { playerId: c.id, team: t.abbr });

      // Volume vs his own history.
      const explained = (c.redistribution || []).length > 0 || (c.notes || []).some((n) => /Role change|absence|returning/i.test(n));
      const backup = c.role === 'Support' || (c.pos === 'QB' && !/Starting/.test(c.role || ''));
      if ((h.games || 0) >= 2) {
        for (const [key, hist, label] of [['carries', h.carries, 'carries'], ['targets', h.targets, 'targets'], ['passAtt', h.passAtt, 'pass attempts']]) {
          const proj = key === 'passAtt' ? o.dropbacks : o[key];
          if (proj == null || hist == null) continue;
          if (backup && key === 'passAtt') continue; // a backup QB is expected not to throw
          // Flag only when the projection is far from BOTH his season average and his most recent game
          // (a role that changed last week is the model following the evidence, not a bug).
          const last = h.last?.[key];
          const farFromLast = (p2) => last == null || (p2 > last * R.jump.ratio && p2 - last >= R.jump[key]);
          const farBelowLast = (p2) => last == null || (last >= R.drop[key] && p2 < last * R.drop.ratio);
          if (proj > hist * R.jump.ratio && proj - hist >= R.jump[key] && farFromLast(proj)) add(explained ? 'info' : 'medium', `volume-jump-${key}`, `${who}: projected ${f1(proj)} ${label} vs ${f1(hist)} per game so far (${f1(last)} last game)${explained ? ' (the model cites a reason: ' + ((c.notes || []).find((n) => /Role change|absence|returning/i.test(n)) || 'usage redistribution') + ')' : ' — no reason given'}.`, { playerId: c.id, team: t.abbr, evidence: { projected: proj, perGame: hist, games: h.games } });
          if (!backup && hist >= R.drop[key] && proj < hist * R.drop.ratio && farBelowLast(proj)) add(explained ? 'info' : 'medium', `volume-drop-${key}`, `${who}: projected ${f1(proj)} ${label} vs ${f1(hist)} per game so far (${f1(last)} last game)${explained ? '' : ' — no reason given'}.`, { playerId: c.id, team: t.abbr, evidence: { projected: proj, perGame: hist, games: h.games } });
        }
      }

      // Stat-level arithmetic and ranges.
      const S = c.stats || {};
      for (const [k, s] of Object.entries(S)) {
        if (!s || s.proj == null || s.p10 == null) continue;
        if (![s.proj, s.p10, s.p50, s.p90].every((v) => v == null || Number.isFinite(v))) add('high', 'non-finite', `${who} ${k}: projection or range is not a number.`, { playerId: c.id, team: t.abbr, stat: k });
        if (s.p50 != null && s.p90 != null && !(s.p10 <= s.p50 + 1e-9 && s.p50 <= s.p90 + 1e-9)) add('high', 'range-order', `${who} ${k}: range out of order (${f1(s.p10)} / ${f1(s.p50)} / ${f1(s.p90)}).`, { playerId: c.id, team: t.abbr, stat: k });
        if (NONNEG.has(k) && (s.proj < -1e-9 || s.p10 < -1e-9)) add('high', 'negative-count', `${who} ${k}: negative projection ${f1(s.proj)}.`, { playerId: c.id, team: t.abbr, stat: k });
        const corr = s.calibration?.correction;
        if (corr != null && s.proj > 5 && Math.abs(corr) > R.bigCorrection * s.proj) add('medium', 'big-learned-correction', `${who} ${k}: the v1.4 correction (${corr > 0 ? '+' : ''}${f1(corr)}) is ${Math.round(Math.abs(corr) / s.proj * 100)}% of the projection — out of sample, corrections this large were less reliable (2024→2025 test: 12.9 vs 16.3 avg miss on 54 such picks).`, { playerId: c.id, team: t.abbr, stat: k });
      }
      if (S.receptions?.proj != null && S.targets?.proj != null && S.receptions.proj > S.targets.proj + 1e-6) add('high', 'receptions-exceed-targets', `${who}: ${f1(S.receptions.proj)} receptions projected on ${f1(S.targets.proj)} targets.`, { playerId: c.id, team: t.abbr });
      if (S.completions?.proj != null && S.pass_att?.proj != null && S.completions.proj > S.pass_att.proj + 1e-6) add('high', 'completions-exceed-attempts', `${who}: ${f1(S.completions.proj)} completions on ${f1(S.pass_att.proj)} attempts.`, { playerId: c.id, team: t.abbr });
      if (S.receptions?.proj > 0.5 && S.rec_yds?.proj != null && S.rec_yds.proj / S.receptions.proj > 25) add('medium', 'yards-per-catch', `${who}: ${f1(S.rec_yds.proj / S.receptions.proj)} yards per catch projected.`, { playerId: c.id, team: t.abbr });
      if (S.carries?.proj > 1 && S.rush_yds?.proj != null && S.rush_yds.proj / S.carries.proj > 7.5) add('medium', 'yards-per-carry', `${who}: ${f1(S.rush_yds.proj / S.carries.proj)} yards per carry projected.`, { playerId: c.id, team: t.abbr });

      // Primary stat outside everything he has done in his last 5 games.
      const ps = S[c.primary];
      // This season only (roles change between seasons); a game with no recorded stat counts as 0.
      const thisSeason = String(m.season ?? '');
      const l5 = (ps?.last5 || []).filter((x) => !thisSeason || String(x.season) === thisSeason).map((x) => x.value ?? 0);
      if (!backup && ps?.proj != null && l5.length >= R.band.minGames && RANGE_STATS.includes(c.primary)) {
        const lo = Math.min(...l5), hi = Math.max(...l5);
        if (ps.proj > Math.max(hi * R.band.highMult, hi + 15)) add(explained ? 'info' : 'medium', 'above-recent-range', `${who}: projected ${f1(ps.proj)} ${ps.label?.toLowerCase()}, above every one of his last ${l5.length} games (${l5.join(', ')}).`, { playerId: c.id, team: t.abbr, stat: c.primary });
        if (lo > 10 && ps.proj < lo * R.band.lowMult) add(explained ? 'info' : 'medium', 'below-recent-range', `${who}: projected ${f1(ps.proj)} ${ps.label?.toLowerCase()}, below every one of his last ${l5.length} games (${l5.join(', ')}).`, { playerId: c.id, team: t.abbr, stat: c.primary });
      }
    }
  }

  const order = { high: 0, medium: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = { high: 0, medium: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { findings, counts, rules: SKEPTIC_RULES, vetoed: [...new Set(findings.filter((f) => f.severity === 'high' && f.playerId).map((f) => f.playerId))] };
}
