// ============================================================
// STATISTICAL CORE — estimating relationships, not asserting them
// ------------------------------------------------------------
// The correlation engine scored each driver independently: sign of its move
// times its own correlation with gold, averaged. That is univariate, and it
// double-counts. The dollar and real yields move together, so when both fall
// the naive score counts the same underlying repricing twice and calls it
// two pieces of evidence.
//
// A multiple regression estimates PARTIAL effects — what the dollar adds once
// real yields are already accounted for. Collinear drivers split the credit
// between them instead of each claiming it in full, which is the whole point.
//
// Everything here is plain linear algebra on small matrices (at most a handful
// of drivers over a few months of daily data), so it stays fast, deterministic
// and testable — no dependency, and the same numbers every run.
// ============================================================

// Solve A x = b by Gauss-Jordan elimination with partial pivoting, returning
// both the solution and A's inverse. The inverse is needed for standard errors,
// which is what separates "this coefficient is 0.4" from "this coefficient is
// 0.4 and we cannot distinguish it from zero".
export function solveWithInverse(A, b) {
  const n = A.length;
  if (!n || A.some(r => r.length !== n) || b.length !== n) return null;

  // [A | I | b]
  const M = A.map((row, i) => {
    const eye = new Array(n).fill(0); eye[i] = 1;
    return row.concat(eye, [b[i]]);
  });

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null; // singular
    if (pivot !== col) { const t = M[pivot]; M[pivot] = M[col]; M[col] = t; }

    const p = M[col][col];
    for (let c = col; c < 2 * n + 1; c++) M[col][c] /= p;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c < 2 * n + 1; c++) M[r][c] -= f * M[col][c];
    }
  }
  return {
    x: M.map(row => row[2 * n]),
    inverse: M.map(row => row.slice(n, 2 * n))
  };
}

export function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
export function stdDev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
}

// Ridge regression on standardised inputs.
//
// Standardising puts every driver on the same scale, so coefficients are
// directly comparable — a basis-point move in a yield and a percent move in an
// index become "one standard deviation" of each. The ridge penalty is small but
// not optional: with collinear drivers the normal equations are near-singular,
// and without it the coefficients explode into equal-and-opposite nonsense that
// fits the sample and predicts nothing.
export function fitRidge(columns, y, lambda) {
  const k = columns.length;
  const n = y.length;
  if (!k || n < k + 5) return null;               // refuse to fit on too little data
  if (columns.some(c => c.length !== n)) return null;

  const yMean = mean(y);
  const yc = y.map(v => v - yMean);

  const scales = [], means = [], Z = [];
  for (const col of columns) {
    const m = mean(col), s = stdDev(col);
    if (!(s > 0)) return null;                    // a constant driver explains nothing
    means.push(m); scales.push(s);
    Z.push(col.map(v => (v - m) / s));
  }

  const lam = lambda == null ? 1e-3 * n : lambda;

  // XtX + lambda*I, and Xty
  const XtX = [];
  for (let i = 0; i < k; i++) {
    XtX.push([]);
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += Z[i][t] * Z[j][t];
      XtX[i].push(s + (i === j ? lam : 0));
    }
  }
  const Xty = Z.map(zi => { let s = 0; for (let t = 0; t < n; t++) s += zi[t] * yc[t]; return s; });

  const solved = solveWithInverse(XtX, Xty);
  if (!solved) return null;
  const beta = solved.x;

  // fitted values, residuals, R^2
  const fitted = new Array(n).fill(0);
  for (let t = 0; t < n; t++) { let s = 0; for (let i = 0; i < k; i++) s += beta[i] * Z[i][t]; fitted[t] = s; }
  const resid = yc.map((v, t) => v - fitted[t]);
  const ssRes = resid.reduce((s, v) => s + v * v, 0);
  const ssTot = yc.reduce((s, v) => s + v * v, 0);
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  // standard errors from sigma^2 * diag((XtX + lambda I)^-1)
  const dof = Math.max(1, n - k);
  const sigma2 = ssRes / dof;
  const se = beta.map((_, i) => Math.sqrt(Math.max(0, sigma2 * solved.inverse[i][i])));
  const tStat = beta.map((b, i) => (se[i] > 0 ? b / se[i] : 0));

  return {
    beta, se, tStat, r2, n, k, sigma: Math.sqrt(sigma2),
    yMean, means, scales,
    // Predict a standardised-input response for one fresh observation.
    predict(rawRow) {
      if (!rawRow || rawRow.length !== k) return null;
      let s = 0;
      for (let i = 0; i < k; i++) {
        if (!isFinite(rawRow[i])) return null;
        s += beta[i] * ((rawRow[i] - means[i]) / scales[i]);
      }
      return s + yMean;
    }
  };
}

