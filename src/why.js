// WHY: the reasoning behind an outlier pick, built from the same inputs the model used. It answers:
//   1. Volume  — how many chances (targets / carries / pass attempts) the model expects vs his season, and why
//                (his share changed? his team's volume changed?)
//   2. Efficiency — what he does per chance vs his season (and the opponent adjustment)
//   3. Line math — what he would need to clear the line, and how often he has done that
//   4. Matchup — this defense vs his position / style (src/profiles.js), and the relevant unit-rating edge
// Pure: reads a candidate (with its card fields attached), returns plain-English sentences, most important first.

const f1 = (x) => (x == null || !Number.isFinite(x) ? '—' : (Math.round(x * 10) / 10).toString());
const pct = (x) => `${Math.round(x * 100)}%`;
const VOLUME = {
  receptions: 'targets', rec_yds: 'targets', targets: 'targets', long_rec: 'targets', rec_td: 'targets',
  rush_yds: 'carries', carries: 'carries', long_rush: 'carries', rush_td: 'carries',
  pass_yds: 'passAtt', completions: 'passAtt', pass_att: 'passAtt', pass_td: 'passAtt', ints: 'passAtt', long_cmp: 'passAtt',
};
const VOL_WORD = { targets: 'targets', carries: 'carries', passAtt: 'pass attempts' };
const TEAM_VOL = { targets: 'targets', carries: 'carries', passAtt: 'passAtt' };

/**
 * c: candidate with .direction, .card (player card), .teamHist / .teamProj ({targets, carries, passAtt} per game),
 * .unitEdge, .expMargin, .scriptWeights. Returns [{ text, stance }] where stance is 'for' (supports the pick),
 * 'against' (works against it) or 'info' (context), ordered for → against → info.
 */
