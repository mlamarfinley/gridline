// fbm-1.3.0 output calibration (NFL), learned walk-forward from every scored pick of 2024+2025
// (scripts/learn_v13.mjs -> src/fitted_v13.json). Per position|stat:
//   centre : shift by the shrunk median residual `a` (MAE-optimal; slope fixed at 1)
//   range  : widen/narrow around the median by `s` (smallest width with >= 80% training coverage)
// Applied to the simulated sample so projections, ranges AND model probabilities stay consistent.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

let CAL = null;
try { CAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'fitted_v13.json'), 'utf8')).byStat; } catch { CAL = null; }

export function calibrationFor(lg, pos, stat) {
  if (lg !== 'nfl' || !CAL) return null;
  const c = CAL[`${pos}|${stat}`];
  return c && Number.isFinite(c.a) ? c : null;
}

/** Returns a new Float64Array with the calibration applied (or the input if none applies). */
export function calibrateSample(arr, c) {
  if (!c || !arr?.length) return arr;
  const sorted = Float64Array.from(arr).sort();
  // No simulated opportunity at all (e.g. a backup QB): a calibration shift would invent production from nothing.
  if (sorted[sorted.length - 1] === 0) return arr;
  const med = sorted[Math.floor((sorted.length - 1) / 2)] + c.a;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Math.max(0, med + c.s * (arr[i] + c.a - med));
  return out;
}
