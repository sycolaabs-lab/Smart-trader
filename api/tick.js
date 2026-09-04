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
  AUTONOMY_DEFAULTS, macroContribution, aggregateMacroScore, pctChangeOf,
  seriesDeltas, latestChangeOf, correlateByDay, ECONOMIC_RELEASES, buildReleaseCalendar,
  newsWindowState, NEWS_WINDOW_DEFAULTS
} from '../lib/engine.js';
import { auditAnalysis, auditOpenTrades } from '../lib/auditor.js';

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
  news: 2 * 60 * 60 * 1000,         // Alpha Vantage free tier is ~25 requests/day
  calendar: 12 * 60 * 60 * 1000     // a release schedule does not change hour to hour
};

const WORKER_DOC = 'worker';
// Published separately from the worker's own state so the dashboard can watch
// the trade list without pulling the candle cache down with it.
const PUBLIC_SIGNALS_DOC = 'workerSignals';
const PUBLIC_SIGNAL_LIMIT = 150;

function envNum(name, fallback) {
  const v = parseFloat(process.env[name]);
  return isFinite(v) ? v : fallback;
}
const TICK_DOC = 'latestTick';

const DEFAULT_WEIGHTS = {
  weekly: 15, daily: 12, htf: 10, mtf: 8, ltf: 8, ob: 9, fvg: 5, liquidity: 5,
  premiumDiscount: 4, priceAction: 9, classic: 4, correlation: 7, fundamental: 8, newsSentiment: 5
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wall-clock budget. The function is capped at 60s (vercel.json), and the
// comment at the top of this file claims slow optional work must never take the
// tick down with it — but nothing enforced that, and it duly happened: adding
// cache signatures for correlation and fundamentals at once busted both on the
// same invocation, forcing ~15 sequential HTTP calls plus rate-limit sleeps on
// top of a cold start. The tick hit a 504 and never reached its final write, so
// Firestore silently kept serving the previous one.
//
// Optional work now runs only while budget remains. Structure is what the tick
// exists for; macro is an enrichment and yields first.
const TICK_BUDGET_MS = 42000;
const MACRO_MIN_MS = 8000;   // don't start a macro refresh without room to finish
function budget(started) {
  const used = Date.now() - started;
  return { used, left: Math.max(0, TICK_BUDGET_MS - used) };
}

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
    series_id: seriesId, api_key: fredKey, file_type: 'json', sort_order: 'desc', limit: String(limit * 2)
  });
  const r = await fetch('https://api.stlouisfed.org/fred/series/observations?' + qs);
  const j = await r.json();
  if (j.error_code) throw new Error(j.error_message || 'FRED error');
  if (!j.observations) throw new Error('No observations returned');
  const obs = j.observations
    .filter(o => o.value !== '.')
    .map(o => ({ time: new Date(o.date + 'T00:00:00Z').getTime(), close: parseFloat(o.value) }));
  if (!obs.length) throw new Error('No usable data points');
  // Newest-first from FRED; everything downstream expects oldest-first.
  obs.sort((a, b) => a.time - b.time);
  return obs.slice(-limit);
}

// Upcoming economic releases, straight from FRED (no CORS concern server-side).
async function fetchReleaseCalendar(fredKey) {
  if (!fredKey) return [];
  const today = new Date().toISOString().slice(0, 10);
  const wanted = new Set(ECONOMIC_RELEASES.map(r => r.id));
  const qs = new URLSearchParams({
    api_key: fredKey, file_type: 'json', include_release_dates_with_no_data: 'true',
    realtime_start: today, sort_order: 'asc', limit: '1000'
  });
  const r = await fetch('https://api.stlouisfed.org/fred/releases/dates?' + qs);
  const j = await r.json();
  if (j.error_code) throw new Error(j.error_message || 'FRED calendar error');
  const rows = (j.release_dates || []).filter(d => wanted.has(d.release_id));
  return buildReleaseCalendar(rows).filter(e => e.at >= Date.now() - 24 * 3600 * 1000);
}

