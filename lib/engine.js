// ============================================================
// SHARED ANALYSIS ENGINE
// ------------------------------------------------------------
// Every function in here is pure: candles and numbers in, numbers and plain
// objects out. No DOM, no localStorage, no network. That is deliberate — this
// exact file is imported both by the browser app (app.js) and by the
// server-side autonomous worker (api/cron/analyze.js), so the analysis that
// runs unattended on Vercel is bit-for-bit the same analysis the UI shows.
// Anything that touches a screen, a key, or storage belongs in app.js instead.
// ============================================================

// The meta-labeler model is the one piece of learned state the pure scoring path
// needs. Rather than reach for a global (which would tie this file to the browser
// app's variables), whoever owns the state injects it here: the UI does it when
// learning state loads or retrains, the cron worker does it after reading state
// out of Firestore. Unset means "not trained yet", which scoreAdaBoost treats as
// a neutral 0 score.
let _metaModel = null;
export function setMetaModel(model) { _metaModel = model || null; }
export function getMetaModel() { return _metaModel; }

// ============================================================
// CLASSIC INDICATORS
// ============================================================
export function genData(n, startPrice, intervalMs) {
  intervalMs = intervalMs || 900000; // 15min
  let p = startPrice, data = [], now = Date.now();
  for (let i = n; i >= 0; i--) {
    let t = now - i * intervalMs;
    let ch = (Math.random() - 0.495) * 2.2;
    p = Math.max(1500, p + ch);
    let o = p - (Math.random() - 0.5) * 1.2;
    let h = Math.max(o, p) + Math.random() * 1.8;
    let l = Math.min(o, p) - Math.random() * 1.8;
    let c = (o + h + l + p) / 4 + (Math.random() - 0.5) * 0.9;
    data.push({ time: t, open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2) });
  }
  return data;
}
export function calcEMA(data, period) {
  let ema = [], sum = 0;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { sum += data[i].close; ema.push(null); }
    else if (i === period - 1) { sum += data[i].close; ema.push(sum / period); }
    else { let v = data[i].close * (2 / (period + 1)) + ema[i - 1] * (1 - 2 / (period + 1)); ema.push(v); }
  }
  return ema;
}
export function calcRSI(data, p) {
  p = p || 14;
  // Wilder's smoothing. avgGain/avgLoss hold AVERAGES, not running sums — the seeding
  // phase accumulates sums and then divides once at i === p to hand over to the
  // recurrence. Keeping sums here instead would make each step multiply the
  // accumulator by (p-1), which overflows to Infinity within a few hundred bars and
  // turns every later RSI reading into NaN.
  const rsi = [null];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;
    if (i <= p) {
      avgGain += up; avgLoss += down;
      if (i === p) {
        avgGain /= p; avgLoss /= p;
        rsi.push(rsiFromAverages(avgGain, avgLoss));
      } else {
        rsi.push(null);
      }
    } else {
      avgGain = (avgGain * (p - 1) + up) / p;
      avgLoss = (avgLoss * (p - 1) + down) / p;
      rsi.push(rsiFromAverages(avgGain, avgLoss));
    }
  }
  return rsi;
}
function rsiFromAverages(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100; // no downside at all: flat = 50, pure upside = 100
  return 100 - 100 / (1 + avgGain / avgLoss);
}
export function calcATR(data, p) {
  p = p || 14;
  let tr = [];
  for (let i = 0; i < data.length; i++) {
    if (i === 0) tr.push(data[i].high - data[i].low);
    else tr.push(Math.max(data[i].high - data[i].low, Math.abs(data[i].high - data[i - 1].close), Math.abs(data[i].low - data[i - 1].close)));
  }
  let atr = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < p - 1) atr.push(null);
    else if (i === p - 1) { let s = 0; for (let j = 0; j <= i; j++) s += tr[j]; atr.push(s / p); }
    else atr.push((atr[i - 1] * (p - 1) + tr[i]) / p);
  }
  return atr;
}
// Display helper. Tolerates undefined/NaN because it renders records restored
// from localStorage, which may predate a field or have been written partially —
// one missing value should show a dash, not throw and blank an entire panel.
export function fmt(n) { return (typeof n === 'number' && isFinite(n)) ? n.toFixed(2) : '—'; }
// Parses a "YYYY-MM-DD HH:MM:SS"-style string as UTC explicitly. JS's Date constructor treats a bare
// datetime string (no 'Z', no offset) as LOCAL time, which silently corrupts every downstream session/
// kill-zone/timeframe calculation depending on the device's timezone. This makes the interpretation explicit.
export function parseUtcDatetime(str) {
  if (!str) return Date.now();
  const iso = /Z$|[+-]\d\d:?\d\d$/.test(str) ? str : str.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  return isNaN(t) ? Date.now() : t;
}

// ============================================================
// SMC ENGINE
// ============================================================
export function aggregateCandles(data, factor) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const chunk = data.slice(i, Math.min(i + factor, data.length));
    out.push({
      time: chunk[0].time, open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close
    });
    i += factor;
  }
  return out;
}
export function detectSwings(data, left, right) {
  left = left == null ? 2 : left; right = right == null ? 2 : right;
  const swings = [];
  for (let i = left; i < data.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (data[j].high >= data[i].high) isHigh = false;
      if (data[j].low <= data[i].low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: data[i].high, type: 'high' });
    if (isLow) swings.push({ index: i, price: data[i].low, type: 'low' });
  }
  return swings;
}
export function analyzeStructure(data, swings) {
  const events = [];
  let trend = null;
  let lastSwingHigh = null, lastSwingLow = null, swingPtr = 0;
  const sorted = swings.slice().sort((a, b) => a.index - b.index);
  for (let i = 0; i < data.length; i++) {
    while (swingPtr < sorted.length && sorted[swingPtr].index === i) {
      const s = sorted[swingPtr];
      if (s.type === 'high') lastSwingHigh = s; else lastSwingLow = s;
      swingPtr++;
    }
    const c = data[i].close;
    if (lastSwingHigh && c > lastSwingHigh.price) {
      const isChoch = trend === 'bearish';
      events.push({ index: i, type: isChoch ? 'CHoCH' : 'BOS', direction: 'bullish', level: lastSwingHigh.price });
      trend = 'bullish'; lastSwingHigh = null;
    } else if (lastSwingLow && c < lastSwingLow.price) {
      const isChoch = trend === 'bullish';
      events.push({ index: i, type: isChoch ? 'CHoCH' : 'BOS', direction: 'bearish', level: lastSwingLow.price });
      trend = 'bearish'; lastSwingLow = null;
    }
  }
  return { trend, events };
}
export function detectOrderBlocks(data, events) {
  const obs = [];
  events.forEach(ev => {
    const wantDown = ev.direction === 'bullish';
    for (let j = ev.index; j >= Math.max(0, ev.index - 15); j--) {
      const c = data[j];
      if (wantDown && c.close < c.open) { obs.push({ dir: 'bullish', low: c.low, high: c.high, index: j, eventIndex: ev.index, mitigated: false }); break; }
      if (!wantDown && c.close > c.open) { obs.push({ dir: 'bearish', low: c.low, high: c.high, index: j, eventIndex: ev.index, mitigated: false }); break; }
    }
  });
  obs.forEach(ob => {
    for (let k = ob.eventIndex + 1; k < data.length; k++) {
      if (data[k].low <= ob.high && data[k].high >= ob.low) { ob.mitigated = true; break; }
    }
  });
  return obs;
}
export function detectFVGs(data) {
  const fvgs = [];
  for (let i = 1; i < data.length - 1; i++) {
    const prev = data[i - 1], next = data[i + 1];
    if (next.low > prev.high) fvgs.push({ dir: 'bullish', low: prev.high, high: next.low, index: i, mitigated: false });
    else if (next.high < prev.low) fvgs.push({ dir: 'bearish', low: next.high, high: prev.low, index: i, mitigated: false });
  }
  fvgs.forEach(f => {
    for (let k = f.index + 2; k < data.length; k++) {
      if (data[k].low <= f.high && data[k].high >= f.low) { f.mitigated = true; break; }
    }
  });
  return fvgs;
}
export function detectLiquidity(swings, tolerance) {
  tolerance = tolerance || 0.0008;
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  function cluster(points) {
    const clusters = [];
    points.forEach(p => {
      const found = clusters.find(c => Math.abs(c.price - p.price) / p.price < tolerance);
      if (found) { found.points.push(p); found.price = found.points.reduce((s, x) => s + x.price, 0) / found.points.length; }
      else clusters.push({ price: p.price, points: [p] });
    });
    return clusters.filter(c => c.points.length >= 2).map(c => Object.assign(c, { strength: c.points.length, lastIndex: Math.max(...c.points.map(p => p.index)) }));
  }
  return { buySideLiquidity: cluster(highs), sellSideLiquidity: cluster(lows) };
}
export function detectRoundNumbers(data, step) {
  step = step || 10;
  const price = data[data.length - 1].close;
  const levels = [];
  const base = Math.floor(price / step) * step;
  for (let m = -3; m <= 3; m++) if (base + m * step > 0) levels.push(base + m * step);
  return levels;
}
export function detectSweep(data, liquidity) {
  const last = data[data.length - 1];
  let sweep = null;
  liquidity.buySideLiquidity.forEach(lv => { if (last.high > lv.price && last.close < lv.price) sweep = { dir: 'bearish', level: lv.price, note: 'Price swept buy-side liquidity above ' + fmt(lv.price) + ' and closed back below it — a classic stop-hunt pattern that often precedes a move down.' }; });
  liquidity.sellSideLiquidity.forEach(lv => { if (last.low < lv.price && last.close > lv.price) sweep = { dir: 'bullish', level: lv.price, note: 'Price swept sell-side liquidity below ' + fmt(lv.price) + ' and closed back above it — a classic stop-hunt pattern that often precedes a move up.' }; });
  return sweep;
}
export function premiumDiscount(data, swings) {
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  if (!highs.length || !lows.length) return null;
  const lastHigh = highs[highs.length - 1], lastLow = lows[lows.length - 1];
  const rangeHigh = Math.max(lastHigh.price, lastLow.price), rangeLow = Math.min(lastHigh.price, lastLow.price);
  const mid = (rangeHigh + rangeLow) / 2;
  const price = data[data.length - 1].close;
  const zone = price > mid ? 'premium' : 'discount';
  const oteHigh = rangeHigh - (rangeHigh - rangeLow) * 0.618;
  const oteLow = rangeHigh - (rangeHigh - rangeLow) * 0.79;
  return { rangeHigh, rangeLow, mid, zone, oteLow, oteHigh, inOTE: price <= oteHigh && price >= oteLow };
}
// ============================================================
// SESSION INTELLIGENCE
// ============================================================
export function getSessionInfo(ms) {
  const h = new Date(ms).getUTCHours();
  let session = 'Asian';
  if (h >= 7 && h < 12) session = 'London';
  else if (h >= 12 && h < 16) session = 'London-NY Overlap';
  else if (h >= 16 && h < 21) session = 'New York';
  let killZone = null;
  if (h >= 7 && h < 10) killZone = 'London Killzone';
  else if (h >= 12 && h < 15) killZone = 'New York Killzone';
  return { session, killZone };
}
export function computeSessionStats(ltf) {
  const buckets = { Asian: [], London: [], 'London-NY Overlap': [], 'New York': [] };
  ltf.forEach(c => { const { session } = getSessionInfo(c.time); buckets[session].push(c.high - c.low); });
  const avgRange = {};
  Object.keys(buckets).forEach(k => { avgRange[k] = buckets[k].length ? buckets[k].reduce((a, b) => a + b, 0) / buckets[k].length : 0; });
  return avgRange;
}

// ============================================================
// MARKET REGIME
// ============================================================
export function detectMarketRegime(swings, atrArr) {
  const recentATR = atrArr.slice(-20).filter(v => v != null);
  const olderATR = atrArr.slice(-40, -20).filter(v => v != null);
  const avgRecent = recentATR.length ? recentATR.reduce((a, b) => a + b, 0) / recentATR.length : 0;
  const avgOlder = olderATR.length ? olderATR.reduce((a, b) => a + b, 0) / olderATR.length : avgRecent;
  const volTrend = avgOlder > 0 ? (avgRecent - avgOlder) / avgOlder : 0;

  const recentSwings = swings.slice(-8);
  const highs = recentSwings.filter(s => s.type === 'high'), lows = recentSwings.filter(s => s.type === 'low');
  let hh = 0, lh = 0, hl = 0, ll = 0;
  for (let i = 1; i < highs.length; i++) { if (highs[i].price > highs[i - 1].price) hh++; else lh++; }
  for (let i = 1; i < lows.length; i++) { if (lows[i].price > lows[i - 1].price) hl++; else ll++; }
  const directionalScore = (hh + hl) - (lh + ll);
  const isTrending = Math.abs(directionalScore) >= 2;

  let regime;
  if (isTrending && volTrend > 0.05) regime = 'Trending / Expansion';
  else if (isTrending) regime = 'Trending';
  else if (volTrend < -0.1) regime = 'Compression (range narrowing — often precedes breakout)';
  else if (volTrend > 0.1) regime = 'Expansion (range widening, no clear direction)';
  else regime = 'Ranging / Accumulation-Distribution';
  return { regime, volTrend, directionalScore, isTrending };
}

// ============================================================
// HISTORICAL SIMILARITY (real k-nearest-neighbor pattern match against actual price history)
// ============================================================
export function buildFeatureVector(ltf, i, ema9, ema21, rsi, atr) {
  const emaSpread = atr[i] ? (ema9[i] - ema21[i]) / atr[i] : 0;
  const rsiVal = rsi[i] == null ? 50 : rsi[i];
  const atrPct = atr[i] ? (atr[i] / ltf[i].close) * 10000 : 0;
  return [rsiVal / 100, Math.max(-3, Math.min(3, emaSpread)) / 3, Math.min(atrPct, 50) / 50];
}
export function historicalSimilarity(ltf, uptoIndex, lookAheadBars, kNeighbors) {
  lookAheadBars = lookAheadBars || 10; kNeighbors = kNeighbors || 20;
  if (uptoIndex < 80) return null;
  const ema9 = calcEMA(ltf, 9), ema21 = calcEMA(ltf, 21), rsi = calcRSI(ltf, 14), atr = calcATR(ltf, 14);
  if (ema9[uptoIndex] == null || atr[uptoIndex] == null) return null;
  const curVec = buildFeatureVector(ltf, uptoIndex, ema9, ema21, rsi, atr);
  const candidates = [];
  for (let i = 60; i < uptoIndex - lookAheadBars; i++) {
    if (ema9[i] == null || ema21[i] == null || rsi[i] == null || atr[i] == null) continue;
    const vec = buildFeatureVector(ltf, i, ema9, ema21, rsi, atr);
    const dist = Math.sqrt(vec.reduce((s, v, idx) => s + (v - curVec[idx]) * (v - curVec[idx]), 0));
    candidates.push({ i, dist });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.dist - b.dist);
  const top = candidates.slice(0, kNeighbors);
  let bull = 0, bear = 0; const moves = [];
  top.forEach(c => {
    const startP = ltf[c.i].close, endP = ltf[Math.min(c.i + lookAheadBars, ltf.length - 1)].close;
    const movePct = (endP - startP) / startP * 100;
    moves.push(movePct);
    if (movePct > 0.05) bull++; else if (movePct < -0.05) bear++;
  });
  const avgMove = moves.reduce((a, b) => a + b, 0) / moves.length;
  return { count: top.length, bullishPct: Math.round(bull / top.length * 100), bearishPct: Math.round(bear / top.length * 100), avgMovePct: avgMove, rangePct: Math.max(...moves) - Math.min(...moves), avgDurationBars: lookAheadBars };
}

// ============================================================
// CONTRARIAN REASONING + DECISION FUSION
// ============================================================
export function buildTheses(factors) {
  const bull = [], bear = [], neutral = [];
  Object.keys(factors).forEach(k => {
    const v = factors[k], label = FACTOR_LABELS[k];
    if (v > 0) bull.push(label); else if (v < 0) bear.push(label); else neutral.push(label);
  });
  return { bull, bear, neutral };
}
export function decisionFusion(direction, confidence, factors, sessionInfo, regimeInfo, histSim) {
  const theses = buildTheses(factors);
  let grade = confidence >= 70 ? 'A' : confidence >= 50 ? 'B' : confidence >= 30 ? 'C' : 'D';
  const riskNotes = [];
  if (regimeInfo.regime.indexOf('Ranging') === 0 || regimeInfo.regime.indexOf('Ranging') > 0) { riskNotes.push('ranging market — false breakouts common'); if (grade === 'A') grade = 'B'; else if (grade === 'B') grade = 'C'; }
  if (sessionInfo.killZone) riskNotes.push(sessionInfo.killZone + ' active — sharp liquidity moves possible');
  if (histSim && direction !== 'HOLD') {
    const agrees = (direction === 'BUY' && histSim.bullishPct > histSim.bearishPct) || (direction === 'SELL' && histSim.bearishPct > histSim.bullishPct);
    if (!agrees) { riskNotes.push('historical similarity leans the other way (' + histSim.bullishPct + '% bull / ' + histSim.bearishPct + '% bear in ' + histSim.count + ' similar past setups)'); if (grade === 'A') grade = 'B'; else if (grade === 'B') grade = 'C'; }
  }
  const riskLevel = riskNotes.length ? riskNotes.join('; ') : 'Normal';
  return { theses, grade, riskLevel };
}
// Pure function — never mutates the original grade, so calling it repeatedly on the same base grade
// (e.g. re-rendering after the target R:R slider moves) can never cumulatively downgrade further than one step.
export function downgradeGrade(grade, metaScore) {
  if (metaScore == null || metaScore >= -0.15) return grade;
  const order = ['A', 'B', 'C', 'D'];
  const idx = order.indexOf(grade);
  return idx < 0 ? grade : order[Math.min(order.length - 1, idx + 1)];
}