// Align several daily series onto the dates they share. FRED publishes on
// business days, the gold feed has its own calendar, and holidays differ — so
// pairing by array index silently compares Tuesday's gold with Monday's yield.
// Everything downstream depends on this being right.
export function alignByDay(series) {
  const dayOf = t => Math.floor(t / 86400000);
  const maps = series.map(s => {
    const m = new Map();
    (s || []).forEach(p => { if (isFinite(p.close) && isFinite(p.time)) m.set(dayOf(p.time), p.close); });
    return m;
  });
  if (!maps.length) return { days: [], columns: [] };

  let common = [...maps[0].keys()];
  for (let i = 1; i < maps.length; i++) common = common.filter(d => maps[i].has(d));
  common.sort((a, b) => a - b);

  return { days: common, columns: maps.map(m => common.map(d => m.get(d))) };
}

// Period-over-period changes, in the units each series deserves: absolute for a
// yield (basis points), relative for a price.
export function toChanges(values, kind) {
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1], cur = values[i];
    if (!isFinite(prev) || !isFinite(cur)) { out.push(0); continue; }
    out.push(kind === 'yield' ? cur - prev : (prev !== 0 ? (cur - prev) / prev : 0));
  }
  return out;
}

// ============================================================
// SEPARATING SIGNAL FROM NOISE
// ------------------------------------------------------------
// An in-sample fit is not evidence. Three specific ways it lies, and the
// defence for each:
//
//   1. In-sample R² rises mechanically with the number of drivers. Seven random
//      series on 60 observations of pure noise produce R² ≈ 0.12 — so a
//      threshold of 0.08 would certify noise as explanatory. The defence is
//      OUT-OF-SAMPLE R² from a walk-forward: estimate on the past, predict the
//      next point, never let the model see what it is being scored on. It can
//      go negative, and negative is the honest answer for a model that learned
//      nothing.
//
//   2. Testing seven drivers at 5% each gives a 30% chance that at least one
//      looks real when none is. The defence is a false-discovery-rate
//      correction across the whole family of tests, not per driver.
//
//   3. Both of the above assume the errors behave. Financial series are
//      autocorrelated and fat-tailed, so they often don't. The defence is a
//      BLOCK PERMUTATION test: shuffle the outcome in contiguous blocks, keep
//      the drivers fixed, refit hundreds of times, and see how often chance
//      alone beats the real fit. It assumes almost nothing, and shuffling in
//      blocks rather than singly preserves the autocorrelation that makes
//      spurious fits easy in the first place.
// ============================================================

// Abramowitz & Stegun 7.1.26 — accurate to ~1e-7, which is far finer than any
// p-value here is meaningful to.
export function normalCdf(z) {
  const s = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}

// Two-sided p from a t statistic. Uses the normal approximation, which is close
// enough above ~30 degrees of freedom — and below that this module refuses to
// draw conclusions anyway.
export function twoSidedP(t) {
  if (!isFinite(t)) return 1;
  return 2 * (1 - normalCdf(Math.abs(t)));
}

