// ============================================================
// ACCUMULATED KNOWLEDGE — understanding built up over time
// ------------------------------------------------------------
// A rolling-window regression forgets. Refit it every day on the last sixty
// observations and it has exactly as much understanding on day 900 as on day
// 60 — which is not how understanding works.
//
// This keeps every observation it has ever seen and re-estimates against the
// whole record, so a relationship gets more firmly established as evidence
// accumulates. Three things follow from that:
//
//   * A relationship has a MATURITY, not just a coefficient. Something seen
//     twenty times is being watched; something seen four hundred times with a
//     stable sign is established. The engine says which, rather than quoting a
//     number with false authority.
//   * A relationship can DECAY. Estimating early and late halves separately
//     catches a driver that used to work and has stopped — which a single
//     whole-sample fit hides completely, since the average still looks fine.
//   * Conditions can be NOVEL. When today's drivers sit outside anything in the
//     record, the honest output is "this is new, I am watching it" rather than
//     a confident extrapolation from data that never contained this case.
// ============================================================

import { fitRidge, stdDev, mean, twoSidedP, benjaminiHochberg,
  blockPermutationTest, walkForwardR2 } from './stats.js';

export const KNOWLEDGE_DEFAULTS = {
  maxObservations: 3000,      // ~12 years of daily data; far past any practical need
  watchingBelow: 30,          // fewer than this and no claim is made at all
  emergingBelow: 90,          // enough to see a shape, not enough to trust it
  establishedT: 2.0,          // |t| a driver must clear BEFORE the corrections below
  decayRatio: 0.4,            // late-half effect below this fraction of early = fading
  noveltyZ: 2.5,              // per-driver z beyond which today is unlike the record

  // Noise controls. Without these the whole thing is theatre: seven drivers on
  // sixty rows of pure noise give an in-sample R² near 0.12, so any threshold
  // below that certifies randomness as understanding.
  fdrQ: 0.10,                 // false-discovery rate across the family of drivers
  permutationIterations: 200, // block shuffles used to build the null distribution
  permutationBlock: 5,        // block length, so autocorrelation survives the shuffle
  permutationAlpha: 0.05,     // the fit must beat chance at this level
  minWalkForwardR2: 0.0,      // out-of-sample must beat predicting the mean at all
  walkForwardMinTrain: 40,
  maxWalkForwardFits: 300     // adaptive step keeps this bounded on a long record
};

export function emptyKnowledge() {
  return { rows: [], firstSeen: {}, updatedAt: null };
}

// One observation per day, keyed by day so a re-run cannot double-count.
// Duplicate days replace rather than append — the tick runs every 15 minutes
// and would otherwise stack ninety-six copies of the same day and manufacture
// significance out of nothing.
export function recordObservation(store, obs, cfg) {
  cfg = Object.assign({}, KNOWLEDGE_DEFAULTS, cfg || {});
  const s = store && store.rows ? store : emptyKnowledge();
  if (!obs || !isFinite(obs.day) || !isFinite(obs.gold)) return s;

  const rows = s.rows.slice();
  const idx = rows.findIndex(r => r.day === obs.day);
  const row = { day: obs.day, gold: obs.gold, drivers: Object.assign({}, obs.drivers) };
  if (idx >= 0) rows[idx] = row; else rows.push(row);
  rows.sort((a, b) => a.day - b.day);

  const firstSeen = Object.assign({}, s.firstSeen);
  Object.keys(row.drivers).forEach(k => { if (firstSeen[k] == null) firstSeen[k] = obs.day; });

  return {
    rows: rows.slice(-cfg.maxObservations),
    firstSeen,
    updatedAt: Date.now()
  };
}

// Build regression columns from the accumulated record, using only the rows
// where every requested driver is present. A driver added later must not
// silently drop the years of history that predate it.
function columnsFor(store, driverKeys) {
  const usable = store.rows.filter(r => driverKeys.every(k => isFinite(r.drivers[k])));
  return {
    n: usable.length,
    y: usable.map(r => r.gold),
    columns: driverKeys.map(k => usable.map(r => r.drivers[k])),
    rows: usable
  };
}

function maturityOf(n, t, cfg) {
  if (n < cfg.watchingBelow) return 'watching';
  if (Math.abs(t) < cfg.establishedT) return n < cfg.emergingBelow ? 'watching' : 'unsupported';
  return n < cfg.emergingBelow ? 'emerging' : 'established';
}

