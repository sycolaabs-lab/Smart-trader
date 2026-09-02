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
export const FRED_INSTRUMENTS = [
  { key: 'dxy', seriesId: 'DTWEXBGS', label: 'Broad Dollar Index (FRED proxy for DXY)', polarity: -1 },
  { key: 'oil', seriesId: 'DCOILWTICO', label: 'Crude Oil (WTI)', polarity: 0.4 },
  { key: 'spx', seriesId: 'SP500', label: 'S&P 500', polarity: -0.3 },
  { key: 'vix', seriesId: 'VIXCLS', label: 'Volatility (VIX)', polarity: 1 },
  { key: 'us10y', seriesId: 'DGS10', label: 'US 10Y Treasury Yield', polarity: -0.6 },
  { key: 'us2y', seriesId: 'DGS2', label: 'US 2Y Treasury Yield', polarity: -0.5 }
];
// FRED has no good series for these — Twelve Data still handles them, only 2 calls now, spaced out to stay under the rate limit.
// Nasdaq dropped: it only relates to gold indirectly through general risk sentiment, and SPX already covers
// that channel — Nasdaq added redundant noise, not independent information.
export const CORRELATION_INSTRUMENTS = [
  { key: 'xag', symbol: 'XAG/USD', label: 'Silver', polarity: 1 },
  { key: 'btc', symbol: 'BTC/USD', label: 'Bitcoin', polarity: 0.1 }
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

export const AUTONOMY_DEFAULTS = {
  minConfidence: 45,     // below this the engine is guessing; don't commit a signal
  minMetaScore: -0.25,   // meta-labeler veto: strongly negative quality reads are skipped
  gradeFloor: 'B',
  allowedGrades: ['A+', 'A', 'B'],
  cooldownMinutes: 60,   // don't stack signals bar after bar off the same structure
  maxOpenSignals: 3,
  maxBarsToFill: 32,     // a limit entry that hasn't been tagged in ~8h (15min bars) is stale
  maxBarsOpen: 192,      // ~2 days on 15min bars; after that call it a scratch, not a win/loss
  analysisIntervalMinutes: 15,
  backtestIntervalHours: 4
};

// Walk `candles` forward from a signal and decide what actually happened to it.
// Returns one of:
//   pending  — not filled yet, still inside its fill window
//   open     — filled, neither stop nor target touched yet
//   won/lost — target or stop reached
//   expired  — never filled within maxBarsToFill, or held past maxBarsOpen unresolved
// When a single candle's range covers both the stop and the target we can't know
// from OHLC alone which came first, so we assume the stop. That biases the
// learning data pessimistically, which is the right way to be wrong here: it
// makes the meta-labeler sceptical of setups that need a coin-flip to win.
export function resolveSignal(signal, candles, cfg) {
  cfg = Object.assign({}, AUTONOMY_DEFAULTS, cfg || {});
  if (!signal || signal.dir !== 'BUY' && signal.dir !== 'SELL') return { status: 'expired', reason: 'not a directional signal' };

  const isBuy = signal.dir === 'BUY';
  const signalTime = typeof signal.time === 'string' ? Date.parse(signal.time) : signal.time;
  const after = candles.filter(c => c.time > signalTime);
  if (!after.length) return { status: signal.entryType === 'market' ? 'open' : 'pending', barsSeen: 0 };

  let filled = signal.entryType === 'market';
  let fillIndex = filled ? 0 : -1;

  for (let i = 0; i < after.length; i++) {
    const c = after[i];
    if (!filled) {
      // A limit entry fills when price trades through the level.
      if (c.low <= signal.entry && c.high >= signal.entry) { filled = true; fillIndex = i; }
      else if (i + 1 >= cfg.maxBarsToFill) return { status: 'expired', reason: 'entry never filled', barsSeen: i + 1 };
      else continue;
    }
    const hitStop = isBuy ? c.low <= signal.sl : c.high >= signal.sl;
    const hitTarget = isBuy ? c.high >= signal.tp : c.low <= signal.tp;
    if (hitStop && hitTarget) {
      return { status: 'lost', exitPrice: signal.sl, ambiguousBar: true, resolvedAt: c.time, barsHeld: i - fillIndex + 1 };
    }
    if (hitStop) return { status: 'lost', exitPrice: signal.sl, resolvedAt: c.time, barsHeld: i - fillIndex + 1 };
    if (hitTarget) return { status: 'won', exitPrice: signal.tp, resolvedAt: c.time, barsHeld: i - fillIndex + 1 };
    if (i - fillIndex + 1 >= cfg.maxBarsOpen) {
      return { status: 'expired', reason: 'held past max duration without resolving', resolvedAt: c.time, barsHeld: i - fillIndex + 1 };
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
  const reward = Math.abs(sig.tp - sig.entry);
  const rr = reward / risk;
  if (!isFinite(rr)) return null;
  return sig.status === 'won' ? rr : -1;
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

// Open a simulated position from a signal. Returns null when the signal cannot
// be sized — a zero-width stop, a full book, or a flat account.
export function openPaperPosition(signal, account, cfg) {
  cfg = Object.assign({}, PAPER_DEFAULTS, cfg || {});
  if (!signal || (signal.dir !== 'BUY' && signal.dir !== 'SELL')) return null;
  const open = (account.positions || []).filter(p => p.status === 'open');
  if (open.length >= cfg.maxConcurrent) return null;
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
    status: 'open'
  };
}

// Close a position from the signal's own verdict. `outcome` is 'won' | 'lost' |
// 'expired'; an expired position is closed at whatever price it is marked at,
// which is neither a win nor a loss, just a scratch.
export function closePaperPosition(position, outcome, markPrice, cfg) {
  cfg = Object.assign({}, PAPER_DEFAULTS, cfg || {});
  if (!position || position.status !== 'open') return position;
  let exitPrice;
  if (outcome === 'won') exitPrice = position.tp;                       // limit fills at the level
  else if (outcome === 'lost') exitPrice = worsePrice(position.sl, position.dir, 'exit', cfg.slippagePips, cfg.pipSize);
  else exitPrice = isFinite(markPrice) ? markPrice : position.entryFill;

  const direction = position.dir === 'BUY' ? 1 : -1;
  const pnl = (exitPrice - position.entryFill) * direction * position.units;
  return Object.assign({}, position, {
    status: 'closed', outcome, exitPrice,
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
  const open = all.filter(p => p.status === 'open');

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