// Benjamini-Hochberg. Controls the expected PROPORTION of false discoveries
// among those declared significant, which is the right question when testing a
// family of drivers at once. Bonferroni would also work but is so conservative
// on correlated tests that nothing would ever be discovered.
export function benjaminiHochberg(pValues, q) {
  const alpha = q == null ? 0.10 : q;
  const n = pValues.length;
  if (!n) return [];
  const idx = pValues.map((p, i) => ({ p: isFinite(p) ? p : 1, i })).sort((a, b) => a.p - b.p);
  let cutoff = -1;
  for (let rank = 0; rank < n; rank++) {
    if (idx[rank].p <= ((rank + 1) / n) * alpha) cutoff = rank;
  }
  const survives = new Array(n).fill(false);
  for (let rank = 0; rank <= cutoff; rank++) survives[idx[rank].i] = true;
  return survives;
}

// Deterministic PRNG. Significance that changes on every reload is itself noise,
// and would make the whole exercise unfalsifiable.
function seededRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Shuffle y in contiguous blocks so short-run autocorrelation survives the
// shuffle. Plain element-wise shuffling destroys it and makes the null too easy
// to beat, which would flatter every fit.
export function blockPermutationTest(columns, y, opts) {
  const o = Object.assign({ iterations: 250, blockSize: 5, seed: 20260101 }, opts || {});
  const observed = fitRidge(columns, y);
  if (!observed) return null;

  const n = y.length;
  const blocks = [];
  for (let i = 0; i < n; i += o.blockSize) blocks.push(y.slice(i, i + o.blockSize));

  const rand = seededRandom(o.seed);
  let beaten = 0;
  const nullR2 = [];
  for (let it = 0; it < o.iterations; it++) {
    const order = blocks.map((b, i) => ({ b, k: rand() })).sort((a, b2) => a.k - b2.k);
    const shuffled = [];
    order.forEach(e => { for (const v of e.b) shuffled.push(v); });
    const f = fitRidge(columns, shuffled.slice(0, n));
    if (!f) continue;
    nullR2.push(f.r2);
    if (f.r2 >= observed.r2) beaten++;
  }
  if (!nullR2.length) return null;
  nullR2.sort((a, b) => a - b);

  return {
    observedR2: observed.r2,
    // +1 in both places is the standard correction — a p of exactly 0 would
    // claim more certainty than a finite number of shuffles can support.
    pValue: (beaten + 1) / (nullR2.length + 1),
    nullMedianR2: nullR2[Math.floor(nullR2.length / 2)],
    null95R2: nullR2[Math.floor(nullR2.length * 0.95)],
    iterations: nullR2.length
  };
}

// Expanding-window walk-forward. Each prediction is made by a model that has
// never seen the point it is predicting, which is the only R² that means
// anything. Negative is a real and useful result: worse than predicting the mean.
export function walkForwardR2(columns, y, opts) {
  const o = Object.assign({ minTrain: 40, step: 1 }, opts || {});
  const n = y.length;
  if (n < o.minTrain + 10) return null;

  const preds = [], actuals = [];
  for (let t = o.minTrain; t < n; t += o.step) {
    const fit = fitRidge(columns.map(c => c.slice(0, t)), y.slice(0, t));
    if (!fit) continue;
    const row = columns.map(c => c[t]);
    const p = fit.predict(row);
    if (p == null || !isFinite(p) || !isFinite(y[t])) continue;
    preds.push(p); actuals.push(y[t]);
  }
  if (preds.length < 10) return null;

  const m = actuals.reduce((s, v) => s + v, 0) / actuals.length;
  const ssRes = actuals.reduce((s, v, i) => s + (v - preds[i]) * (v - preds[i]), 0);
  const ssTot = actuals.reduce((s, v) => s + (v - m) * (v - m), 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Directional hit rate: does it at least get the sign right more than half
  // the time? A model can have a poor R² and still be directionally useful.
  let hits = 0, directional = 0;
  for (let i = 0; i < preds.length; i++) {
    if (preds[i] === 0 || actuals[i] === 0) continue;
    directional++;
    if (Math.sign(preds[i]) === Math.sign(actuals[i])) hits++;
  }
  return {
    r2, n: preds.length,
    hitRate: directional ? hits / directional : null,
    directional
  };
}
