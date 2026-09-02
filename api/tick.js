// ============================================================
// BACKGROUND WORKER — /api/tick
// ------------------------------------------------------------
// The unattended half of the system. A scheduler GETs this endpoint every few
// minutes and it does one full pass with no browser involved: pull candles,
// grade whatever the market has decided since last time, re-analyse, commit a
// signal if the gate clears, retrain the meta-labeler on real outcomes, and
// publish a snapshot the UI subscribes to.
//
// It imports lib/engine.js — the same module the browser runs — so the numbers
// here and the numbers on screen come from one implementation, not two that
// drift apart.
//
// Two constraints shape the design:
//
//   * Twelve Data's free tier allows ~8 requests/minute and 800/day. Naively
//     refetching every timeframe each tick would burn the daily quota before
//     lunch, so higher timeframes are cached in Firestore and refreshed on
//     their own schedules (see REFRESH_MS). A 5-minute cadence then costs
//     roughly one request per tick instead of eight.
//   * The function has a hard wall-clock limit, so slow optional work (macro,
//     news) is allowed to fail without taking the tick down with it. A tick
//     that publishes structure but no news is far better than no tick.
// ============================================================
import {
  computeComposite, buildTradePlan, resolveSignal, autonomyGate, setMetaModel,
  trainAdaBoostStumps, parseUtcDatetime, pearsonCorrelation, toDailyReturns,
  CORRELATION_INSTRUMENTS, FUNDAMENTAL_INSTRUMENTS, FRED_INSTRUMENTS,
  AUTONOMY_DEFAULTS, macroContribution, aggregateMacroScore, pctChangeOf
} from '../lib/engine.js';

const SYMBOL = 'XAU/USD';
const LIVE_INTERVAL = '15min';

// How stale each cached input is allowed to get before the tick refetches it.
// These are the whole reason the daily quota survives a 5-minute schedule.
const REFRESH_MS = {
  ltf: 0,                       // always fresh — this is the signal timeframe
  mtf: 60 * 60 * 1000,          // 1H candles: hourly
  htf: 4 * 60 * 60 * 1000,      // 4H candles: every 4h
  daily: 12 * 60 * 60 * 1000,
  weekly: 24 * 60 * 60 * 1000,
  correlation: 6 * 60 * 60 * 1000,
  fundamental: 3 * 60 * 60 * 1000,  // FRED is free and unmetered, but the data is daily anyway
  news: 2 * 60 * 60 * 1000          // Alpha Vantage free tier is ~25 requests/day
};

const WORKER_DOC = 'worker';
const TICK_DOC = 'latestTick';

const DEFAULT_WEIGHTS = {
  weekly: 15, daily: 12, htf: 10, mtf: 8, ltf: 8, ob: 9, fvg: 5, liquidity: 5,
  premiumDiscount: 4, priceAction: 9, classic: 4, correlation: 7, fundamental: 8, newsSentiment: 5
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Firestore (Admin) ----------
// firebase-admin is initialised lazily and reused across warm invocations;
// re-initialising on every request would both leak apps and add cold-start cost.
let dbPromise = null;
async function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const admin = (await import('firebase-admin')).default;
    if (!admin.apps.length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
      // Accept either raw JSON or base64-wrapped JSON — pasting a service account
      // into a dashboard field goes wrong often enough to be worth tolerating both.
      const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      const creds = JSON.parse(json);
      admin.initializeApp({ credential: admin.credential.cert(creds) });
    }
    return admin.firestore();
  })();
  return dbPromise;
}

