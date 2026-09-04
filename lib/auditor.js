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


// Bars a span should contain, counting weekdays only. Walks day by day rather
// than approximating, so it is correct regardless of which day the span starts
// or ends on.
export function expectedBarsExcludingWeekend(startMs, endMs, intervalMs) {
  if (!(endMs > startMs) || !(intervalMs > 0)) return 0;
  const DAY = 86400000;
  let total = 0;
  let cursor = startMs;
  while (cursor < endMs) {
    const dayStart = Math.floor(cursor / DAY) * DAY;
    const dayEnd = Math.min(dayStart + DAY, endMs);
    const dow = new Date(dayStart).getUTCDay(); // 0 Sun, 6 Sat
    if (dow !== 0 && dow !== 6) total += (dayEnd - cursor) / intervalMs;
    cursor = dayEnd;
  }
  return Math.max(1, Math.round(total) + 1);
}

function spansWeekend(aMs, bMs) {
  const DAY = 86400000;
  for (let d = Math.floor(aMs / DAY) * DAY; d <= bMs; d += DAY) {
    const dow = new Date(d).getUTCDay();
    if (dow === 0 || dow === 6) return true;
  }
  return false;
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
    // A gap that spans a weekend is the market being shut, not a broken feed.
    if (expectedIntervalMs && b.time - a.time > expectedIntervalMs * 1.5 && !spansWeekend(a.time, b.time)) gaps++;
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
  //
  // The expected count must exclude the weekend. Gold trades 24/5, so a naive
  // count reads about 71% coverage on ANY window purely from Saturday and
  // Sunday — a warning that fires every single time, which teaches you to
  // ignore the auditor, and sits close enough to the critical threshold that a
  // holiday would have blocked trading outright.
  if (expectedIntervalMs) {
    const expected = expectedBarsExcludingWeekend(candles[0].time, candles[candles.length - 1].time, expectedIntervalMs);
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

// ---- is the feed telling the truth? ---------------------------------------
//
// auditData above asks whether the feed is INTACT — ordered, complete, not
// duplicated. This asks the harder question: is what arrived actually the
// market? A feed can be perfectly well-formed and still be wrong — the wrong
// instrument, a decimal shift, a stuck provider repeating its last value, a bad
// tick nobody traded. All of those produce confident analysis of something that
// did not happen, and none of them announce themselves.
//
// Every finding here names WHERE: the index, the timestamp, and the values that
// are wrong, so the problem can be gone and looked at rather than guessed at.

const stamp = (t) => { try { return new Date(t).toISOString().replace('T', ' ').slice(0, 16) + 'Z'; } catch (e) { return String(t); } };
const at = (i, c) => 'bar ' + i + ' (' + stamp(c.time) + ')';
// Raw floats read as noise in a finding; two decimals is how the price is quoted.
const px = (v) => isFinite(v) ? (+v).toFixed(2) : String(v);

function medianOf(values) {
  if (!values.length) return null;
  const v = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export const FEED_SANITY = {
  // Gold. Wide enough that no real market move trips it, narrow enough that a
  // wrong symbol or a decimal shift does.
  minPrice: 200,
  maxPrice: 20000,
  // A single bar moving this many times the typical bar move is a bad tick, not
  // a market. Gold's worst real sessions stay well inside it.
  jumpMultiple: 25,
  // Consecutive identical closes that mean the provider has stopped updating.
  frozenRun: 8,
  // Fraction of bars with high === low before the feed looks synthetic.
  zeroRangeFraction: 0.25
};

export function auditFeedIntegrity(candles, opts) {
  const cfg = Object.assign({}, FEED_SANITY, opts || {});
  const out = [];
  if (!candles || candles.length < 3) return out;

  // 1. Bars that are internally impossible. A close outside its own bar's range
  //    is not a market event; it is corrupt data, and every level derived from
  //    that bar is wrong.
  const impossible = [];
  candles.forEach((c, i) => {
    if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) {
      impossible.push(at(i, c) + ': non-numeric OHLC');
    } else if (c.close > c.high || c.close < c.low || c.open > c.high || c.open < c.low) {
      impossible.push(at(i, c) + ': O' + px(c.open) + ' C' + px(c.close) + ' outside range ' + px(c.low) + '-' + px(c.high));
    }
  });
  if (impossible.length) {
    out.push(finding(SEVERITY.critical, 'impossible-bars', 'Candles that cannot exist',
      impossible.length + ' bar(s) have an open or close outside their own high-low range. ' +
      'First: ' + impossible.slice(0, 3).join('; ') + '.'));
  }

  // 2. Prices outside anything this instrument can be. Catches the wrong symbol
  //    being served, and a decimal shift, which is the dangerous one: the shape
  //    of the chart is unchanged, so nothing looks wrong until every level is
  //    off by a factor of ten.
  const outOfBand = [];
  candles.forEach((c, i) => {
    if (isFinite(c.close) && (c.close < cfg.minPrice || c.close > cfg.maxPrice)) outOfBand.push(at(i, c) + ': ' + px(c.close));
  });
  if (outOfBand.length) {
    out.push(finding(SEVERITY.critical, 'price-out-of-band', 'Prices outside anything this instrument trades at',
      outOfBand.length + ' bar(s) sit outside ' + cfg.minPrice + '-' + cfg.maxPrice +
      '. That is a wrong symbol or a decimal shift, not a market move. First: ' + outOfBand.slice(0, 3).join('; ') + '.'));
  }

  // 3. A jump no market made. Measured against the feed's own typical bar move
  //    rather than a fixed number, so it adapts to how volatile the series is,
  //    and weekend gaps are exempt because those are real.
  const moves = [];
  for (let i = 1; i < candles.length; i++) {
    if (isFinite(candles[i].close) && isFinite(candles[i - 1].close)) moves.push(Math.abs(candles[i].close - candles[i - 1].close));
  }
  const typical = medianOf(moves.filter(m => m > 0));
  if (typical > 0) {
    const jumps = [];
    for (let i = 1; i < candles.length; i++) {
      const move = Math.abs(candles[i].close - candles[i - 1].close);
      if (move >= typical * cfg.jumpMultiple && !spansWeekend(candles[i - 1].time, candles[i].time)) {
        jumps.push(at(i, candles[i]) + ': ' + px(candles[i - 1].close) + ' -> ' + px(candles[i].close) +
          ' (' + (move / typical).toFixed(0) + 'x the typical ' + typical.toFixed(2) + ' move)');
      }
    }
    if (jumps.length) {
      out.push(finding(SEVERITY.warning, 'impossible-jump', 'Price jumps far beyond this feed\'s own volatility',
        jumps.length + ' bar(s) move further in one step than the market plausibly did intraday. ' +
        'A bad tick becomes a swing point, and structure is read off it. First: ' + jumps.slice(0, 2).join('; ') + '.'));
    }
  }

  // 4. A provider that has stopped updating still returns data — the same value,
  //    over and over. Nothing else in the system can tell that apart from a
  //    genuinely motionless market.
  let run = 1, worstRun = 1, worstEnd = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close === candles[i - 1].close) { run++; if (run > worstRun) { worstRun = run; worstEnd = i; } }
    else run = 1;
  }
  if (worstRun >= cfg.frozenRun) {
    out.push(finding(SEVERITY.warning, 'frozen-feed', 'The feed stopped moving',
      worstRun + ' consecutive bars share the identical close, ending at ' + at(worstEnd, candles[worstEnd]) +
      '. A stalled provider looks exactly like a flat market to everything downstream.'));
  }

  // 5. Bars with no range at all. A few are plausible on a quiet minute; a
  //    quarter of the series means the feed is filling in rather than reporting.
  const flat = candles.filter(c => isFinite(c.high) && c.high === c.low).length;
  if (flat > candles.length * cfg.zeroRangeFraction) {
    out.push(finding(SEVERITY.warning, 'synthetic-feed', 'Most bars have no high-low range',
      flat + ' of ' + candles.length + ' bars have high === low. Real bars have range; this looks generated or padded.'));
  }
  return out;
}

