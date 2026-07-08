// Technical indicator library + sanity-check test suite.
// Covers: SMA, EMA, RSI, MACD, Bollinger Bands, OBV.
// Run with: node indicators.js — once every check passes, port these
// functions into the React chart artifact.
//
// Fixes vs. the draft version:
//  - ema(): guards against series shorter than `period` (previously produced
//    NaN and silently grew the output array past its real length, which
//    then corrupted macd()'s signal line on shorter inputs).
//  - macd(): no longer mishandles the "no valid MACD data yet" case
//    (previously `slice(-1)` grabbed the wrong slice instead of an empty one).
//  - rsi(): a fully flat window (no gains AND no losses) now returns 50
//    (neutral) instead of 100, which was only meant to fire when there are
//    gains but zero losses.
//  - sma() / bollinger(): switched from O(n*period) recomputation to an
//    O(n) sliding window (same math, much cheaper on long candle series).
//  - obv(): throws if closes/volumes lengths don't match instead of
//    silently producing NaN.

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
}

/**
 * Simple Moving Average.
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
function sma(values, period) {
  assertArray(values, 'values');
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let windowSum = 0;
  for (let i = 0; i < values.length; i++) {
    windowSum += values[i];
    if (i >= period) windowSum -= values[i - period];
    if (i >= period - 1) out[i] = windowSum / period;
  }
  return out;
}

/**
 * Exponential Moving Average, seeded with the SMA of the first `period` values.
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
function ema(values, period) {
  assertArray(values, 'values');
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out; // not enough data yet

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function rsiFromAverages(avgGain, avgLoss) {
  if (avgGain === 0 && avgLoss === 0) return 50; // no movement at all - neutral
  if (avgLoss === 0) return 100;                 // gains only
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Relative Strength Index (Wilder's smoothing).
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
function rsi(values, period = 14) {
  assertArray(values, 'values');
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length <= period) return out;

  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gainSum += delta; else lossSum -= delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

/**
 * MACD: fast EMA minus slow EMA, plus a signal line (EMA of the MACD line).
 * @param {number[]} values
 * @param {number} fast
 * @param {number} slow
 * @param {number} signalPeriod
 * @returns {{macdLine:(number|null)[], signalLine:(number|null)[], histogram:(number|null)[]}}
 */
function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  assertArray(values, 'values');
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );

  const signalLine = new Array(values.length).fill(null);
  const firstValid = macdLine.findIndex(v => v != null);
  if (firstValid !== -1) {
    const compact = macdLine.slice(firstValid);
    const signalCompact = ema(compact, signalPeriod);
    for (let i = 0; i < signalCompact.length; i++) {
      signalLine[firstValid + i] = signalCompact[i];
    }
  }

  const histogram = values.map((_, i) =>
    macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

/**
 * Bollinger Bands: SMA midline +/- (mult * population standard deviation).
 * @param {number[]} values
 * @param {number} period
 * @param {number} mult
 * @returns {{mid:(number|null)[], upper:(number|null)[], lower:(number|null)[]}}
 */
function bollinger(values, period = 20, mult = 2) {
  assertArray(values, 'values');
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return { mid, upper, lower };

  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    sumSq += values[i] * values[i];
    if (i >= period) sumSq -= values[i - period] * values[i - period];
    if (i >= period - 1) {
      const mean = mid[i];
      const variance = Math.max(0, sumSq / period - mean * mean);
      const sd = Math.sqrt(variance);
      upper[i] = mean + mult * sd;
      lower[i] = mean - mult * sd;
    }
  }
  return { mid, upper, lower };
}

/**
 * On-Balance Volume.
 * @param {number[]} closes
 * @param {number[]} volumes
 * @returns {number[]}
 */
function obv(closes, volumes) {
  assertArray(closes, 'closes');
  assertArray(volumes, 'volumes');
  if (closes.length !== volumes.length) {
    throw new RangeError('obv: closes and volumes must be the same length');
  }
  const out = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) out[i] = out[i - 1] + volumes[i];
    else if (closes[i] < closes[i - 1]) out[i] = out[i - 1] - volumes[i];
    else out[i] = out[i - 1];
  }
  return out;
}