// What the system currently believes, and how firmly.
export function assessKnowledge(store, driverSpecs, cfg) {
  cfg = Object.assign({}, KNOWLEDGE_DEFAULTS, cfg || {});
  const s = store && store.rows ? store : emptyKnowledge();
  const keys = (driverSpecs || []).map(d => d.key);
  if (!keys.length) return { ok: false, reason: 'no drivers configured', totalObservations: s.rows.length };

  const { n, y, columns, rows } = columnsFor(s, keys);
  if (n < cfg.watchingBelow) {
    return {
      ok: false, totalObservations: s.rows.length, usable: n,
      reason: 'still watching — ' + n + ' of ' + cfg.watchingBelow + ' observations needed before any relationship is claimed',
      drivers: driverSpecs.map(d => ({ key: d.key, label: d.label, maturity: 'watching', observations: n }))
    };
  }

  const full = fitRidge(columns, y);
  if (!full) return { ok: false, totalObservations: s.rows.length, usable: n, reason: 'could not estimate on the accumulated record' };

  // --- is this fit distinguishable from noise at all? -------------------
  // Two independent checks, because they fail differently. The permutation
  // test asks whether chance alone produces a fit this good; the walk-forward
  // asks whether the model predicts anything it has not already seen. A model
  // that memorised the sample passes the first and fails the second.
  const permutation = blockPermutationTest(columns, y, {
    iterations: cfg.permutationIterations, blockSize: cfg.permutationBlock
  });
  const walkForward = walkForwardR2(columns, y, {
    minTrain: cfg.walkForwardMinTrain,
    step: Math.max(1, Math.floor((n - cfg.walkForwardMinTrain) / cfg.maxWalkForwardFits))
  });

  const beatsChance = !!(permutation && permutation.pValue <= cfg.permutationAlpha);
  const predictsOutOfSample = !!(walkForward && walkForward.r2 > cfg.minWalkForwardR2);
  const modelIsReal = beatsChance && predictsOutOfSample;

  // --- which individual drivers survive multiple testing? ---------------
  const pValues = full.tStat.map(twoSidedP);
  const survivesFdr = benjaminiHochberg(pValues, cfg.fdrQ);

  // Split-half comparison: has a relationship faded?
  const mid = Math.floor(n / 2);
  const early = n >= 2 * cfg.watchingBelow ? fitRidge(columns.map(c => c.slice(0, mid)), y.slice(0, mid)) : null;
  const late = n >= 2 * cfg.watchingBelow ? fitRidge(columns.map(c => c.slice(mid)), y.slice(mid)) : null;

  const goldSigma = stdDev(y) || 1;
  const drivers = driverSpecs.map((d, i) => {
    const beta = full.beta[i], t = full.tStat[i];
    // A driver can only be established if it clears its own t-threshold,
    // survives correction for the fact that six others were tested alongside
    // it, AND sits inside a model that beats chance out of sample. Any one of
    // those failing means what looks like a relationship is not evidence.
    let maturity = maturityOf(n, t, cfg);
    if (maturity === 'established' || maturity === 'emerging') {
      if (!survivesFdr[i]) maturity = 'unsupported';
      else if (!modelIsReal) maturity = 'watching';
    }
    let trend = null;
    if (early && late) {
      const e = Math.abs(early.beta[i]), l = Math.abs(late.beta[i]);
      const signFlip = Math.sign(early.beta[i]) !== Math.sign(late.beta[i]) && e > 0 && l > 0;
      // A reversal is reported unconditionally, and deliberately overrides an
      // 'unsupported' verdict. A relationship that was strongly negative and is
      // now strongly positive averages to nothing over the whole sample, so the
      // pooled t-statistic says "no relationship" — the flat result is a
      // SYMPTOM of the flip, not evidence against it. Reporting that as "no
      // effect" would hide the single most important thing in the record.
      if (signFlip) { trend = 'reversed'; if (maturity !== 'watching') maturity = 'unstable'; }
      else if (e > 0 && l / e < cfg.decayRatio) {
        trend = 'fading';
        if (maturity === 'established' || maturity === 'unsupported') maturity = 'decaying';
      }
      else if (e > 0 && l / e > 1 / cfg.decayRatio) trend = 'strengthening';
      else trend = 'stable';
    }
    return {
      key: d.key, label: d.label, kind: d.kind,
      beta, t, impactSigma: beta / goldSigma,
      pValue: pValues[i], survivesFdr: survivesFdr[i],
      maturity, trend,
      observations: n,
      firstSeen: s.firstSeen[d.key] || null,
      earlyBeta: early ? early.beta[i] : null,
      lateBeta: late ? late.beta[i] : null
    };
  }).sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));

  return {
    ok: true,
    totalObservations: s.rows.length,
    usable: n,
    r2: full.r2,
    drivers,
    established: drivers.filter(d => d.maturity === 'established').length,
    watching: drivers.filter(d => d.maturity === 'watching').length,
    goldSigma,
    permutation, walkForward, beatsChance, predictsOutOfSample, modelIsReal,
    latestRow: rows.length ? rows[rows.length - 1] : null
  };
}

