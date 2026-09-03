// ============================================================
// INDEPENDENT AUDITOR — checking the system's work from outside it
// ------------------------------------------------------------
// An auditor that reuses the engine's own computed values is not an auditor;
// it is the engine agreeing with itself. So the rule here is that nothing the
// engine claims is taken on trust. Where a claim can be re-derived from raw
// candles, it is re-derived and compared — price, R:R, stop distance against
// volatility, the direction implied by the factor weights.
//
// Its posture is adversarial on purpose. It is not looking for reasons the
// analysis is right; it is looking for the specific ways it could be wrong:
//
//   * ARITHMETIC — does the trade plan actually say what it claims to say?
//     A stop on the wrong side of entry is not a judgement call.
//   * DATA — is the feed it reasoned from intact? Stale, gapped, out-of-order
//     or duplicated candles produce confident analysis of a market that isn't
//     there.
//   * EVIDENCE — does the narrative cite support that the statistics have
//     rejected? Citing a macro driver that failed its noise tests is the most
//     dangerous failure here, because it reads as rigour.
//   * TRACK RECORD — is confidence being leaned on when the record says
//     confidence does not discriminate?
//
// Findings carry a severity and a reason. It never silently overrides the
// engine — an auditor that edits the thing it audits has stopped being one.
// ============================================================

export const SEVERITY = { critical: 'critical', warning: 'warning', note: 'note' };

const finding = (severity, code, title, detail) => ({ severity, code, title, detail });

// Recompute ATR from raw candles. Deliberately a second implementation rather
// than a call into the engine's — if the engine's ATR were wrong, reusing it
// would hide exactly the error worth catching.
function independentAtr(candles, period) {
  const p = period || 14;
  if (!candles || candles.length < p + 1) return null;
  const trs = [];
  for (let i = candles.length - p; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    if (!c || !prev) continue;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  if (!trs.length) return null;
  return trs.reduce((s, v) => s + v, 0) / trs.length;
}

// ---- data integrity -------------------------------------------------------
export function auditData(candles, expectedIntervalMs) {
  const out = [];
  if (!candles || candles.length < 2) {
    out.push(finding('critical', 'no-data', 'No candle data', 'The analysis has nothing to stand on.'));
    return out;
  }
  let outOfOrder = 0, duplicates = 0, malformed = 0, gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1], b = candles[i];
    if (b.time === a.time) duplicates++;
    else if (b.time < a.time) outOfOrder++;
    if (!(b.high >= b.low) || !isFinite(b.close) || !isFinite(b.open) || b.close <= 0) malformed++;
    if (expectedIntervalMs && b.time - a.time > expectedIntervalMs * 1.5) gaps++;
  }
  if (outOfOrder) out.push(finding('critical', 'unordered', 'Candles are out of chronological order',
    outOfOrder + ' pair(s) go backwards in time. Structure, swings and every derived level are unreliable.'));
  if (duplicates) out.push(finding('warning', 'duplicate-candles', 'Duplicate candle timestamps',
    duplicates + ' repeated timestamp(s) — the same bar counted more than once inflates apparent confluence.'));
  if (malformed) out.push(finding('critical', 'malformed-candles', 'Malformed candles',
    malformed + ' candle(s) have high < low or a non-finite price.'));
  if (gaps > candles.length * 0.05) out.push(finding('warning', 'gappy-feed', 'Gappy price feed',
    gaps + ' gap(s) longer than one interval. Missing bars hide structure the engine assumes it can see.'));

  // Counting gaps alone misses a feed that is uniformly thinned — every second
  // bar absent produces regular spacing and no single gap looks anomalous, yet
  // half the market is invisible. Comparing bars received against bars the time
  // span should contain catches that.
  if (expectedIntervalMs) {
    const span = candles[candles.length - 1].time - candles[0].time;
    const expected = Math.floor(span / expectedIntervalMs) + 1;
    if (expected > 10) {
      const coverage = candles.length / expected;
      if (coverage < 0.9) {
        out.push(finding(coverage < 0.6 ? 'critical' : 'warning', 'thin-coverage', 'Price feed is missing bars',
          'Received ' + candles.length + ' candles where the time span should hold ' + expected
          + ' (' + (coverage * 100).toFixed(0) + '% coverage). The engine is reading structure from a partial market.'));
      }
    }
  }
  return out;
}

// ---- freshness ------------------------------------------------------------
export function auditFreshness(candles, now, maxAgeMs) {
  const out = [];
  if (!candles || !candles.length) return out;
  const last = candles[candles.length - 1];
  const age = (now || Date.now()) - last.time;
  if (maxAgeMs && age > maxAgeMs) {
    out.push(finding(age > maxAgeMs * 4 ? 'critical' : 'warning', 'stale-feed', 'Price data is stale',
      'Newest candle is ' + Math.round(age / 60000) + ' min old. Levels are being computed against a market that has moved on.'));
  }
  return out;
}