// ---------------- Sanity checks ----------------

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { passed++; console.log(`OK   ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
}
function approxEqual(a, b, eps = 1e-6) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < eps;
}

// 1. Monotonically increasing series -> RSI = 100 (never any losses)
const upSeries = Array.from({ length: 60 }, (_, i) => 100 + i);
check('RSI on strictly increasing series is 100', approxEqual(rsi(upSeries, 14).at(-1), 100));

// 2. Monotonically decreasing series -> RSI = 0 (never any gains)
const downSeries = Array.from({ length: 60 }, (_, i) => 200 - i);
check('RSI on strictly decreasing series is 0', approxEqual(rsi(downSeries, 14).at(-1), 0));

// 3. Flat series -> RSI = 50 (no movement at all), not NaN
const flatSeries = new Array(40).fill(100);
check('RSI on flat series is 50, not NaN', approxEqual(rsi(flatSeries, 14).at(-1), 50));

// 4. SMA sanity
const simple = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
check('SMA(3) of 1..10 last value is 9', approxEqual(sma(simple, 3).at(-1), 9));

// 5. EMA reacts faster than SMA to a sudden shock (more weight on the newest bar)
const stepSeries = new Array(30).fill(100).concat(new Array(15).fill(200));
const emaStep = ema(stepSeries, 12);
const smaStep = sma(stepSeries, 12);
check('EMA(12) moves toward a shock faster than SMA(12) one bar later',
  Number.isFinite(emaStep[30]) && emaStep[30] > smaStep[30]);

// 6. MACD structure: lengths line up, histogram = macd - signal
const macdRes = macd(upSeries, 12, 26, 9);
const lastIdx = upSeries.length - 1;
check('MACD/signal/histogram arrays match input length',
  macdRes.macdLine.length === upSeries.length &&
  macdRes.signalLine.length === upSeries.length &&
  macdRes.histogram.length === upSeries.length);
check('MACD histogram equals macdLine - signalLine',
  approxEqual(macdRes.histogram[lastIdx], macdRes.macdLine[lastIdx] - macdRes.signalLine[lastIdx]));

// 7. Bollinger sanity: lower < mid < upper
const bb = bollinger(simple.concat([20, 1, 25, 2, 30]), 5, 2);
const li = bb.mid.length - 1;
check('Bollinger bands ordered lower < mid < upper', bb.lower[li] < bb.mid[li] && bb.mid[li] < bb.upper[li]);

// 8. OBV sanity: net-upward closes give net-upward OBV
const closesForObv = [10, 11, 12, 11, 13, 14];
const volsForObv = [100, 100, 100, 100, 100, 100];
const obvSeries = obv(closesForObv, volsForObv);
check('OBV shows net upward drift', obvSeries.at(-1) > obvSeries[0]);

// 9. Edge case: series shorter than the period should return nulls, not throw
check('RSI on short series returns all nulls without throwing', (() => {
  const r = rsi([1, 2, 3], 14);
  return r.length === 3 && r.every(v => v === null);
})());

// 10. Same edge case, directly on ema() (this used to leak NaN into a longer array)
check('EMA on short series returns all nulls, correct length', (() => {
  const e = ema([1, 2, 3], 14);
  return e.length === 3 && e.every(v => v === null);
})());

// 11. MACD must stay well-formed even when the signal window is longer
//     than the amount of MACD data available (the original failure case)
check('MACD stays well-formed when signal window exceeds available MACD data', (() => {
  const shortSeries = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.5);
  const m = macd(shortSeries, 12, 26, 9);
  return m.macdLine.length === shortSeries.length && m.signalLine.length === shortSeries.length;
})());

// 12. OBV should refuse mismatched input lengths rather than emit NaN
check('OBV throws on mismatched closes/volumes length', (() => {
  try { obv([1, 2, 3], [1, 2]); return false; }
  catch (e) { return true; }
})());

console.log(`\n${passed}/${passed + failed} checks passed.`);
if (failed > 0) console.log('Fix the failing checks before porting this into the React artifact.');

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sma, ema, rsi, macd, bollinger, obv };
}
