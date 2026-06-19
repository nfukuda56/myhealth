/**
 * envelope.js — Lower envelope (PCHIP), change point detection, pace statistics
 *
 * All functions are pure: no DOM access, no side effects.
 * Parameters are fixed constants per the requirements spec (v1.1).
 */

// ======================================================
// Internal: PCHIP interpolation (Fritsch-Carlson)
// ======================================================

/**
 * Evaluate PCHIP at query positions.
 * @param {number[]} xs  - key-point x values (integer indices, sorted ascending)
 * @param {number[]} ys  - key-point y values
 * @param {number[]} xq  - query x values (need not be sorted)
 * @returns {number[]}
 */
function _pchip(xs, ys, xq) {
  const n = xs.length
  if (n === 0) return xq.map(() => null)
  if (n === 1) return xq.map(() => ys[0])

  // Step 1: secant slopes
  const h = [], delta = []
  for (let k = 0; k < n - 1; k++) {
    h[k] = xs[k + 1] - xs[k]
    delta[k] = h[k] < 1e-12 ? 0 : (ys[k + 1] - ys[k]) / h[k]
  }

  // Step 2: initial tangent slopes (weighted harmonic mean at interior points)
  const m = new Array(n).fill(0)
  m[0] = delta[0]
  m[n - 1] = delta[n - 2]
  for (let k = 1; k < n - 1; k++) {
    if (delta[k - 1] * delta[k] <= 0) {
      // Opposite signs or zero: flat at this knot (prevents overshoot)
      m[k] = 0
    } else {
      const w1 = 2 * h[k] + h[k - 1]
      const w2 = h[k] + 2 * h[k - 1]
      m[k] = (w1 + w2) / (w1 / delta[k - 1] + w2 / delta[k])
    }
  }

  // Step 3: Fritsch-Carlson monotonicity fix per interval
  for (let k = 0; k < n - 1; k++) {
    if (Math.abs(delta[k]) < 1e-12) {
      m[k] = 0; m[k + 1] = 0; continue
    }
    const alpha = m[k]     / delta[k]
    const beta  = m[k + 1] / delta[k]
    const r2 = alpha * alpha + beta * beta
    if (r2 > 9) {
      const tau = 3 / Math.sqrt(r2)
      m[k]     = tau * alpha * delta[k]
      m[k + 1] = tau * beta  * delta[k]
    }
  }

  // Step 4: evaluate cubic Hermite polynomials at query points
  return xq.map(x => {
    if (x <= xs[0])     return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]

    // Binary search for interval
    let lo = 0, hi = n - 2
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (xs[mid] <= x) lo = mid; else hi = mid - 1
    }
    const k  = lo
    const hk = h[k]
    const t  = (x - xs[k]) / hk
    const t2 = t * t, t3 = t2 * t

    return (2*t3 - 3*t2 + 1) * ys[k]
         + (t3  - 2*t2 + t)  * hk * m[k]
         + (-2*t3 + 3*t2)    * ys[k + 1]
         + (t3  - t2)        * hk * m[k + 1]
  })
}

// ======================================================
// Public API
// ======================================================

/**
 * Compute the lower envelope of a body-weight time series via PCHIP.
 *
 * Algorithm:
 *   1. Rolling minimum (half-window = win days each side)
 *   2. Extract local valley key-points (min separation = minSeg days)
 *   3. PCHIP-interpolate through key-points across all dates
 *
 * @param {string[]}        dates   - YYYY-MM-DD, sorted ascending (contiguous calendar days)
 * @param {(number|null)[]} weights - daily weights aligned with dates (null = no measurement)
 * @param {{win?:number, minSeg?:number}} opts
 * @returns {{
 *   dates:     string[],
 *   values:    (number|null)[],
 *   keyPoints: {date:string, value:number, idx:number}[]
 * }}
 */