// ============================================================
// SYSTEM ALERT: technical/macro conflict + volatility anomaly detection
// ============================================================
// Deliberately NOT an auto-investigation layer — no LLM call, no auto-generated explanation. It only flags
// that something is worth a human look, same spirit as a trader's gut telling them "this doesn't add up,"
// without pretending a rule-based system can explain the "why" itself. That's your job once it flags.
export function detectSystemAlert(factors, atrArr) {
  const technicalKeys = ['weekly', 'daily', 'htf', 'mtf', 'ltf', 'ob', 'fvg', 'liquidity', 'premiumDiscount', 'priceAction', 'classic'];
  const macroKeys = ['correlation', 'fundamental', 'newsSentiment'];
  const avg = keys => { const vals = keys.map(k => factors[k]).filter(v => v != null); return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0; };
  const technicalScore = avg(technicalKeys);
  const macroScore = avg(macroKeys);
  const conflict = (technicalScore > 0.25 && macroScore < -0.25) || (technicalScore < -0.25 && macroScore > 0.25);

  let volRatio = null, volAnomaly = false;
  const validAtr = atrArr.filter(v => v != null);
  if (validAtr.length >= 40) {
    const recent = validAtr.slice(-20), baseline = validAtr.slice(-100, -20);
    const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
    const baselineAvg = baseline.length ? baseline.reduce((s, v) => s + v, 0) / baseline.length : recentAvg;
    volRatio = baselineAvg > 0 ? recentAvg / baselineAvg : 1;
    volAnomaly = volRatio >= 2 || volRatio <= 0.5;
  }

  if (!conflict && !volAnomaly) return { active: false };
  const parts = [];
  if (conflict) parts.push('technical structure (' + (technicalScore > 0 ? 'bullish' : 'bearish') + ') conflicts sharply with macro reads (' + (macroScore > 0 ? 'bullish' : 'bearish') + ')');
  if (volAnomaly) parts.push('current volatility is ' + volRatio.toFixed(1) + 'x the recent baseline — ' + (volRatio >= 2 ? 'unusually elevated' : 'unusually quiet'));
  return { active: true, conflict, volAnomaly, technicalScore, macroScore, volRatio, message: 'System alert: ' + parts.join('; ') + '. Historical patterns may not represent current conditions well — worth investigating before trading this.' };
}