// Cross-market correlation score. Same shape as the browser's refreshCorrelation:
// gold's own daily history is fetched once and reused for every comparison, and
// each instrument is weighted by its measured correlation via macroContribution.
async function computeCorrelation(tdKey, fredKey, deadlineAt) {
  const outOfTime = () => deadlineAt != null && Date.now() >= deadlineAt;
  const contributions = [];
  // Which instruments actually contributed, and which failed. Without this a
  // dead or renamed FRED series just silently drops out of the average and the
  // score quietly reflects fewer inputs than you think it does.
  const contributors = [];
  const failures = [];
  let xauDaily = null;
  try { xauDaily = await twelveSeries(tdKey, '1day', 60); await sleep(1200); }
  catch (e) { xauDaily = null; }

  if (fredKey) {
    for (const inst of FRED_INSTRUMENTS) {
      if (outOfTime()) { failures.push(inst.key + ': skipped, out of time'); continue; }
      try {
        const obs = await fredSeries(inst.seriesId, fredKey, 60);
        // Yields use absolute (basis-point) changes; prices use returns.
        // Calendar-aligned: gold and FRED keep different holidays, and zipping
        // by array position offsets everything before each one.
        const corr = xauDaily ? correlateByDay(xauDaily, obs, inst.kind) : null;
        contributions.push(macroContribution(latestChangeOf(obs, inst.kind), corr, inst.polarity));
        contributors.push(inst.key);
      } catch (e) {
        failures.push(inst.key + ': ' + ((e && e.message) || 'failed'));
      }
    }
  }
  if (xauDaily) {
    for (let i = 0; i < CORRELATION_INSTRUMENTS.length; i++) {
      const inst = CORRELATION_INSTRUMENTS[i];
      if (outOfTime()) { failures.push(inst.key + ': skipped, out of time'); continue; }
      try {
        const candles = await twelveSeries(tdKey, '1day', 60, inst.symbol);
        const corr = correlateByDay(xauDaily, candles, inst.kind);
        contributions.push(macroContribution(latestChangeOf(candles, inst.kind), corr, inst.polarity));
        contributors.push(inst.key);
      } catch (e) {
        failures.push(inst.key + ': ' + ((e && e.message) || 'failed'));
      }
      // Throttle between calls only — sleeping after the final one burned 1.2s
      // of a budget that had nothing left to spend it on.
      if (i < CORRELATION_INSTRUMENTS.length - 1) await sleep(1200);
    }
  }
  return { score: aggregateMacroScore(contributions), available: contributions.length > 0, contributors, failures };
}