export function whyPick(c) {
  const out = [];
  const sign = c.direction === 'UNDER' ? -1 : 1; // +1 = facts that push the number UP support this pick
  const add = (text, effect = 0) => out.push({ text, stance: effect === 0 ? 'info' : effect * sign > 0 ? 'for' : 'against' });
  const card = c.card || {};
  const vk = VOLUME[c.stat];
  const o = card.opportunity || {};
  const h = card.usageHistory || {};
  const projVol = vk === 'passAtt' ? o.dropbacks : vk ? o[vk] : null;
  const histVol = vk ? h[vk] : null;
  const runStat = /rush|carries/.test(c.stat);

  // 0. The line vs his record this season (the most direct case for either side of a line).
  const vals = seasonValues(card.stats?.[c.stat]?.last5);
  if (c.line != null && vals.length >= 2) {
    const avgV = vals.reduce((a, b) => a + b, 0) / vals.length, over = vals.filter((v) => v > c.line).length;
    const d = avgV - c.line, meaningful = Math.abs(d) >= 0.1 * Math.max(1, c.line);
    add(`Line vs his season: ${c.line} vs his ${f1(avgV)} average; he went over it in ${over} of ${vals.length} games (${vals.join(', ')}).`, meaningful ? (d > 0 ? 1 : -1) : 0);
  }

  // 1. Volume
  if (projVol != null && histVol != null && h.games >= 1) {
    const word = VOL_WORD[vk];
    const diff = projVol - histVol;
    const big = Math.abs(diff) >= 0.1 * Math.max(histVol, 1);
    let s = `Volume: the model expects ${f1(projVol)} ${word}, vs his ${f1(histVol)} per game this season${h.partialGames ? ` (not counting ${h.partialGames} partial game${h.partialGames > 1 ? 's' : ''})` : ''}`;
    const shares = (card.shareTrend || []).filter((x) => !x.partial).map((x) => (vk === 'carries' ? x.carry : x.target)).filter((v) => v != null);
    const projShare = vk === 'carries' ? o.carryShare : vk === 'targets' ? o.targetShare : null;
    if (projShare != null && shares.length) {
      const seasonShare = shares.reduce((a, b) => a + b, 0) / shares.length, last = shares[shares.length - 1];
      if (Math.abs(projShare - seasonShare) >= 0.03) s += ` — his projected ${vk === 'carries' ? 'carry' : 'target'} share is ${pct(projShare)} vs ${pct(seasonShare)} on the season${Math.abs(last - seasonShare) >= 0.05 ? ` (${shares.map(pct).join(' → ')})` : ''}`;
    }
    add(`${s}.`, big ? (diff > 0 ? 1 : -1) : 0);
    // Team volume, same basis on both sides: projected team targets/carries vs actual per game.
    const teamH = c.teamHist?.[TEAM_VOL[vk]], teamP = c.teamProj?.[TEAM_VOL[vk]];
    if (teamH && teamP) {
      const r = teamP / teamH - 1;
      add(`Team volume: his team is projected for ${f1(teamP)} ${vk === 'carries' ? 'carries' : 'targets'}, vs ${f1(teamH)} per game so far.`, Math.abs(r) >= 0.08 ? (r > 0 ? 1 : -1) : 0);
    }
    for (const r of card.redistribution || []) { const a = vk === 'carries' ? r.addCarryShare : r.addTargetShare; if (a >= 0.01) add(`Injury: ${r.from} is ${r.questionable ? 'questionable (expected share of what he\'d leave)' : 'out'}, adding ${pct(a)} ${vk === 'carries' ? 'carry' : 'target'} share.`, 1); }
  }
  for (const n of card.notes || []) {
    if (/partial game/.test(n)) add(`Injury context: ${n}`);
    // His own questionable tag: lower usage when active.
    else if (/^Listed .*questionable played/i.test(n)) add(`Injury: ${n}`, /at 100% usage/.test(n) ? 0 : -1);
    // A teammate's absence changing the team's run/pass mix: more passing helps pass stats, hurts run stats.
    else if (/^Team run\/pass mix/.test(n) && vk) { const up = /raised/.test(n); add(n, (vk === 'carries') === up ? -1 : 1); }
    else if (/^QB .* is questionable/.test(n) && /rec_yds|pass_yds/.test(c.stat)) add(`Injury: ${n}`, -1);
  }

  // 2. Game script
  if (c.expMargin != null && c.scriptWeights) {
    const w = c.scriptWeights, ahead = (w.lead || 0) + (w.blowLead || 0), behind = (w.trail || 0) + (w.blowTrail || 0);
    const fav = c.expMargin >= 0 ? `favored by ${f1(c.expMargin)}` : `an underdog by ${f1(-c.expMargin)}`;
    const meaningful = Math.abs(c.expMargin) >= 3 && Math.abs(ahead - behind) >= 0.1;
    const e = !meaningful ? 0 : runStat ? (ahead > behind ? 1 : -1) : (behind > ahead ? 1 : -1);
    add(`Game script: ${c.team} is ${fav}; the model spends ${pct(ahead)} of the game ahead and ${pct(behind)} behind. Teams that are ahead run more and throw less${runStat ? '' : ', and trailing teams throw more'}.${meaningful && runStat && (w.blowLead || 0) >= 0.12 ? ` (${pct(w.blowLead)} chance of a blowout lead, where some late carries go to backups.)` : ''}`, e);
  }

  // 3. Efficiency + line math
  const e = card.efficiency || {};
  const line = c.line;
  if ((c.stat === 'receptions' || c.stat === 'rec_yds') && e.catchRate?.final) {
    const cr = e.catchRate.final, ypc = e.ypCatch?.final;
    if (c.stat === 'receptions') {
      const need = (Math.floor(line) + 1) / cr;
      add(`Line math: at his ${pct(cr)} catch rate, ${line} catches takes about ${f1(need)} targets; the model expects ${f1(projVol)}. His targets this season: ${listOf(c.card?.stats?.targets?.last5)}.`, mathEffect(projVol, need));
    } else if (ypc) {
      const ypt = cr * ypc, m = e.ypCatch?.oppMult ?? 1;
      if (Math.abs(m - 1) >= 0.04) add(`Matchup efficiency: this defense moves his yards per catch ×${m.toFixed(2)} (applied to the projection).`, m > 1 ? 1 : -1);
      add(`Line math: ${pct(cr)} catch rate × ${f1(ypc)} yds/catch ≈ ${f1(ypt)} yds per target, so ${line} yards needs about ${f1(line / ypt)} targets; the model expects ${f1(projVol)}.`, mathEffect(projVol, line / ypt));
    }
  } else if (c.stat === 'rush_yds' && e.ypc?.final) {
    const m = e.ypc.oppMult ?? 1;
    if (Math.abs(m - 1) >= 0.04) add(`Matchup efficiency: this run defense moves his yards per carry ×${m.toFixed(2)} (applied to the projection).`, m > 1 ? 1 : -1);
    add(`Line math: at ${f1(e.ypc.final)} yds/carry, ${line} yards needs about ${f1(line / e.ypc.final)} carries; the model expects ${f1(projVol)}. His carries this season: ${listOf(c.card?.stats?.carries?.last5)}.`, mathEffect(projVol, line / e.ypc.final));
  } else if (c.stat === 'pass_yds' && projVol) {
    const ypa = c.proj / projVol;
    add(`Line math: about ${f1(ypa)} yds per attempt projected, so ${line} yards needs ${f1(line / ypa)} attempts; the model expects ${f1(projVol)}.`, mathEffect(projVol, line / ypa));
  }

  // 4a. Same slot vs this defense: what the last 5 players in his role (RB1, WR1, …) did against them.
  const vp = card.stats?.[c.stat]?.vsPos;
  if (vp?.avg != null && c.line != null) {
    const g = vp.games.filter((x) => x.value != null);
    const d = vp.avg - c.line, meaningful = Math.abs(d) >= 0.1 * Math.max(1, c.line) && g.length >= 3;
    add(`Matchup: ${vp.label}, last ${g.length}: ${g.map((x) => `${x.name ? x.name.split(' ').slice(-1)[0] : '?'} ${f1(x.value)}`).join(', ')} — average ${f1(vp.avg)} vs this ${c.line} line.`, meaningful ? (d > 0 ? 1 : -1) : 0);
  }
  // Head-to-head: his last games against this opponent (any team, any season). Context only — 1–3 games, often with
  // different teammates and coaches, is too small a sample to count for or against a side.
  const hh = card.stats?.[c.stat]?.h2h;
  if (hh?.games?.some((g) => g.value != null)) add(`Head-to-head: his last ${hh.games.length} vs ${hh.opp}: ${hh.games.map((g) => `${f1(g.value)} (${g.season} season${g.team ? `, ${g.team}` : ''})`).join(', ')}${hh.avg != null && c.line != null ? ` — average ${f1(hh.avg)} vs this ${c.line} line` : ''}. Small sample, so context only.`);

  // Situational multiplier model: his baseline × what this kind of game has done to players like him (2022–25).
  const sx = card.stats?.[c.stat]?.situational;
  if (sx && c.line != null) {
    const d = sx.value - c.line, meaningful = Math.abs(d) >= 0.1 * Math.max(1, c.line);
    add(`Situation model: ${situationText(sx)}${sx.w ? ` — ${pct(sx.w)} of it is blended into the projection (that improved accuracy out of sample)` : ' — shown for reference; for this stat the main model was more accurate out of sample'}.`, meaningful ? (d > 0 ? 1 : -1) : 0);
  }
  // Player quality: Player Rating (RB carries / rush yds) and the skill ratings.
  const ra = card.stats?.[c.stat]?.ratingAdj;
  if (ra && Math.abs(ra.shift) >= 0.3) add(`Player Rating ${ra.rating}: moves the projection ${ra.shift > 0 ? 'up' : 'down'} ${f1(Math.abs(ra.shift))} (backs this good / this weak beat / missed their projections in 2024).`, ra.shift > 0 ? 1 : -1);
  const sa = card.stats?.[c.stat]?.skillAdj;
  if (sa && Math.abs(sa.shift) >= 0.1) add(`Skill ratings (overall ${sa.overall}): ${sa.shift > 0 ? '+' : ''}${f1(sa.shift)}${sa.top.length ? ` — mostly ${sa.top.map((t) => `${t.skill} ${t.rating}`).join(', ')}` : ''}.`, 0);
  // Season anchor (learned): part of the projection is his own season average.
  const an = card.stats?.[c.stat]?.anchor;
  if (an && Math.abs(an.shift) >= 0.5) add(`Who he is: the projection is blended ${pct(an.w)} toward his season average (${f1(an.seasonAvg)}), moving it ${an.shift > 0 ? 'up' : 'down'} ${f1(Math.abs(an.shift))} — learned from 2024–25, where it made projections more accurate.`, an.shift > 0 ? 1 : -1);

  // 4. Matchup (defense vs his position/style + unit edge)
  const fit = card.matchup?.fit;
  let favorableRec = false;
  for (const r of fit?.reasons || []) if ((r.kind === 'run') === runStat) { add(`Matchup: ${r.text}`, r.effect || 0); if (!runStat && r.effect > 0) favorableRec = true; }
  if (c.unitEdge) add(`Unit ratings: ${c.unitEdge.label} — ${c.team} offense ${c.unitEdge.offense} vs ${c.opponent} defense ${c.unitEdge.defense} (${c.unitEdge.verdict}).`, c.unitEdge.verdict === 'offense advantage' ? 1 : c.unitEdge.verdict === 'defense advantage' ? -1 : 0);
  if (favorableRec && sign < 0) add('Note: a soft matchup raises his yards per target (applied above), not his number of targets. Across 7,600 receiver-games (2022–25), receivers did not get more targets against defenses that allow more to their position or zones (scripts/matchup_volume_test.mjs).');
  if (card.matchup?.style?.length) add(`Player type: ${card.matchup.style.join(', ')}.`);
  const order = { for: 0, against: 1, info: 2 };
  return out.sort((a, b) => order[a.stance] - order[b.stance]);
}