// ============================================================
// CORRELATION ENGINE (real cross-market data via Twelve Data)
// ============================================================
// polarity = expected relationship to gold: +1 moves with gold, -1 moves against gold, fractional = weaker/mixed relationship.
// Twelve Data free-tier coverage varies by symbol — each fetch is independent so one failing (e.g. DXY on some plans) doesn't break the rest.
// FRED (St. Louis Fed) covers the macro side for free with no meaningful rate limit — moving DXY/oil/SPX/VIX/yields
// here means they no longer compete with the live price feed's Twelve Data quota, which is what was likely causing
// every instrument to show "unavailable" (8+ rapid Twelve Data calls right after connect blew through the 8/min cap).
// DTWEXBGS is a real but DIFFERENT dollar index methodology than ICE's DXY — same direction, not identical numbers.
// Oil and the S&P were dropped in favour of the two series that actually drive
// gold. Real yields are the cleanest single driver: gold pays no coupon, so when
// the real (inflation-adjusted) return on a risk-free bond rises, the opportunity
// cost of holding metal rises with it. Breakeven inflation is the other half of
// the same decomposition and carries gold's inflation-hedge channel. Oil's
// relationship with gold has historically been unstable, and the S&P's is
// indirect risk sentiment that VIX already covers.
//
// The nominal 10Y (DGS10) is deliberately absent: nominal = real + breakeven by
// construction (live check: 4.75 vs 2.44 + 2.35), so carrying it alongside its
// own two components counts the rates channel twice and lets redundancy, rather
// than judgement, decide the weighting. The 2Y stays — the short end is policy
// expectations, which is genuinely separate information from duration.
//
// `kind: 'yield'` matters — see seriesDeltas(). These are rates quoted in
// percent, so a move is basis points, not a percentage of the level.
export const FRED_INSTRUMENTS = [
  { key: 'dxy', seriesId: 'DTWEXBGS', label: 'Broad Dollar Index (FRED proxy for DXY)', polarity: -1, kind: 'price' },
  { key: 'real10y', seriesId: 'DFII10', label: '10Y Real Yield (TIPS)', polarity: -1, kind: 'yield' },
  { key: 'breakeven10y', seriesId: 'T10YIE', label: '10Y Breakeven Inflation', polarity: 0.6, kind: 'yield' },
  { key: 'vix', seriesId: 'VIXCLS', label: 'Volatility (VIX)', polarity: 1, kind: 'price' },
  { key: 'us2y', seriesId: 'DGS2', label: 'US 2Y Treasury Yield', polarity: -0.5, kind: 'yield' }
];
// FRED has no good series for these — Twelve Data still handles them, only 2 calls now, spaced out to stay under the rate limit.
// Nasdaq dropped: it only relates to gold indirectly through general risk sentiment, and SPX already covers
// that channel — Nasdaq added redundant noise, not independent information.
export const CORRELATION_INSTRUMENTS = [
  { key: 'xag', symbol: 'XAG/USD', label: 'Silver', polarity: 1, kind: 'price' },
  { key: 'btc', symbol: 'BTC/USD', label: 'Bitcoin', polarity: 0.1, kind: 'price' }
];
// Fundamental Intelligence Engine — real macro data, same free FRED proxy, no new API needed.
// Polarity here is deliberately conservative and simplified: gold's relationship to any single macro print is
// contested among economists (e.g. rising CPI can be gold-bullish via inflation-hedge demand, or gold-bearish
// if it triggers Fed hawkishness and higher real yields — both narratives exist). These are directional leans,
// not settled fact. NFP proxy is monthly payroll count, not the exact BLS release figure. GDP/CPI/PPI/Retail
// Sales report monthly or quarterly with real-world lag, so "latest change" reflects the last released period,
// not real-time — there is no live NFP-day flash reaction here, only the eventual FRED-published data point.
export const FUNDAMENTAL_INSTRUMENTS = [
  { key: 'cpi', seriesId: 'CPIAUCSL', label: 'CPI (Inflation)', polarity: 0.5 },
  { key: 'ppi', seriesId: 'PPIACO', label: 'PPI (Producer Prices)', polarity: 0.4 },
  { key: 'unrate', seriesId: 'UNRATE', label: 'Unemployment Rate', polarity: 0.6 },
  { key: 'nfp', seriesId: 'PAYEMS', label: 'Nonfarm Payrolls', polarity: -0.6 },
  { key: 'fedfunds', seriesId: 'FEDFUNDS', label: 'Fed Funds Rate', polarity: -0.8 },
  { key: 'gdp', seriesId: 'GDP', label: 'GDP', polarity: -0.3 },
  { key: 'sentiment', seriesId: 'UMCSENT', label: 'Consumer Sentiment', polarity: -0.3 },
  { key: 'retail', seriesId: 'RSAFS', label: 'Retail Sales', polarity: -0.3 }
];
export function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const av = a.slice(-n), bv = b.slice(-n);
  const meanA = av.reduce((s, v) => s + v, 0) / n, meanB = bv.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) { const da = av[i] - meanA, db = bv[i] - meanB; num += da * db; denA += da * da; denB += db * db; }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? null : num / den;
}
export function toDailyReturns(candles) {
  const rets = [];
  for (let i = 1; i < candles.length; i++) rets.push((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
  return rets;
}
// A yield is not a price. Moving from 0.05 to 0.10 is a 5 basis point rise, not
// a 100% one, and DFII10 (10y real yield) spent 2020-2022 BELOW zero — where a
// percentage change divides by a negative number and flips the sign of a rise.
// Yield series therefore use absolute differences; price and index series keep
// percentage returns.
export function toDailyChanges(series) {
  const d = [];
  for (let i = 1; i < series.length; i++) d.push(series[i].close - series[i - 1].close);
  return d;
}
export function absChangeOf(series) {
  if (!series || series.length < 2) return 0;
  return series[series.length - 1].close - series[series.length - 2].close;
}
// Correlation is scale-invariant, so comparing gold RETURNS against yield
// CHANGES is sound — each side just has to be the right transform of itself.
export function seriesDeltas(series, kind) {
  return kind === 'yield' ? toDailyChanges(series) : toDailyReturns(series);
}
export function latestChangeOf(series, kind) {
  return kind === 'yield' ? absChangeOf(series) : pctChangeOf(series);
}

export function biasScore(trend) { return trend === 'bullish' ? 1 : (trend === 'bearish' ? -1 : 0); }

// Classic candlestick price-action reading — a separate lens from SMC structure/liquidity.
export function detectPriceAction(data) {
  if (data.length < 3) return { score: 0, pattern: null };
  const c0 = data[data.length - 1], c1 = data[data.length - 2];
  const body = c => Math.abs(c.close - c.open);
  const range = c => Math.max(c.high - c.low, 0.0001);
  const upperWick = c => c.high - Math.max(c.open, c.close);
  const lowerWick = c => Math.min(c.open, c.close) - c.low;

  if (c1.close < c1.open && c0.close > c0.open && c0.open <= c1.close && c0.close >= c1.open) return { score: 1, pattern: 'Bullish engulfing' };
  if (c1.close > c1.open && c0.close < c0.open && c0.open >= c1.close && c0.close <= c1.open) return { score: -1, pattern: 'Bearish engulfing' };
  if (lowerWick(c0) > body(c0) * 2 && upperWick(c0) < body(c0)) return { score: 1, pattern: 'Bullish pin bar / hammer' };
  if (upperWick(c0) > body(c0) * 2 && lowerWick(c0) < body(c0)) return { score: -1, pattern: 'Bearish pin bar / shooting star' };
  if (c0.high <= c1.high && c0.low >= c1.low) return { score: 0, pattern: 'Inside bar (consolidation)' };
  if (body(c0) < range(c0) * 0.1) return { score: 0, pattern: 'Doji (indecision)' };
  if (body(c0) > range(c0) * 0.7) return { score: c0.close > c0.open ? 1 : -1, pattern: (c0.close > c0.open ? 'Bullish' : 'Bearish') + ' momentum candle' };
  return { score: 0, pattern: null };
}

export function sliceByTime(candles, cutoffTime) {
  let end = candles.length;
  for (let i = 0; i < candles.length; i++) { if (candles[i].time > cutoffTime) { end = i; break; } }
  return candles.slice(0, end);
}
export function computeComposite(fullLtf, uptoIndex, weights, realMtf, realHtf, corrScore, fundScore, newsScore, realDaily, realWeekly) {
  const ltf = fullLtf.slice(0, uptoIndex + 1);
  if (ltf.length < 60) return null;
  const cutoff = ltf[ltf.length - 1].time;
  let mtf = realMtf && realMtf.length ? sliceByTime(realMtf, cutoff) : null;
  let htf = realHtf && realHtf.length ? sliceByTime(realHtf, cutoff) : null;
  let daily = realDaily && realDaily.length ? sliceByTime(realDaily, cutoff) : null;
  let weekly = realWeekly && realWeekly.length ? sliceByTime(realWeekly, cutoff) : null;
  const mtfIsReal = !!(mtf && mtf.length >= 20);
  const htfIsReal = !!(htf && htf.length >= 20);
  const dailyIsReal = !!(daily && daily.length >= 20);
  const weeklyIsReal = !!(weekly && weekly.length >= 10);
  if (!mtfIsReal) mtf = aggregateCandles(ltf, 4);
  if (!htfIsReal) htf = aggregateCandles(ltf, 16);
  // Daily/weekly aggregation fallback from a ~500-700 bar 15min window is thin (5-7 daily candles, close to
  // nothing for weekly) — honest, not fabricated, but real data is what actually makes this layer meaningful.
  // dailyIsReal/weeklyIsReal drive the "source" label in the UI so that's visible, not hidden.
  if (!dailyIsReal) daily = aggregateCandles(ltf, 96);
  if (!weeklyIsReal) weekly = aggregateCandles(ltf, 672);

  const swingsLtf = detectSwings(ltf, 2, 2);
  const structLtf = analyzeStructure(ltf, swingsLtf);
  const structMtf = analyzeStructure(mtf, detectSwings(mtf, 1, 1));
  const structHtf = analyzeStructure(htf, detectSwings(htf, 1, 1));
  const structDaily = analyzeStructure(daily, detectSwings(daily, 1, 1));
  const structWeekly = analyzeStructure(weekly, detectSwings(weekly, 1, 1));

  const obs = detectOrderBlocks(ltf, structLtf.events);
  const fvgs = detectFVGs(ltf);
  const liquidity = detectLiquidity(swingsLtf);
  const roundNumbers = detectRoundNumbers(ltf, 10);
  const sweep = detectSweep(ltf, liquidity);
  const pd = premiumDiscount(ltf, swingsLtf);

  const price = ltf[ltf.length - 1].close;
  const ema9 = calcEMA(ltf, 9), ema21 = calcEMA(ltf, 21), ema50 = calcEMA(ltf, 50), rsi = calcRSI(ltf, 14), atrArr = calcATR(ltf, 14);
  const curRsi = rsi[rsi.length - 1] == null ? 50 : rsi[rsi.length - 1];
  const cEma9 = ema9[ema9.length - 1] == null ? price : ema9[ema9.length - 1];
  const cEma21 = ema21[ema21.length - 1] == null ? price : ema21[ema21.length - 1];
  const cEma50 = ema50[ema50.length - 1] == null ? price : ema50[ema50.length - 1];
  const atr = atrArr[atrArr.length - 1] == null ? 5 : atrArr[atrArr.length - 1];

  let classicScore = 0;
  classicScore += price > cEma50 ? 1 : -1;
  classicScore += cEma9 > cEma21 ? 1 : -1;
  classicScore = classicScore / 2;

  const freshBullOB = obs.filter(o => o.dir === 'bullish' && !o.mitigated).slice(-1)[0];
  const freshBearOB = obs.filter(o => o.dir === 'bearish' && !o.mitigated).slice(-1)[0];
  let obScore = 0;
  if (freshBullOB && price >= freshBullOB.low && price <= freshBullOB.high) obScore = 1;
  else if (freshBearOB && price >= freshBearOB.low && price <= freshBearOB.high) obScore = -1;

  const freshBullFVG = fvgs.filter(f => f.dir === 'bullish' && !f.mitigated).slice(-1)[0];
  const freshBearFVG = fvgs.filter(f => f.dir === 'bearish' && !f.mitigated).slice(-1)[0];
  let fvgScore = 0;
  if (freshBullFVG && price >= freshBullFVG.low && price <= freshBullFVG.high) fvgScore = 1;
  else if (freshBearFVG && price >= freshBearFVG.low && price <= freshBearFVG.high) fvgScore = -1;

  let liqScore = sweep ? (sweep.dir === 'bullish' ? 1 : -1) : 0;
  let pdScore = pd ? (pd.zone === 'discount' ? 1 : -1) : 0;
  const pa = detectPriceAction(ltf);

  const factors = { weekly: biasScore(structWeekly.trend), daily: biasScore(structDaily.trend), htf: biasScore(structHtf.trend), mtf: biasScore(structMtf.trend), ltf: biasScore(structLtf.trend), ob: obScore, fvg: fvgScore, liquidity: liqScore, premiumDiscount: pdScore, priceAction: pa.score, classic: classicScore, correlation: corrScore || 0, fundamental: fundScore || 0, newsSentiment: newsScore || 0 };
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  let score = 0;
  for (const k in factors) score += factors[k] * (weights[k] || 0);
  score = score / totalWeight;

  const confidence = Math.min(100, Math.round(Math.abs(score) * 100));
  let direction = 'HOLD';
  if (score > 0.15) direction = 'BUY'; else if (score < -0.15) direction = 'SELL';

  const sessionInfo = getSessionInfo(ltf[ltf.length - 1].time);
  const sessionStats = computeSessionStats(ltf);
  const regimeInfo = detectMarketRegime(swingsLtf, atrArr);
  const histSim = historicalSimilarity(ltf, ltf.length - 1, 10, 20);
  const fusion = decisionFusion(direction, confidence, factors, sessionInfo, regimeInfo, histSim);

  return { direction, confidence, score, factors, weights, totalWeight, price, atr, atrArr, rsiArr: rsi, curRsi, cEma9, cEma21, cEma50, ltf, swingsLtf, structLtf, structMtf, structHtf, structDaily, structWeekly, obs, fvgs, liquidity, roundNumbers, sweep, pd, priceAction: pa, sessionInfo, sessionStats, regimeInfo, histSim, fusion, mtfIsReal, htfIsReal, dailyIsReal, weeklyIsReal };
}
export const PIP_SIZE = 0.1; // XAUUSD standard MT4/5 convention (2-decimal quoting) — confirm against your own broker's spec, some quote 3 decimals (pip = 0.01)
// ============================================================
// META-LABELING: QUALITY FEATURES + SECOND-OPINION DIVERGENCE
// ============================================================
// Reframes the learning problem from "what is valid SMC" (intractable, no clean labels) to "given a
// candidate OB/FVG the generator already flagged, will trading it actually work" (tractable — every
// resolved trade is a clean win/loss label). These functions compute the evidence; the AdaBoost stump
// ensemble further down turns that evidence into a trained quality score, retrained each backtest cycle.

// Was there a genuine liquidity sweep near the bar that created this candidate, vs random consolidation?
export function hadSweepNear(data, liquidity, eventIndex, lookback) {
  lookback = lookback || 3;
  const start = Math.max(0, eventIndex - lookback);
  for (let i = start; i <= eventIndex; i++) {
    const c = data[i];
    for (const lv of liquidity.buySideLiquidity) { if (c.high > lv.price && c.close < lv.price) return 1; }
    for (const lv of liquidity.sellSideLiquidity) { if (c.low < lv.price && c.close > lv.price) return 1; }
  }
  return 0;
}
// ATR-normalized size of the impulsive move away from the candidate toward the structural break that created it.
export function displacementQuality(data, atrArr, candidateIndex, eventIndex) {
  const a = atrArr[eventIndex] || atrArr[atrArr.length - 1] || 1;
  if (!a || eventIndex <= candidateIndex) return 0.3;
  const move = Math.abs(data[eventIndex].close - data[candidateIndex].close);
  return Math.max(0, Math.min(1, (move / a) / 4)); // 4x ATR displacement or more maxes out the score
}
// Fresher, untested candidates score higher than ones sitting untouched for a long time (context decays).
export function freshnessScore(candidateIndex, currentIndex, maxBars) {
  maxBars = maxBars || 60;
  const barsAgo = Math.max(0, currentIndex - candidateIndex);
  return Math.max(0, 1 - barsAgo / maxBars);
}
// Does the candidate agree with HTF trend direction and sit in the HTF-consistent premium/discount zone?
// Genuine top-down alignment, not just a single "HTF" — checks weekly, daily, and 4H trend together against
// the LTF premium/discount zone, so a candidate only scores well when the whole hierarchy actually agrees.
export function htfAlignmentScore(direction, structHtf, pd, structWeekly, structDaily) {
  const wantBullish = direction === 'BUY';
  const wantTrend = wantBullish ? 'bullish' : 'bearish';
  const trendChecks = [structHtf && structHtf.trend, structDaily && structDaily.trend, structWeekly && structWeekly.trend].filter(t => t != null);
  const trendMatch = trendChecks.length ? trendChecks.filter(t => t === wantTrend).length / trendChecks.length : 0.5;
  const zoneMatch = pd ? (pd.zone === (wantBullish ? 'discount' : 'premium') ? 1 : 0) : 0.5;
  return (trendMatch + zoneMatch) / 2;
}
// Does the candidate sit near a liquidity pool (area of real interest) rather than dead space?
export function liquidityContextScore(price, liquidity, atr) {
  const tolerance = (atr || 1) * 1.5;
  const pools = [...liquidity.buySideLiquidity, ...liquidity.sellSideLiquidity];
  if (!pools.length) return 0;
  const nearest = Math.min(...pools.map(p => Math.abs(p.price - price)));
  return nearest <= tolerance ? Math.max(0, 1 - nearest / tolerance) : 0;
}
// Session/regime context — London/NY carry more genuine liquidity than Asian; trending regimes favor continuation.
export function sessionRegimeQuality(sessionInfo, regimeInfo) {
  const sessionQuality = (sessionInfo.session === 'London' || sessionInfo.session === 'London-NY Overlap' || sessionInfo.session === 'New York') ? 1 : 0.3;
  const regimeQuality = regimeInfo.regime.indexOf('Trending') === 0 ? 1 : regimeInfo.regime.indexOf('Ranging') === 0 ? 0.2 : 0.5;
  return (sessionQuality + regimeQuality) / 2;
}
// Second-opinion, non-SMC-derived: classical RSI divergence against the last two swing pivots, scored
// relative to the candidate's direction — a confidence vote for the meta-labeler, not a separate signal generator.
export function momentumDivergenceScore(swingsLtf, rsiArr, direction) {
  const highs = swingsLtf.filter(s => s.type === 'high').slice(-2);
  const lows = swingsLtf.filter(s => s.type === 'low').slice(-2);
  let bullishDiv = false, bearishDiv = false;
  if (lows.length === 2) {
    const [a, b] = lows;
    const rsiA = rsiArr[a.index], rsiB = rsiArr[b.index];
    if (rsiA != null && rsiB != null && b.price < a.price && rsiB > rsiA) bullishDiv = true;
  }
  if (highs.length === 2) {
    const [a, b] = highs;
    const rsiA = rsiArr[a.index], rsiB = rsiArr[b.index];
    if (rsiA != null && rsiB != null && b.price > a.price && rsiB < rsiA) bearishDiv = true;
  }
  if (direction === 'BUY') return bullishDiv ? 1 : (bearishDiv ? 0 : 0.5);
  if (direction === 'SELL') return bearishDiv ? 1 : (bullishDiv ? 0 : 0.5);
  return 0.5;
}
// Builds the full feature vector the meta-labeler trains and scores on. Falls back to neutral (0.5) values
// for zone-specific features when there's no OB/FVG driving entry (a market-order signal) — HTF alignment,
// session/regime, and divergence still apply regardless of entry type.
export function buildQualityFeatures(result, zone, entryIndex, direction, ltfLen) {
  const hasZone = !!zone;
  return [
    hasZone ? hadSweepNear(result.ltf, result.liquidity, zone.eventIndex != null ? zone.eventIndex : zone.index, 3) : 0.3,
    hasZone ? displacementQuality(result.ltf, result.atrArr, zone.index, zone.eventIndex != null ? zone.eventIndex : zone.index) : 0.3,
    hasZone ? freshnessScore(zone.index, ltfLen - 1) : 0.3,
    htfAlignmentScore(direction, result.structHtf, result.pd, result.structWeekly, result.structDaily),
    hasZone ? liquidityContextScore((zone.high + zone.low) / 2, result.liquidity, result.atr) : 0.3,
    sessionRegimeQuality(result.sessionInfo, result.regimeInfo),
    momentumDivergenceScore(result.swingsLtf, result.rsiArr, direction)
  ];
}
export const QUALITY_FEATURE_NAMES = ['Origin strength (sweep)', 'Displacement quality', 'Freshness', 'HTF alignment', 'Liquidity context', 'Session/regime', 'Momentum divergence'];

// Classifies ANY displayed OB/FVG — not just the one chosen for trade entry — into Active/Dead (same 4x ATR
// realistic-distance rule used for entry selection) and Strong/Moderate/Weak (same quality features the
// meta-labeler trains on). This is what actually differentiates a dead zone from a live one in the UI,
// rather than just "unmitigated" — a zone can be technically untested and still be stale and unreachable.
export function classifyZone(zone, dir, result) {
  const price = result.price, atr = result.atr;
  const zoneMid = (zone.high + zone.low) / 2;
  const distance = Math.abs(price - zoneMid);
  const isActive = distance <= atr * 4;
  const evtIdx = zone.eventIndex != null ? zone.eventIndex : zone.index;
  const features = [
    hadSweepNear(result.ltf, result.liquidity, evtIdx, 3),
    displacementQuality(result.ltf, result.atrArr, zone.index, evtIdx),
    freshnessScore(zone.index, result.ltf.length - 1),
    htfAlignmentScore(dir, result.structHtf, result.pd, result.structWeekly, result.structDaily),
    liquidityContextScore(zoneMid, result.liquidity, atr),
    sessionRegimeQuality(result.sessionInfo, result.regimeInfo),
    momentumDivergenceScore(result.swingsLtf, result.rsiArr, dir)
  ];
  const avgScore = features.reduce((s, v) => s + v, 0) / features.length;
  const metaScore = scoreAdaBoost(_metaModel, features);
  const strength = avgScore >= 0.6 ? 'Strong' : avgScore >= 0.4 ? 'Moderate' : 'Weak';
  return { isActive, strength, avgScore, metaScore, distance };
}

// ============================================================
// META-LABELER MODEL: AdaBoost with decision stumps
// ============================================================
// Real gradient-boosted trees have no practical home in a client-side app with no training backend and only
// a few hundred labeled trades at most — deep trees would overfit badly on that little data anyway. Boosted
// decision stumps are a legitimate member of the same boosting family, hand-rollable in plain JS, and a
// better match for this data volume. Each stump thresholds one quality feature; the ensemble vote (weighted
// by how much each stump reduced error) becomes the meta score. Retrained each auto-backtest cycle on
// out-of-sample trade outcomes plus resolved live signals — see runBacktestCycle and markSignalResult.
export function trainAdaBoostStumps(examples, numStumps) {
  numStumps = numStumps || 20;
  const n = examples.length;
  if (n < 15) return null; // not enough labeled trades yet to train anything meaningful
  let weights = new Array(n).fill(1 / n);
  const stumps = [];
  const numFeatures = examples[0].features.length;
  for (let t = 0; t < numStumps; t++) {
    let best = null;
    for (let f = 0; f < numFeatures; f++) {
      const values = Array.from(new Set(examples.map(e => e.features[f]))).sort((a, b) => a - b);
      for (const thresh of values) {
        for (const polarity of [1, -1]) {
          let err = 0;
          for (let i = 0; i < n; i++) {
            const pred = (examples[i].features[f] >= thresh ? 1 : -1) * polarity;
            if (pred !== examples[i].label) err += weights[i];
          }
          if (!best || err < best.err) best = { f, thresh, polarity, err };
        }
      }
    }
    if (!best || best.err >= 0.5) break; // no stump beats random guessing — stop early rather than force noise in
    const err = Math.max(best.err, 1e-6);
    const alpha = 0.5 * Math.log((1 - err) / err);
    stumps.push({ feature: best.f, threshold: best.thresh, polarity: best.polarity, alpha });
    let sumW = 0;
    for (let i = 0; i < n; i++) {
      const pred = (examples[i].features[best.f] >= best.thresh ? 1 : -1) * best.polarity;
      weights[i] *= Math.exp(-alpha * examples[i].label * pred);
      sumW += weights[i];
    }
    for (let i = 0; i < n; i++) weights[i] /= sumW;
  }
  return stumps.length ? stumps : null;
}
// Returns a score roughly in [-1, 1]: positive means the ensemble thinks this candidate looks like past winners.
export function scoreAdaBoost(stumps, features) {
  if (!stumps || !stumps.length || !features) return 0;
  let sum = 0, totalAlpha = 0;
  stumps.forEach(s => {
    const pred = (features[s.feature] >= s.threshold ? 1 : -1) * s.polarity;
    sum += s.alpha * pred;
    totalAlpha += s.alpha;
  });
  return totalAlpha > 0 ? Math.max(-1, Math.min(1, sum / totalAlpha)) : 0;
}

export function buildTradePlan(result, targetRR) {
  targetRR = targetRR || 4;
  const minRR = 3, maxRR = 5;
  const { direction, price, atr } = result;

  if (direction === 'HOLD') {
    const sl = price - atr, tp = price + atr;
    return { entry: price, sl, tp, rr: 1, entryType: 'market', slPips: Math.abs(price - sl) / PIP_SIZE, tpPips: Math.abs(tp - price) / PIP_SIZE };
  }

  let entry, sl, entryType;
  const minStop = atr * 1.0; // floor so stops aren't unrealistically tight on quiet bars

  if (direction === 'BUY') {
    const freshBullOB = result.obs.filter(o => o.dir === 'bullish' && !o.mitigated).slice(-1)[0];
    const freshBullFVG = result.fvgs.filter(f => f.dir === 'bullish' && !f.mitigated).slice(-1)[0];
    // Bound to a realistic distance from current price (4x ATR) — an unmitigated zone can be genuinely
    // untouched because price trended away from it weeks ago, not because it's still a live setup. Without
    // this bound the system would happily propose a limit order dozens of points from the market.
    const maxZoneDist = atr * 4;
    const zones = [freshBullOB, freshBullFVG].filter(z => z && z.high < price && (price - z.high) <= maxZoneDist);
    let zone = null;
    if (zones.length) { zone = zones.sort((a, b) => b.high - a.high)[0]; entry = zone.high; entryType = 'limit — retrace into ' + (zone === freshBullOB ? 'order block' : 'FVG'); }
    else { entry = price; entryType = 'market'; }

    const swingLows = result.swingsLtf.filter(s => s.type === 'low');
    const structLow = swingLows.length ? swingLows[swingLows.length - 1].price : entry - atr * 1.5;
    sl = Math.min(structLow - atr * 0.15, entry - minStop);

    const risk = entry - sl;
    const targets = result.liquidity.buySideLiquidity.filter(l => l.price > entry).sort((a, b) => a.price - b.price);
    const match = targets.find(l => { const rr = (l.price - entry) / risk; return rr >= minRR && rr <= maxRR; });
    const tp = match ? match.price : entry + risk * targetRR;
    const reward = tp - entry;
    const qualityFeatures = buildQualityFeatures(result, zone, result.ltf.length - 1, 'BUY', result.ltf.length);
    const metaScore = scoreAdaBoost(_metaModel, qualityFeatures);
    return { entry, sl, tp, rr: risk > 0 ? +(reward / risk).toFixed(2) : 0, entryType, slPips: risk / PIP_SIZE, tpPips: reward / PIP_SIZE, qualityFeatures, metaScore };
  } else {
    const freshBearOB = result.obs.filter(o => o.dir === 'bearish' && !o.mitigated).slice(-1)[0];
    const freshBearFVG = result.fvgs.filter(f => f.dir === 'bearish' && !f.mitigated).slice(-1)[0];
    const maxZoneDist = atr * 4;
    const zones = [freshBearOB, freshBearFVG].filter(z => z && z.low > price && (z.low - price) <= maxZoneDist);
    let zone = null;
    if (zones.length) { zone = zones.sort((a, b) => a.low - b.low)[0]; entry = zone.low; entryType = 'limit — retrace into ' + (zone === freshBearOB ? 'order block' : 'FVG'); }
    else { entry = price; entryType = 'market'; }

    const swingHighs = result.swingsLtf.filter(s => s.type === 'high');
    const structHigh = swingHighs.length ? swingHighs[swingHighs.length - 1].price : entry + atr * 1.5;
    sl = Math.max(structHigh + atr * 0.15, entry + minStop);

    const risk = sl - entry;
    const targets = result.liquidity.sellSideLiquidity.filter(l => l.price < entry).sort((a, b) => b.price - a.price);
    const match = targets.find(l => { const rr = (entry - l.price) / risk; return rr >= minRR && rr <= maxRR; });
    const tp = match ? match.price : entry - risk * targetRR;
    const reward = entry - tp;
    const qualityFeatures = buildQualityFeatures(result, zone, result.ltf.length - 1, 'SELL', result.ltf.length);
    const metaScore = scoreAdaBoost(_metaModel, qualityFeatures);
    return { entry, sl, tp, rr: risk > 0 ? +(reward / risk).toFixed(2) : 0, entryType, slPips: risk / PIP_SIZE, tpPips: reward / PIP_SIZE, qualityFeatures, metaScore };
  }
}
export function reasoningText(result, plan) {
  const parts = [];
  if (result.factors.weekly) parts.push('weekly structure is ' + (result.factors.weekly > 0 ? 'bullish' : 'bearish'));
  if (result.factors.daily) parts.push('daily structure is ' + (result.factors.daily > 0 ? 'bullish' : 'bearish'));
  if (result.factors.htf) parts.push('4H structure is ' + (result.factors.htf > 0 ? 'bullish' : 'bearish'));
  if (result.factors.mtf) parts.push('1H structure is ' + (result.factors.mtf > 0 ? 'bullish' : 'bearish'));
  if (result.factors.ltf) parts.push('15min structure is ' + (result.factors.ltf > 0 ? 'bullish' : 'bearish'));
  if (result.factors.ob) parts.push('price sits inside a fresh ' + (result.factors.ob > 0 ? 'bullish' : 'bearish') + ' order block');
  if (result.factors.fvg) parts.push('price sits inside an unfilled ' + (result.factors.fvg > 0 ? 'bullish' : 'bearish') + ' FVG');
  if (result.factors.liquidity) parts.push(result.sweep ? result.sweep.note : 'a liquidity sweep was detected');
  if (result.factors.premiumDiscount) parts.push('price is trading in a ' + (result.pd ? result.pd.zone : '') + ' zone');
  if (result.priceAction && result.priceAction.pattern) parts.push('price action shows a ' + result.priceAction.pattern.toLowerCase());
  if (result.factors.correlation) parts.push('cross-market correlation leans ' + (result.factors.correlation > 0 ? 'bullish' : 'bearish') + ' for gold');
  if (result.factors.fundamental) parts.push('macro fundamentals lean ' + (result.factors.fundamental > 0 ? 'bullish' : 'bearish') + ' for gold');
  if (result.factors.newsSentiment) parts.push('news sentiment leans ' + (result.factors.newsSentiment > 0 ? 'bullish' : 'bearish') + ' for gold');
  let text = parts.length ? parts.join('; ') + '.' : 'No strong confluence across timeframes right now.';
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (result.direction === 'HOLD') {
    text += ' Not enough weighted confluence to size a trade — waiting for alignment.';
  } else {
    const entryNote = plan.entryType === 'market' ? 'Entering at market since price is already inside the zone.' : 'Entry is a ' + plan.entryType + ' — wait for price to tag that level rather than chasing.';
    text += ' Stop placed beyond the nearest structure point (' + plan.slPips.toFixed(0) + ' pips risk), target at ' + (plan.rr >= 3 ? 'a liquidity pool' : 'a fixed extension') + ' giving ' + plan.rr.toFixed(2) + ':1 (' + plan.tpPips.toFixed(0) + ' pips). ' + entryNote;
    const contradicting = result.direction === 'BUY' ? result.fusion.theses.bear : result.fusion.theses.bull;
    text += ' Invalidation: a close beyond $' + fmt(plan.sl) + ' invalidates this read.';
    text += contradicting.length ? ' Working against it: ' + contradicting.join(', ') + '.' : ' No factors are currently contradicting this direction.';
    if (result.histSim) text += ' Similar past setups: ' + result.histSim.bullishPct + '% bullish / ' + result.histSim.bearishPct + '% bearish outcomes.';
  }
  return text;
}


// ============================================================
// FACTOR TAXONOMY / LEARNING PRIMITIVES
// ============================================================
export const FACTOR_LABELS = { weekly: 'Weekly Trend', daily: 'Daily Trend', htf: 'HTF Trend (4H)', mtf: 'MTF Trend (1H)', ltf: 'LTF Structure (15m)', ob: 'Order Block', fvg: 'Fair Value Gap', liquidity: 'Liquidity Sweep', premiumDiscount: 'Premium/Discount', priceAction: 'Price Action', classic: 'Classic (EMA/RSI)', correlation: 'Cross-Market Correlation', fundamental: 'Fundamental (Macro)', newsSentiment: 'News Sentiment' };
export function patternSignature(dir, factors) {
  const dirSign = dir === 'BUY' ? 1 : -1;
  return Object.keys(FACTOR_LABELS).filter(k => factors[k] && Math.sign(factors[k]) === dirSign).sort().join('+') || 'none';
}

export function computeTunedWeights(trades, baseWeights) {
  const stats = {}; Object.keys(FACTOR_LABELS).forEach(k => stats[k] = { votes: 0, wins: 0 });
  trades.forEach(t => {
    const dirSign = t.dir === 'BUY' ? 1 : -1;
    Object.keys(FACTOR_LABELS).forEach(k => {
      const v = t.factors[k];
      if (v && Math.sign(v) === dirSign) { stats[k].votes++; if (t.result === 'win') stats[k].wins++; }
    });
  });
  const tuned = Object.assign({}, baseWeights);
  Object.keys(FACTOR_LABELS).forEach(k => {
    if (stats[k].votes >= 5) tuned[k] = Math.max(2, Math.min(30, Math.round((stats[k].wins / stats[k].votes) * 100 * 0.4)));
  });
  return { tuned, stats };
}
// ============================================================
// BACKTEST
// ============================================================
export function runSmcBacktest(ltfFull, params, weights, targetRR, costPips) {
  costPips = costPips || 0;
  let equity = params.capital, peak = equity, maxDD = 0;
  let equityCurve = [{ i: 0, equity }], trades = [], openTrade = null;
  for (let i = 100; i < ltfFull.length; i++) {
    const d = ltfFull[i];
    if (openTrade) {
      let exitPrice = null, result = null;
      if (openTrade.dir === 'BUY') {
        if (d.low <= openTrade.sl) { exitPrice = openTrade.sl; result = 'loss'; }
        else if (d.high >= openTrade.tp) { exitPrice = openTrade.tp; result = 'win'; }
      } else {
        if (d.high >= openTrade.sl) { exitPrice = openTrade.sl; result = 'loss'; }
        else if (d.low <= openTrade.tp) { exitPrice = openTrade.tp; result = 'win'; }
      }
      if (exitPrice != null) {
        const grossPnl = openTrade.dir === 'BUY' ? (exitPrice - openTrade.entry) * openTrade.size : (openTrade.entry - exitPrice) * openTrade.size;
        const cost = costPips * PIP_SIZE * openTrade.size; // round-turn spread/slippage estimate
        const pnl = grossPnl - cost;
        equity += pnl; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak * 100);
        trades.push({ dir: openTrade.dir, entry: openTrade.entry, exit: exitPrice, pnl, result, confidence: openTrade.confidence, factors: openTrade.factors, entryIndex: openTrade.entryIndex, qualityFeatures: openTrade.qualityFeatures });
        equityCurve.push({ i, equity }); openTrade = null;
      }
      continue;
    }
    const sig = computeComposite(ltfFull, i, weights);
    if (!sig) continue;
    if (sig.direction !== 'HOLD' && sig.confidence >= params.minConfidence) {
      const plan = buildTradePlan(sig, targetRR);
      const riskAmt = equity * (params.riskPct / 100);
      const slDist = Math.abs(plan.entry - plan.sl);
      if (slDist <= 0) continue;
      const size = riskAmt / slDist;
      openTrade = { dir: sig.direction, entry: plan.entry, sl: plan.sl, tp: plan.tp, size, confidence: sig.confidence, factors: sig.factors, entryIndex: i, qualityFeatures: plan.qualityFeatures };
    }
  }
  return { trades, equityCurve, finalEquity: equity, maxDD };
}

// ============================================================
// AUTONOMOUS OPERATION PRIMITIVES
// ------------------------------------------------------------
// These close the learning loop without a human in it. Until now a live signal
// only became training data when someone clicked win/loss in the journal, so an
// unattended session learned nothing from its own live calls. resolveSignal()
// replays a signal against the candles that came after it and decides the
// outcome from price alone, and autonomyGate() decides which setups are worth
// committing to in the first place.
//
// Both are pure and shared with the server worker, so a signal resolves to the
// same verdict whether the browser or the cron job gets to it first.
// ============================================================

// Grade is itself derived from confidence (A>=70, B>=50, C>=30) and then
// downgraded again for a ranging market or disagreeing history. So a grade floor
// and a confidence floor are not independent controls — setting confidence to 45
// while demanding grade B does nothing, because 45 grades as C and is rejected on
// grade regardless. gradeFloor is the honest knob; minConfidence only bites when
// it is set ABOVE the floor's implied confidence.
export const GRADE_ORDER = ['A+', 'A', 'B', 'C', 'D'];
export function gradesAtOrAbove(floor) {
  const i = GRADE_ORDER.indexOf(floor);
  return i === -1 ? GRADE_ORDER.slice(0, 3) : GRADE_ORDER.slice(0, i + 1);
}

// Partial take-profit. A full 1:4 target on 15-minute structure can sit open for
// days, and an unrealised target is not a profit — the trade is exposed the whole
// time it waits. Banking at the halfway mark converts more setups into closed
// outcomes, which is also what feeds the learning loop.
//
// The exception is conviction: when the setup's own analysis says it looks like
// past winners, let it run to the full target instead of clipping the trades
// most likely to pay for the losers.
export const PARTIAL_TP_DEFAULTS = {
  enabled: true,
  fraction: 0.5,            // bank at 50% of the distance from entry to target
  holdIfMetaScore: 0.35,    // meta-labeler conviction that earns a full run
  holdIfGrades: ['A+', 'A']
};

// Price at `fraction` of the way from entry to target. The signed (tp - entry)
// makes this work unchanged for a SELL, where the target sits below entry.
export function partialTakeProfitLevel(signal, fraction) {
  if (!signal || !isFinite(signal.entry) || !isFinite(signal.tp)) return null;
  const f = isFinite(fraction) ? fraction : PARTIAL_TP_DEFAULTS.fraction;
  if (!(f > 0 && f < 1)) return null;
  return signal.entry + (signal.tp - signal.entry) * f;
}

// Does this setup's own analysis justify holding for the full target?
export function shouldHoldForFullTarget(signal, cfg) {
  cfg = Object.assign({}, PARTIAL_TP_DEFAULTS, cfg || {});
  if (!cfg.enabled) return true;               // partial taking switched off entirely
  if (signal && (cfg.holdIfGrades || []).indexOf(signal.grade) !== -1) return true;
  const meta = signal && signal.metaScore;
  return isFinite(meta) && meta >= cfg.holdIfMetaScore;
}

// How far behind the wall clock the newest candle has to be before resolveSignal
// concludes it is replaying history rather than watching a live market. A week:
// no live feed is ever that stale, no weekend or outage comes close, and any
// backtest is far past it.
export const REPLAY_DETECT_HOURS = 168;

export const AUTONOMY_DEFAULTS = {
  minConfidence: 45,     // below this the engine is guessing; don't commit a signal
  minMetaScore: -0.25,   // meta-labeler veto: strongly negative quality reads are skipped
  gradeFloor: 'B',
  allowedGrades: ['A+', 'A', 'B'],
  cooldownMinutes: 60,   // don't stack signals bar after bar off the same structure
  maxOpenSignals: 3,
  maxBarsToFill: 32,     // a limit entry that hasn't been tagged in ~8h (15min bars) is stale
  maxBarsOpen: 192,      // ~2 days on 15min bars; after that call it a scratch, not a win/loss
  // ---- kill switch for stale orders (wall clock, not bars) ----------------
  // Bar counting alone cannot expire anything when no new bars arrive. Gold is
  // closed all weekend, a provider can stall, a quota can run out — and in each
  // case a resting order sat untouched and was still treated as live. Elapsed
  // real time is checked independently of whether any candle showed up.
  maxHoursToFill: 12,    // a resting order older than this is cancelled outright
  maxHoursOpen: 72,      // a filled position running this long is scratched, not graded
  // The setup, not just the clock. If price travelled this far from the entry
  // (in multiples of the stop distance) without ever tagging it, the move the
  // order was positioned for has already happened. Price coming back now is a
  // RETEST of a zone that already did its work, not the setup that was
  // analysed — filling it there feeds the learning loop a trade the system
  // would never actually have taken.
  maxDriftRToFill: 1.5,
  analysisIntervalMinutes: 15,
  backtestIntervalHours: 4,
  partialTP: PARTIAL_TP_DEFAULTS
};

// Walk `candles` forward from a signal and decide what actually happened to it.
// Returns one of:
//   pending  — not filled yet, still inside its fill window
//   open     — filled, neither stop nor target touched yet
//   won/lost — target or stop reached
//   expired  — killed rather than graded. Four ways: never filled within
//              maxBarsToFill or maxHoursToFill, price drifted maxDriftRToFill
//              away from the entry without tagging it, or the position ran past
//              maxBarsOpen / maxHoursOpen unresolved.
//
// An expired signal is deliberately NOT training data. It has no outcome to
// learn from, and inventing one — grading a stale order that finally filled on
// a retest days later — is how a self-learning system quietly poisons itself.
//
// `cfg.now` overrides the wall clock, for tests and for replaying history.
// When a single candle's range covers both the stop and the target we can't know
// from OHLC alone which came first, so we assume the stop. That biases the
// learning data pessimistically, which is the right way to be wrong here: it
// makes the meta-labeler sceptical of setups that need a coin-flip to win.
export function resolveSignal(signal, candles, cfg) {
  cfg = Object.assign({}, AUTONOMY_DEFAULTS, cfg || {});
  if (!signal || signal.dir !== 'BUY' && signal.dir !== 'SELL') return { status: 'expired', reason: 'not a directional signal' };

  const isBuy = signal.dir === 'BUY';
  const signalTime = typeof signal.time === 'string' ? Date.parse(signal.time) : signal.time;
  const HOUR = 3600000;
  const startedMarket = signal.entryType === 'market';

  // What "now" means depends on whether this is live or a replay.
  //
  // Live, the wall clock is the only honest answer: gold is shut all weekend
  // and a provider can stall, and in both cases no new bar arrives while real
  // time keeps passing — which is exactly when an order goes stale unnoticed.
  //
  // Replaying history (a backtest, or grading old signals against an archive)
  // the wall clock is meaningless: every signal would expire because the data
  // is from the past. There the newest candle IS now.
  //
  // The two are told apart by how far behind the data is. A week is far beyond
  // any weekend or outage a live feed can produce, and far short of any replay.
  // Callers that know better pass cfg.now and skip the guess entirely.
  const latestCandle = candles && candles.length ? candles[candles.length - 1].time : null;
  const wallNow = Date.now();
  const replaying = latestCandle != null && (wallNow - latestCandle) > REPLAY_DETECT_HOURS * HOUR;
  const nowMs = isFinite(cfg.now) ? cfg.now : (replaying ? latestCandle : wallNow);

  // ---- kill switch, checked BEFORE any candle is looked at ----------------
  // This has to run first and independently of the data. The old expiry was a
  // bar count evaluated inside the candle loop, so an order that saw no new
  // bars at all — the whole weekend, a stalled provider, a spent quota — was
  // never even considered for expiry and stayed "resting" indefinitely.
  // A signal with no usable timestamp cannot be aged. Bar rules still apply to
  // it; the clock does not, because "1970" is missing data, not an old order.
  const timeIsUsable = isFinite(signalTime) && signalTime > 0;
  const ageHours = timeIsUsable ? (nowMs - signalTime) / HOUR : 0;
  if (timeIsUsable && !startedMarket && !signal.filledAt && cfg.maxHoursToFill > 0 && ageHours >= cfg.maxHoursToFill) {
    return { status: 'expired', reason: 'resting order cancelled after ' + Math.round(ageHours) +
      'h without filling (limit ' + cfg.maxHoursToFill + 'h)', killSwitch: 'stale-order', ageHours };
  }
  const filledAtMs = signal.filledAt ? Date.parse(signal.filledAt) : (startedMarket && timeIsUsable ? signalTime : null);
  if (filledAtMs > 0 && cfg.maxHoursOpen > 0 && (nowMs - filledAtMs) / HOUR >= cfg.maxHoursOpen) {
    return { status: 'expired', reason: 'position scratched after ' + Math.round((nowMs - filledAtMs) / HOUR) +
      'h open without resolving (limit ' + cfg.maxHoursOpen + 'h)', killSwitch: 'stale-position',
      ageHours: (nowMs - filledAtMs) / HOUR };
  }

  const after = candles.filter(c => c.time > signalTime);
  // With nothing new to look at, report what the signal already is. A limit
  // that has a recorded fill is open, not pending — saying otherwise would have
  // this function contradict the record it was handed.
  if (!after.length) {
    return (startedMarket || signal.filledAt)
      ? { status: 'open', barsSeen: 0 }
      : { status: 'pending', barsSeen: 0 };
  }

  let filled = startedMarket;
  let fillIndex = filled ? 0 : -1;
  // Distance to the stop is the trade's unit of risk, and the yardstick for
  // deciding the entry zone has been left behind.
  const riskDistance = Math.abs(signal.entry - signal.sl);
  // A limit entry is placed away from price by design — "retrace into the order
  // block" starts life some distance below the market. Measuring drift from the
  // entry alone would therefore cancel almost every limit on its first bar. What
  // matters is how much FURTHER price ran after the order was placed, so the
  // opening gap is the baseline and only movement beyond it counts.
  const driftOf = (c) => isBuy ? (c.high - signal.entry) : (signal.entry - c.low);
  const baselineDrift = filled ? 0 : Math.max(0, driftOf(after[0]));

  const partialCfg = Object.assign({}, PARTIAL_TP_DEFAULTS, cfg.partialTP || {});
  const takePartial = partialCfg.enabled && !shouldHoldForFullTarget(signal, partialCfg);
  const partialLevel = takePartial ? partialTakeProfitLevel(signal, partialCfg.fraction) : null;

  for (let i = 0; i < after.length; i++) {
    const c = after[i];
    if (!filled) {
      // A limit entry fills when price trades through the level.
      if (c.low <= signal.entry && c.high >= signal.entry) { filled = true; fillIndex = i; }
      else {
        // The move happened without us. Price ran this far past the entry in
        // the trade's own direction and never came back to tag it, so the
        // structure the order was placed against has already been spent. A
        // return to that level now is a retest, and filling it there would
        // record a trade the analysis never actually called.
        const extraDrift = driftOf(c) - baselineDrift;
        if (riskDistance > 0 && cfg.maxDriftRToFill > 0 && extraDrift >= cfg.maxDriftRToFill * riskDistance) {
          return { status: 'expired', killSwitch: 'zone-left-behind', barsSeen: i + 1, resolvedAt: c.time,
            reason: 'price ran a further ' + (extraDrift / riskDistance).toFixed(1) + 'R away from the entry without ' +
              'filling — a return to that level now is a retest, not this setup' };
        }
        if (i + 1 >= cfg.maxBarsToFill) {
          return { status: 'expired', reason: 'entry never filled within ' + cfg.maxBarsToFill + ' bars',
            killSwitch: 'stale-order', barsSeen: i + 1 };
        }
        continue;
      }
    }
    const hitStop = isBuy ? c.low <= signal.sl : c.high >= signal.sl;
    const hitTarget = isBuy ? c.high >= signal.tp : c.low <= signal.tp;

    // A partial exit sits nearer than the full target, so it is tested first —
    // otherwise a bar that spans both would always report the further one.
    const hitPartial = takePartial && partialLevel != null &&
      (isBuy ? c.high >= partialLevel : c.low <= partialLevel);

    if (hitStop && (hitTarget || hitPartial)) {
      return { status: 'lost', exitPrice: signal.sl, ambiguousBar: true, resolvedAt: c.time, barsHeld: i - fillIndex + 1 };
    }
    if (hitStop) return { status: 'lost', exitPrice: signal.sl, resolvedAt: c.time, barsHeld: i - fillIndex + 1 };
    // Partial before full target, even when one bar spans both: price has to
    // travel through the nearer level to reach the further one, so a resting
    // partial order is already filled by then. Booking the full target here
    // would credit reward that a real partial exit would never have collected.
    if (hitPartial) {
      return { status: 'won', exitPrice: partialLevel, partial: true, resolvedAt: c.time, barsHeld: i - fillIndex + 1 };
    }
    if (hitTarget) return { status: 'won', exitPrice: signal.tp, resolvedAt: c.time, barsHeld: i - fillIndex + 1 };
    if (i - fillIndex + 1 >= cfg.maxBarsOpen) {
      return { status: 'expired', reason: 'held past ' + cfg.maxBarsOpen + ' bars without resolving',
        killSwitch: 'stale-position', resolvedAt: c.time, barsHeld: i - fillIndex + 1 };
    }
  }
  return filled
    ? { status: 'open', barsHeld: after.length - fillIndex, filledAt: after[fillIndex].time }
    : { status: 'pending', barsSeen: after.length };
}

// Decide whether an analysis result is worth committing as an unattended signal.
// Returns { take: boolean, reason: string } — reason is surfaced in the UI so the
// user can see why the engine chose to sit on its hands, which matters a lot when
// nobody is watching it work.
export function autonomyGate(result, plan, openSignals, lastSignalTime, cfg) {
  cfg = Object.assign({}, AUTONOMY_DEFAULTS, cfg || {});
  if (!result || result.direction === 'HOLD') return { take: false, code: 'hold', reason: 'no directional edge — engine is flat' };
  if (!plan || !isFinite(plan.entry) || !isFinite(plan.sl) || !isFinite(plan.tp)) return { take: false, code: 'noplan', reason: 'no valid trade plan could be built' };
  if (plan.rr <= 0) return { take: false, code: 'noplan', reason: 'trade plan has non-positive R:R' };
  // Scheduled high-impact data comes before any consideration of setup quality.
  // A good read is still a bad trade thirty seconds before NFP: spreads widen,
  // and a stop sitting inside the spike gets taken out on a move that reverses.
  if (cfg.newsState && cfg.newsState.blocked) {
    const n = cfg.newsState.active;
    const when = n.phase === 'before'
      ? 'in ' + Math.max(0, Math.round(n.minutesUntil)) + ' min'
      : Math.round(-n.minutesUntil) + ' min ago';
    return { take: false, code: 'news', reason: n.name + ' ' + when + ' — standing aside through the release window' };
  }
  if (result.confidence < cfg.minConfidence) {
    return { take: false, code: 'confidence', reason: 'confidence ' + result.confidence + '% is below the ' + cfg.minConfidence + '% autonomous threshold' };
  }
  const allowed = cfg.gradeFloor ? gradesAtOrAbove(cfg.gradeFloor) : cfg.allowedGrades;
  const grade = result.fusion ? downgradeGrade(result.fusion.grade, plan.metaScore || 0) : null;
  if (grade && allowed.indexOf(grade) === -1) {
    return { take: false, code: 'grade', reason: 'grade ' + grade + ' is below the ' + (cfg.gradeFloor || allowed[allowed.length - 1]) + ' floor (a ranging market or disagreeing history downgrades a setup one step each)' };
  }
  if ((plan.metaScore || 0) < cfg.minMetaScore) {
    return { take: false, code: 'meta', reason: 'meta-labeler score ' + (plan.metaScore || 0).toFixed(2) + ' vetoed this setup' };
  }
  const open = (openSignals || []).filter(s => s.status === 'pending' || s.status === 'open');
  if (open.length >= cfg.maxOpenSignals) {
    return { take: false, code: 'maxopen', reason: open.length + ' signals already open (cap ' + cfg.maxOpenSignals + ')' };
  }
  if (open.some(s => s.dir === result.direction)) {
    return { take: false, code: 'duplicate', reason: 'already holding an open ' + result.direction + ' signal' };
  }
  if (lastSignalTime) {
    const mins = (Date.now() - lastSignalTime) / 60000;
    if (mins < cfg.cooldownMinutes) {
      return { take: false, code: 'cooldown', reason: 'cooldown — ' + Math.ceil(cfg.cooldownMinutes - mins) + ' min until the next signal is allowed' };
    }
  }
  return { take: true, code: 'taken', reason: 'confluence, grade and meta-score all cleared the autonomous thresholds', grade };
}

// ============================================================
// IS THIS TRADE STILL ALIVE?
// ------------------------------------------------------------
// The log used to say "awaiting entry" or "filled" and nothing else. Both are
// true of a trade placed a minute ago and of one that has been sitting for
// eleven hours with the kill switch about to take it — which is the difference
// that actually matters when you look at the list.
//
// A trade is alive while it still has room to do what it was placed for, and
// dead once it does not: the clock has nearly run out, or price has walked away
// from the level and left the setup behind. This says which, in those terms.
//
// Pure and side-effect free: it reads the signal, the limits and the current
// price, and returns what to show.
// ============================================================

export const LIVENESS_WARN_RATIO = 0.5;   // past half its allotted time
export const LIVENESS_CRITICAL_RATIO = 0.85;

export function signalLiveness(sig, cfg, opts) {
  cfg = Object.assign({}, AUTONOMY_DEFAULTS, cfg || {});
  opts = opts || {};
  const now = isFinite(opts.now) ? opts.now : Date.now();
  const price = isFinite(opts.price) ? opts.price : null;
  if (!sig) return { state: 'unknown', label: '—', tone: 'idle' };

  if (sig.status === 'won' || sig.status === 'lost') {
    return { state: 'closed', label: sig.status === 'won' ? 'closed · won' : 'closed · lost',
      tone: sig.status === 'won' ? 'good' : 'bad', ratio: null, ageHours: null };
  }
  if (sig.status === 'expired') {
    return { state: 'killed', label: sig.killSwitch ? 'killed as stale' : 'expired',
      tone: 'idle', ratio: null, ageHours: null };
  }

  const resting = sig.status !== 'open';
  const startRaw = resting ? sig.time : (sig.filledAt || sig.time);
  const start = typeof startRaw === 'string' ? Date.parse(startRaw) : startRaw;
  const ageHours = isFinite(start) && start > 0 ? (now - start) / 3600000 : null;
  const limitHours = resting ? cfg.maxHoursToFill : cfg.maxHoursOpen;
  const ratio = (ageHours != null && limitHours > 0) ? ageHours / limitHours : null;

  // How far the trade has actually travelled, in units of its own risk. A
  // position sitting at -0.8R with an hour left is dead in every sense that
  // matters, and the clock alone would not say so.
  let progressR = null;
  const risk = Math.abs(sig.entry - sig.sl);
  if (price != null && risk > 0) {
    const dir = sig.dir === 'BUY' ? 1 : -1;
    progressR = resting
      ? -Math.abs(price - sig.entry) / risk   // distance still to travel to fill
      : (price - sig.entry) * dir / risk;
  }

  let tone = 'live';
  if (ratio != null && ratio >= LIVENESS_CRITICAL_RATIO) tone = 'bad';
  else if (ratio != null && ratio >= LIVENESS_WARN_RATIO) tone = 'warn';

  const left = (ratio != null && limitHours > 0)
    ? Math.max(0, limitHours - ageHours)
    : null;
  const hrs = (h) => h == null ? '—' : (h < 1 ? Math.round(h * 60) + 'm' : h.toFixed(1) + 'h');

  let label, detail;
  if (resting) {
    const base = 'resting ' + hrs(ageHours);
    label = tone === 'bad' ? base + ' · about to be killed'
      : tone === 'warn' ? base + ' · going stale'
      : base + ' · alive';
    detail = 'Order placed but not filled. ' +
      (left != null ? 'Cancelled in ' + hrs(left) + ' if price has not reached the entry.' : 'No time limit set.') +
      (progressR != null ? ' Price is ' + Math.abs(progressR).toFixed(2) + 'R away from the entry.' : '');
  } else {
    const base = 'running ' + hrs(ageHours);
    label = tone === 'bad' ? base + ' · about to be scratched'
      : tone === 'warn' ? base + ' · stalling'
      : base + ' · alive';
    if (progressR != null) label += ' · ' + (progressR >= 0 ? '+' : '') + progressR.toFixed(2) + 'R';
    detail = 'Filled and carrying risk. ' +
      (left != null ? 'Scratched in ' + hrs(left) + ' if it has not hit its stop or target.' : 'No time limit set.') +
      (progressR != null ? ' Currently ' + (progressR >= 0 ? 'ahead by ' : 'behind by ') + Math.abs(progressR).toFixed(2) + 'R.' : '');
  }

  return { state: resting ? 'resting' : 'running', label, detail, tone, ratio, ageHours, hoursLeft: left, progressR };
}

// ============================================================
// SIGNAL LOG MERGE (browser <- background worker)
// ------------------------------------------------------------
// The worker keeps its own signal log server-side and the browser keeps one
// locally. They are two views of the SAME record: a trade the worker took
// unattended at 3am is not a different trade because the tab was closed. Until
// these were merged, an autonomously taken trade simply never appeared in the
// log, so there was no way to tell what the system had entered or whether it
// had won or lost — the only signals the log knew about were the ones taken
// while the page was open.
//
// Merge rules, in order:
//   * Same `id` is the same signal. Ids carry a random suffix, so a collision
//     between two genuinely different signals is not a practical concern.
//   * The MORE RESOLVED record wins. won/lost/expired beats open beats pending,
//     because a status only ever moves forward. This is what stops a stale
//     cached copy from reopening a trade the other side already graded.
//   * At equal resolution the local copy wins, so locally-entered notes (a
//     mistake note, a manual override) are never overwritten by a server copy
//     that does not carry them.
//   * Fields the loser holds and the winner lacks are filled in rather than
//     dropped — the worker knows `exitPrice`, the browser knows `reason`.
// ============================================================

const SIGNAL_RESOLUTION_RANK = { pending: 0, open: 1, expired: 2, lost: 3, won: 3 };

export function signalResolutionRank(sig) {
  if (!sig) return -1;
  const r = SIGNAL_RESOLUTION_RANK[sig.status];
  return r === undefined ? 0 : r;
}

function mergeSignalPair(preferred, other) {
  const out = Object.assign({}, other, preferred);
  // Object.assign would let an explicit undefined/null on the winner erase a
  // value the loser actually has. Only fill gaps.
  Object.keys(other || {}).forEach(k => {
    if (out[k] === undefined || out[k] === null) out[k] = other[k];
  });
  return out;
}

export function mergeSignalLogs(local, incoming, max) {
  const byId = new Map();
  const add = (sig, isLocal) => {
    if (!sig || !sig.id) return;
    const prev = byId.get(sig.id);
    if (!prev) { byId.set(sig.id, { sig, isLocal }); return; }
    const a = signalResolutionRank(prev.sig), b = signalResolutionRank(sig);
    // Strictly greater to win; a tie leaves the incumbent in place, and local
    // is always added first so a tie resolves in local's favour.
    if (b > a) byId.set(sig.id, { sig: mergeSignalPair(sig, prev.sig), isLocal });
    else byId.set(sig.id, { sig: mergeSignalPair(prev.sig, sig), isLocal: prev.isLocal });
  };
  (Array.isArray(local) ? local : []).forEach(s => add(s, true));
  (Array.isArray(incoming) ? incoming : []).forEach(s => add(s, false));

  const merged = Array.from(byId.values()).map(v => v.sig);
  merged.sort((x, y) => {
    const tx = Date.parse(x.time) || 0, ty = Date.parse(y.time) || 0;
    return ty - tx;
  });
  const cap = isFinite(max) && max > 0 ? max : merged.length;
  return merged.slice(0, cap);
}

// Which signals in `merged` are newly resolved relative to `before` — i.e. the
// outcomes this device has not yet learned from or booked in the paper account.
// Returned as the merged records so the caller has the exit price.
export function newlyResolvedSignals(before, merged) {
  const prior = new Map((Array.isArray(before) ? before : []).map(s => [s.id, s]));
  return (Array.isArray(merged) ? merged : []).filter(s => {
    if (s.status !== 'won' && s.status !== 'lost') return false;
    const was = prior.get(s.id);
    return !was || (was.status !== 'won' && was.status !== 'lost');
  });
}

// Signals the kill switch (or any expiry) has just killed. These need their
// paper order cancelling — an expired signal is not a win or a loss, so it must
// not be closed as one, and it must not be left occupying a slot forever.
export function newlyExpiredSignals(before, merged) {
  const prior = new Map((Array.isArray(before) ? before : []).map(s => [s.id, s]));
  return (Array.isArray(merged) ? merged : []).filter(s => {
    if (s.status !== 'expired') return false;
    const was = prior.get(s.id);
    return !was || was.status !== 'expired';
  });
}

// Signals that appeared for the first time in `merged` and are still live.
// These need a paper position opening if the account is tracking them.
export function newlyArrivedOpenSignals(before, merged) {
  const prior = new Set((Array.isArray(before) ? before : []).map(s => s.id));
  return (Array.isArray(merged) ? merged : []).filter(s =>
    (s.status === 'pending' || s.status === 'open') && !prior.has(s.id));
}

// ============================================================
// MACRO SCORING (shared by the browser and the background worker)
// ------------------------------------------------------------
// The correlation and fundamental scores used to be computed inline in the UI
// only. The background worker needs the identical numbers, and a second copy of
// the formula would drift the moment either side was tuned — so the formula
// lives here once and both callers fetch their own data and hand it over.
// ============================================================

// One instrument's pull on the macro score.
//   pctChange — the instrument's latest period-over-period move
//   corr      — its MEASURED correlation with gold, or null if not measurable
//   polarity  — the assumed relationship, used only as a fallback
// Weighting by measured correlation lets a weak or unstable relationship shrink
// its own influence toward zero instead of trusting a hardcoded assumption.
export function macroContribution(pctChange, corr, polarity) {
  const sign = pctChange > 0 ? 1 : pctChange < 0 ? -1 : 0;
  const weight = (corr != null && isFinite(corr)) ? corr : polarity;
  return sign * weight;
}

// Mean contribution across the instruments that actually returned data, clamped
// to [-1, 1] so one wild print can't dominate the composite.
export function aggregateMacroScore(contributions) {
  const usable = (contributions || []).filter(c => isFinite(c));
  if (!usable.length) return 0;
  return Math.max(-1, Math.min(1, usable.reduce((s, c) => s + c, 0) / usable.length));
}

// Period-over-period percentage change from a candle-like series (needs .close).
export function pctChangeOf(series) {
  if (!series || series.length < 2) return 0;
  const last = series[series.length - 1].close, prev = series[series.length - 2].close;
  return prev !== 0 ? (last - prev) / prev * 100 : 0;
}

// ============================================================
// ANALYSIS QUALITY — auditing the engine's own judgement
// ------------------------------------------------------------
// This section deliberately does not try to make the engine predict better. It
// makes the engine honest about itself, which is the part a person genuinely
// cannot do by hand:
//
//   * Nobody remembers their non-trades. Every trader has a story about the
//     setup they passed on; nobody has the ledger. computeGateAudit() keeps
//     that ledger, so "am I being too picky?" becomes a measured question.
//   * Nobody can tell whether their own confidence means anything. Saying "70%"
//     and being right 70% of the time are unrelated skills.
//     computeCalibration() measures the gap.
//   * Nobody holds a session-by-regime performance matrix in their head across
//     hundreds of trades without the memory quietly editing itself in favour of
//     the trades they enjoyed. computeConditionBreakdown() just counts.
//
// All pure, all shared with the worker.
// ============================================================

// R-multiple of a resolved signal: +rr on a win, -1 on a loss. Win rate alone
// is misleading at 1:4 targets, where being right a third of the time is a good
// system — expectancy in R is the number that actually says whether it works.
export function signalRMultiple(sig) {
  if (!sig || (sig.status !== 'won' && sig.status !== 'lost')) return null;
  const risk = Math.abs(sig.entry - sig.sl);
  if (!isFinite(risk) || risk <= 0) return null;
  if (sig.status === 'lost') return -1;
  // Use where it ACTUALLY exited. Assuming the full target would credit a
  // partial exit with reward it never collected, inflating every statistic
  // built on R — expectancy, the gate audit, the calibration table.
  const exit = isFinite(sig.exitPrice) ? sig.exitPrice : sig.tp;
  const reward = Math.abs(exit - sig.entry);
  const rr = reward / risk;
  return isFinite(rr) ? rr : null;
}

function summarise(signals) {
  const resolved = signals.filter(s => s.status === 'won' || s.status === 'lost');
  const rs = resolved.map(signalRMultiple).filter(r => r != null);
  const wins = resolved.filter(s => s.status === 'won').length;
  return {
    n: resolved.length,
    wins,
    winRate: resolved.length ? wins / resolved.length : null,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    totalR: rs.reduce((a, b) => a + b, 0)
  };
}

// Is the confidence number worth anything?
//
// The naive test — "does 70% confidence win 70% of the time?" — is the wrong
// one here: confidence is a confluence score, and at a 1:4 target a 40% win
// rate is excellent. The question that matters is whether confidence
// DISCRIMINATES: do higher-confidence signals actually outperform lower ones?
// If discrimination is ~0 the number is decoration, however precise it looks —
// and that is worth knowing.
export function computeCalibration(signals, bucketWidth) {
  bucketWidth = bucketWidth || 10;
  const resolved = signals.filter(s => (s.status === 'won' || s.status === 'lost') && isFinite(s.confidence));
  const buckets = [];
  for (let lo = 0; lo < 100; lo += bucketWidth) {
    const hi = lo + bucketWidth;
    const inBucket = resolved.filter(s => s.confidence >= lo && s.confidence < (hi === 100 ? 101 : hi));
    if (!inBucket.length) continue;
    const s = summarise(inBucket);
    buckets.push({
      lo, hi,
      n: s.n,
      statedAvg: inBucket.reduce((a, b) => a + b.confidence, 0) / inBucket.length,
      winRate: s.winRate,
      expectancyR: s.expectancyR
    });
  }

  // Discrimination: win rate of the top half of signals by confidence minus the
  // bottom half. Positive means confidence is carrying real information.
  let discrimination = null, topHalf = null, bottomHalf = null;
  if (resolved.length >= 8) {
    const sorted = resolved.slice().sort((a, b) => a.confidence - b.confidence);
    const mid = Math.floor(sorted.length / 2);
    bottomHalf = summarise(sorted.slice(0, mid));
    topHalf = summarise(sorted.slice(mid));
    if (bottomHalf.winRate != null && topHalf.winRate != null) {
      discrimination = topHalf.winRate - bottomHalf.winRate;
    }
  }

  let verdict;
  if (resolved.length < 8) verdict = 'Not enough resolved signals yet — needs at least 8 to say anything honest.';
  else if (discrimination == null) verdict = 'Not enough spread in confidence to measure.';
  else if (discrimination >= 0.15) verdict = 'Confidence is informative — higher-confidence setups are winning meaningfully more often.';
  else if (discrimination > 0.05) verdict = 'Confidence is weakly informative. Real, but do not lean on small differences.';
  else if (discrimination > -0.05) verdict = 'Confidence is not currently discriminating — a high number is not buying you better odds than a low one.';
  else verdict = 'Confidence is inverted: lower-confidence setups are outperforming. Treat the score with suspicion until this reverses.';

  return { buckets, discrimination, topHalf, bottomHalf, sample: resolved.length, verdict, overall: summarise(resolved) };
}

// ============================================================
// WHAT A CONFIDENCE NUMBER MEANS
// ------------------------------------------------------------
// "58%" on its own is decoration. It looks like a probability and is not one:
// it is the share of the weighted framework that agrees, and at a 1:4 target a
// 40% win rate is excellent, so reading it as "58% likely to win" is wrong in
// both directions. Worse, the scale is not the one the number implies — perfect
// alignment across all five timeframes only reaches about 49%, so 58% is not
// "slightly better than a coin flip", it is near the top of what this engine
// can produce.
//
// So the number is reported with the three things that give it meaning:
//
//   1. WHERE IT SITS on the scale this engine actually produces, measured from
//      the system's own logged signals rather than assumed from 0-100.
//   2. WHAT IT HAS MEANT — the resolved record of past signals in the same
//      band. This is the only honest answer to "how much do you trust this".
//   3. HOW MUCH THAT IS WORTH — sample size, and whether confidence discriminates
//      at all. A band record over four trades is an anecdote and says so.
//
// When there is no record yet it says exactly that, rather than implying one.
// ============================================================

// Evidence thresholds for a band's own track record. Below `thin` a win rate is
// noise; `solid` is where a difference between bands starts to mean something.
export const CONFIDENCE_EVIDENCE = { thin: 5, usable: 12, solid: 30 };

// The practical ceiling of the composite score. Not a tuning constant — it is
// what the weighting arithmetic tops out at with every factor aligned, and it
// is why a fixed 0-100 reading of confidence misleads.
export const CONFIDENCE_PRACTICAL_MAX = 49;

// Split the range into bands. Once the system has logged enough signals the
// bands come from its OWN distribution — the point is "high for this engine",
// not "high on a scale nobody calibrated". Before that, fall back to the fixed
// thresholds the grades already use.
export function confidenceBands(signals) {
  const logged = (signals || []).map(s => s.confidence).filter(v => isFinite(v)).sort((a, b) => a - b);
  if (logged.length >= 20) {
    const q = (p) => logged[Math.min(logged.length - 1, Math.floor(p * logged.length))];
    const lo = q(1 / 3), hi = q(2 / 3);
    // Degenerate case: almost every signal scored the same, so thirds collapse.
    if (hi > lo) {
      return { adaptive: true, sample: logged.length, cuts: [lo, hi],
        min: logged[0], max: logged[logged.length - 1] };
    }
  }
  return { adaptive: false, sample: logged.length, cuts: [30, 50], min: 0, max: 100 };
}

export function confidenceBand(value, signals) {
  const b = confidenceBands(signals);
  const [lo, hi] = b.cuts;
  if (!isFinite(value)) return { key: 'unknown', label: 'unmeasured', lo: null, hi: null, includesHi: false, adaptive: b.adaptive };
  if (value < lo) {
    return { key: 'low', lo: b.adaptive ? b.min : 0, hi: lo, includesHi: false, adaptive: b.adaptive,
      label: b.adaptive ? 'bottom third of what this system produces' : 'thin: only part of the framework is contributing' };
  }
  if (value < hi) {
    return { key: 'mid', lo, hi, includesHi: false, adaptive: b.adaptive,
      label: b.adaptive ? 'middle third of what this system produces' : 'moderate: a real read, short of full confluence' };
  }
  return { key: 'high', lo: hi, hi: b.adaptive ? b.max : 100, includesHi: true, adaptive: b.adaptive,
    label: b.adaptive ? 'top third of what this system produces' : 'high for this engine, where full alignment reaches only ~49%' };
}

function evidenceLevel(n) {
  if (n < CONFIDENCE_EVIDENCE.thin) return 'none';
  if (n < CONFIDENCE_EVIDENCE.usable) return 'thin';
  if (n < CONFIDENCE_EVIDENCE.solid) return 'usable';
  return 'solid';
}

// What win rate this trade actually has to clear. Stating "a win rate well under
// half is still profitable" is only true above 1:1 — at a 1:1 target it is
// exactly wrong — so the breakeven is computed rather than asserted.
export function breakevenWinRate(rr) {
  if (!isFinite(rr) || rr <= 0) return null;
  return 1 / (1 + rr);
}

function breakevenNote(rr) {
  const be = breakevenWinRate(rr);
  if (be == null) {
    return 'What win rate it needs to clear depends on the target, which is not set yet.';
  }
  const pct = Math.round(be * 100);
  if (be < 0.4) {
    return 'At this ' + rr.toFixed(1) + ':1 target the trade only has to win about ' + pct +
      '% of the time to break even, so a win rate well under half is not the same as a bad system.';
  }
  if (be <= 0.5) {
    return 'At this ' + rr.toFixed(1) + ':1 target it has to win about ' + pct +
      '% of the time to break even — there is little room for a low win rate here.';
  }
  return 'At this ' + rr.toFixed(1) + ':1 target it has to win more than ' + pct +
    '% of the time just to break even, which is a demanding trade rather than a forgiving one.';
}

// The whole point of the exercise: what did this confidence level actually do
// last time, and the time before that.
export function interpretConfidence(value, signals, opts) {
  opts = opts || {};
  const list = Array.isArray(signals) ? signals : [];
  const band = confidenceBand(value, list);
  const cal = opts.calibration || computeCalibration(list);

  // Half-open on the upper edge for every band but the top one. Closing both
  // edges made the middle band swallow the top band's signals, so a mid-range
  // score reported the whole log's record as its own.
  const inBand = band.lo == null ? [] : list.filter(s =>
    (s.status === 'won' || s.status === 'lost') && isFinite(s.confidence) &&
    s.confidence >= band.lo &&
    (band.hi == null || (band.includesHi ? s.confidence <= band.hi : s.confidence < band.hi)));
  const track = inBand.length ? summarise(inBand) : null;
  const evidence = evidenceLevel(inBand.length);

  // Where it sits as a share of what the engine can actually reach, so the
  // number stops being read against an imaginary 100.
  const ceiling = band.adaptive && confidenceBands(list).max > 0
    ? Math.max(confidenceBands(list).max, CONFIDENCE_PRACTICAL_MAX)
    : CONFIDENCE_PRACTICAL_MAX;
  const ofCeiling = isFinite(value) && ceiling > 0 ? Math.min(1, value / ceiling) : null;

  // Headline — one line that says what the number is worth.
  let headline;
  if (!isFinite(value)) headline = 'No confidence score.';
  else if (evidence === 'none') {
    headline = 'No track record at this level yet — ' + inBand.length + ' resolved trade' + (inBand.length === 1 ? '' : 's') +
      ' in this band, so the number is a structural read only.';
  } else {
    const wr = Math.round(track.winRate * 100);
    const exp = track.expectancyR != null ? (track.expectancyR >= 0 ? '+' : '') + track.expectancyR.toFixed(2) + 'R' : null;
    // The win rate alone does not say whether the level makes money — a 20% win
    // rate at 4:1 is profitable and a 45% one at 1:1 is not. The expectancy
    // does, so it gets said outright rather than left for the reader to infer.
    let verdict = '';
    if (exp != null && evidence !== 'none') {
      verdict = track.expectancyR > 0.05 ? ' Net profitable at this level.'
        : track.expectancyR < -0.05 ? ' Net losing at this level.'
        : ' Roughly break-even at this level.';
    }
    headline = 'Signals in this band have won ' + track.wins + ' of ' + track.n + ' (' + wr + '%)' +
      (exp != null ? ' at ' + exp + ' per trade.' : '.') + verdict;
  }

  // Does confidence carry information at all? A band record is only meaningful
  // if higher bands actually beat lower ones.
  let discriminationNote;
  if (cal.discrimination == null) {
    discriminationNote = 'Whether confidence separates winners from losers is not measurable yet (needs 8+ resolved signals with some spread).';
  } else if (cal.discrimination >= 0.15) {
    discriminationNote = 'Higher-confidence setups are winning ' + Math.round(cal.discrimination * 100) +
      ' points more often than lower ones, so the number is carrying real information.';
  } else if (cal.discrimination > 0.05) {
    discriminationNote = 'Higher-confidence setups win ' + Math.round(cal.discrimination * 100) +
      ' points more often — real, but too small to lean on.';
  } else if (cal.discrimination > -0.05) {
    discriminationNote = 'Higher-confidence setups are NOT winning more often than lower ones. Until that changes, a big number here is not buying better odds.';
  } else {
    discriminationNote = 'Confidence is currently inverted — lower-confidence setups are outperforming. Treat a high number with suspicion.';
  }

  const evidenceNote = {
    none: 'Too few resolved trades in this band to mean anything — treat the percentage as an opinion, not a record.',
    thin: 'A handful of trades. Directionally interesting, statistically an anecdote.',
    usable: 'Enough trades to be worth reading, not enough to bet the account on.',
    solid: 'Enough resolved trades for this band record to be worth trusting.'
  }[evidence];

  const scaleNote = band.adaptive
    ? 'Bands come from this system\'s own ' + confidenceBands(list).sample + ' logged signals, so "high" means high for this engine rather than high on a scale nobody calibrated.'
    : 'Fewer than 20 logged signals, so the bands are still the fixed grade thresholds. They will re-centre on this system\'s own range as the record builds.';

  return {
    value, band, evidence, track,
    sampleInBand: inBand.length,
    ofCeiling, ceiling,
    discrimination: cal.discrimination,
    headline, discriminationNote, evidenceNote, scaleNote,
    // The one sentence that has to be true whatever the record says.
    meaning: 'This is the share of the weighted framework that agrees with the direction — not a probability of winning. ' +
      breakevenNote(opts.rr)
  };
}

// Where the edge actually lives. Slices the resolved record by the conditions
// the engine already records, so a strategy that only works in one regime shows
// up as exactly that instead of averaging into a mediocre whole.
export function computeConditionBreakdown(signals) {
  const resolved = signals.filter(s => s.status === 'won' || s.status === 'lost');
  const by = (keyFn) => {
    const groups = {};
    resolved.forEach(s => {
      const k = keyFn(s) || 'Unknown';
      (groups[k] = groups[k] || []).push(s);
    });
    return Object.keys(groups)
      .map(k => Object.assign({ key: k }, summarise(groups[k])))
      .sort((a, b) => (b.expectancyR ?? -99) - (a.expectancyR ?? -99));
  };
  return {
    bySession: by(s => s.session),
    byRegime: by(s => s.regime),
    byGrade: by(s => s.grade),
    byDirection: by(s => s.dir),
    overall: summarise(resolved)
  };
}

// The ledger of roads not taken.
//
// `declined` are setups the gate rejected but which were tracked anyway, then
// resolved against real price like any other signal. Comparing their expectancy
// to the taken set answers the question no trading journal ever can: was
// passing on those the right call, or is the filter throwing away money?
export function computeGateAudit(taken, declined) {
  const t = summarise(taken || []);
  const d = summarise(declined || []);

  let verdict;
  if (d.n < 10) {
    verdict = 'Not enough declined setups resolved yet (' + d.n + '/10) to judge the filter.';
  } else if (d.expectancyR == null || t.expectancyR == null) {
    verdict = 'Need resolved signals on both sides to compare.';
  } else if (d.expectancyR > t.expectancyR + 0.15) {
    verdict = 'The filter looks too tight — setups it rejected have been outperforming the ones it took. Consider lowering min confidence or the meta-score floor.';
  } else if (d.expectancyR > 0 && d.expectancyR > t.expectancyR - 0.15) {
    verdict = 'The filter is roughly neutral — rejected setups performed about as well as accepted ones. It is not adding much beyond reducing trade count.';
  } else {
    verdict = 'The filter is earning its keep — setups it rejected performed worse than the ones it took.';
  }

  return {
    taken: t,
    declined: d,
    edgeFromFiltering: (t.expectancyR != null && d.expectancyR != null) ? t.expectancyR - d.expectancyR : null,
    verdict
  };
}

// ============================================================
// API QUOTA BUDGETING
// ------------------------------------------------------------
// Twelve Data's free tier allows 800 credits/day and 8/minute, and the browser
// and the background worker share one key. Exhausting it does not degrade
// gracefully — every later call fails, so an over-eager afternoon silently
// blinds the engine for the rest of the day, worker included.
//
// Rather than pick one static interval and hope, calls are spent against a
// budget with a priority. When the day's spend runs ahead, the cheap niceties
// are dropped first and the analysis path keeps running. The policy is pure so
// it can be tested; the counting lives in the app.
// ============================================================

export const QUOTA_PRIORITY = { critical: 'critical', normal: 'normal', low: 'low' };

// The core function — pull fresh candles, analyse, grade open signals — must never
// be the thing that runs out of budget. Ceilings expressed as a fraction of the
// whole cap do not guarantee that: discretionary calls can walk total usage up to
// the normal ceiling and leave the analysis path short for the rest of the day.
//
// So the cap is split. `reserve` credits are ring-fenced for critical work and
// discretionary priorities are measured against the REMAINDER, never the whole
// cap. Whatever else happens, the analysis path still has `reserve` to spend.
const DISCRETIONARY_CEILING = { low: 0.65, normal: 1.0 };

// Credits a day of analysis cycles needs, given how often autonomy runs. The
// margin covers reconnects, catch-up fetches and a retry or two.
export function criticalReserveFor(analysisIntervalMinutes, marginFactor) {
  const mins = analysisIntervalMinutes > 0 ? analysisIntervalMinutes : 15;
  const cyclesPerDay = Math.ceil((24 * 60) / mins);
  return Math.ceil(cyclesPerDay * (marginFactor || 1.35)) + 10;
}

export function utcDayKey(ts) {
  return new Date(ts == null ? Date.now() : ts).toISOString().slice(0, 10);
}

// Reset the counter when the UTC day rolls over — Twelve Data's quota is daily.
export function rollQuota(state, nowTs) {
  const day = utcDayKey(nowTs);
  if (!state || state.day !== day) return { day, used: 0 };
  return state;
}

export function quotaStatus(state, dailyCap) {
  const used = (state && state.used) || 0;
  const cap = dailyCap > 0 ? dailyCap : 1;
  return {
    used, cap,
    remaining: Math.max(0, cap - used),
    fraction: used / cap,
    exhausted: used >= cap
  };
}

// May a call of this priority be made right now?
// Critical spends against the full cap. Everything else spends against the cap
// minus the reserve, so discretionary work physically cannot consume the
// analysis path's allocation.
export function canSpend(state, dailyCap, priority, cost, reserve) {
  cost = cost || 1;
  const { used, cap } = quotaStatus(state, dailyCap);
  if (priority === 'critical') return (used + cost) <= cap;
  const discretionary = Math.max(0, cap - (reserve || 0));
  const ceiling = DISCRETIONARY_CEILING[priority] != null ? DISCRETIONARY_CEILING[priority] : DISCRETIONARY_CEILING.normal;
  return (used + cost) <= discretionary * ceiling;
}

export function spendQuota(state, cost) {
  const s = rollQuota(state, Date.now());
  return { day: s.day, used: s.used + (cost || 1) };
}

// Plain-language summary for the UI. Being able to see the number is most of
// the value — an invisible quota is the reason people discover the limit by
// having everything break.
export function quotaSummary(state, dailyCap, reserve) {
  const s = quotaStatus(state, dailyCap);
  const pct = Math.round(s.fraction * 100);
  const discretionary = Math.max(0, s.cap - (reserve || 0));
  const analysisLeft = Math.max(0, s.cap - s.used);
  let note;
  if (s.exhausted) {
    note = 'Daily budget spent — paused until 00:00 UTC. Analysis is running on the last candles fetched.';
  } else if (s.used >= discretionary) {
    note = 'Optional refreshes paused. The analysis path is still fully funded (' + analysisLeft + ' credits reserved for it).';
  } else if (s.used >= discretionary * DISCRETIONARY_CEILING.low) {
    note = 'Price ticks and correlation paused to protect the analysis budget.';
  } else {
    note = 'Within budget.';
  }
  return { used: s.used, cap: s.cap, remaining: s.remaining, pct, note, reserve: reserve || 0, analysisLeft };
}

// ============================================================
// PAPER TRADING — a simulated account, no money, no broker
// ------------------------------------------------------------
// The learning loop already grades signals against real price. What this adds
// is the accounting a signal log cannot show: position sizing off a risk
// percentage, money P&L, equity, drawdown — the difference between "62% of
// signals won" and "this would have been up 4.3% with an 11% drawdown".
//
// Two deliberate choices about honesty:
//
//   * Fills are pessimistic. Entry is filled at a spread-adjusted price and
//     stops take slippage, so the record does not quietly assume perfect
//     execution. A simulator that flatters itself produces training data that
//     teaches the wrong lesson.
//   * A paper position never feeds the learning loop. The SIGNAL is the unit of
//     learning and already records its own outcome; a position is an accounting
//     mirror of that signal. Letting both report would double-count every trade
//     in the factor statistics.
//
// Sizing is in units of gold rather than lots, so it stays broker-agnostic:
// units = riskAmount / stopDistance, which makes the money risked on a stop
// exactly the configured percentage, whatever the stop width.
// ============================================================

export const PAPER_DEFAULTS = {
  startingBalance: 10000,
  riskPercent: 1,        // of current balance, per trade
  spreadPips: 3,         // applied against the trader on entry
  slippagePips: 1,       // applied against the trader on stop exits only
  maxConcurrent: 3
};

// Move a price against whoever is trading it. Entering a BUY costs the spread
// upward; exiting a BUY on a stop slips downward.
export function worsePrice(price, dir, side, pips, pipSize) {
  const delta = (pips || 0) * (pipSize || PIP_SIZE);
  const isBuy = dir === 'BUY';
  if (side === 'entry') return isBuy ? price + delta : price - delta;
  return isBuy ? price - delta : price + delta; // exit
}

// Units sized so that being stopped out costs exactly riskAmount.
export function paperPositionSize(balance, riskPercent, entryFill, stopPrice) {
  const riskAmount = balance * (riskPercent / 100);
  const stopDistance = Math.abs(entryFill - stopPrice);
  if (!isFinite(stopDistance) || stopDistance <= 0) return null;
  const units = riskAmount / stopDistance;
  if (!isFinite(units) || units <= 0) return null;
  return { units, riskAmount, stopDistance };
}

// Should this signal open a paper position?
//
// Two switches, not one. The master switch is the paper account itself; the
// signal panel carries a second for the trades you generate by hand, so trying
// one out does not require finding a control in another panel, and turning your
// own experiments off never silences the unattended account.
//
// Lives here rather than in the UI so the rule is testable without a browser
// and cannot drift between the two callers.
export function shouldPaperTrade(signal, paper) {
  if (!paper || !paper.enabled) return false;
  const origin = (signal && signal.source) || 'manual';
  if (origin === 'manual' && paper.manual === false) return false;
  return true;
}

// Open a simulated position from a signal. Returns null when the signal cannot
// be sized — a zero-width stop, a full book, or a flat account.
export function openPaperPosition(signal, account, cfg) {
  cfg = Object.assign({}, PAPER_DEFAULTS, cfg || {});
  if (!signal || (signal.dir !== 'BUY' && signal.dir !== 'SELL')) return null;
  // A resting order occupies a slot just as a filled one does.
  const committed = (account.positions || []).filter(p => p.status === 'open' || p.status === 'pending');
  if (committed.length >= cfg.maxConcurrent) return null;
  if (!(account.balance > 0)) return null;

  const entryFill = worsePrice(signal.entry, signal.dir, 'entry', cfg.spreadPips, cfg.pipSize);
  const sized = paperPositionSize(account.balance, cfg.riskPercent, entryFill, signal.sl);
  if (!sized) return null;

  return {
    id: 'pp-' + signal.id,
    signalId: signal.id,
    dir: signal.dir,
    requestedEntry: signal.entry,
    entryFill,
    sl: signal.sl,
    tp: signal.tp,
    units: sized.units,
    riskAmount: sized.riskAmount,
    balanceAtOpen: account.balance,
    openedAt: signal.time || new Date().toISOString(),
    // Only a market entry is live straight away. Most plans here are a limit —
    // "retrace into order block" — and a resting order is not a position: it has
    // no exposure and cannot have a profit or a loss until price reaches the
    // level. Marking those 'open' had the account reporting floating P&L on
    // trades it had never entered.
    status: signal.entryType === 'market' ? 'open' : 'pending',
    filledAt: signal.entryType === 'market' ? (signal.time || new Date().toISOString()) : null
  };
}

// A resting order became a real position. Exposure starts here, not when the
// signal was generated.
export function fillPaperPosition(position, atTime) {
  if (!position || position.status !== 'pending') return position;
  return Object.assign({}, position, { status: 'open', filledAt: atTime || new Date().toISOString() });
}

// Close a position from the signal's own verdict. `outcome` is 'won' | 'lost' |
// 'expired'; an expired position is closed at whatever price it is marked at,
// which is neither a win nor a loss, just a scratch.
// `atPrice` is the level the signal actually resolved at — the full target, a
// partial take-profit, or the stop. Passing it matters: a position that banked
// halfway must not be booked as though it collected the whole target.
export function closePaperPosition(position, outcome, markPrice, cfg, atPrice) {
  cfg = Object.assign({}, PAPER_DEFAULTS, cfg || {});
  // An order that never filled is cancelled, not closed. It has no P&L, and
  // booking it at the current mark would invent a result from a trade that
  // never existed.
  if (position && position.status === 'pending') {
    return Object.assign({}, position, {
      status: 'cancelled', outcome: 'cancelled', pnl: 0, rMultiple: null,
      exitPrice: null, closedAt: new Date().toISOString()
    });
  }
  if (!position || position.status !== 'open') return position;
  let exitPrice;
  if (outcome === 'won') exitPrice = isFinite(atPrice) ? atPrice : position.tp;  // limit fills at the level
  else if (outcome === 'lost') exitPrice = worsePrice(position.sl, position.dir, 'exit', cfg.slippagePips, cfg.pipSize);
  else exitPrice = isFinite(markPrice) ? markPrice : position.entryFill;

  const direction = position.dir === 'BUY' ? 1 : -1;
  const pnl = (exitPrice - position.entryFill) * direction * position.units;
  return Object.assign({}, position, {
    status: 'closed', outcome, exitPrice, partial: !!(outcome === 'won' && isFinite(atPrice) && atPrice !== position.tp),
    pnl, rMultiple: position.riskAmount > 0 ? pnl / position.riskAmount : null,
    closedAt: new Date().toISOString()
  });
}

// Floating P&L of an open position at the current price.
export function unrealisedPnl(position, price) {
  if (!position || position.status !== 'open' || !isFinite(price)) return 0;
  const direction = position.dir === 'BUY' ? 1 : -1;
  return (price - position.entryFill) * direction * position.units;
}

// Account state from the position history. Equity includes floating P&L;
// drawdown is measured on the realised curve, peak to trough.
export function paperAccountSummary(positions, startingBalance, price) {
  const all = positions || [];
  const closed = all.filter(p => p.status === 'closed');
  const open = all.filter(p => p.status === 'open');       // filled, carrying exposure
  const pending = all.filter(p => p.status === 'pending');  // resting orders, no exposure
  const cancelled = all.filter(p => p.status === 'cancelled');

  const realised = closed.reduce((s, p) => s + (p.pnl || 0), 0);
  const balance = startingBalance + realised;
  const floating = open.reduce((s, p) => s + unrealisedPnl(p, price), 0);
  const equity = balance + floating;

  const wins = closed.filter(p => (p.pnl || 0) > 0);
  const losses = closed.filter(p => (p.pnl || 0) < 0);
  const grossWin = wins.reduce((s, p) => s + p.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p.pnl, 0));

  // Peak-to-trough on the realised equity curve, in order of closing.
  let running = startingBalance, peak = startingBalance, maxDD = 0;
  closed.slice().sort((a, b) => String(a.closedAt).localeCompare(String(b.closedAt))).forEach(p => {
    running += p.pnl || 0;
    if (running > peak) peak = running;
    const dd = peak > 0 ? (peak - running) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  });

  return {
    startingBalance, balance, equity, floating, realised,
    openCount: open.length,
    pendingCount: pending.length,
    cancelledCount: cancelled.length,
    closedCount: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    maxDrawdown: maxDD,
    returnPct: startingBalance > 0 ? (equity - startingBalance) / startingBalance * 100 : 0,
    avgR: closed.length ? closed.reduce((s, p) => s + (p.rMultiple || 0), 0) / closed.length : null
  };
}