export function computeEnvelope(dates, weights, { win = 3, minSeg = 3 } = {}) {
  const n = dates.length
  const empty = { dates, values: new Array(n).fill(null), keyPoints: [] }

  if (weights.filter(v => v != null).length < 5) return empty

  // ----- Step 1: rolling minimum -----
  const rollMin = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    let mn = Infinity
    for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) {
      if (weights[j] != null && weights[j] < mn) mn = weights[j]
    }
    if (mn !== Infinity) rollMin[i] = mn
  }

  // ----- Step 2: local minima in rollMin with NMS (min spacing = minSeg) -----
  const keyIdxs = []
  let lastKept = -minSeg

  for (let i = 0; i < n; i++) {
    if (rollMin[i] == null) continue
    const prev = i > 0       ? rollMin[i - 1] : rollMin[i]
    const next = i < n - 1  ? rollMin[i + 1] : rollMin[i]
    const isLocalMin = rollMin[i] <= (prev ?? rollMin[i]) &&
                       rollMin[i] <= (next ?? rollMin[i])
    if (isLocalMin && i - lastKept >= minSeg) {
      keyIdxs.push(i)
      lastKept = i
    }
  }

  // Ensure the first and last non-null positions are anchors
  const firstNonNull = rollMin.findIndex(v => v != null)
  const lastNonNull  = n - 1 - [...rollMin].reverse().findIndex(v => v != null)
  if (firstNonNull >= 0 && (keyIdxs.length === 0 || keyIdxs[0] !== firstNonNull))
    keyIdxs.unshift(firstNonNull)
  if (lastNonNull >= 0 && lastNonNull !== firstNonNull &&
      keyIdxs[keyIdxs.length - 1] !== lastNonNull)
    keyIdxs.push(lastNonNull)

  if (keyIdxs.length < 2) return empty

  // ----- Step 3: PCHIP interpolation across all date positions -----
  const keyXs = keyIdxs.map(i => i)
  const keyYs = keyIdxs.map(i => rollMin[i])
  const allXs = dates.map((_, i) => i)
  const interp = _pchip(keyXs, keyYs, allXs)

  return {
    dates,
    values:    interp.map(v => v != null ? Math.round(v * 100) / 100 : null),
    keyPoints: keyIdxs.map(i => ({ date: dates[i], value: rollMin[i], idx: i }))
  }
}

/**
 * Detect significant pace change-points in the envelope.
 *
 * Uses center-difference 2nd derivative of the envelope.
 * A point is a change-point when |Δf'| > thr.
 *
 * @param {string[]}        dates
 * @param {(number|null)[]} values - envelope values
 * @param {{thr?:number, minSeg?:number}} opts
 * @returns {{date:string, idx:number, deltaSlope:number}[]}
 */
export function detectChangePoints(dates, values, { thr = 0.08, minSeg = 4 } = {}) {
  const n = values.length
  if (n < 5) return []

  // First derivative via center difference
  const d1 = new Array(n).fill(null)
  for (let i = 1; i < n - 1; i++) {
    if (values[i - 1] != null && values[i + 1] != null)
      d1[i] = (values[i + 1] - values[i - 1]) / 2
  }

  // |Δf'| = |center-difference of d1| ~ |2nd derivative|
  const mag = new Array(n).fill(null)
  for (let i = 2; i < n - 2; i++) {
    if (d1[i - 1] != null && d1[i + 1] != null)
      mag[i] = Math.abs((d1[i + 1] - d1[i - 1]) / 2)
  }

  // Collect above-threshold candidates, NMS with minSeg spacing
  const result = []
  let lastIdx = -minSeg
  for (let i = 0; i < n; i++) {
    if (mag[i] != null && mag[i] > thr && i - lastIdx >= minSeg) {
      result.push({ date: dates[i], idx: i, deltaSlope: mag[i] })
      lastIdx = i
    }
  }
  return result
}