// ---------- Twelve Data ----------
async function twelveSeries(key, interval, outputsize, symbol) {
  const qs = new URLSearchParams({
    symbol: symbol || SYMBOL, interval, outputsize: String(outputsize), timezone: 'UTC', apikey: key
  });
  const r = await fetch('https://api.twelvedata.com/time_series?' + qs);
  const j = await r.json();
  if (j.status === 'error' || j.code) throw new Error(j.message || 'Twelve Data error');
  if (!j.values || !j.values.length) throw new Error('No data for ' + (symbol || SYMBOL) + ' @ ' + interval);
  return j.values.slice().reverse().map(v => ({
    time: parseUtcDatetime(v.datetime), open: +v.open, high: +v.high, low: +v.low, close: +v.close
  }));
}

// ---------- FRED ----------
// Returns candle-like points ({time, close}) so the shared engine helpers —
// toDailyReturns, pctChangeOf — work on FRED series exactly as they do on candles.
async function fredSeries(seriesId, fredKey, limit) {
  limit = limit || 60;
  const qs = new URLSearchParams({
    series_id: seriesId, api_key: fredKey, file_type: 'json', sort_order: 'asc', limit: String(limit * 2)
  });
  const r = await fetch('https://api.stlouisfed.org/fred/series/observations?' + qs);
  const j = await r.json();
  if (j.error_code) throw new Error(j.error_message || 'FRED error');
  if (!j.observations) throw new Error('No observations returned');
  const obs = j.observations
    .filter(o => o.value !== '.')
    .map(o => ({ time: new Date(o.date + 'T00:00:00Z').getTime(), close: parseFloat(o.value) }));
  if (!obs.length) throw new Error('No usable data points');
  return obs.slice(-limit);
}

// Cross-market correlation score. Same shape as the browser's refreshCorrelation:
// gold's own daily history is fetched once and reused for every comparison, and
// each instrument is weighted by its measured correlation via macroContribution.
async function computeCorrelation(tdKey, fredKey) {
  const contributions = [];
  let xauDaily = null;
  try { xauDaily = await twelveSeries(tdKey, '1day', 60); await sleep(1200); }
  catch (e) { xauDaily = null; }
  const xauRets = xauDaily ? toDailyReturns(xauDaily) : null;

  if (fredKey) {
    for (const inst of FRED_INSTRUMENTS) {
      try {
        const obs = await fredSeries(inst.seriesId, fredKey, 60);
        const corr = xauRets ? pearsonCorrelation(xauRets, toDailyReturns(obs)) : null;
        contributions.push(macroContribution(pctChangeOf(obs), corr, inst.polarity));
      } catch (e) { /* one series failing must not sink the rest */ }
    }
  }
  if (xauRets) {
    for (const inst of CORRELATION_INSTRUMENTS) {
      try {
        const candles = await twelveSeries(tdKey, '1day', 60, inst.symbol);
        const corr = pearsonCorrelation(xauRets, toDailyReturns(candles));
        contributions.push(macroContribution(pctChangeOf(candles), corr, inst.polarity));
      } catch (e) { /* ditto */ }
      await sleep(1200); // stay under Twelve Data's free-tier 8 requests/minute cap
    }
  }
  return { score: aggregateMacroScore(contributions), available: contributions.length > 0 };
}

// Macro fundamentals from FRED. These are low-frequency prints with no usable
// short-window correlation, so the assumed polarity carries the weight.
async function computeFundamentals(fredKey) {
  if (!fredKey) return { score: 0, available: false };
  const contributions = [];
  for (const inst of FUNDAMENTAL_INSTRUMENTS) {
    try {
      const obs = await fredSeries(inst.seriesId, fredKey, 24);
      if (obs.length < 2) continue;
      contributions.push(macroContribution(pctChangeOf(obs), null, inst.polarity));
    } catch (e) { /* optional */ }
  }
  return { score: aggregateMacroScore(contributions), available: contributions.length > 0 };
}