// Is today unlike anything in the record? Extrapolating a fitted relationship
// into conditions it never saw is exactly where a confident model is most
// wrong, so this is reported rather than smoothed over.
export function detectNovelty(store, currentDrivers, cfg) {
  cfg = Object.assign({}, KNOWLEDGE_DEFAULTS, cfg || {});
  const s = store && store.rows ? store : emptyKnowledge();
  const keys = Object.keys(currentDrivers || {});
  if (s.rows.length < cfg.watchingBelow || !keys.length) {
    return { novel: false, reason: 'not enough history to judge what is normal', unusual: [] };
  }
  const unusual = [];
  keys.forEach(k => {
    const hist = s.rows.map(r => r.drivers[k]).filter(isFinite);
    if (hist.length < cfg.watchingBelow) { unusual.push({ key: k, z: null, note: 'newly tracked — no baseline yet' }); return; }
    const m = mean(hist), sd = stdDev(hist);
    if (!(sd > 0)) return;
    const z = (currentDrivers[k] - m) / sd;
    if (Math.abs(z) >= cfg.noveltyZ) unusual.push({ key: k, z, note: Math.abs(z).toFixed(1) + 'σ move, rare in the record' });
  });
  return {
    novel: unusual.length > 0,
    unusual,
    reason: unusual.length
      ? 'Conditions are outside the usual range on ' + unusual.length + ' driver(s) — the fitted relationships are being extrapolated, not applied.'
      : 'Conditions are within the range the model was estimated on.'
  };
}

// Plain-language summary of what it knows and what it is still working out.
export function describeKnowledge(assessment) {
  if (!assessment) return 'No accumulated knowledge yet.';
  if (!assessment.ok) return assessment.reason;

  // Lead with whether any of this is distinguishable from noise. Reporting
  // coefficients first and the caveat later gets the emphasis exactly backwards
  // — the caveat is the finding.
  if (!assessment.modelIsReal) {
    const bits = [];
    if (assessment.permutation) {
      bits.push('randomly reshuffled data produces a fit this good ' +
        (assessment.permutation.pValue * 100).toFixed(0) + '% of the time');
    }
    if (assessment.walkForward) {
      bits.push('out-of-sample R² is ' + (assessment.walkForward.r2 * 100).toFixed(0) + '%' +
        (assessment.walkForward.r2 <= 0 ? ' — worse than simply predicting the average' : ''));
    }
    return 'Built from ' + assessment.usable + ' accumulated observations, but nothing here is yet '
      + 'distinguishable from noise: ' + bits.join(', ')
      + '. In-sample fit looks like ' + (assessment.r2 * 100).toFixed(0) + '%, which is roughly what '
      + assessment.drivers.length + ' unrelated series would produce by chance on this much data. '
      + 'Still watching.';
  }
  const est = assessment.drivers.filter(d => d.maturity === 'established');
  const watch = assessment.drivers.filter(d => d.maturity === 'watching' || d.maturity === 'emerging');
  const gone = assessment.drivers.filter(d => d.maturity === 'decaying' || d.maturity === 'unstable');

  const wf = assessment.walkForward;
  const parts = ['Built from ' + assessment.usable + ' accumulated daily observations. '
    + 'The fit beats reshuffled data (p ' + assessment.permutation.pValue.toFixed(3) + ') and holds up '
    + 'out of sample (R² ' + (wf.r2 * 100).toFixed(0) + '%'
    + (wf.hitRate != null ? ', direction right ' + (wf.hitRate * 100).toFixed(0) + '% of the time' : '') + ').'];
  if (est.length) {
    parts.push('Established: ' + est.map(d => d.label + ' (' + (d.impactSigma >= 0 ? '+' : '') + d.impactSigma.toFixed(2) + 'σ, ' + (d.trend || 'stable') + ')').join('; ') + '.');
  }
  if (watch.length) {
    parts.push('Still watching: ' + watch.map(d => d.label).join(', ') + ' — seen, not yet trusted.');
  }
  if (gone.length) {
    parts.push('Weakening: ' + gone.map(d => d.label + ' (' + d.maturity + ')').join(', ') + ' — held historically, no longer holding.');
  }
  if (!est.length && !gone.length) {
    parts.push('Nothing is established yet; every relationship here is provisional.');
  }
  return parts.join(' ');
}