const SIT_WORD = { favPts: 'favored', dogPts: 'underdog', blowFav: 'big favorite', blowDog: 'big underdog', teamTot: 'team total', oppAllow: 'what this defense allows', home: 'home', wind15: 'wind', cold: 'cold' };
/** "his baseline 20.0 × 0.98 (underdog by 2.5) × 1.04 (what this defense allows) = 20.4" */
export function situationText(sx) {
  const parts = [...(Math.abs(sx.constMult - 1) >= 0.005 ? [{ feat: 'level', mult: sx.constMult }] : []), ...(sx.parts || [])];
  const label = (p) => (p.feat === 'level' ? 'typical change for this stat' : p.feat === 'favPts' || p.feat === 'blowFav' ? `favored by ${f1(sx.spread)}` : p.feat === 'dogPts' || p.feat === 'blowDog' ? `underdog by ${f1(-sx.spread)}` : p.feat === 'oppAllow' ? `this defense allows ${f1(sx.oppAllowPer)} per game to his position vs ${f1(sx.leaguePer)} league` : SIT_WORD[p.feat] || p.feat);
  return `his baseline ${f1(sx.base)}${parts.map((p) => ` × ${p.mult.toFixed(2)} (${label(p)})`).join('')} = ${f1(sx.value)}`;
}
// Volume clears what the line needs → supports OVER (+1); well short → supports UNDER (−1); within 5% → no lean.
function mathEffect(have, need) {
  if (!(have > 0) || !(need > 0)) return 0;
  const r = have / need - 1;
  return Math.abs(r) < 0.05 ? 0 : r > 0 ? 1 : -1;
}
function seasonValues(l5) {
  const cur = (l5 || []).filter((x) => x && x.season && String(x.season) === String(l5[l5.length - 1]?.season));
  return cur.map((x) => x.value ?? 0);
}
function listOf(l5) {
  const v = (l5 || []).filter((x) => x && x.season && String(x.season) === String(l5[l5.length - 1]?.season)).map((x) => x.value ?? 0);
  return v.length ? v.join(', ') : 'n/a';
}

/** Which unit-rating edge is relevant for a stat/position. Keys from src/profiles.js EDGES. */
export function edgeKeyFor(pos, stat) {
  if (/^rush|carries|long_rush/.test(stat)) return 'Run game';
  if (pos === 'TE') return 'TEs vs TE coverage';
  if (pos === 'RB') return 'RB receiving vs RB coverage';
  if (pos === 'WR') return 'WRs vs outside coverage (CBs)';
  if (pos === 'QB') return 'Passing vs pass defense';
  return null;
}