// Human-readable label for each gate outcome, used by the UI's decline tally.
// Seeing "12 x no directional edge" versus "12 x grade too low" points at two
// completely different problems: the first means the engine finds no setup at
// all and loosening thresholds will not help; the second means the filter is
// the blocker.
export const GATE_LABELS = {
  hold: 'No directional edge — engine flat',
  noplan: 'No valid trade plan',
  confidence: 'Confidence below threshold',
  grade: 'Grade below floor',
  meta: 'Meta-labeler veto',
  maxopen: 'Open-signal cap reached',
  duplicate: 'Already holding that direction',
  cooldown: 'Cooldown active',
  audit: 'Blocked by independent audit',
  news: 'High-impact data release window',
  taken: 'Signal taken'
};

// ============================================================
// DATA INVENTORY — what the system actually knows
// ------------------------------------------------------------
// The learning here is spread across several stores with different caps and
// different thresholds before they do anything: the meta-labeler needs 15
// labelled examples, the knowledge base 15 resolved outcomes, calibration 8,
// the gate audit 10 declined. None of that is visible from the outside, so it
// is easy to run for days assuming learning is happening when in fact every
// store is still below its threshold and nothing is being applied at all.
//
// This reports each store's size and how far it is from the point where it
// starts to matter.
// ============================================================