/**
 * Compute pace statistics (current pace, 30-day forecast, lag correlation).
 *
 * @param {string[]}        dates       - envelope dates
 * @param {(number|null)[]} envVals     - envelope values
 * @param {{date:string,idx:number}[]} changePts
 * @param {Map<string,number|null>}    balanceMap  - date → calorie balance
 * @param {{lag?:number}} opts
 * @returns {{
 *   pacePerWeek:          number|null,   // kg/week (negative = losing)
 *   pacePerMonth:         number|null,   // kg/month
 *   estimatedWeight30d:   number|null,   // kg
 *   currentEnvelopeValue: number|null,   // kg
 *   r:                    number|null    // Pearson r
 * }}
 */
export function computePaceStats(dates, envVals, changePts, balanceMap, { lag = 3 } = {}) {
  const n = dates.length

  // Last non-null envelope value
  let currentEnvelopeValue = null
  for (let i = n - 1; i >= 0; i--) {
    if (envVals[i] != null) { currentEnvelopeValue = envVals[i]; break }
  }

  // Pace = slope of envelope from last change-point to end
  let pacePerWeek = null
  const startIdx = changePts.length > 0 ? changePts[changePts.length - 1].idx : 0
  const segVals  = envVals.slice(startIdx)
  const validSeg = segVals
    .map((v, i) => [i, v])
    .filter(([, v]) => v != null)

  if (validSeg.length >= 2) {
    const [x0, y0] = validSeg[0]
    const [x1, y1] = validSeg[validSeg.length - 1]
    if (x1 > x0)
      pacePerWeek = Math.round(((y1 - y0) / (x1 - x0) * 7) * 100) / 100
  }

  const pacePerMonth = pacePerWeek != null
    ? Math.round(pacePerWeek / 7 * 30 * 100) / 100
    : null

  const estimatedWeight30d = (currentEnvelopeValue != null && pacePerMonth != null)
    ? Math.round((currentEnvelopeValue + pacePerMonth) * 10) / 10
    : null

  // Envelope first derivative (center difference)
  const d1 = new Array(n).fill(null)
  for (let i = 1; i < n - 1; i++) {
    if (envVals[i - 1] != null && envVals[i + 1] != null)
      d1[i] = (envVals[i + 1] - envVals[i - 1]) / 2
  }

  // Pearson r(balance[i], d1[i+lag])
  const pairs = []
  for (let i = 0; i + lag < n; i++) {
    const b = balanceMap.get(dates[i])
    const s = d1[i + lag]
    if (b != null && s != null) pairs.push([b, s])
  }

  let r = null
  if (pairs.length >= 5) {
    const xs = pairs.map(p => p[0])
    const ys = pairs.map(p => p[1])
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length
    const my = ys.reduce((a, b) => a + b, 0) / ys.length
    let cov = 0, vx = 0, vy = 0
    for (let i = 0; i < pairs.length; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my
      cov += dx * dy; vx += dx * dx; vy += dy * dy
    }
    const denom = Math.sqrt(vx * vy)
    if (denom > 1e-10) r = Math.round((cov / denom) * 1000) / 1000
  }

  return { pacePerWeek, pacePerMonth, estimatedWeight30d, currentEnvelopeValue, r }
}

/**
 * Return evaluation label + color for a given weekly pace (kg/week).
 * @param {number|null} pacePerWeek
 * @returns {{label:string, color:string}}
 */
export function evaluatePace(pacePerWeek) {
  if (pacePerWeek == null) return { label: '—',          color: '#64748b' }
  if (pacePerWeek > -0.1)  return { label: '停滞気味',   color: '#e07030' }
  if (pacePerWeek > -0.5)  return { label: 'やや緩め',   color: '#c0a020' }
  if (pacePerWeek > -1.0)  return { label: '適正 ✓',    color: '#2a9050' }
  if (pacePerWeek > -1.5)  return { label: 'やや速め',   color: '#e07030' }
  return                          { label: 'ペース過速', color: '#e05050' }
}
