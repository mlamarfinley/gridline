// Whole-stat outcomes from the final simulation, independent of player prop prices.
export function outcomeDistribution(samples, scale = 1) {
  if (!samples?.length || !Number.isFinite(scale) || scale < 0) return null;
  const bins = new Map();
  for (const sample of samples) {
    if (!Number.isFinite(sample) || !Number.isFinite(sample * scale)) return null;
    const value = Math.round(sample * scale);
    bins.set(value, (bins.get(value) || 0) + 1);
  }
  return { n: samples.length, bins: [...bins].sort((a,b) => a[0]-b[0]) };
}
export function targetDistributions(samples, stat) {
  const baseline = outcomeDistribution(samples);
  const mean = baseline ? Array.from(samples).reduce((a,b)=>a+b,0)/samples.length : 0;
  const projection = stat.experimental?.projection;
  return { version: 1, baseline, experimental: mean > 0 && Number.isFinite(projection) && projection >= 0 ? outcomeDistribution(samples, projection/mean) : null };
}
export function targetChance(distribution, target) {
  if (!distribution?.n || !Number.isFinite(target)) return null;
  const hits = distribution.bins.reduce((sum,[value,count]) => sum + (value >= target ? count : 0), 0);
  return { hits, n: distribution.n, probability: (hits + 0.5)/(distribution.n + 1) };
}
export function formatChance(p) {
  if (!Number.isFinite(p)) return 'Unavailable';
  return p > .999 ? '>99.9%' : p < .001 ? '<0.1%' : `${(100*p).toFixed(1)}%`;
}
const remembered = new Map();
const escape = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function resultMarkup(d, target) {
  const baseline = targetChance(d.baseline,target), experimental = targetChance(d.experimental,target);
  const primary = experimental || baseline;
  if (!primary) return '<p>Simulation samples unavailable.</p>';
  return `<div class="target-chance"><div><span>${experimental ? 'Experimental scenario' : 'Baseline model'}</span><strong>${formatChance(primary.probability)}</strong><span>chance of reaching ${target} or more</span></div>${experimental ? `<div class="target-baseline">Baseline <b>${formatChance(baseline.probability)}</b></div>` : ''}</div><p class="target-confidence">${primary.probability >= .9 ? 'High model probability · not guaranteed' : 'Model estimate · not calibrated'}</p>`;
}
export function playerTargetBlock(m,c,s) {

  const d=s.targetDistribution;
  if (!d?.baseline) return '<p class="faint">Target explorer unavailable: this stat has no saved simulation distribution.</p>';
  const key=JSON.stringify([m.id ?? m.eventId ?? m.kickoff,c.id,s.key]);
  const target=remembered.get(key) ?? Math.max(0,Math.round(s.experimental?.projection ?? s.proj ?? 0));
  const max=Math.max(10,Math.ceil((d.experimental||d.baseline).bins.at(-1)[0]),target);
  const id=`target-${c.id}-${s.key}`;
  return `<section class="target-explorer" data-target-key="${escape(key)}"><h4>Explore a target · ${escape(s.label)}</h4>${m.status?.state!=='pre'?'<p class="target-history">Rebuilt estimate · not a saved pregame prediction</p>':''}<div class="target-controls"><label for="${id}-number">Reach at least</label><input id="${id}-number" class="target-number" type="number" min="0" step="0.5" value="${target}" aria-label="${escape(c.name)} ${escape(s.label)} target"><input id="${id}" class="target-slider" type="range" min="0" max="${max}" step="0.5" value="${target}" aria-label="${escape(c.name)} ${escape(s.label)} target slider"></div><div class="target-result" role="status" aria-live="polite">${resultMarkup(d,target)}</div><details><summary>How this percentage is calculated</summary><p>Counts whole-stat outcomes reaching your target in ${d.baseline.n.toLocaleString()} simulated games. Reaching 40 means 40 or more, not over 40. A small half-count correction keeps finite samples from claiming 0% or 100% certainty.</p><p>${d.experimental ? 'Experimental scenario: scales each simulated outcome to the experimental expected production, preserving zero-production outcomes. It assumes the baseline’s relative variability still applies; this assumption has not been validated.' : 'No experimental distribution is available for this stat; the baseline simulation is shown.'}</p><p>Uses modeled workload, efficiency and matchup context. Player book prices do not set this percentage. Game-level spread and totals still inform the underlying model. Estimates assume the modeled role and availability; injuries or role changes can invalidate them.</p><p>These controls explore scenarios; they do not change saved projections or picks.</p></details></section>`;
}
export function wirePlayerTargets(root, matchup) {
  // Delegation survives stat switches without adding listeners to every rerender.
  root.oninput = event => {
    if (!event.target.matches('.target-number, .target-slider')) return;
    const section=event.target.closest('.target-explorer'), card=section.closest('.card, .kick');
    const c=[...matchup.away.cards,...matchup.home.cards,matchup.away.kicker,matchup.home.kicker].filter(Boolean).find(c=>String(c.id)===card.dataset.id);
    const [, ,statKey]=JSON.parse(section.dataset.targetKey);
    const d=c?.stats[statKey]?.targetDistribution;
    const target=event.target.valueAsNumber;
    if (!d || !Number.isFinite(target) || target<0) { event.target.setCustomValidity('Enter a target of zero or more.'); return; }
    event.target.setCustomValidity('');
    const slider=section.querySelector('.target-slider'), number=section.querySelector('.target-number');
    slider.max=String(Math.max(Number(slider.max),target));
    slider.value=String(target); number.value=String(target);
    remembered.set(section.dataset.targetKey,target);
    section.querySelector('.target-result').innerHTML=resultMarkup(d,target);
  };
}