export const LEARNING_THRESHOLDS = {
  knowledgeBase: 15,   // resolved outcomes before tuned weights are auto-applied
  metaLabeler: 15,     // labelled examples before the meta-labeler scores anything
  calibration: 8,      // resolved signals before confidence discrimination is measurable
  gateAudit: 10,       // resolved declined setups before the filter can be judged
  conditionGroup: 3,   // resolved trades per session/regime before that row is shown
  journal: 5           // resolved trades before journal insights appear
};

export const STORE_CAPS = {
  signalLog: 600,
  shadowLog: 250,
  metaExamples: 500,
  paperPositions: 500
};

function pct(n, of) { return of > 0 ? Math.min(100, Math.round(n / of * 100)) : 0; }

// `sources` is whatever the caller has: { learningState, signalLog, shadowLog,
// paperPositions }. Missing pieces are treated as empty rather than throwing,
// so the browser and the worker can each pass what they hold.
export function dataInventory(sources) {
  const s = sources || {};
  const ls = s.learningState || {};
  const signals = s.signalLog || [];
  const shadows = s.shadowLog || [];
  const positions = s.paperPositions || [];

  const resolved = signals.filter(x => x.status === 'won' || x.status === 'lost');
  const openish = signals.filter(x => x.status === 'pending' || x.status === 'open');
  const expired = signals.filter(x => x.status === 'expired');
  const shadowResolved = shadows.filter(x => x.status === 'won' || x.status === 'lost');
  const metaExamples = (ls.metaExamples || []).length;
  const totalLogged = ls.totalLogged || 0;

  // Factors only learn from outcomes where they actually voted, so a factor can
  // sit at zero votes for a long time while the headline count climbs.
  const factorStats = Object.keys(ls.factors || {}).map(k => ({
    key: k,
    votes: (ls.factors[k] || {}).votes || 0,
    wins: (ls.factors[k] || {}).wins || 0
  }));
  const factorsWithData = factorStats.filter(f => f.votes >= 5).length;

  const capability = (have, need) => ({
    have, need,
    ready: have >= need,
    remaining: Math.max(0, need - have),
    pct: pct(have, need)
  });

  return {
    stores: {
      signalsTotal: signals.length,
      signalsResolved: resolved.length,
      signalsOpen: openish.length,
      signalsExpired: expired.length,
      shadowsTotal: shadows.length,
      shadowsResolved: shadowResolved.length,
      metaExamples,
      paperClosed: positions.filter(p => p.status === 'closed').length,
      paperOpen: positions.filter(p => p.status === 'open').length,
      totalLogged,
      patterns: Object.keys(ls.patterns || {}).length,
      factorsWithData,
      factorsTotal: factorStats.length
    },
    caps: STORE_CAPS,
    capabilities: {
      knowledgeBase: capability(totalLogged, LEARNING_THRESHOLDS.knowledgeBase),
      metaLabeler: capability(metaExamples, LEARNING_THRESHOLDS.metaLabeler),
      calibration: capability(resolved.length, LEARNING_THRESHOLDS.calibration),
      gateAudit: capability(shadowResolved.length, LEARNING_THRESHOLDS.gateAudit),
      journal: capability(resolved.length, LEARNING_THRESHOLDS.journal)
    },
    metaTrained: !!(ls.metaModel && ls.metaModel.length),
    factorStats: factorStats.sort((a, b) => b.votes - a.votes)
  };
}