async function computeNews(avKey) {
  if (!avKey) return { score: 0, available: false };
  try {
    const qs = new URLSearchParams({
      function: 'NEWS_SENTIMENT', topics: 'economy_macro,economy_monetary,financial_markets',
      sort: 'LATEST', limit: '50', apikey: avKey
    });
    const r = await fetch('https://www.alphavantage.co/query?' + qs);
    const j = await r.json();
    if (!j.feed || !j.feed.length) return { score: 0, available: false };
    const scores = j.feed.map(f => parseFloat(f.overall_sentiment_score)).filter(isFinite);
    if (!scores.length) return { score: 0, available: false };
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    // Risk-off macro sentiment is broadly gold-supportive, so the sign is inverted.
    return { score: Math.max(-1, Math.min(1, -avg * 4)), available: true };
  } catch (e) {
    return { score: 0, available: false };
  }
}

// Refetch a cached input only when its own refresh window has elapsed.
async function cached(state, key, maxAgeMs, fetcher) {
  const meta = state.cacheMeta || (state.cacheMeta = {});
  const now = Date.now();
  const fresh = meta[key] && (now - meta[key]) < maxAgeMs;
  if (fresh && state.cache && state.cache[key] != null) {
    return { value: state.cache[key], refreshed: false };
  }
  const value = await fetcher();
  state.cache = state.cache || {};
  state.cache[key] = value;
  meta[key] = now;
  return { value, refreshed: true };
}

