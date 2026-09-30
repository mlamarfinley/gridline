// Kickoff weather from Open-Meteo (free, no key). Only for outdoor venues and kickoffs inside
// the 14-day forecast window. Effects on the model are modest heuristics (documented in README),
// not validated coefficients.
import { fetchCached } from './fetcher.js';

export async function kickoffWeather(venue, kickoffISO, prov) {
  if (!venue) return { available: false, reason: 'No venue data' };
  if (venue.indoor) return { available: true, indoor: true, text: 'Indoor / roof — weather not a factor', effects: none() };
  const ko = Date.parse(kickoffISO);
  const days = (ko - Date.now()) / 86400000;
  if (days > 14) return { available: false, reason: 'Kickoff beyond forecast window' };
  if (days < -2) return { available: false, reason: 'Historical game — forecast not retrieved (would not reflect pregame information)' };
  const q = [venue.city, venue.state].filter(Boolean).join(', ');
  const geo = await fetchCached(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(venue.city || '')}&count=5&language=en&format=json`, { ttl: 30 * 86400, label: 'Venue geocode' });
  prov.add(geo.meta);
  const results = geo.data?.results || [];
  const loc = results.find((r) => !venue.state || (r.admin1 && stateMatch(r.admin1, venue.state))) || (venue.country && venue.country !== 'USA' ? results[0] : results.find((r) => r.country_code === 'US')) || null;
  if (!loc) return { available: false, reason: `Could not geocode ${q}` };
  const day = new Date(ko).toISOString().slice(0, 10);
  const fc = await fetchCached(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&hourly=temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m&wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=UTC&start_date=${day}&end_date=${day}`, { ttl: 3600, label: 'Kickoff forecast' });
  prov.add(fc.meta);
  const h = fc.data?.hourly;
  if (!h?.time) return { available: false, reason: 'Forecast unavailable' };
  const hr = new Date(ko).toISOString().slice(0, 13);
  const idx = Math.max(0, h.time.findIndex((t) => t.startsWith(hr)));
  const slice = (arr) => arr.slice(idx, idx + 3).filter((x) => x != null);
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const wind = avg(slice(h.wind_speed_10m)), gust = Math.max(...slice(h.wind_gusts_10m), 0), precip = slice(h.precipitation).reduce((s, x) => s + x, 0), temp = avg(slice(h.temperature_2m));
  return { available: true, indoor: false, location: `${loc.name}, ${loc.admin1 || loc.country}`, windMph: round1(wind), gustMph: round1(gust), precipIn: round2(precip), tempF: round1(temp), effects: effects({ wind, precip, temp }) };
}

export function effects({ wind, precip, temp }) {
  const e = none();
  const notes = [];
  if (wind != null && wind > 12) {
    const k = Math.min(0.12, (wind - 12) * 0.008);
    e.passEff = 1 - k; e.catchRate = 1 - k / 2; e.passRate = -Math.min(0.04, (wind - 12) * 0.003);
    notes.push(`Wind ${Math.round(wind)} mph: pass efficiency ×${e.passEff.toFixed(2)}, pass rate ${(e.passRate * 100).toFixed(1)} pts`);
  }
  if (precip != null && precip >= 0.08) {
    e.passEff *= 0.97; e.catchRate *= 0.98; e.fumble = 1.3; e.dispersion = 1.08;
    notes.push(`Precipitation ${precip.toFixed(2)} in over kickoff window: small passing/fumble adjustment`);
  }
  if (temp != null && temp < 25) { e.passEff *= 0.98; notes.push(`Cold (${Math.round(temp)}°F): passing ×0.98`); }
  e.notes = notes;
  return e;
}
function none() { return { passEff: 1, catchRate: 1, passRate: 0, fumble: 1, dispersion: 1, notes: [] }; }
function stateMatch(admin1, st) {
  const S = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
  return admin1 === st || admin1 === S[st];
}
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