// ============================================================
// ECONOMIC RELEASE CALENDAR
// ------------------------------------------------------------
// The fundamental series already tracked here are the PUBLISHED numbers, which
// arrive with a lag — they say what CPI was, never that CPI is out in twenty
// minutes. That gap matters for gold specifically: NFP, CPI and FOMC routinely
// move it tens of dollars in seconds, spreads widen, and stops sitting inside
// the noise get taken out on a spike that reverses.
//
// FRED publishes a forward release calendar, so this needs no new provider and
// no new key — the same FRED key already in use. Dates come from the API; the
// TIME of day does not, so each release carries its known publication time in
// US Eastern, converted with real DST rules rather than a fixed offset.
// ============================================================

export const ECONOMIC_RELEASES = [
  { id: 50,  key: 'nfp',    name: 'Employment Situation (NFP)',    impact: 'high',   etHour: 8,  etMinute: 30 },
  { id: 10,  key: 'cpi',    name: 'Consumer Price Index',          impact: 'high',   etHour: 8,  etMinute: 30 },
  { id: 101, key: 'fomc',   name: 'FOMC Press Release',            impact: 'high',   etHour: 14, etMinute: 0  },
  { id: 54,  key: 'pce',    name: 'Personal Income & Outlays (PCE)', impact: 'high', etHour: 8,  etMinute: 30 },
  { id: 46,  key: 'ppi',    name: 'Producer Price Index',          impact: 'medium', etHour: 8,  etMinute: 30 },
  { id: 9,   key: 'retail', name: 'Retail Sales',                  impact: 'medium', etHour: 8,  etMinute: 30 },
  { id: 53,  key: 'gdp',    name: 'Gross Domestic Product',        impact: 'medium', etHour: 8,  etMinute: 30 },
  { id: 91,  key: 'umich',  name: 'Consumer Sentiment (UMich)',    impact: 'medium', etHour: 10, etMinute: 0  },
  { id: 180, key: 'claims', name: 'Jobless Claims',                impact: 'medium', etHour: 8,  etMinute: 30 }
];