// The whole tick, with its two external dependencies — Firestore and the API
// keys — passed in rather than reached for. handler() below wires up the real
// ones; the test suite passes fakes and exercises the same code path.
export async function runTick({ db, tdKey, fredKey, avKey }) {
  const started = Date.now();
  {
    const sysRef = db.collection('system');
    const workerRef = sysRef.doc(WORKER_DOC);

    // ---- load persisted worker state -------------------------------------
    const snap = await workerRef.get();
    const stored = snap.exists ? (snap.data() || {}) : {};
    const state = {
      signalLog: stored.signalLog ? JSON.parse(stored.signalLog) : [],
      learningState: stored.learningState
        ? JSON.parse(stored.learningState)
        : { factors: {}, patterns: {}, totalLogged: 0, metaExamples: [], metaModel: null },
      weights: stored.weights ? JSON.parse(stored.weights) : Object.assign({}, DEFAULT_WEIGHTS),
      cache: stored.cache ? JSON.parse(stored.cache) : {},
      cacheMeta: stored.cacheMeta || {},
      lastSignalAt: stored.lastSignalAt || null
    };
    setMetaModel(state.learningState.metaModel);

    // ---- market data (tiered refresh) ------------------------------------
    const ltf = (await cached(state, 'ltf', REFRESH_MS.ltf, () => twelveSeries(tdKey, LIVE_INTERVAL, 500))).value;
    const mtfR = await cached(state, 'mtf', REFRESH_MS.mtf, async () => { await sleep(1200); return twelveSeries(tdKey, '1h', 300); });
    const htfR = await cached(state, 'htf', REFRESH_MS.htf, async () => { await sleep(1200); return twelveSeries(tdKey, '4h', 200); });
    const dayR = await cached(state, 'daily', REFRESH_MS.daily, async () => { await sleep(1200); return twelveSeries(tdKey, '1day', 200); });
    const wkR = await cached(state, 'weekly', REFRESH_MS.weekly, async () => { await sleep(1200); return twelveSeries(tdKey, '1week', 104); });

    // ---- macro inputs (all optional, all failure-tolerant) ---------------
    let corr = { score: 0, available: false }, fund = { score: 0, available: false }, news = { score: 0, available: false };
    try { corr = (await cached(state, 'correlation', REFRESH_MS.correlation, () => computeCorrelation(tdKey, fredKey))).value; } catch (e) { /* optional */ }
    try { fund = (await cached(state, 'fundamental', REFRESH_MS.fundamental, () => computeFundamentals(fredKey))).value; } catch (e) { /* optional */ }
    try { news = (await cached(state, 'news', REFRESH_MS.news, () => computeNews(avKey))).value; } catch (e) { /* optional */ }

    // ---- 1. grade what the market already decided ------------------------
    let resolvedThisTick = 0;
    state.signalLog.forEach(sig => {
      if (sig.status !== 'pending' && sig.status !== 'open') return;
      const verdict = resolveSignal(sig, ltf, AUTONOMY_DEFAULTS);
      if (verdict.status === 'won' || verdict.status === 'lost') {
        const won = verdict.status === 'won';
        sig.status = verdict.status;
        sig.resolvedAt = new Date().toISOString();
        sig.resolvedBy = 'worker';
        sig.exitPrice = verdict.exitPrice;
        resolvedThisTick++;
        // Same learning updates the browser applies on a resolved signal.
        const ls = state.learningState;
        ls.totalLogged = (ls.totalLogged || 0) + 1;
        Object.keys(sig.factors || {}).forEach(k => {
          const v = sig.factors[k];
          if (!v) return;
          if (Math.sign(v) !== (sig.dir === 'BUY' ? 1 : -1)) return;
          ls.factors[k] = ls.factors[k] || { votes: 0, wins: 0 };
          ls.factors[k].votes++;
          if (won) ls.factors[k].wins++;
        });
        if (sig.qualityFeatures) {
          ls.metaExamples = (ls.metaExamples || []).concat([{ features: sig.qualityFeatures, label: won ? 1 : -1 }]).slice(-500);
        }
      } else if (verdict.status === 'expired') {
        sig.status = 'expired';
        sig.expiryReason = verdict.reason || null;
        sig.resolvedAt = new Date().toISOString();
      } else if (verdict.status === 'open' && sig.status === 'pending') {
        sig.status = 'open';
      }
    });

    // ---- 2. retrain the meta-labeler on real outcomes --------------------
    const examples = state.learningState.metaExamples || [];
    if (examples.length >= 15) {
      state.learningState.metaModel = trainAdaBoostStumps(examples, 20);
      setMetaModel(state.learningState.metaModel);
    }

    // ---- 3. analyse -------------------------------------------------------
    const result = computeComposite(
      ltf, ltf.length - 1, state.weights,
      mtfR.value, htfR.value, corr.score, fund.score, news.score, dayR.value, wkR.value
    );
    if (!result) throw new Error('Not enough candle history to analyse');
    const plan = buildTradePlan(result, 4);

    // ---- 4. commit a signal if the gate clears ---------------------------
    // Thresholds are overridable per deployment. The defaults are tuned for
    // trading, not for gathering data: grade is derived from confidence and then
    // downgraded again for a ranging market and for disagreeing history, so at
    // the default B floor a ranging market needs 70%+ to qualify at all. Set
    // TICK_GRADE_FLOOR=C while building up a record.
    const gateCfg = Object.assign({}, AUTONOMY_DEFAULTS, {
      gradeFloor: process.env.TICK_GRADE_FLOOR || AUTONOMY_DEFAULTS.gradeFloor,
      minConfidence: isFinite(parseFloat(process.env.TICK_MIN_CONFIDENCE))
        ? parseFloat(process.env.TICK_MIN_CONFIDENCE)
        : AUTONOMY_DEFAULTS.minConfidence
    });
    const gate = autonomyGate(result, plan, state.signalLog, state.lastSignalAt, gateCfg);
    let tookSignal = false;
    if (gate.take) {
      state.signalLog.unshift({
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        dir: result.direction, entry: plan.entry, sl: plan.sl, tp: plan.tp,
        entryType: plan.entryType, confidence: result.confidence,
        factors: Object.assign({}, result.factors),
        session: result.sessionInfo ? result.sessionInfo.session : null,
        grade: gate.grade || null,
        qualityFeatures: plan.qualityFeatures || null,
        metaScore: plan.metaScore || 0,
        time: new Date().toISOString(), status: plan.entryType === 'market' ? 'open' : 'pending',
        source: 'worker'
      });
      state.signalLog = state.signalLog.slice(0, 400);
      state.lastSignalAt = Date.now();
      tookSignal = true;
    }

    // ---- 5. persist ------------------------------------------------------
    // Series and nested state go in as JSON strings: Firestore rejects nested
    // arrays, and one string per input keeps the document well under 1MB.
    await workerRef.set({
      signalLog: JSON.stringify(state.signalLog),
      learningState: JSON.stringify(state.learningState),
      weights: JSON.stringify(state.weights),
      cache: JSON.stringify(state.cache),
      cacheMeta: state.cacheMeta,
      lastSignalAt: state.lastSignalAt,
      updatedAt: Date.now()
    }, { merge: true });

    // The public snapshot the dashboard subscribes to. Field names here are the
    // contract with the Background System panel in index.html — changing one
    // means changing both.
    const tick = {
      time: Date.now(),
      price: result.price,
      direction: result.direction,
      confidence: result.confidence,
      entry: plan.entry, sl: plan.sl, tp: plan.tp,
      metaScore: plan.metaScore || 0,
      metaTrained: !!(state.learningState.metaModel && state.learningState.metaModel.length),
      metaExampleCount: examples.length,
      resolvedThisTick,
      tookSignal,
      gateReason: gate.reason,
      gateCode: gate.code || null,
      gradeFloor: gateCfg.gradeFloor,
      minConfidence: gateCfg.minConfidence,
      session: result.sessionInfo ? result.sessionInfo.session : null,
      regime: result.regimeInfo ? result.regimeInfo.regime : null,
      macro: {
        correlationAvailable: !!corr.available, correlationScore: corr.score || 0,
        fundamentalAvailable: !!fund.available, fundamentalScore: fund.score || 0,
        newsAvailable: !!news.available, newsScore: news.score || 0
      },
      openSignals: state.signalLog.filter(s => s.status === 'pending' || s.status === 'open').length,
      totalLogged: state.learningState.totalLogged || 0,
      durationMs: Date.now() - started
    };
    await sysRef.doc(TICK_DOC).set(tick);

    return tick;
  }
}