// Timeframes that claim to describe the same instrument have to agree on what
// it costs. If the 4H series says gold is 2000 while the 15m says 4400, one of
// them is a different symbol, a different unit, or stale by months — and the
// multi-timeframe alignment the whole engine rests on is meaningless.
export function auditCrossSeries(series) {
  const out = [];
  const named = Object.keys(series || {})
    .map(k => ({ name: k, s: series[k] }))
    .filter(x => Array.isArray(x.s) && x.s.length && isFinite(x.s[x.s.length - 1].close));
  if (named.length < 2) return out;

  const levels = named.map(x => ({ name: x.name, price: x.s[x.s.length - 1].close }));
  const prices = levels.map(l => l.price);
  const lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices);
  if (lo > 0 && hi / lo > 1.25) {
    const detail = levels.map(l => l.name + ' ' + l.price.toFixed(2)).join(', ');
    out.push(finding(SEVERITY.critical, 'timeframe-mismatch', 'Timeframes disagree about the price',
      'Latest close by series: ' + detail + ' — a ' + ((hi / lo - 1) * 100).toFixed(0) + '% spread. ' +
      'These cannot all be the same instrument at the same time, so higher-timeframe alignment is meaningless.'));
  }
  return out;
}

// A macro series can be well-formed and still be useless: frozen, or so far out
// of date that it describes a different regime, while the engine reads it as
// current. Both are silent — the number is there, it is just not true any more.
export function auditMacroSeries(list, now) {
  const out = [];
  const t = isFinite(now) ? now : Date.now();
  (list || []).forEach(entry => {
    if (!entry) return;
    // Two shapes reach here: FRED's own {date, value} observations, and the
    // {time, close} series the engine keeps internally. Normalising here beats
    // a conversion at each call site, which is one more place to get it wrong.
    const raw = Array.isArray(entry.observations) ? entry.observations
      : Array.isArray(entry.series) ? entry.series.map(o => ({ date: o.date || o.time, value: o.value != null ? o.value : o.close }))
      : null;
    if (!raw || !raw.length) return;
    const obs = raw.filter(o => isFinite(o.value));
    if (obs.length < 2) return;
    const values = obs.map(o => o.value);
    if (values.every(v => v === values[0])) {
      out.push(finding(SEVERITY.warning, 'macro-frozen', 'Macro series never changes',
        entry.label + ' (' + entry.key + ') holds ' + values[0] + ' across all ' + values.length +
        ' observations. It is contributing a constant to the score, which is not information.'));
    }
    const lastDate = obs[obs.length - 1].date;
    const lastAt = typeof lastDate === 'number' ? lastDate : Date.parse(lastDate);
    if (isFinite(lastAt)) {
      const days = (t - lastAt) / 86400000;
      // Judge staleness against the series' OWN publication rhythm rather than a
      // flat number of days. A daily rate is late after a week; monthly CPI is
      // not late until it has missed a print. A single threshold either
      // false-alarms on every monthly series or lets a dead daily one through.
      const times = obs.map(o => typeof o.date === 'number' ? o.date : Date.parse(o.date)).filter(isFinite);
      let widestGap = 0;
      for (let i = 1; i < times.length; i++) widestGap = Math.max(widestGap, (times[i] - times[i - 1]) / 86400000);
      // The widest observed gap already absorbs weekends and holidays for a
      // daily series, and the natural month for a monthly one.
      const cadence = widestGap > 0 ? widestGap : 1;
      const warnAfter = isFinite(entry.maxAgeDays) ? entry.maxAgeDays : Math.max(cadence * 3, 10);
      const blockAfter = Math.max(warnAfter * 3, 90);
      if (days > warnAfter) {
        out.push(finding(days > blockAfter ? SEVERITY.critical : SEVERITY.warning, 'macro-stale',
          'Macro series is out of date',
          entry.label + ' (' + entry.key + ') was last published ' + Math.round(days) +
          ' days ago (' + (typeof lastDate === 'number' ? stamp(lastDate).slice(0, 10) : lastDate) +
          '), against a normal publication gap of ' + cadence.toFixed(0) +
          ' day(s). It is being read as the current state of a market that has moved.'));
      }
    }
  });
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
// ============================================================
// AUDITING TRADES THAT ARE ALREADY LIVE
// ------------------------------------------------------------
// Auditing the analysis before a trade is committed is only half the job. Once
// an order is out there it can rot: the move it was placed for happens without
// it, the market walks away from the level, and what finally fills days later
// is a retest of a spent zone rather than the setup that was analysed. Grading
// that fill teaches the system from a trade it would never have taken.
//
// Deciding that is the auditor's job rather than the engine's, for the same
// reason the auditor exists at all: the engine would be judging whether its own
// trade has gone bad. So nothing the signal record claims is taken on trust.
// Fill state is re-derived from raw candles, not read from `status`, which also
// catches the case where the bookkeeping and the market disagree — a "pending"
// order price actually traded through, or an "open" position that never filled.
//
// It returns verdicts. Applying them stays with the caller, because an auditor
// that edits the thing it audits has stopped being one.
// ============================================================

// Did price actually trade through this level, and when? Re-derived from
// candles rather than trusting signal.filledAt.
function derivedFill(sig, candles) {
  const signalTime = typeof sig.time === 'string' ? Date.parse(sig.time) : sig.time;
  const after = (candles || []).filter(c => c.time > signalTime);
  if (sig.entryType === 'market') {
    return { filled: true, at: after.length ? after[0].time : signalTime, derivable: true };
  }
  if (!after.length) return { filled: false, at: null, derivable: false };
  for (let i = 0; i < after.length; i++) {
    const c = after[i];
    if (c.low <= sig.entry && c.high >= sig.entry) return { filled: true, at: c.time, derivable: true };
  }
  return { filled: false, at: null, derivable: true };
}

// How far price ran from the entry in the trade's own direction, beyond
// wherever it already was when the order was placed, in multiples of the stop.
function derivedDrift(sig, candles) {
  const signalTime = typeof sig.time === 'string' ? Date.parse(sig.time) : sig.time;
  const after = (candles || []).filter(c => c.time > signalTime);
  const risk = Math.abs(sig.entry - sig.sl);
  if (!after.length || !(risk > 0)) return null;
  const isBuy = sig.dir === 'BUY';
  const driftOf = c => isBuy ? (c.high - sig.entry) : (sig.entry - c.low);
  const baseline = Math.max(0, driftOf(after[0]));
  let worst = 0;
  after.forEach(c => { worst = Math.max(worst, driftOf(c) - baseline); });
  return worst / risk;
}

export const TRADE_AUDIT_DEFAULTS = {
  maxHoursToFill: 12,
  maxHoursOpen: 72,
  maxDriftRToFill: 1.5,
  warnAtRatio: 0.75
};

// Audit one live trade. Returns { id, verdict, code, reason, findings }.
// verdict is 'kill' | 'watch' | 'ok'.
export function auditTrade(sig, candles, cfg, opts) {
  cfg = Object.assign({}, TRADE_AUDIT_DEFAULTS, cfg || {});
  opts = opts || {};
  const now = isFinite(opts.now) ? opts.now : Date.now();
  const findings = [];
  const out = (verdict, code, reason) => ({ id: sig && sig.id, verdict, code, reason, findings });

  if (!sig || (sig.status !== 'pending' && sig.status !== 'open')) return out('ok', null, 'not a live trade');
  if (sig.dir !== 'BUY' && sig.dir !== 'SELL') {
    findings.push(finding(SEVERITY.critical, 'trade-direction', 'Live trade has no direction',
      'A trade is sitting in the book with a direction of "' + sig.dir + '". It cannot be resolved or graded.'));
    return out('kill', 'malformed', 'the trade has no direction and can never resolve');
  }

  const signalTime = typeof sig.time === 'string' ? Date.parse(sig.time) : sig.time;
  const timeIsUsable = isFinite(signalTime) && signalTime > 0;
  const fill = derivedFill(sig, candles);

  // Bookkeeping against the market. The engine's own status is a claim, and
  // this is the one place it can be checked against what price actually did.
  if (fill.derivable && sig.status === 'pending' && fill.filled) {
    findings.push(finding(SEVERITY.warning, 'trade-missed-fill', 'Order shows unfilled but price traded through it',
      'The record says this order is still resting, but the candles show price reaching ' + sig.entry +
      '. It is being treated as filled for the purposes of this audit.'));
  }
  if (fill.derivable && sig.status === 'open' && !fill.filled && sig.entryType !== 'market') {
    findings.push(finding(SEVERITY.warning, 'trade-phantom-fill', 'Position shows filled but price never reached the entry',
      'The record says this position is live, but no candle since the signal has traded through ' + sig.entry + '.'));
  }

  const treatAsFilled = fill.derivable ? fill.filled : (sig.status === 'open');
  const startedAt = treatAsFilled
    ? (fill.at || (sig.filledAt ? Date.parse(sig.filledAt) : signalTime))
    : signalTime;
  const ageHours = (isFinite(startedAt) && startedAt > 0) ? (now - startedAt) / 3600000 : null;
  const limit = treatAsFilled ? cfg.maxHoursOpen : cfg.maxHoursToFill;

  // The move happened without it. Checked before the clock, because this is the
  // stronger statement: the setup is spent whatever the clock says.
  if (!treatAsFilled && cfg.maxDriftRToFill > 0) {
    const drift = derivedDrift(sig, candles);
    if (drift != null && drift >= cfg.maxDriftRToFill) {
      findings.push(finding(SEVERITY.critical, 'trade-zone-spent', 'The market has left this order behind',
        'Price ran a further ' + drift.toFixed(1) + 'R away from the entry without ever tagging it. ' +
        'The move this order was positioned for has already happened, so a return to that level now is a ' +
        'retest of a spent zone, not the setup that was analysed.'));
      return out('kill', 'zone-left-behind',
        'price ran a further ' + drift.toFixed(1) + 'R away without filling — a return now is a retest, not this setup');
    }
  }

  if (!timeIsUsable) {
    findings.push(finding(SEVERITY.note, 'trade-no-timestamp', 'Trade has no usable timestamp',
      'Its age cannot be checked, so the time limits do not apply to it.'));
    return out('ok', null, 'no usable timestamp to age against');
  }
  if (ageHours != null && limit > 0 && ageHours >= limit) {
    const what = treatAsFilled ? 'position' : 'order';
    findings.push(finding(SEVERITY.critical, 'trade-stale', 'Live ' + what + ' is past its time limit',
      'It has been ' + (treatAsFilled ? 'open' : 'resting') + ' for ' + ageHours.toFixed(1) +
      'h against a limit of ' + limit + 'h. Left alone it either fills on a stale level or resolves on ' +
      'conditions unrelated to the ones analysed, and either way the outcome is not evidence about the setup.'));
    return out('kill', treatAsFilled ? 'stale-position' : 'stale-order',
      (treatAsFilled ? 'position open ' : 'resting order ') + ageHours.toFixed(1) + 'h, past the ' + limit + 'h limit');
  }
  if (ageHours != null && limit > 0 && ageHours >= limit * cfg.warnAtRatio) {
    findings.push(finding(SEVERITY.warning, 'trade-ageing', 'Live trade is approaching its time limit',
      (treatAsFilled ? 'Open' : 'Resting') + ' for ' + ageHours.toFixed(1) + 'h of an allowed ' + limit + 'h.'));
    return out('watch', 'ageing', 'approaching its time limit');
  }
  return out('ok', null, 'within limits');
}

// Audit every live trade in the book.
export function auditOpenTrades(signals, candles, cfg, opts) {
  const live = (signals || []).filter(s => s && (s.status === 'pending' || s.status === 'open'));
  const verdicts = live.map(s => auditTrade(s, candles, cfg, opts));
  const kills = verdicts.filter(v => v.verdict === 'kill');
  const watch = verdicts.filter(v => v.verdict === 'watch');
  const findings = verdicts.reduce((a, v) => a.concat(v.findings), []);
  return {
    reviewed: live.length,
    kills, watch, verdicts, findings,
    critical: findings.filter(f => f.severity === 'critical').length,
    warnings: findings.filter(f => f.severity === 'warning').length,
    verdict: !live.length ? 'No live trades to review.'
      : kills.length ? kills.length + ' of ' + live.length + ' live trade(s) should be closed out.'
      : watch.length ? watch.length + ' of ' + live.length + ' live trade(s) are approaching their limit.'
      : 'All ' + live.length + ' live trade(s) are within limits.'
  };
}

export function auditAnalysis(input) {
  const {
    result, plan, candles, expectedIntervalMs, now, maxAgeMs,
    knowledgeAssessment, calibration, series, macroSeries, feedSanity
  } = input || {};

  const findings = []
    .concat(auditData(candles, expectedIntervalMs))
    // Intact is not the same as true: a well-formed feed can still be the wrong
    // instrument, a decimal shift, a stalled provider or a bad tick.
    .concat(auditFeedIntegrity(candles, feedSanity))
    .concat(auditCrossSeries(series))
    .concat(auditMacroSeries(macroSeries, now))
    .concat(auditFreshness(candles, now, maxAgeMs))
    .concat(auditPlan(result, plan, candles))
    .concat(auditEvidence(result, knowledgeAssessment, calibration));

  const critical = findings.filter(f => f.severity === 'critical').length;
  const warnings = findings.filter(f => f.severity === 'warning').length;

  // A data fault is reported differently from an analysis fault: the analysis
  // may be impeccable and still worthless if what it reasoned from was wrong,
  // and saying "the analysis has errors" would send you looking in the wrong
  // place.
  const dataCodes = ['no-data', 'unordered', 'malformed-candles', 'impossible-bars', 'price-out-of-band',
    'timeframe-mismatch', 'thin-coverage', 'stale-feed', 'frozen-feed', 'impossible-jump',
    'synthetic-feed', 'duplicate-candles', 'gappy-feed', 'macro-stale', 'macro-frozen'];
  const dataFaults = findings.filter(f => dataCodes.indexOf(f.code) !== -1);
  const blockingData = dataFaults.filter(f => f.severity === 'critical');

  let verdict;
  if (blockingData.length) verdict = 'The data feeding this analysis is wrong — ' + blockingData[0].title.toLowerCase() +
    '. Nothing downstream can be trusted until the feed is fixed.';
  else if (critical) verdict = 'This analysis has errors that make it unsafe to act on.';
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
    // Separated so the UI can say whether the problem is in the reasoning or in
    // what the reasoning was given.
    dataFaults, dataProblem: blockingData.length > 0,
    verdict
  };
}