// ---- the trade plan's own arithmetic --------------------------------------
export function auditPlan(result, plan, candles) {
  const out = [];
  if (!result || result.direction === 'HOLD' || !plan) return out;
  const isBuy = result.direction === 'BUY';

  if (![plan.entry, plan.sl, plan.tp].every(isFinite)) {
    out.push(finding('critical', 'plan-nonfinite', 'Trade plan contains non-finite prices',
      'entry/sl/tp must all be real numbers.'));
    return out;
  }
  if (isBuy && plan.sl >= plan.entry) {
    out.push(finding('critical', 'sl-wrong-side', 'Stop is above entry on a BUY',
      'sl ' + plan.sl.toFixed(2) + ' >= entry ' + plan.entry.toFixed(2) + '. The trade is stopped out on arrival.'));
  }
  if (!isBuy && plan.sl <= plan.entry) {
    out.push(finding('critical', 'sl-wrong-side', 'Stop is below entry on a SELL',
      'sl ' + plan.sl.toFixed(2) + ' <= entry ' + plan.entry.toFixed(2) + '.'));
  }
  if (isBuy && plan.tp <= plan.entry) {
    out.push(finding('critical', 'tp-wrong-side', 'Target is below entry on a BUY', 'The plan cannot profit.'));
  }
  if (!isBuy && plan.tp >= plan.entry) {
    out.push(finding('critical', 'tp-wrong-side', 'Target is above entry on a SELL', 'The plan cannot profit.'));
  }

  // R:R re-derived from the prices themselves, not read off the plan.
  const risk = Math.abs(plan.entry - plan.sl);
  const reward = Math.abs(plan.tp - plan.entry);
  if (risk > 0) {
    const derived = reward / risk;
    if (isFinite(plan.rr) && Math.abs(derived - plan.rr) > 0.05) {
      out.push(finding('critical', 'rr-mismatch', 'Stated R:R does not match the prices',
        'Plan says ' + plan.rr.toFixed(2) + ':1, the levels give ' + derived.toFixed(2) + ':1.'));
    }
  }

  // A stop inside normal noise is a stop that gets hit for no reason.
  const atr = independentAtr(candles, 14);
  if (atr && risk > 0 && risk < atr * 0.5) {
    out.push(finding('warning', 'stop-inside-noise', 'Stop sits inside normal volatility',
      'Risk is ' + risk.toFixed(2) + ' against an ATR of ' + atr.toFixed(2)
      + '. A stop under half the average range is likely to be taken out by ordinary movement rather than by being wrong.'));
  }

  // The engine's own weighted score should agree with the direction it declared.
  if (result.factors && result.weights) {
    let score = 0;
    Object.keys(result.factors).forEach(k => { score += (result.factors[k] || 0) * (result.weights[k] || 0); });
    if (score !== 0 && Math.sign(score) !== (isBuy ? 1 : -1)) {
      out.push(finding('critical', 'direction-contradiction', 'Direction contradicts its own factors',
        'Weighted factor sum is ' + score.toFixed(2) + ' but the engine declared ' + result.direction + '.'));
    }
  }

  // Price the plan was built from should be the price the feed reports.
  if (candles && candles.length && isFinite(result.price)) {
    const last = candles[candles.length - 1].close;
    if (isFinite(last) && last > 0 && Math.abs(result.price - last) / last > 0.002) {
      out.push(finding('warning', 'price-drift', 'Analysis price differs from the latest candle',
        'Analysis used ' + result.price.toFixed(2) + ', newest close is ' + last.toFixed(2) + '.'));
    }
  }
  return out;
}

// ---- does the narrative outrun the evidence? ------------------------------
export function auditEvidence(result, knowledgeAssessment, calibration) {
  const out = [];
  if (!result) return out;

  const usesMacro = !!(result.factors && (result.factors.correlation || result.factors.fundamental));
  if (usesMacro && knowledgeAssessment && knowledgeAssessment.ok && !knowledgeAssessment.modelIsReal) {
    out.push(finding('warning', 'macro-unproven', 'Leaning on macro that has not passed its own tests',
      'The score includes a cross-market or fundamental contribution, but the accumulated model is not yet '
      + 'distinguishable from noise. That part of the reasoning carries no established evidence behind it.'));
  }
  if (usesMacro && knowledgeAssessment && knowledgeAssessment.ok && knowledgeAssessment.modelIsReal) {
    const decayed = knowledgeAssessment.drivers.filter(d => d.maturity === 'decaying' || d.maturity === 'unstable');
    if (decayed.length) {
      out.push(finding('note', 'driver-decay', 'Some drivers are no longer behaving as they did',
        decayed.map(d => d.label + ' (' + d.maturity + ')').join(', ')
        + '. Their historical relationship is still in the average but has stopped holding recently.'));
    }
  }
  if (calibration && calibration.sample >= 8 && calibration.discrimination != null && calibration.discrimination <= 0.05) {
    out.push(finding('warning', 'confidence-uninformative', 'Confidence is being reported but does not discriminate',
      'Over ' + calibration.sample + ' resolved signals, high-confidence setups have not won more often than low-confidence ones. '
      + 'Treat the percentage as a label, not a probability.'));
  }
  return out;
}

// ---- assemble -------------------------------------------------------------
export function auditAnalysis(input) {
  const {
    result, plan, candles, expectedIntervalMs, now, maxAgeMs,
    knowledgeAssessment, calibration
  } = input || {};

  const findings = []
    .concat(auditData(candles, expectedIntervalMs))
    .concat(auditFreshness(candles, now, maxAgeMs))
    .concat(auditPlan(result, plan, candles))
    .concat(auditEvidence(result, knowledgeAssessment, calibration));

  const critical = findings.filter(f => f.severity === 'critical').length;
  const warnings = findings.filter(f => f.severity === 'warning').length;

  let verdict;
  if (critical) verdict = 'This analysis has errors that make it unsafe to act on.';
  else if (warnings) verdict = 'Usable, with caveats worth reading before acting.';
  else if (findings.length) verdict = 'No problems found; some context worth noting.';
  else verdict = 'No problems found.';

  return {
    findings: findings.sort((a, b) => {
      const rank = { critical: 0, warning: 1, note: 2 };
      return rank[a.severity] - rank[b.severity];
    }),
    critical, warnings, notes: findings.filter(f => f.severity === 'note').length,
    clean: findings.length === 0,
    blocking: critical > 0,
    verdict
  };
}