// Macro fundamentals from FRED. These are low-frequency prints with no usable
// short-window correlation, so the assumed polarity carries the weight.
async function computeFundamentals(fredKey, deadlineAt) {
  if (!fredKey) return { score: 0, available: false };
  const contributions = [];
  for (const inst of FUNDAMENTAL_INSTRUMENTS) {
    if (deadlineAt != null && Date.now() >= deadlineAt) break;
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

// Refetch a cached input when its refresh window has elapsed OR when the
// configuration that produced it has changed.
//
// The second condition is not theoretical: correlation caches for six hours, so
// after swapping oil and the S&P out of the basket the worker kept serving a
// score computed from the OLD instruments — and from the old, buggy yield
// handling — for hours, with no sign anything was stale. A cached value is only
// valid for the config that produced it, so the signature is part of its identity.
async function cached(state, key, maxAgeMs, fetcher, signature) {
  const meta = state.cacheMeta || (state.cacheMeta = {});
  const sigs = state.cacheSig || (state.cacheSig = {});
  const now = Date.now();
  const sigMatches = signature == null || sigs[key] === signature;
  const fresh = meta[key] && (now - meta[key]) < maxAgeMs;
  if (fresh && sigMatches && state.cache && state.cache[key] != null) {
    return { value: state.cache[key], refreshed: false };
  }
  const value = await fetcher();
  state.cache = state.cache || {};
  state.cache[key] = value;
  meta[key] = now;
  if (signature != null) sigs[key] = signature;
  return { value, refreshed: true };
}

// Identifies the instrument set a cached macro score was computed from. Change
// an instrument, its polarity or its kind and the signature changes with it.
const describe = list => list.map(i => [i.key, i.seriesId || i.symbol, i.polarity, i.kind].join(':')).join('|');
const CORRELATION_SIG = describe(FRED_INSTRUMENTS) + '||' + describe(CORRELATION_INSTRUMENTS);
const FUNDAMENTAL_SIG = describe(FUNDAMENTAL_INSTRUMENTS);

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
      cacheSig: stored.cacheSig || {},
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
    // Each of these may be served straight from cache (cheap) or trigger a full
    // refetch (expensive). Only start one if there is room to finish it, and
    // fall back to the last cached value rather than skipping the tick.
    let corr = { score: 0, available: false }, fund = { score: 0, available: false }, news = { score: 0, available: false };
    let calendar = [];
    const cachedOr = (key, fallback) => (state.cache && state.cache[key] != null) ? state.cache[key] : fallback;
    const macroSkipped = [];

    for (const job of [
      { key: 'correlation', maxAge: REFRESH_MS.correlation, sig: CORRELATION_SIG,
        run: (deadline) => computeCorrelation(tdKey, fredKey, deadline),
        set: v => { corr = v; } },
      { key: 'fundamental', maxAge: REFRESH_MS.fundamental, sig: FUNDAMENTAL_SIG,
        run: (deadline) => computeFundamentals(fredKey, deadline),
        set: v => { fund = v; } },
      { key: 'news', maxAge: REFRESH_MS.news, sig: null,
        run: () => computeNews(avKey),
        set: v => { news = v; } },
      { key: 'calendar', maxAge: REFRESH_MS.calendar, sig: null,
        run: () => fetchReleaseCalendar(fredKey),
        set: v => { calendar = v || []; } }
    ]) {
      const b = budget(started);
      if (b.left < MACRO_MIN_MS) {
        job.set(cachedOr(job.key, job.key === 'calendar' ? [] : { score: 0, available: false }));
        macroSkipped.push(job.key);
        continue;
      }
      try {
        const deadline = Date.now() + b.left - 4000; // leave room to persist and respond
        job.set((await cached(state, job.key, job.maxAge, () => job.run(deadline), job.sig)).value);
      } catch (e) {
        job.set(cachedOr(job.key, job.key === 'calendar' ? [] : { score: 0, available: false }));
        macroSkipped.push(job.key + ' (failed)');
      }
    }

    // ---- 1. grade what the market already decided ------------------------
    // The kill switch runs here, on the unattended side, because this is where
    // an order actually goes stale: the browser may be closed for days while
    // the worker keeps ticking. Overridable per deployment without a redeploy.
    const resolveCfg = Object.assign({}, AUTONOMY_DEFAULTS, {
      maxHoursToFill: envNum('TICK_KILL_FILL_HOURS', AUTONOMY_DEFAULTS.maxHoursToFill),
      maxHoursOpen: envNum('TICK_KILL_OPEN_HOURS', AUTONOMY_DEFAULTS.maxHoursOpen),
      maxDriftRToFill: envNum('TICK_KILL_DRIFT_R', AUTONOMY_DEFAULTS.maxDriftRToFill)
    });
    let resolvedThisTick = 0;
    let killedThisTick = 0;

    // The auditor, not the worker, decides which live trades are past saving.
    // Same reasoning as everywhere else it is used: the engine judging whether
    // its own trade has gone bad is not a check. It re-derives fill state from
    // raw candles instead of trusting the stored status, so bookkeeping that
    // has drifted from what price actually did is caught rather than compounded.
    const tradeAudit = auditOpenTrades(state.signalLog, ltf, {
      maxHoursToFill: resolveCfg.maxHoursToFill,
      maxHoursOpen: resolveCfg.maxHoursOpen,
      maxDriftRToFill: resolveCfg.maxDriftRToFill
    });
    const killedBy = new Map(tradeAudit.kills.map(k => [k.id, k]));

    state.signalLog.forEach(sig => {
      if (sig.status !== 'pending' && sig.status !== 'open') return;
      const verdict = resolveSignal(sig, ltf, resolveCfg);
      // A stop or target that genuinely printed is a real outcome and real
      // evidence; a time limit must not discard it.
      const kill = killedBy.get(sig.id);
      if (kill && verdict.status !== 'won' && verdict.status !== 'lost') {
        sig.status = 'expired';
        sig.expiryReason = 'auditor: ' + kill.reason;
        sig.killSwitch = kill.code;
        sig.resolvedAt = new Date().toISOString();
        sig.resolvedBy = 'auditor';
        killedThisTick++;
        return;
      }
      if (verdict.status === 'won' || verdict.status === 'lost') {
        const won = verdict.status === 'won';
        sig.status = verdict.status;
        sig.resolvedAt = new Date().toISOString();
        sig.resolvedBy = 'worker';
        sig.exitPrice = verdict.exitPrice;
        if (verdict.partial) sig.partial = true;
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
        sig.killSwitch = verdict.killSwitch || null;
        sig.resolvedAt = new Date().toISOString();
        sig.resolvedBy = 'worker';
        // Deliberately no learning update here. An expired signal has no
        // outcome, and manufacturing one from a stale order is exactly the
        // contamination the kill switch exists to prevent.
        killedThisTick++;
      } else if (verdict.status === 'open' && sig.status === 'pending') {
        sig.status = 'open';
        // The browser books the paper fill off this timestamp, so it has to be
        // recorded here rather than invented on arrival.
        sig.filledAt = new Date().toISOString();
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
    // The same independent audit the browser runs. The worker commits signals
    // unattended, so it is the half that most needs an arithmetic check before
    // acting — a plan whose stop sits on the wrong side of entry should never
    // reach Firestore as a live signal.
    const audit = auditAnalysis({
      result, plan, candles: ltf,
      expectedIntervalMs: 15 * 60 * 1000,
      now: Date.now(),
      maxAgeMs: 45 * 60 * 1000,
      knowledgeAssessment: null,
      calibration: null,
      // The unattended path is the one that most needs its inputs checked:
      // nobody is looking at the chart to notice the feed has gone wrong. A
      // timeframe on a different instrument, a stalled provider or a decimal
      // shift would otherwise be analysed with full confidence.
      series: { '15m': ltf, '1H': mtfR.value, '4H': htfR.value, Daily: dayR.value, Weekly: wkR.value },
      macroSeries: (corr.series || []).map(d => ({ key: d.key, label: d.label, series: d.series }))
    });

    const newsState = newsWindowState(calendar, Date.now(), NEWS_WINDOW_DEFAULTS);
    const gateCfg = Object.assign({}, AUTONOMY_DEFAULTS, {
      newsState,
      gradeFloor: process.env.TICK_GRADE_FLOOR || AUTONOMY_DEFAULTS.gradeFloor,
      minConfidence: isFinite(parseFloat(process.env.TICK_MIN_CONFIDENCE))
        ? parseFloat(process.env.TICK_MIN_CONFIDENCE)
        : AUTONOMY_DEFAULTS.minConfidence
    });
    let gate;
    if (audit.blocking) {
      gate = { take: false, code: 'audit',
        reason: 'independent audit found ' + audit.critical + ' critical issue(s): ' + audit.findings[0].title };
    } else {
      gate = autonomyGate(result, plan, state.signalLog, state.lastSignalAt, gateCfg);
    }
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
      cacheSig: state.cacheSig || {},
      lastSignalAt: state.lastSignalAt,
      updatedAt: Date.now()
    }, { merge: true });

    // A small, public copy of the signal log for the dashboard to subscribe to.
    //
    // The worker document above is the worker's own state and carries its
    // candle cache — hundreds of KB that a browser would re-download on every
    // tick for no reason. And latestTick is only a summary: it has a direction
    // and a price but no signal identity, so it can never say which trade was
    // entered or how it ended. Neither was usable as the log's source, which is
    // why autonomously taken trades were invisible in the UI.
    //
    // So: the most recent trades, trimmed to the fields the log actually
    // renders. Enough to show what the system took, whether it filled, and how
    // it resolved.
    const publicSignals = state.signalLog.slice(0, PUBLIC_SIGNAL_LIMIT).map(s => ({
      id: s.id, dir: s.dir, entry: s.entry, sl: s.sl, tp: s.tp,
      entryType: s.entryType, confidence: s.confidence, grade: s.grade,
      session: s.session, time: s.time, status: s.status,
      filledAt: s.filledAt || null,
      resolvedAt: s.resolvedAt || null, resolvedBy: s.resolvedBy || null,
      exitPrice: s.exitPrice != null ? s.exitPrice : null,
      partial: !!s.partial, expiryReason: s.expiryReason || null,
      killSwitch: s.killSwitch || null,
      // The factors and quality features are what the browser learns from, so a
      // merged trade trains the local model exactly like a locally-taken one.
      factors: s.factors || null,
      qualityFeatures: s.qualityFeatures || null,
      metaScore: s.metaScore || 0,
      source: s.source || 'worker'
    }));
    await sysRef.doc(PUBLIC_SIGNALS_DOC).set({
      signalLog: JSON.stringify(publicSignals),
      count: state.signalLog.length,
      updatedAt: Date.now()
    });

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
      killedThisTick,
      tradeAuditReviewed: tradeAudit.reviewed,
      tradeAuditVerdict: tradeAudit.verdict,
      tookSignal,
      gateReason: gate.reason,
      gateCode: gate.code || null,
      auditCritical: audit.critical,
      auditWarnings: audit.warnings,
      auditDataProblem: !!audit.dataProblem,
      auditDataFaults: (audit.dataFaults || []).slice(0, 5).map(f => f.code + ': ' + f.title),
      auditFindings: audit.findings.slice(0, 5).map(f => f.severity + ': ' + f.title),
      newsBlocked: !!newsState.blocked,
      newsActive: newsState.active ? newsState.active.name : null,
      nextRelease: newsState.next ? { name: newsState.next.name, at: newsState.next.at, impact: newsState.next.impact } : null,
      gradeFloor: gateCfg.gradeFloor,
      minConfidence: gateCfg.minConfidence,
      session: result.sessionInfo ? result.sessionInfo.session : null,
      regime: result.regimeInfo ? result.regimeInfo.regime : null,
      macro: {
        correlationAvailable: !!corr.available, correlationScore: corr.score || 0,
        correlationContributors: corr.contributors || [],
        correlationFailures: corr.failures || [],
        fundamentalAvailable: !!fund.available, fundamentalScore: fund.score || 0,
        newsAvailable: !!news.available, newsScore: news.score || 0
      },
      macroSkipped,
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
