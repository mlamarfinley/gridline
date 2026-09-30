// Team color theming with guaranteed readability. Pure functions (tested in test/theme.test.js).
//
// ESPN gives each team a primary `color` and an `alternateColor`. Raw brand colors are often
// unreadable on our surfaces (e.g. Raiders #000000 on a near-black page), and two teams can
// share nearly the same color. We therefore:
//   1. pick primary, falling back to alternate when the primary can't be made readable or the
//      two teams are too similar; neutral fallbacks if ESPN has no color at all;
//   2. derive an ACCENT (lines, bars, headers) nudged in lightness until it has >= 3:1 contrast
//      with the page background (WCAG non-text contrast);
//   3. derive INK (text on a solid team-color fill) as white or near-black, whichever contrasts more.

export const FALLBACK = { away: '#8fb3ff', home: '#f2b25c' };

export function parseHex(h) {
  const m = String(h || '').trim().replace(/^#/, '').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let x = m[1];
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
}
export const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

export function luminance(rgb) {
  const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Adjust lightness until `hex` reaches `min` contrast against `bg`. Returns {hex, shifted, ratio}. */
export function readableAccent(hex, bg, min = 3) {
  const rgb = parseHex(hex), b = parseHex(bg);
  if (!rgb || !b) return null;
  if (contrast(rgb, b) >= min) return { hex: toHex(rgb), shifted: 0, ratio: contrast(rgb, b) };
  const [h, s, l0] = rgbToHsl(rgb);
  const lighten = luminance(b) < 0.5;
  for (let i = 1; i <= 50; i++) {
    const l = Math.max(0, Math.min(1, l0 + (lighten ? 1 : -1) * i * 0.02));
    const c = hslToRgb([h, s, l]);
    if (contrast(c, b) >= min) return { hex: toHex(c), shifted: Math.abs(l - l0), ratio: contrast(c, b) };
  }
  return null;
}

/** White or near-black text for a solid fill of `hex`, whichever contrasts more. */
export function inkOn(hex) {
  const rgb = parseHex(hex) || [128, 128, 128];
  return contrast(rgb, [255, 255, 255]) >= contrast(rgb, [17, 17, 17]) ? '#ffffff' : '#111111';
}

function dist(a, b) { const x = parseHex(a), y = parseHex(b); return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : 999; }

/** Best readable accent for one team from its candidate colors (primary first). */
function accentFor(colors, bg, avoid) {
  const opts = [];
  for (const c of colors) {
    const r = readableAccent(c, bg);
    if (!r) continue;
    // Prefer colors that barely needed adjusting (stay recognizably on-brand).
    opts.push({ raw: toHex(parseHex(c)), ...r, penalty: r.shifted + (avoid && dist(r.hex, avoid) < 90 ? 1 : 0) });
  }
  opts.sort((a, b) => a.penalty - b.penalty);
  return opts[0] || null;
}

/**
 * Theme for a matchup. team = {color, alternateColor} (hex with or without '#').
 * Returns { away:{accent, fill, ink, source}, home:{...} } for the given page background.
 */
export function matchupTheme(away, home, bg = '#0c0f13') {
  const cand = (t) => [t?.color, t?.alternateColor].filter((c) => parseHex(c));
  const h = accentFor(cand(home), bg) || null;
  const a = accentFor(cand(away), bg, h?.hex) || null;
  const mk = (x, side) => {
    if (!x) {
      const fb = FALLBACK[side];
      return { accent: fb, fill: fb, ink: inkOn(fb), accentInk: inkOn(fb), source: 'fallback' };
    }
    return { accent: x.hex, fill: x.raw, ink: inkOn(x.raw), accentInk: inkOn(x.hex), source: x.shifted ? 'adjusted for contrast' : 'team color' };
  };
  const out = { away: mk(a, 'away'), home: mk(h, 'home') };
  // Still indistinguishable (e.g. both teams only have similar colors)? Use the away fallback.
  if (dist(out.away.accent, out.home.accent) < 60) out.away = { accent: FALLBACK.away, fill: FALLBACK.away, ink: inkOn(FALLBACK.away), accentInk: inkOn(FALLBACK.away), source: 'fallback (colors too similar)' };
  return out;
}