export const NEWS_WINDOW_DEFAULTS = {
  enabled: true,
  beforeMin: 30,              // stand aside this long before a release
  afterMin: 15,               // and this long after, until the spike settles
  blockImpacts: ['high'],     // medium-impact events warn but do not block
  warnAheadMin: 120           // how far ahead the UI starts showing a countdown
};

// US Eastern is UTC-5, or UTC-4 during DST: second Sunday of March through the
// first Sunday of November. Assuming a fixed offset would put every release an
// hour out for two thirds of the year.
function nthSundayUtc(year, monthIndex, n) {
  const first = Date.UTC(year, monthIndex, 1);
  const dow = new Date(first).getUTCDay();
  const firstSunday = 1 + ((7 - dow) % 7);
  return Date.UTC(year, monthIndex, firstSunday + (n - 1) * 7, 7, 0, 0); // 2am ET in UTC
}
export function isUsEasternDst(ts) {
  const y = new Date(ts).getUTCFullYear();
  return ts >= nthSundayUtc(y, 2, 2) && ts < nthSundayUtc(y, 10, 1);
}

// "2026-09-04" + 8:30 ET -> epoch ms.
export function releaseTimestamp(dateStr, etHour, etMinute) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  const guess = Date.UTC(y, m - 1, d, 12, 0, 0);          // midday, safely inside the right day
  const offset = isUsEasternDst(guess) ? 4 : 5;            // hours behind UTC
  return Date.UTC(y, m - 1, d, (etHour || 0) + offset, etMinute || 0, 0);
}

