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

/** c: outlier candidate with .card (player card), .teamHist / .teamProj ({targets, carries, passAtt} per game), .unitEdge. */
export function whyPick(c) {
  const out = [];
  const card = c.card || {};
  const vk = VOLUME[c.stat];
  const o = card.opportunity || {};
  const h = card.usageHistory || {};
  const projVol = vk === 'passAtt' ? o.dropbacks : vk ? o[vk] : null;
  const histVol = vk ? h[vk] : null;

  // 1. Volume
  if (projVol != null && histVol != null && h.games >= 1) {
    const word = VOL_WORD[vk];
    const diff = projVol - histVol;
    let s = `Volume: the model expects ${f1(projVol)} ${word}, vs his ${f1(histVol)} per game this season`;
    const causes = [];
    const shares = (card.shareTrend || []).map((x) => (vk === 'carries' ? x.carry : x.target)).filter((v) => v != null);
    const projShare = vk === 'carries' ? o.carryShare : vk === 'targets' ? o.targetShare : null;
    if (projShare != null && shares.length) {
      const seasonShare = shares.reduce((a, b) => a + b, 0) / shares.length, last = shares[shares.length - 1];
      if (Math.abs(projShare - seasonShare) >= 0.03) causes.push(`his projected ${vk === 'carries' ? 'carry' : 'target'} share is ${pct(projShare)} vs ${pct(seasonShare)} on the season${Math.abs(last - seasonShare) >= 0.05 ? ` — it was ${pct(last)} last game (${shares.map(pct).join(' → ')})` : ''}`);
    }
    // Same basis on both sides: projected team targets/carries (sum over every simulated player) vs actual per game.
    const teamH = c.teamHist?.[TEAM_VOL[vk]], teamP = c.teamProj?.[TEAM_VOL[vk]];
    if (teamH && teamP && Math.abs(teamP / teamH - 1) >= 0.08) causes.push(`his team is projected for ${f1(teamP)} ${vk === 'carries' ? 'carries' : 'targets'} vs ${f1(teamH)} per game so far (expected game script: ${c.expMargin != null ? (c.expMargin > 0 ? `favored by ${f1(c.expMargin)}` : `underdog by ${f1(-c.expMargin)}`) : 'n/a'})`);
    for (const r of card.redistribution || []) { const add = vk === 'carries' ? r.addCarryShare : r.addTargetShare; if (add >= 0.01) causes.push(`${r.from} is out, adding ${pct(add)} ${vk === 'carries' ? 'carry' : 'target'} share`); }
    if (Math.abs(diff) >= 0.15 * Math.max(histVol, 1)) s += causes.length ? ` — because ${causes.join('; ')}.` : '.';
    else s += causes.length ? ` (${causes.join('; ')}).` : ' — about the same.';
    out.push(s);
  }

  // 2. Efficiency + 3. line math
  const e = card.efficiency || {};
  const line = c.line;
  if ((c.stat === 'receptions' || c.stat === 'rec_yds') && e.catchRate?.final) {
    const cr = e.catchRate.final, ypc = e.ypCatch?.final;
    if (c.stat === 'receptions') {
      out.push(`Line math: at his ${pct(cr)} catch rate, ${line} catches takes about ${f1((Math.floor(line) + 1) / cr)} targets; his targets this season: ${listOf(c.card?.stats?.targets?.last5)}.`);
    } else if (ypc) {
      const ypt = cr * ypc;
      out.push(`Efficiency: ${pct(cr)} catch rate × ${f1(ypc)} yds/catch ≈ ${f1(ypt)} yds per target${e.ypCatch?.oppMult && Math.abs(e.ypCatch.oppMult - 1) >= 0.04 ? ` (opponent adjustment ×${e.ypCatch.oppMult.toFixed(2)})` : ''}. Line math: ${line} yards needs about ${f1(line / ypt)} targets at that rate.`);
    }
  } else if ((c.stat === 'rush_yds') && e.ypc?.final) {
    out.push(`Efficiency: ${f1(e.ypc.final)} yds/carry${Math.abs((e.ypc.oppMult ?? 1) - 1) >= 0.04 ? ` (opponent run D ×${e.ypc.oppMult.toFixed(2)})` : ''}. Line math: ${line} yards needs about ${f1(line / e.ypc.final)} carries at that rate; his carries this season: ${listOf(c.card?.stats?.carries?.last5)}.`);
  } else if (c.stat === 'pass_yds' && projVol) {
    const ypa = c.proj / projVol;
    out.push(`Efficiency: about ${f1(ypa)} yds per attempt projected. Line math: ${line} yards needs ${f1(line / ypa)} attempts at that rate, or ${f1(line / projVol)} yds/attempt on ${f1(projVol)} attempts.`);
  } else if (/_td$/.test(c.stat)) {
    out.push(`Touchdowns: the model's mean is ${f1(c.proj)} — driven by his team's implied ${f1(c.impliedPts)} points and his share of red-zone work.`);
  }

  // 4. Matchup (defense vs his position/style + unit edge)
  const fit = card.matchup?.fit;
  const runStat = /rush|carries/.test(c.stat);
  for (const r of fit?.reasons || []) if ((r.kind === 'run') === runStat) out.push(`Matchup: ${r.text}`);
  if (card.matchup?.style?.length) out.push(`Player type: ${card.matchup.style.join(', ')}.`);
  if (c.unitEdge) out.push(`Unit ratings: ${c.unitEdge.label} — ${c.team} offense ${c.unitEdge.offense} vs ${c.opponent} defense ${c.unitEdge.defense} (${c.unitEdge.verdict}).`);
  return out;
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