export default async function handler(req, res) {
  const started = Date.now();
  // Accept the secret either as ?secret= or as an Authorization: Bearer header.
  // External schedulers differ in which they can send, and Vercel's own cron
  // always sends the header form using CRON_SECRET — supporting both means the
  // same endpoint works from cron-job.org, curl, and the built-in daily cron
  // without a second code path.
  const secret = process.env.TICK_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const provided = (req.query && req.query.secret) || bearer;

  if (!secret && !cronSecret) {
    return res.status(500).json({
      ok: false,
      error: 'TICK_SECRET is not configured on this deployment. Set it in Vercel → Settings → Environment Variables, then redeploy. Open /api/health to check what this deployment can see.'
    });
  }
  const authorised = (secret && provided === secret) || (cronSecret && bearer === cronSecret);
  if (!authorised) {
    return res.status(401).json({ ok: false, error: 'Unauthorized — pass ?secret=YOUR_TICK_SECRET or an Authorization: Bearer header.' });
  }

  const tdKey = process.env.TWELVEDATA_API_KEY;
  if (!tdKey) {
    return res.status(500).json({
      ok: false,
      error: 'TWELVEDATA_API_KEY is not configured. Open /api/health for a full setup check.'
    });
  }

  try {
    const tick = await runTick({
      db: await getDb(),
      tdKey,
      fredKey: process.env.FRED_API_KEY || '',
      avKey: process.env.ALPHAVANTAGE_API_KEY || ''
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, ...tick });
  } catch (e) {
    // Surface the failure to the scheduler (non-2xx) so a broken key or quota
    // shows up as failing runs rather than silently doing nothing for days.
    return res.status(500).json({ ok: false, error: (e && e.message) || String(e), durationMs: Date.now() - started });
  }
}