// Turn raw {release_id, date} rows from FRED into timed, named events.
export function buildReleaseCalendar(rows) {
  const byId = {};
  ECONOMIC_RELEASES.forEach(r => { byId[r.id] = r; });
  return (rows || [])
    .map(row => {
      const meta = byId[row.release_id];
      if (!meta) return null;
      const at = releaseTimestamp(row.date, meta.etHour, meta.etMinute);
      return at == null ? null : { key: meta.key, name: meta.name, impact: meta.impact, at, date: row.date };
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

// Where we stand relative to the calendar right now.
//   blocked  — inside a blocking window; do not open new positions
//   active   — the event responsible, with which side of it we are on
//   next     — the next upcoming event, for a countdown
export function newsWindowState(calendar, now, cfg) {
  cfg = Object.assign({}, NEWS_WINDOW_DEFAULTS, cfg || {});
  const t = now == null ? Date.now() : now;
  const events = calendar || [];
  let active = null;

  for (const ev of events) {
    const minutesUntil = (ev.at - t) / 60000;
    const inWindow = minutesUntil <= cfg.beforeMin && minutesUntil >= -cfg.afterMin;
    if (!inWindow) continue;
    const blocking = cfg.enabled && cfg.blockImpacts.indexOf(ev.impact) !== -1;
    const candidate = {
      key: ev.key, name: ev.name, impact: ev.impact, at: ev.at,
      minutesUntil, phase: minutesUntil >= 0 ? 'before' : 'after', blocking
    };
    // A blocking event always wins over a merely notable one.
    if (!active || (candidate.blocking && !active.blocking)) active = candidate;
  }

  const upcoming = events.filter(e => e.at > t);
  const next = upcoming.length ? Object.assign({}, upcoming[0], { minutesUntil: (upcoming[0].at - t) / 60000 }) : null;

  return { blocked: !!(active && active.blocking), active, next };
}

// ============================================================
// MARKET EXPLANATION — what is happening, and what is driving it
// ------------------------------------------------------------
// The engine already collects far more than price: measured correlations with
// the dollar and real yields, macro prints, news sentiment, session and regime,
// and a release calendar. Until now those were all just numbers feeding a
// score, so the output could say WHAT it thought without ever saying WHY.
//
// This assembles a causal reading from evidence the system actually holds. It
// is honest about its own basis: drivers are ranked by MEASURED correlation
// rather than assumed relationships, and where the structural read and the
// macro backdrop disagree it says so rather than averaging the tension away —
// a conflict is information, and hiding it is how a confident-sounding
// narrative ends up more misleading than no narrative at all.
//
// No language model involved. Every sentence is derived from a number the
// engine measured, which is what makes it checkable.
// ============================================================

function strengthWord(abs) {
  return abs >= 0.6 ? 'strongly' : abs >= 0.3 ? 'moderately' : 'weakly';
}
function directionWord(v) { return v > 0 ? 'supportive of' : v < 0 ? 'a drag on' : 'neutral for'; }

// Rank the macro inputs by how much they actually pushed the score, using each
// instrument's measured correlation with gold rather than an assumed sign.
export function rankDrivers(correlationDetails, fundamentalDetails) {
  const drivers = [];
  (correlationDetails || []).forEach(d => {
    if (!d.available || !isFinite(d.contribution) || d.contribution === 0) return;
    drivers.push({
      label: d.label, source: 'correlation', contribution: d.contribution,
      corr: isFinite(d.corr) ? d.corr : null, pctChange: d.pctChange, kind: d.kind || 'price'
    });
  });
  (fundamentalDetails || []).forEach(d => {
    if (!d.available || !isFinite(d.contribution) || d.contribution === 0) return;
    drivers.push({
      label: d.label, source: 'fundamental', contribution: d.contribution,
      corr: null, pctChange: d.pctChange, kind: d.kind || 'price'
    });
  });
  return drivers.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

export function explainMarket(input) {
  const { result, correlationDetails, fundamentalDetails, newsScore, newsAvailable, newsState } = input || {};
  if (!result) return { headline: 'No analysis available yet.', narrative: [], drivers: [], conflicts: [] };

  const drivers = rankDrivers(correlationDetails, fundamentalDetails);
  const narrative = [];
  const conflicts = [];

  // --- what price itself is doing -----------------------------------------
  const tf = [
    ['Weekly', result.structWeekly], ['Daily', result.structDaily],
    ['4H', result.structHtf], ['1H', result.structMtf], ['15m', result.structLtf]
  ].filter(([, v]) => v && v.trend);
  const bull = tf.filter(([, v]) => v.trend === 'bullish').map(([n]) => n);
  const bear = tf.filter(([, v]) => v.trend === 'bearish').map(([n]) => n);

  let structureLean = 0;
  if (bull.length > bear.length) structureLean = 1;
  else if (bear.length > bull.length) structureLean = -1;

  const headline = result.direction === 'HOLD'
    ? 'No directional edge — the evidence is pulling against itself.'
    : result.direction + ' bias at ' + result.confidence + '% confidence.';

  if (tf.length) {
    if (bull.length && bear.length) {
      narrative.push('Structure is split: ' + bull.join('/') + ' bullish against ' + bear.join('/') + ' bearish. '
        + 'Timeframes disagreeing is itself the reason confidence is low — the higher ones set context and the lower ones set timing, so a conflict means no clean entry rather than a hidden opportunity.');
    } else if (bull.length) {
      narrative.push('Structure is aligned bullish across ' + bull.join(', ') + '.');
    } else if (bear.length) {
      narrative.push('Structure is aligned bearish across ' + bear.join(', ') + '.');
    }
  }

  // --- what the macro backdrop is doing ------------------------------------
  const top = drivers.slice(0, 3);
  if (top.length) {
    const parts = top.map(d => {
      const moveTxt = isFinite(d.pctChange)
        ? (d.pctChange >= 0 ? 'up ' : 'down ') + Math.abs(d.pctChange).toFixed(2) + (d.kind === 'yield' ? 'pp' : '%')
        : 'moved';
      const corrTxt = d.corr != null ? ' (measured correlation ' + d.corr.toFixed(2) + ')' : '';
      return d.label + ' ' + moveTxt + corrTxt + ', ' + directionWord(d.contribution) + ' gold';
    });
    narrative.push('The strongest macro inputs right now: ' + parts.join('; ') + '.');
  } else {
    narrative.push('No macro input is contributing measurably — correlation and fundamentals are either unavailable or flat, so this read rests on price structure alone.');
  }

  const macroSum = drivers.reduce((s, d) => s + d.contribution, 0);
  const macroLean = macroSum > 0.05 ? 1 : macroSum < -0.05 ? -1 : 0;

  // --- does the macro backdrop agree with price? ---------------------------
  if (structureLean && macroLean) {
    if (structureLean === macroLean) {
      narrative.push('Price and macro agree: the ' + (structureLean > 0 ? 'bullish' : 'bearish')
        + ' structural read is ' + strengthWord(Math.abs(macroSum)) + ' backed by the cross-market picture, which is the more reliable configuration.');
    } else {
      conflicts.push('Structure is ' + (structureLean > 0 ? 'bullish' : 'bearish')
        + ' while macro leans ' + (macroLean > 0 ? 'bullish' : 'bearish') + '.');
      narrative.push('Price is moving against its macro backdrop. That happens — positioning and flow can dominate for a while — '
        + 'but a move unsupported by its drivers tends to be the one that retraces, so treat it as lower quality rather than a contrarian signal.');
    }
  }

  // --- sentiment ------------------------------------------------------------
  if (newsAvailable && isFinite(newsScore) && Math.abs(newsScore) > 0.1) {
    narrative.push('Headline sentiment is ' + (newsScore > 0 ? 'risk-off' : 'risk-on')
      + ', which is ' + directionWord(newsScore) + ' gold. Sentiment is the softest input here — it is a classifier reading headlines, not a measured relationship.');
  }

  // --- when, and what is scheduled -----------------------------------------
  if (result.sessionInfo && result.sessionInfo.session) {
    const regime = result.regimeInfo ? result.regimeInfo.regime : null;
    narrative.push('Session is ' + result.sessionInfo.session + (regime ? ', regime reads as ' + regime : '') + '.');
  }
  if (newsState && newsState.active) {
    const mins = Math.round(Math.abs(newsState.active.minutesUntil));
    narrative.push(newsState.active.name + ' is ' + (newsState.active.phase === 'before' ? 'due in ' + mins + ' min' : mins + ' min past')
      + (newsState.blocked ? ' — new positions are held back through the window, since a spike can take a stop out on a move that then reverses.' : ' — expect wider spreads.'));
  } else if (newsState && newsState.next && newsState.next.minutesUntil < 24 * 60) {
    narrative.push('Next scheduled release: ' + newsState.next.name + ' in ' + Math.round(newsState.next.minutesUntil / 60) + 'h.');
  }

  // --- why confidence is what it is ----------------------------------------
  let confidenceNote;
  if (result.direction === 'HOLD') {
    confidenceNote = 'Confidence is low because the inputs are cancelling, not because nothing was measured. Silent factors count against the score too — an order block only speaks when price is inside one.';
  } else if (result.confidence < 30) {
    confidenceNote = 'Confidence is thin: only part of the framework is contributing, so this is a lean rather than a setup.';
  } else if (result.confidence < 50) {
    confidenceNote = 'Moderate confidence — a real read, but short of the full-confluence case.';
  } else {
    confidenceNote = 'Confidence is high by this engine\'s scale, where even perfect alignment of all five timeframes reaches only about 49%.';
  }

  return { headline, narrative, drivers: top, conflicts, macroLean, structureLean, confidenceNote };
}

// ============================================================
// MACRO MODEL — estimated relationships rather than asserted ones
// ------------------------------------------------------------
// The correlation score scored each driver on its own: sign of its move times
// its own correlation with gold, averaged across instruments. Two problems with
// that, both structural rather than tuning issues.
//
// It double-counts. The dollar and real yields are largely the same repricing
// seen twice, so when both move the naive score treats one story as two
// independent votes and doubles its weight.
//
// And it cannot say "no". A univariate correlation is never zero on real data,
// so every instrument always contributes something, however meaningless.
//
// A multiple regression fixes both: coefficients are PARTIAL effects, so
// collinear drivers split the credit, and a standard error says whether a
// coefficient can be distinguished from zero at all. The model also produces
// something the old score could not — an EXPECTED gold move given today's
// drivers, and therefore a residual when gold does something else entirely.
// ============================================================

import { fitRidge, alignByDay, toChanges, stdDev } from './stats.js';

export const MACRO_MODEL_DEFAULTS = {
  minObservations: 25,   // below this the fit is noise dressed as a number
  minR2: 0.08,           // below this the macro genuinely explains little
  significanceT: 2.0     // |t| threshold for calling a driver real
};

// `goldSeries` and each driver's `series` are candle-like ({time, close}).
export function fitMacroModel(goldSeries, driverSpecs, cfg) {
  cfg = Object.assign({}, MACRO_MODEL_DEFAULTS, cfg || {});
  const specs = (driverSpecs || []).filter(d => d && d.series && d.series.length > 5);
  if (!goldSeries || goldSeries.length < 10 || !specs.length) {
    return { ok: false, reason: 'not enough aligned history to estimate anything' };
  }

  const aligned = alignByDay([goldSeries].concat(specs.map(d => d.series)));
  if (aligned.days.length < cfg.minObservations + 1) {
    return { ok: false, reason: 'only ' + aligned.days.length + ' overlapping days; needs ' + (cfg.minObservations + 1) };
  }

  const goldChanges = toChanges(aligned.columns[0], 'price');
  const driverChanges = specs.map((d, i) => toChanges(aligned.columns[i + 1], d.kind));

  const fit = fitRidge(driverChanges, goldChanges);
  if (!fit) return { ok: false, reason: 'the regression could not be estimated (collinear or degenerate inputs)' };

  const goldSigma = stdDev(goldChanges) || 1;
  const drivers = specs.map((d, i) => ({
    key: d.key, label: d.label, kind: d.kind,
    beta: fit.beta[i], t: fit.tStat[i],
    // Raw beta is a gold RETURN per standard deviation of the driver — about
    // 0.003, which rounds to "0.00" and reads as no effect. Expressed in units
    // of gold's own volatility it becomes interpretable: "a one-sigma move in
    // real yields moves gold 0.9 sigma."
    impactSigma: fit.beta[i] / goldSigma,
    significant: Math.abs(fit.tStat[i]) >= cfg.significanceT,
    latestChange: driverChanges[i][driverChanges[i].length - 1]
  })).sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));

  // What the model expects gold to have done on the latest observation, versus
  // what it actually did.
  const latestRow = driverChanges.map(c => c[c.length - 1]);
  const predicted = fit.predict(latestRow);
  const actual = goldChanges[goldChanges.length - 1];
  const residual = (isFinite(predicted) && isFinite(actual)) ? actual - predicted : null;
  const goldVol = stdDev(goldChanges) || 1;

  return {
    ok: true,
    r2: fit.r2, n: fit.n, sigma: fit.sigma,
    drivers,
    significantCount: drivers.filter(d => d.significant).length,
    predicted, actual, residual,
    // Residual in units of gold's own daily volatility — "1.8 sigma beyond what
    // the drivers explain" is interpretable in a way a raw return is not.
    residualZ: residual != null ? residual / goldVol : null,
    explanatory: fit.r2 >= cfg.minR2,
    goldVol
  };
}

// A macro score in [-1, 1] derived from the model's EXPECTED move rather than
// from averaged univariate correlations. Returns null when the model does not
// clear its own quality bar, so the caller can fall back rather than dress a
// bad fit up as a number.
export function macroModelScore(model) {
  if (!model || !model.ok || !model.explanatory) return null;
  if (!isFinite(model.predicted) || !(model.goldVol > 0)) return null;
  return Math.max(-1, Math.min(1, model.predicted / (2 * model.goldVol)));
}

// Plain-language reading of the fit, including the cases where the honest
// answer is that it explains nothing.
export function describeMacroModel(model) {
  if (!model || !model.ok) return 'Macro model unavailable — ' + ((model && model.reason) || 'no data') + '.';
  const pct = (model.r2 * 100).toFixed(0);
  const sig = model.drivers.filter(d => d.significant);

  if (!model.explanatory) {
    return 'Macro drivers explain only ' + pct + '% of gold\'s recent daily variance — too little to lean on. '
      + 'Price is being set by something these inputs do not capture, so the structural read stands on its own.';
  }
  const lead = sig.length
    ? sig.slice(0, 2).map(d => d.label + ' (' + (d.impactSigma >= 0 ? '+' : '') + d.impactSigma.toFixed(2) + 'σ per σ, t ' + d.t.toFixed(1) + ')').join(' and ')
    : 'no individual driver';
  let out = 'Macro drivers explain ' + pct + '% of gold\'s recent daily variance over ' + model.n + ' observations, led by ' + lead + '.';
  if (!sig.length) {
    out += ' No single driver is statistically distinguishable from zero, so the explanatory power is shared rather than attributable.';
  }
  if (model.residualZ != null && Math.abs(model.residualZ) > 1.5) {
    out += ' Gold\'s latest move is ' + Math.abs(model.residualZ).toFixed(1) + 'σ '
      + (model.residualZ > 0 ? 'above' : 'below') + ' what those drivers predict — it is moving for reasons outside this model.';
  }
  return out;
}

// Re-exported so the browser app has one import surface for analysis helpers.
export { alignByDay, toChanges } from './stats.js';
