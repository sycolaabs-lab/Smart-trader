// ============================================================
// SMART TRADER — APPLICATION SHELL
// ------------------------------------------------------------
// Everything with a side effect lives here: DOM rendering, provider network
// calls, localStorage, Firebase sync, and the autonomous scheduler. The maths
// itself comes from lib/engine.js, which is shared verbatim with the
// server-side worker so unattended analysis can't drift from what's on screen.
// ============================================================
import {
  genData, calcEMA, calcRSI, calcATR, fmt, parseUtcDatetime, aggregateCandles,
  detectSwings, analyzeStructure, detectOrderBlocks, detectFVGs, detectLiquidity,
  detectRoundNumbers, detectSweep, premiumDiscount, getSessionInfo, computeSessionStats,
  detectMarketRegime, buildFeatureVector, historicalSimilarity, buildTheses,
  decisionFusion, downgradeGrade, detectSystemAlert, FRED_INSTRUMENTS,
  CORRELATION_INSTRUMENTS, FUNDAMENTAL_INSTRUMENTS, pearsonCorrelation, toDailyReturns,
  biasScore, detectPriceAction, sliceByTime, computeComposite, PIP_SIZE, hadSweepNear,
  displacementQuality, freshnessScore, htfAlignmentScore, liquidityContextScore,
  sessionRegimeQuality, momentumDivergenceScore, buildQualityFeatures,
  QUALITY_FEATURE_NAMES, classifyZone, trainAdaBoostStumps, scoreAdaBoost,
  buildTradePlan, reasoningText, FACTOR_LABELS, patternSignature,
  computeTunedWeights, runSmcBacktest, setMetaModel,
  AUTONOMY_DEFAULTS, resolveSignal, autonomyGate,
  macroContribution, aggregateMacroScore, pctChangeOf
} from './lib/engine.js';

const LEARNING_KEY = 'smc-factor-stats-v1';
let learningState = { factors: {}, patterns: {}, totalLogged: 0, metaExamples: [], metaModel: null };
Object.keys(FACTOR_LABELS).forEach(k => { learningState.factors[k] = { votes: 0, wins: 0 }; });


async function loadLearningState() {
  try {
    const raw = localStorage.getItem(LEARNING_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      Object.keys(FACTOR_LABELS).forEach(k => { if (!parsed.factors[k]) parsed.factors[k] = { votes: 0, wins: 0 }; });
      if (!parsed.patterns) parsed.patterns = {};
      if (!parsed.metaExamples) parsed.metaExamples = [];
      if (parsed.metaModel === undefined) parsed.metaModel = null;
      learningState = parsed;
      setMetaModel(learningState.metaModel);
    }
  } catch (e) { /* nothing stored yet */ }
  renderLearningTable();
  renderPatternTable();
}
async function saveLearningState() {
  try { localStorage.setItem(LEARNING_KEY, JSON.stringify(learningState)); } catch (e) { /* storage unavailable */ }
  if (fbReady && fbAuth.currentUser) pushCloudState(fbAuth.currentUser.uid);
}
function recordOutcome(dir, factors, won) {
  const dirSign = dir === 'BUY' ? 1 : -1;
  Object.keys(FACTOR_LABELS).forEach(k => {
    const v = factors[k];
    if (v && Math.sign(v) === dirSign) {
      learningState.factors[k].votes++;
      if (won) learningState.factors[k].wins++;
    }
  });
  const sig = patternSignature(dir, factors);
  if (!learningState.patterns[sig]) learningState.patterns[sig] = { votes: 0, wins: 0 };
  learningState.patterns[sig].votes++;
  if (won) learningState.patterns[sig].wins++;
  learningState.totalLogged++;
  saveLearningState();
  renderLearningTable();
  renderPatternTable();
}
function renderPatternTable() {
  const list = document.getElementById('patternList');
  if (!list) return;
  const entries = Object.keys(learningState.patterns)
    .map(sig => ({ sig, v: learningState.patterns[sig] }))
    .filter(e => e.v.votes >= 3)
    .sort((a, b) => (b.v.wins / b.v.votes) - (a.v.wins / a.v.votes));
  if (!entries.length) { list.innerHTML = '<div class="zone-empty">No patterns with 3+ occurrences yet — keep backtesting or logging live signals.</div>'; return; }
  list.innerHTML = entries.slice(0, 6).map(e => {
    const wr = (e.v.wins / e.v.votes * 100);
    const cls = wr >= 55 ? 'fpos' : wr <= 45 ? 'fneg' : 'fneu';
    const niceName = e.sig === 'none' ? 'No confluence' : e.sig.split('+').map(k => FACTOR_LABELS[k] || k).join(' + ');
    return '<div class="zone-item"><span style="max-width:70%;">' + niceName + ' <span style="color:#454a56;">(' + e.v.votes + 'x)</span></span><span class="mono ' + cls + '">' + wr.toFixed(0) + '%</span></div>';
  }).join('');
}
const KB_MIN_TRADES = 15;
function applyKnowledgeBaseWeights() {
  const kbStatus = document.getElementById('kbStatus');
  if (learningState.totalLogged < KB_MIN_TRADES) {
    kbStatus.textContent = 'Knowledge base: ' + learningState.totalLogged + '/' + KB_MIN_TRADES + ' logged outcomes — not enough yet to auto-apply. Backtest on Twelve Data to build it up; using your manually-set weights until then.';
    return false;
  }
  const idByKey = {}; weightIds.forEach(id => { idByKey[weightKeys[id]] = id; });
  Object.keys(FACTOR_LABELS).forEach(k => {
    const s = learningState.factors[k];
    if (s.votes >= 5) {
      const wr = s.wins / s.votes;
      const newWeight = Math.max(2, Math.min(30, Math.round(wr * 100 * 0.4)));
      const el = document.getElementById(idByKey[k]);
      if (el) { el.value = newWeight; document.getElementById(idByKey[k] + 'V').textContent = newWeight; }
    }
  });
  kbStatus.textContent = 'Knowledge base: trained on ' + learningState.totalLogged + ' logged outcomes — weights below were auto-applied from this history and now drive live analysis on whichever provider is connected.';
  return true;
}
function renderLearningTable() {
  const status = document.getElementById('learningStatus');
  status.textContent = learningState.totalLogged
    ? 'Learned from ' + learningState.totalLogged + ' logged trade outcomes (backtests + manually marked live signals), persisted in this browser.'
    : 'No trade outcomes logged yet — run a backtest or mark live signals won/lost below to start building history.';
  const weights = getWeights();
  const table = document.getElementById('learningTable');
  table.innerHTML = Object.keys(FACTOR_LABELS).map(k => {
    const s = learningState.factors[k];
    const wr = s.votes ? (s.wins / s.votes * 100) : null;
    const cls = wr == null ? 'fneu' : wr >= 55 ? 'fpos' : wr <= 45 ? 'fneg' : 'fneu';
    const wrTxt = wr == null ? 'no data' : wr.toFixed(0) + '% (' + s.votes + ')';
    return '<tr><td>' + FACTOR_LABELS[k] + '</td><td class="' + cls + '">' + wrTxt + ' · w=' + weights[k] + '</td></tr>';
  }).join('');
}
document.getElementById('autoTuneBtn').addEventListener('click', () => {
  applyKnowledgeBaseWeights();
  refreshAll(); renderLearningTable();
});
document.getElementById('resetLearning').addEventListener('click', async () => {
  learningState = { factors: {}, patterns: {}, totalLogged: 0, metaExamples: [], metaModel: null };
  Object.keys(FACTOR_LABELS).forEach(k => { learningState.factors[k] = { votes: 0, wins: 0 }; });
  setMetaModel(null);
  await saveLearningState();
  renderLearningTable();
  renderPatternTable();
  applyKnowledgeBaseWeights();
});
// NOTE: startup restore of learning state deliberately does NOT happen here.
// loadLearningState() calls renderLearningTable() -> getWeights(), which reads the
// weightIds/weightKeys consts declared further down this file. Running it at this
// point throws a temporal-dead-zone ReferenceError, which used to abort the whole
// restore chain silently — so saved learning weights were never applied on load.
// The real call now lives in bootstrap() at the end of the file.

const SIGNAL_LOG_KEY = 'smc-signal-log-v1';
let signalLog = [];
async function loadSignalLog() {
  try {
    const raw = localStorage.getItem(SIGNAL_LOG_KEY);
    if (raw) signalLog = JSON.parse(raw);
  } catch (e) { signalLog = []; }
  renderSignalLog();
}
async function saveSignalLog() {
  if (signalLog.length > 200) signalLog = signalLog.slice(-200);
  try { localStorage.setItem(SIGNAL_LOG_KEY, JSON.stringify(signalLog)); } catch (e) { /* storage unavailable */ }
  if (fbReady && fbAuth.currentUser) pushCloudState(fbAuth.currentUser.uid);
}
function addSignalToLog(result, plan) {
  const sig = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    dir: result.direction, entry: plan.entry, sl: plan.sl, tp: plan.tp,
    confidence: result.confidence, factors: Object.assign({}, result.factors),
    session: result.sessionInfo ? result.sessionInfo.session : null,
    grade: result.fusion ? downgradeGrade(result.fusion.grade, plan.metaScore || 0) : null,
    qualityFeatures: plan.qualityFeatures || null, metaScore: plan.metaScore || 0,
    reason: reasoningText(result, plan),
    time: new Date().toISOString(), status: 'pending', mistake: null
  };
  signalLog.unshift(sig);
  saveSignalLog();
  renderSignalLog();
}
// Single place where a signal turns into training data, whether a human clicked
// win/loss or the autonomous resolver read it off the candles. Keeping one path
// means unattended outcomes feed the knowledge base exactly like manual ones.
function applySignalOutcome(sig, won, opts) {
  opts = opts || {};
  if (!sig || (sig.status !== 'pending' && sig.status !== 'open')) return false;
  sig.status = won ? 'won' : 'lost';
  sig.resolvedAt = new Date().toISOString();
  sig.resolvedBy = opts.auto ? 'auto' : 'manual';
  if (opts.exitPrice != null) sig.exitPrice = opts.exitPrice;
  if (opts.ambiguousBar) sig.ambiguousBar = true;
  if (opts.mistakeNote) sig.mistake = opts.mistakeNote;
  recordOutcome(sig.dir, sig.factors, won);
  // Feed the meta-labeler's training set too — retraining itself happens on the next backtest cycle,
  // consistent with the rest of the self-learning loop, rather than retraining on every single resolution.
  if (sig.qualityFeatures) {
    learningState.metaExamples = (learningState.metaExamples || []).concat([{ features: sig.qualityFeatures, label: won ? 1 : -1 }]).slice(-500);
    saveLearningState();
  }
  return true;
}
function markSignalResult(id, won, mistakeNote) {
  const sig = signalLog.find(s => s.id === id);
  if (!applySignalOutcome(sig, won, { mistakeNote: mistakeNote, auto: false })) return;
  saveSignalLog();
  renderSignalLog();
  renderJournalInsights();
}
function renderJournalInsights() {
  const el = document.getElementById('journalInsights');
  if (!el) return;
  // 'open' and 'expired' are not outcomes — only a real win or loss is a data point.
  const resolved = signalLog.filter(s => s.status === 'won' || s.status === 'lost');
  if (resolved.length < 5) { el.textContent = 'Log at least 5 resolved trades to see personalized insights (' + resolved.length + '/5 so far).'; return; }
  const bySession = {};
  resolved.forEach(s => {
    const k = s.session || 'Unknown';
    if (!bySession[k]) bySession[k] = { wins: 0, total: 0 };
    bySession[k].total++; if (s.status === 'won') bySession[k].wins++;
  });
  const lines = Object.keys(bySession).map(k => {
    const s = bySession[k]; const wr = (s.wins / s.total * 100).toFixed(0);
    return k + ': ' + wr + '% (' + s.total + ' trades)';
  });
  const mistakes = resolved.filter(s => s.mistake).length;
  el.innerHTML = 'By session — ' + lines.join(' · ') + (mistakes ? '<br>' + mistakes + ' loss(es) have a logged mistake note — check the log below for patterns.' : '');
}
function renderSignalLog() {
  const log = document.getElementById('tradeLog');
  if (!signalLog.length) { log.innerHTML = '<div class="log-empty">No signals generated yet.</div>'; return; }
  log.innerHTML = '';
  signalLog.slice(0, 15).forEach(sig => {
    const item = document.createElement('div'); item.className = 'log-item'; item.style.flexWrap = 'wrap';
    const timeTxt = new Date(sig.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const gradeTxt = sig.grade ? ' [' + sig.grade + ']' : '';
    const sessionTxt = sig.session ? ' · ' + sig.session : '';
    const stateTxt = sig.status === 'open' ? ' · filled' : sig.status === 'pending' ? ' · awaiting entry' : '';
    item.innerHTML = '<span class="dirtag ' + sig.dir + '">' + sig.dir + gradeTxt + '</span><span class="mono">$' + fmt(sig.entry) + '</span><span class="mono">' + sig.confidence + '%</span><span style="color:#5c6270">' + timeTxt + sessionTxt + stateTxt + '</span>';
    const wrap = document.createElement('span');
    if (sig.status === 'pending' || sig.status === 'open') {
      const wonBtn = document.createElement('button'); wonBtn.textContent = 'Won'; wonBtn.style.cssText = 'background:#123326;color:#3ecf8e;border:1px solid #1e4030;border-radius:5px;font-size:10px;padding:2px 7px;margin-left:6px;cursor:pointer;';
      const lostBtn = document.createElement('button'); lostBtn.textContent = 'Lost'; lostBtn.style.cssText = 'background:#32161a;color:#ef4d5f;border:1px solid #401e22;border-radius:5px;font-size:10px;padding:2px 7px;margin-left:4px;cursor:pointer;';
      wonBtn.addEventListener('click', () => markSignalResult(sig.id, true));
      lostBtn.addEventListener('click', () => {
        const note = window.prompt('Optional: what went wrong with this trade? (helps build your journal — leave blank to skip)');
        markSignalResult(sig.id, false, note || null);
      });
      wrap.appendChild(wonBtn); wrap.appendChild(lostBtn);
    } else {
      const tag = document.createElement('span');
      const colour = sig.status === 'won' ? '#3ecf8e' : sig.status === 'expired' ? '#9298a5' : '#ef4d5f';
      tag.style.cssText = 'font-size:10px;margin-left:6px;color:' + colour + ';';
      const auto = sig.resolvedBy === 'auto' ? ' (auto)' : '';
      if (sig.status === 'won') tag.textContent = '✓ won' + auto;
      else if (sig.status === 'expired') tag.textContent = '– expired' + (sig.expiryReason ? ' · ' + sig.expiryReason : '');
      else tag.textContent = '✗ lost' + auto + (sig.mistake ? ' — ' + sig.mistake : '');
      wrap.appendChild(tag);
    }
    item.appendChild(wrap);
    log.appendChild(item);
  });
  renderJournalInsights();
}
// Restored from bootstrap() at the end of the file, for the same ordering reason
// as the learning state above.

// ============================================================
// FIREBASE CLOUD SYNC (optional — learning knowledge base + signal log only, never API keys)
// ============================================================
// Firebase project: smart-trader-36ae2. Cloud sync activates automatically once fbReady is true below.
const firebaseConfig = {
  apiKey: "AIzaSyB90GIn_PwePfdwQ-_yOMoaTOx9EWK6yQ4",
  authDomain: "smart-trader-36ae2.firebaseapp.com",
  projectId: "smart-trader-36ae2",
  storageBucket: "smart-trader-36ae2.firebasestorage.app",
  messagingSenderId: "649750236079",
  appId: "1:649750236079:web:1e530088f7ef5959f6fd5a"
};
let fbAuth = null, fbDb = null, fbReady = false;
try {
  if (firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY" && typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    fbReady = true;
  }
} catch (e) { console.warn('Firebase not configured:', e.message); }

function updateSyncUI(user) {
  const status = document.getElementById('syncStatus');
  const outPanel = document.getElementById('signedOutPanel');
  const inPanel = document.getElementById('signedInPanel');
  if (!status) return;
  if (!fbReady) { status.textContent = 'Cloud sync not configured yet.'; return; }
  if (user) {
    status.textContent = 'Synced as ' + user.email;
    document.getElementById('signedInEmail').textContent = user.email;
    outPanel.classList.add('hidden'); inPanel.classList.remove('hidden');
  } else {
    status.textContent = 'Not signed in — learning stays on this device only.';
    outPanel.classList.remove('hidden'); inPanel.classList.add('hidden');
  }
}

async function pullCloudState(uid) {
  try {
    const doc = await fbDb.collection('users').doc(uid).get();
    if (doc.exists) {
      const data = doc.data();
      if (data.learningState) {
        const parsed = data.learningState;
        Object.keys(FACTOR_LABELS).forEach(k => { if (!parsed.factors[k]) parsed.factors[k] = { votes: 0, wins: 0 }; });
        if (!parsed.patterns) parsed.patterns = {};
        if (!parsed.metaExamples) parsed.metaExamples = [];
        if (parsed.metaModel === undefined) parsed.metaModel = null;
        learningState = parsed;
        setMetaModel(learningState.metaModel);
      }
      if (data.signalLog) signalLog = data.signalLog;
    } else {
      // First sync for this account — seed the cloud with whatever's currently on this device.
      await pushCloudState(uid);
    }
  } catch (e) { console.warn('Cloud pull failed:', e.message); }
}
async function pushCloudState(uid) {
  try { await fbDb.collection('users').doc(uid).set({ learningState, signalLog, updatedAt: Date.now() }, { merge: true }); }
  catch (e) { console.warn('Cloud push failed:', e.message); }
}

if (fbReady) {
  fbAuth.onAuthStateChanged(async (user) => {
    updateSyncUI(user);
    if (user) {
      await pullCloudState(user.uid);
      renderLearningTable(); renderPatternTable(); renderSignalLog();
      applyKnowledgeBaseWeights();
      if (typeof refreshAll === 'function') refreshAll();
    }
  });
  document.getElementById('signInBtn').addEventListener('click', async () => {
    const email = document.getElementById('authEmailInput').value.trim();
    const pw = document.getElementById('authPasswordInput').value;
    try { await fbAuth.signInWithEmailAndPassword(email, pw); }
    catch (e) { document.getElementById('syncStatus').textContent = 'Sign-in failed: ' + e.message; }
  });
  document.getElementById('signUpBtn').addEventListener('click', async () => {
    const email = document.getElementById('authEmailInput').value.trim();
    const pw = document.getElementById('authPasswordInput').value;
    try { await fbAuth.createUserWithEmailAndPassword(email, pw); }
    catch (e) { document.getElementById('syncStatus').textContent = 'Account creation failed: ' + e.message; }
  });
  document.getElementById('googleSignInBtn').addEventListener('click', async () => {
    try { await fbAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
    catch (e) { document.getElementById('syncStatus').textContent = 'Google sign-in failed: ' + e.message; }
  });
  document.getElementById('signOutBtn').addEventListener('click', async () => { await fbAuth.signOut(); });

  // Live listener on the server's latest tick — public system data, not gated behind sign-in, so this
  // updates in real time even if the browser never signed in and never triggered the tick itself.
  fbDb.collection('system').doc('latestTick').onSnapshot(
    (doc) => {
      const statusEl = document.getElementById('bgTickStatus');
      const detailEl = document.getElementById('bgTickDetail');
      if (!doc.exists) { statusEl.textContent = 'No background tick has landed yet — see setup above.'; return; }
      const d = doc.data();
      const ageMin = Math.round((Date.now() - d.time) / 60000);
      const staleTxt = ageMin > 20 ? ' <span style="color:#454a56;">(stale — check your external scheduler is still running)</span>' : '';
      statusEl.innerHTML = 'Last background tick: ' + ageMin + ' min ago' + staleTxt + (d.resolvedThisTick ? ' · resolved ' + d.resolvedThisTick + ' trade(s) this tick' : '');
      const dirCls = d.direction === 'BUY' ? 'fpos' : d.direction === 'SELL' ? 'fneg' : 'fneu';
      const macroTag = (label, avail, score) => avail
        ? '<span style="' + (score > 0.1 ? 'color:#3ecf8e' : score < -0.1 ? 'color:#ef4d5f' : 'color:#5c6270') + '">' + label + ' ' + (score >= 0 ? '+' : '') + score.toFixed(2) + '</span>'
        : '<span style="color:#454a56;">' + label + ' off</span>';
      const m = d.macro || {};
      detailEl.innerHTML = '<div class="zone-item"><span>' + d.direction + ' <span style="color:#454a56;">(' + d.confidence + '%, full engine — structure + macro + meta-labeler)</span></span><span class="mono ' + dirCls + '">$' + d.price.toFixed(2) + '</span></div>'
        + (d.direction !== 'HOLD' ? '<div class="zone-item"><span>Entry / SL / TP</span><span class="mono">$' + d.entry.toFixed(2) + ' / $' + d.sl.toFixed(2) + ' / $' + d.tp.toFixed(2) + '</span></div>' : '')
        + (d.direction !== 'HOLD' ? '<div class="zone-item"><span>Meta-labeler score</span><span class="mono">' + (d.metaTrained ? ((d.metaScore >= 0 ? '+' : '') + d.metaScore.toFixed(2)) : 'not trained yet') + ' <span style="color:#454a56;font-size:9px;">(' + d.metaExampleCount + ' examples)</span></span></div>' : '')
        + '<div class="zone-item"><span>Macro reads</span><span style="font-size:10px;">' + macroTag('Corr', m.correlationAvailable, m.correlationScore || 0) + ' · ' + macroTag('Fund', m.fundamentalAvailable, m.fundamentalScore || 0) + ' · ' + macroTag('News', m.newsAvailable, m.newsScore || 0) + '</span></div>'
        + '<div class="zone-item"><span>Session / Regime</span><span class="mono" style="font-size:10px;">' + (d.session || '—') + ' · ' + (d.regime || '—') + '</span></div>';
    },
    (err) => { document.getElementById('bgTickStatus').textContent = 'Could not read background tick data: ' + err.message + ' (check Firestore rules allow public read on the "system" collection).'; }
  );
} else {
  updateSyncUI(null);
  const notConfigured = () => { document.getElementById('syncStatus').textContent = 'Cloud sync not configured yet — ask Claude to finish setup with your Firebase config.'; };
  document.getElementById('signInBtn').addEventListener('click', notConfigured);
  document.getElementById('signUpBtn').addEventListener('click', notConfigured);
  document.getElementById('googleSignInBtn').addEventListener('click', notConfigured);
}
document.getElementById('togglePasswordBtn').addEventListener('click', () => {
  const pwInput = document.getElementById('authPasswordInput');
  const btn = document.getElementById('togglePasswordBtn');
  const showing = pwInput.type === 'text';
  pwInput.type = showing ? 'password' : 'text';
  btn.textContent = showing ? '👁' : '🙈';
  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
});
document.getElementById('bgSetupToggle').addEventListener('click', () => {
  document.getElementById('bgSetupNote').classList.toggle('hidden');
});

// ============================================================
// TABS
// ============================================================
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('tab-live').classList.toggle('hidden', t.dataset.tab !== 'live');
    document.getElementById('tab-backtest').classList.toggle('hidden', t.dataset.tab !== 'backtest');
    if (t.dataset.tab === 'live') resizeLiveCanvas();
  });
});

// ============================================================
// WEIGHTS UI
// ============================================================
const weightIds = ['wWeekly', 'wDaily', 'wHtf', 'wMtf', 'wLtf', 'wOb', 'wFvg', 'wLiq', 'wPd', 'wPriceAction', 'wClassic', 'wCorrelation', 'wFundamental', 'wNews'];
const weightKeys = { wWeekly: 'weekly', wDaily: 'daily', wHtf: 'htf', wMtf: 'mtf', wLtf: 'ltf', wOb: 'ob', wFvg: 'fvg', wLiq: 'liquidity', wPd: 'premiumDiscount', wPriceAction: 'priceAction', wClassic: 'classic', wCorrelation: 'correlation', wFundamental: 'fundamental', wNews: 'newsSentiment' };
const weightDefaults = { wWeekly: 15, wDaily: 12, wHtf: 10, wMtf: 8, wLtf: 8, wOb: 9, wFvg: 5, wLiq: 5, wPd: 4, wPriceAction: 9, wClassic: 4, wCorrelation: 7, wFundamental: 8, wNews: 5 };
weightIds.forEach(id => {
  const el = document.getElementById(id), out = document.getElementById(id + 'V');
  el.addEventListener('input', () => { out.textContent = el.value; refreshAll(); });
});
document.getElementById('resetWeights').addEventListener('click', () => {
  weightIds.forEach(id => { document.getElementById(id).value = weightDefaults[id]; document.getElementById(id + 'V').textContent = weightDefaults[id]; });
  document.getElementById('targetRR').value = 4; document.getElementById('targetRRV').textContent = '1:4';
  refreshAll();
});
function getWeights() {
  const w = {};
  weightIds.forEach(id => { w[weightKeys[id]] = +document.getElementById(id).value; });
  return w;
}
const targetRRSlider = document.getElementById('targetRR');
targetRRSlider.addEventListener('input', () => {
  document.getElementById('targetRRV').textContent = '1:' + targetRRSlider.value;
  if (lastComposite) { const plan = buildTradePlan(lastComposite, +targetRRSlider.value); updateSignalUI(lastComposite, plan, false); }
});
function getTargetRR() { return +document.getElementById('targetRR').value; }

// ============================================================
// STATE + CONNECTION
// ============================================================
const SYMBOL = 'XAU/USD';
const LIVE_INTERVAL = '15min';
let apiKey = null, dataMode = 'simulated', activeProvider = null;
let liveData = genData(700, 1928, 900000);
let mtfData = [], htfData = [], dailyData = [], weeklyData = []; // real 1H/4H/Daily/Weekly candles when the provider supports them; empty = fall back to aggregation
let prevClose = liveData[liveData.length - 1].close;
let simTickHandle = null, pollPriceHandle = null, resyncHandle = null, mtfResyncHandle = null, htfResyncHandle = null, corrResyncHandle = null, newsResyncHandle = null, dailyResyncHandle = null, weeklyResyncHandle = null;
let lastComposite = null;
let lastPlan = null;

const connectBtn = document.getElementById('connectBtn');
const connStatus = document.getElementById('connStatus');
const modeLabel = document.getElementById('modeLabel');
const liveDot = document.getElementById('liveDot');
const btSourceNote = document.getElementById('btSourceNote');
const providerSelect = document.getElementById('providerSelect');

// Each provider exposes: timeSeries(key, interval, outputsize) -> candle[], price(key) -> number,
// plus mtfInterval/htfInterval — the native interval strings for that provider's real 1H/4H data
// (null if the provider doesn't support that granularity, in which case the app falls back to
// aggregating from the 15min feed automatically). Adding a new provider means adding one entry here.
const PROVIDERS = {
  twelvedata: {
    label: 'Twelve Data', pollSeconds: 60, resyncMinutes: 10, mtfInterval: '1h', htfInterval: '4h', dailyInterval: '1day', weeklyInterval: '1week',
    async timeSeries(key, interval, outputsize, symbolOverride) {
      const sym = symbolOverride || SYMBOL;
      // timezone=UTC forces Twelve Data to return unambiguous UTC timestamps. Without it, "datetime" comes back
      // with no offset marker (e.g. "2026-08-07 14:30:00"), and new Date(...) on a string like that gets parsed
      // as the BROWSER's local time, not UTC — silently shifting every session/kill-zone calculation by whatever
      // the device's UTC offset happens to be. That's what was causing London to show as New York.
      const qs = new URLSearchParams({ symbol: sym, interval, outputsize, timezone: 'UTC', apikey: key });
      const r = await fetch('https://api.twelvedata.com/time_series?' + qs);
      const j = await r.json();
      if (j.status === 'error' || j.code) throw new Error(j.message || 'Twelve Data error');
      if (!j.values || !j.values.length) throw new Error('No data returned for ' + sym);
      return j.values.slice().reverse().map(v => ({ time: parseUtcDatetime(v.datetime), open: +v.open, high: +v.high, low: +v.low, close: +v.close }));
    },
    async price(key) {
      const qs = new URLSearchParams({ symbol: SYMBOL, apikey: key });
      const r = await fetch('https://api.twelvedata.com/price?' + qs);
      const j = await r.json();
      if (j.status === 'error' || j.code) throw new Error(j.message || 'Twelve Data error');
      const p = parseFloat(j.price);
      if (!isFinite(p)) throw new Error('No price returned');
      return p;
    }
  },
  alphavantage: {
    // Free-tier Alpha Vantage is heavily rate-limited (historically as low as ~25 requests/day) —
    // polling is intentionally slow here. Check your own dashboard for your plan's actual limit.
    // FX_INTRADAY only supports up to 60min — no native 4H/daily/weekly, so those stay null (falls back to aggregation).
    label: 'Alpha Vantage', pollSeconds: 300, resyncMinutes: 30, mtfInterval: '60min', htfInterval: null, dailyInterval: null, weeklyInterval: null,
    async timeSeries(key, interval, outputsize) {
      const qs = new URLSearchParams({ function: 'FX_INTRADAY', from_symbol: 'XAU', to_symbol: 'USD', interval, outputsize: outputsize > 100 ? 'full' : 'compact', apikey: key });
      const r = await fetch('https://www.alphavantage.co/query?' + qs);
      const j = await r.json();
      const seriesKey = Object.keys(j).find(k => k.indexOf('Time Series FX') === 0);
      if (!seriesKey) {
        const raw = j['Error Message'] || j['Note'] || j['Information'] || JSON.stringify(j);
        if (/premium/i.test(raw)) throw new Error('Alpha Vantage intraday FX data requires their paid plan (free tier doesn\'t include it) — try Twelve Data instead.');
        throw new Error(raw || 'Alpha Vantage error — check key or rate limit');
      }
      const series = j[seriesKey];
      const rows = Object.keys(series).sort().map(ts => ({
        time: new Date(ts.replace(' ', 'T') + 'Z').getTime(),
        open: +series[ts]['1. open'], high: +series[ts]['2. high'], low: +series[ts]['3. low'], close: +series[ts]['4. close']
      }));
      return rows.slice(-outputsize);
    },
    async price(key) {
      const qs = new URLSearchParams({ function: 'CURRENCY_EXCHANGE_RATE', from_currency: 'XAU', to_currency: 'USD', apikey: key });
      const r = await fetch('https://www.alphavantage.co/query?' + qs);
      const j = await r.json();
      const node = j['Realtime Currency Exchange Rate'];
      const rate = node && node['5. Exchange Rate'];
      if (!rate) throw new Error(j['Error Message'] || j['Note'] || j['Information'] || 'Alpha Vantage error — check key or rate limit');
      return parseFloat(rate);
    }
  }
};

// ============================================================
// PERSISTED KEYS (opt-in "remember on this device" — auto-reconnect on reload)
// ============================================================
const KEY_STORE_KEY = 'smc-saved-keys-v1';
async function saveKeysIfRemembered() {
  const remember = document.getElementById('rememberKeysCheckbox').checked;
  if (!remember) { await clearSavedKeys(); return; }
  const payload = {
    provider: providerSelect.value,
    apiKey: document.getElementById('apiKeyInput').value.trim(),
    fredKey: document.getElementById('fredKeyInput').value.trim(),
    newsKey: document.getElementById('newsKeyInput').value.trim(),
    autoBacktest: document.getElementById('autoBacktestCheckbox').checked
  };
  try { localStorage.setItem(KEY_STORE_KEY, JSON.stringify(payload)); } catch (e) { /* storage unavailable */ }
}
async function loadSavedKeys() {
  try {
    const raw = localStorage.getItem(KEY_STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* nothing saved */ }
  return null;
}
async function clearSavedKeys() {
  try { localStorage.removeItem(KEY_STORE_KEY); } catch (e) { /* nothing to clear */ }
}
document.getElementById('forgetKeysBtn').addEventListener('click', async () => {
  await clearSavedKeys();
  document.getElementById('rememberKeysCheckbox').checked = false;
  connStatus.textContent = 'Saved keys forgotten on this device.';
  connStatus.className = 'conn-status';
});
document.getElementById('rememberKeysCheckbox').addEventListener('change', () => {
  if (!document.getElementById('rememberKeysCheckbox').checked) clearSavedKeys();
  else if (apiKey) saveKeysIfRemembered();
});

async function fetchHigherTimeframes(provider, key) {
  if (provider.mtfInterval) {
    try { mtfData = await provider.timeSeries(key, provider.mtfInterval, 300); }
    catch (e) { mtfData = []; }
  } else mtfData = [];
  if (provider.htfInterval) {
    try { htfData = await provider.timeSeries(key, provider.htfInterval, 200); }
    catch (e) { htfData = []; }
  } else htfData = [];
  if (provider.dailyInterval) {
    try { dailyData = await provider.timeSeries(key, provider.dailyInterval, 200); }
    catch (e) { dailyData = []; }
  } else dailyData = [];
  if (provider.weeklyInterval) {
    try { weeklyData = await provider.timeSeries(key, provider.weeklyInterval, 104); } // ~2 years of weekly bars
    catch (e) { weeklyData = []; }
  } else weeklyData = [];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchFredSeries(seriesId, fredKey, limit) {
  limit = limit || 60;
  // Routed through /api/fred (same-origin serverless function) instead of calling stlouisfed.org
  // directly from the browser — FRED doesn't set CORS headers for arbitrary sites, so a direct
  // client-side fetch gets silently blocked. The proxy calls FRED server-side, where CORS doesn't apply.
  const qs = new URLSearchParams({ series_id: seriesId, api_key: fredKey, file_type: 'json', sort_order: 'asc', limit: String(limit * 2) });
  const r = await fetch('/api/fred?' + qs);
  const j = await r.json();
  if (j.error_code) throw new Error(j.error_message || 'FRED error');
  if (!j.observations) throw new Error(j.error || 'No observations returned');
  const obs = j.observations.filter(o => o.value !== '.').map(o => ({ time: new Date(o.date + 'T00:00:00Z').getTime(), close: parseFloat(o.value) }));
  if (!obs.length) throw new Error('No usable data points');
  return obs.slice(-limit);
}

let correlationScore = 0;
let correlationDetails = []; // { key, label, source, available, pctChange, corr, contribution, reason }
async function refreshCorrelation(providerId, tdKey, fredKey) {
  const results = [];

  // Fetch gold's own daily history exactly once and reuse it for both FRED and Twelve Data correlation math —
  // fetching it twice was quietly burning one of the eight Twelve Data calls/min this whole engine gets.
  let xauDaily = null;
  if (providerId === 'twelvedata' && tdKey) {
    try { xauDaily = await PROVIDERS.twelvedata.timeSeries(tdKey, '1day', 60); await sleep(1200); }
    catch (e) { xauDaily = null; }
  }
  const xauRets = xauDaily ? toDailyReturns(xauDaily) : null;

  // FRED side — independent of the price provider, no meaningful rate limit, so these always attempt if a key is present.
  if (fredKey) {
    for (const inst of FRED_INSTRUMENTS) {
      try {
        const obs = await fetchFredSeries(inst.seriesId, fredKey, 60);
        const rets = toDailyReturns(obs);
        const corr = xauRets ? pearsonCorrelation(xauRets, rets) : null;
        const pctChange = pctChangeOf(obs);
        // Weight by the ACTUAL measured correlation strength/sign, not the assumed polarity — a genuinely
        // weak or unstable relationship (like oil's has historically been) shrinks toward zero influence on
        // its own instead of me having to guess the right number. Falls back to the assumed polarity only
        // when correlation can't be measured yet (no gold daily history available to compare against).
        results.push({ key: inst.key, label: inst.label, source: 'FRED', available: true, pctChange, corr, contribution: macroContribution(pctChange, corr, inst.polarity), polarity: inst.polarity });
      } catch (e) {
        results.push({ key: inst.key, label: inst.label, source: 'FRED', available: false, reason: e.message });
      }
    }
  } else {
    FRED_INSTRUMENTS.forEach(inst => results.push({ key: inst.key, label: inst.label, source: 'FRED', available: false, reason: 'No FRED API key entered.' }));
  }

  // Twelve Data side — only the instruments FRED can't cover, throttled from the very first call (not just between calls).
  if (providerId === 'twelvedata' && tdKey) {
    if (!xauDaily) {
      CORRELATION_INSTRUMENTS.forEach(inst => results.push({ key: inst.key, label: inst.label, source: 'Twelve Data', available: false, reason: 'Could not fetch gold daily history to correlate against.' }));
    } else {
      for (const inst of CORRELATION_INSTRUMENTS) {
        try {
          const candles = await PROVIDERS.twelvedata.timeSeries(tdKey, '1day', 60, inst.symbol);
          const rets = toDailyReturns(candles);
          const corr = pearsonCorrelation(xauRets, rets);
          const pctChange = pctChangeOf(candles);
          results.push({ key: inst.key, label: inst.label, source: 'Twelve Data', available: true, pctChange, corr, contribution: macroContribution(pctChange, corr, inst.polarity), polarity: inst.polarity });
        } catch (e) {
          results.push({ key: inst.key, label: inst.label, source: 'Twelve Data', available: false, reason: e.message });
        }
        await sleep(1200); // stay well under Twelve Data's free-tier 8 requests/minute cap
      }
    }
  } else {
    CORRELATION_INSTRUMENTS.forEach(inst => results.push({ key: inst.key, label: inst.label, source: 'Twelve Data', available: false, reason: 'Requires Twelve Data as the connected price provider.' }));
  }

  correlationDetails = results;
  const avail = results.filter(r => r.available);
  correlationScore = aggregateMacroScore(avail.map(r => r.contribution));
}

let fundamentalScore = 0;
let fundamentalDetails = []; // { key, label, available, pctChange, contribution, reason }
async function refreshFundamentals(fredKey) {
  const results = [];
  if (!fredKey) {
    FUNDAMENTAL_INSTRUMENTS.forEach(inst => results.push({ key: inst.key, label: inst.label, available: false, reason: 'No FRED API key entered.' }));
    fundamentalDetails = results;
    fundamentalScore = 0;
    return;
  }
  for (const inst of FUNDAMENTAL_INSTRUMENTS) {
    try {
      // 24 monthly/quarterly points is plenty of lookback for these low-frequency series.
      const obs = await fetchFredSeries(inst.seriesId, fredKey, 24);
      if (obs.length < 2) throw new Error('Not enough data points');
      const pctChange = pctChangeOf(obs);
      // No measured correlation for fundamentals — these are low-frequency prints,
      // so the assumed polarity is the weight.
      results.push({ key: inst.key, label: inst.label, available: true, pctChange, contribution: macroContribution(pctChange, null, inst.polarity), polarity: inst.polarity, latestDate: obs[obs.length - 1].time });
    } catch (e) {
      results.push({ key: inst.key, label: inst.label, available: false, reason: e.message });
    }
  }
  fundamentalDetails = results;
  const avail = results.filter(r => r.available);
  fundamentalScore = aggregateMacroScore(avail.map(r => r.contribution));
}

// News Sentiment Engine — Alpha Vantage's own sentiment classifier does the reading, not a homemade keyword scanner.
const NEWS_TOPICS = 'economy_macro,economy_monetary,financial_markets';
let newsSentimentScore = 0;
let newsAvgScore = null;
let newsDetails = [];
let newsError = null;
async function refreshNewsSentiment(avKey) {
  newsError = null;
  if (!avKey) {
    newsDetails = [];
    newsSentimentScore = 0;
    newsAvgScore = null;
    newsError = 'No Alpha Vantage key entered.';
    return;
  }
  try {
    const qs = new URLSearchParams({ function: 'NEWS_SENTIMENT', topics: NEWS_TOPICS, sort: 'LATEST', limit: '50', apikey: avKey });
    const r = await fetch('https://www.alphavantage.co/query?' + qs);
    const j = await r.json();
    const errMsg = j['Error Message'] || j['Note'] || j['Information'];
    if (errMsg) throw new Error(errMsg);
    const feed = j.feed || [];
    if (!feed.length) throw new Error('No articles returned for these topics right now.');
    const articles = feed.slice(0, 15).map(a => ({
      title: a.title, source: a.source, url: a.url, timePublished: a.time_published,
      sentimentScore: parseFloat(a.overall_sentiment_score),
      sentimentLabel: a.overall_sentiment_label
    })).filter(a => !isNaN(a.sentimentScore));
    newsDetails = articles;
    const scores = articles.map(a => a.sentimentScore);
    newsAvgScore = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;
    // Inverted deliberately — see the panel description for why (risk-on market news tends to be gold-bearish).
    newsSentimentScore = Math.max(-1, Math.min(1, -newsAvgScore));
  } catch (e) {
    newsDetails = [];
    newsSentimentScore = 0;
    newsAvgScore = null;
    newsError = e.message;
  }
}

document.getElementById('refreshNewsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshNewsBtn');
  btn.disabled = true; btn.textContent = '...';
  await refreshNewsSentiment(document.getElementById('newsKeyInput').value.trim());
  await saveKeysIfRemembered();
  refreshAll();
  btn.disabled = false; btn.textContent = 'Refresh';
});

document.getElementById('refreshCorrBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshCorrBtn');
  btn.disabled = true; btn.textContent = '...';
  const fredKey = document.getElementById('fredKeyInput').value.trim();
  await refreshCorrelation(activeProvider, apiKey, fredKey);
  await refreshFundamentals(fredKey);
  await saveKeysIfRemembered();
  refreshAll();
  btn.disabled = false; btn.textContent = 'Refresh';
});

// Named + awaitable so bootstrap() can restore a saved connection and then run
// catch-up once it has actually completed, rather than firing a click and hoping.
async function connectProvider() {
  const key = document.getElementById('apiKeyInput').value.trim();
  const providerId = providerSelect.value;
  const provider = PROVIDERS[providerId];
  if (!key) { connStatus.textContent = 'Enter a key first.'; connStatus.className = 'conn-status err'; return; }
  connectBtn.disabled = true; connectBtn.textContent = 'Connecting...';
  connStatus.textContent = 'Connecting to ' + provider.label + '...'; connStatus.className = 'conn-status';
  try {
    const candles = await provider.timeSeries(key, LIVE_INTERVAL, 500);
    apiKey = key; activeProvider = providerId;
    liveData = candles;
    lastPriceUpdateTime = Date.now();
    prevClose = liveData.length > 1 ? liveData[liveData.length - 2].close : liveData[liveData.length - 1].close;
    dataMode = 'live';
    if (simTickHandle) clearInterval(simTickHandle);
    modeLabel.textContent = 'live · ' + LIVE_INTERVAL + ' · ' + provider.label;
    liveDot.classList.add('on');
    connStatus.textContent = 'Connected to ' + provider.label + '. Live 15-minute candles for ' + SYMBOL + '.';
    connStatus.className = 'conn-status ok';
    btSourceNote.textContent = 'Data source: ' + provider.label + ' — connected.';
    await fetchHigherTimeframes(provider, key);
    await refreshCorrelation(providerId, key, document.getElementById('fredKeyInput').value.trim());
    await refreshFundamentals(document.getElementById('fredKeyInput').value.trim());
    await refreshNewsSentiment(document.getElementById('newsKeyInput').value.trim());
    applyKnowledgeBaseWeights();
    refreshAll();
    startLivePolling();
    await saveKeysIfRemembered();
    startAutoBacktest();
  } catch (e) {
    connStatus.textContent = 'Connection failed: ' + e.message + ' — staying on simulated data.';
    connStatus.className = 'conn-status err';
  }
  connectBtn.disabled = false; connectBtn.textContent = 'Connect';
  // A fresh connection is exactly when autonomy should get to work. Without this
  // it would sit idle until the next 60s heartbeat noticed the provider was up.
  if (autonomy.enabled && dataMode === 'live') {
    await autonomyCatchUp();
    autonomy.lastAnalysisAt = null; // the new connection deserves an immediate pass
    autonomyHeartbeat();
  }
}
connectBtn.addEventListener('click', () => { connectProvider(); });

function startLivePolling() {
  if (pollPriceHandle) clearInterval(pollPriceHandle);
  if (resyncHandle) clearInterval(resyncHandle);
  if (mtfResyncHandle) clearInterval(mtfResyncHandle);
  if (htfResyncHandle) clearInterval(htfResyncHandle);
  if (dailyResyncHandle) clearInterval(dailyResyncHandle);
  if (weeklyResyncHandle) clearInterval(weeklyResyncHandle);
  const provider = PROVIDERS[activeProvider];
  pollPriceHandle = setInterval(pollPrice, provider.pollSeconds * 1000);
  resyncHandle = setInterval(resyncCandles, provider.resyncMinutes * 60 * 1000);
  // Higher timeframes resync on their own natural cadence — no point re-fetching a 4H
  // candle that hasn't closed yet, and it's cheaper on the API quota than constant polling.
  if (provider.mtfInterval) mtfResyncHandle = setInterval(() => { PROVIDERS[activeProvider].timeSeries(apiKey, provider.mtfInterval, 300).then(d => { mtfData = d; refreshAll(); }).catch(() => {}); }, 60 * 60 * 1000);
  if (provider.htfInterval) htfResyncHandle = setInterval(() => { PROVIDERS[activeProvider].timeSeries(apiKey, provider.htfInterval, 200).then(d => { htfData = d; refreshAll(); }).catch(() => {}); }, 4 * 60 * 60 * 1000);
  // Daily/weekly candles barely move intraday — resyncing a few times a day (daily) or once a day
  // (weekly) is plenty and keeps this well clear of any provider's rate limit.
  if (provider.dailyInterval) dailyResyncHandle = setInterval(() => { PROVIDERS[activeProvider].timeSeries(apiKey, provider.dailyInterval, 200).then(d => { dailyData = d; refreshAll(); }).catch(() => {}); }, 12 * 60 * 60 * 1000);
  if (provider.weeklyInterval) weeklyResyncHandle = setInterval(() => { PROVIDERS[activeProvider].timeSeries(apiKey, provider.weeklyInterval, 104).then(d => { weeklyData = d; refreshAll(); }).catch(() => {}); }, 24 * 60 * 60 * 1000);
  // Correlation uses daily bars — no point checking more than a few times a day.
  if (corrResyncHandle) clearInterval(corrResyncHandle);
  corrResyncHandle = setInterval(() => {
    const fk = document.getElementById('fredKeyInput').value.trim();
    refreshCorrelation(activeProvider, apiKey, fk).then(() => refreshFundamentals(fk)).then(refreshAll);
  }, 4 * 60 * 60 * 1000);
  // News sentiment resyncs less often than everything else — Alpha Vantage's free tier is the tightest
  // rate limit in this whole app, and headline-level sentiment doesn't meaningfully change hour to hour.
  if (newsResyncHandle) clearInterval(newsResyncHandle);
  newsResyncHandle = setInterval(() => {
    refreshNewsSentiment(document.getElementById('newsKeyInput').value.trim()).then(refreshAll);
  }, 6 * 60 * 60 * 1000);
}
let lastPriceUpdateTime = null;
async function pollPrice() {
  if (!apiKey || !activeProvider) return;
  try {
    const p = await PROVIDERS[activeProvider].price(apiKey);
    const last = liveData[liveData.length - 1];
    last.close = p; last.high = Math.max(last.high, p); last.low = Math.min(last.low, p);
    lastPriceUpdateTime = Date.now();
    refreshAll();
  } catch (e) { connStatus.textContent = 'Price update failed: ' + e.message; connStatus.className = 'conn-status err'; }
}
async function resyncCandles() {
  if (!apiKey || !activeProvider) return;
  try {
    liveData = await PROVIDERS[activeProvider].timeSeries(apiKey, LIVE_INTERVAL, 500);
    lastPriceUpdateTime = Date.now();
    refreshAll();
  } catch (e) { /* keep last good data */ }
}
// If the feed hasn't produced a real price update in far longer than expected, entries/SL/TP generated
// from it are stale — this makes that visible instead of silently trading against an out-of-date market.
function checkFeedStaleness() {
  const warnEl = document.getElementById('staleFeedWarning');
  if (!warnEl) return;
  if (dataMode !== 'live' || !lastPriceUpdateTime || !activeProvider) { warnEl.classList.add('hidden'); return; }
  const provider = PROVIDERS[activeProvider];
  const staleThresholdMs = provider.pollSeconds * 1000 * 4; // 4 missed polls in a row = genuinely stale, not just one slow tick
  const ageMs = Date.now() - lastPriceUpdateTime;
  if (ageMs > staleThresholdMs) {
    const ageMin = Math.round(ageMs / 60000);
    warnEl.textContent = '⚠ Price feed stale — last real update ' + ageMin + ' min ago. Entries/SL/TP below may not reflect the current market. Try reconnecting.';
    warnEl.classList.remove('hidden');
  } else {
    warnEl.classList.add('hidden');
  }
}

// ============================================================
// CHART
// ============================================================
const chartCanvas = document.getElementById('chartCanvas');
const chartCtx = chartCanvas.getContext('2d');
function resizeLiveCanvas() {
  const rect = chartCanvas.parentElement.getBoundingClientRect();
  const w = Math.min(rect.width - 2, window.innerWidth - 22);
  const h = 260;
  chartCanvas.width = w * window.devicePixelRatio; chartCanvas.height = h * window.devicePixelRatio;
  chartCanvas.style.width = w + 'px'; chartCanvas.style.height = h + 'px';
  chartCtx.setTransform(1, 0, 0, 1, 0, 0); chartCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
  drawChart(chartCtx, w, h);
}
function drawChart(ctx, w, h) {
  const visible = liveData.slice(-80);
  const offset = liveData.length - visible.length;
  ctx.clearRect(0, 0, w, h);
  const pad = { top: 16, bottom: 16, left: 4, right: 4 };
  const chartW = w - pad.left - pad.right, chartH = h - pad.top - pad.bottom;
  const minP = Math.min(...visible.map(d => d.low)) - 1, maxP = Math.max(...visible.map(d => d.high)) + 1;
  const range = maxP - minP || 1;
  const xStep = chartW / (visible.length - 1 || 1);
  const xOf = idx => pad.left + (idx - offset) * xStep;
  const yOf = price => pad.top + (maxP - price) / range * chartH;

  ctx.strokeStyle = '#1a1d26'; ctx.lineWidth = 0.5;
  for (let i = 0; i < 5; i++) { let y = pad.top + (i / 4) * chartH; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke(); }

  if (lastComposite) {
    [...lastComposite.obs, ...lastComposite.fvgs].forEach(z => {
      if (z.mitigated || z.index < offset - 5) return;
      const x1 = Math.max(pad.left, xOf(z.index));
      const x2 = w - pad.right;
      const y1 = yOf(z.high), y2 = yOf(z.low);
      ctx.fillStyle = z.dir === 'bullish' ? 'rgba(62,207,142,0.10)' : 'rgba(239,77,95,0.10)';
      ctx.fillRect(x1, y1, x2 - x1, Math.max(1, y2 - y1));
      ctx.strokeStyle = z.dir === 'bullish' ? 'rgba(62,207,142,0.35)' : 'rgba(239,77,95,0.35)';
      ctx.lineWidth = 1; ctx.strokeRect(x1, y1, x2 - x1, Math.max(1, y2 - y1));
    });
  }

  for (let i = 0; i < visible.length; i++) {
    const d = visible[i], x = pad.left + i * xStep;
    const yHigh = yOf(d.high), yLow = yOf(d.low), yOpen = yOf(d.open), yClose = yOf(d.close);
    const isBull = d.close >= d.open;
    ctx.fillStyle = isBull ? '#3ecf8e' : '#ef4d5f'; ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yHigh); ctx.lineTo(x, yLow); ctx.stroke();
    const bodyTop = Math.min(yOpen, yClose), bodyH = Math.max(1, Math.abs(yOpen - yClose));
    ctx.fillRect(x - 2.5, bodyTop, 5, bodyH);
  }

  const ema9 = calcEMA(liveData, 9), ema21 = calcEMA(liveData, 21), ema50 = calcEMA(liveData, 50);
  function drawEMA(arr, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath(); let started = false;
    for (let i = 0; i < visible.length; i++) {
      const idx = offset + i, val = arr[idx]; if (val == null) continue;
      const x = pad.left + i * xStep, y = yOf(val);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  drawEMA(ema9, '#4f8bff'); drawEMA(ema21, '#ffa726'); drawEMA(ema50, '#8b93a3');
}

// ============================================================
// UI REFRESH
// ============================================================
function badgeHtml(trend, labels) {
  labels = labels || { bullish: 'BULL', bearish: 'BEAR', neutral: 'NEUTRAL' };
  const cls = trend === 'bullish' ? 'bullish' : trend === 'bearish' ? 'bearish' : 'neutral';
  const txt = trend === 'bullish' ? labels.bullish : trend === 'bearish' ? labels.bearish : labels.neutral;
  return '<span class="badge ' + cls + '">' + txt + '</span>';
}
function refreshAll() {
  const weights = getWeights();
  lastComposite = computeComposite(liveData, liveData.length - 1, weights, mtfData, htfData, correlationScore, fundamentalScore, newsSentimentScore, dailyData, weeklyData);
  if (!lastComposite) return;
  const r = lastComposite;
  lastPlan = buildTradePlan(lastComposite, getTargetRR());

  document.getElementById('livePrice').innerText = '$' + fmt(r.price);
  const change = r.price - prevClose, pct = (change / prevClose) * 100;
  const chEl = document.getElementById('priceChange');
  chEl.innerText = (change >= 0 ? '+' : '') + fmt(change) + ' (' + (change >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
  document.getElementById('livePrice').className = 'price mono ' + (change >= 0 ? 'up' : 'down');
  chEl.style.color = change >= 0 ? '#3ecf8e' : '#ef4d5f';

  document.getElementById('mRsi').innerText = r.curRsi.toFixed(1);
  document.getElementById('mAtr').innerText = fmt(r.atr);
  document.getElementById('mEma').innerText = fmt(r.cEma9) + ' / ' + fmt(r.cEma21);
  document.getElementById('mZone').innerHTML = r.pd ? badgeHtml(r.pd.zone === 'premium' ? 'bearish' : 'bullish', { bullish: 'DISCOUNT', bearish: 'PREMIUM' }) : badgeHtml('neutral');

  document.getElementById('biasWeekly').innerHTML = badgeHtml(r.structWeekly.trend);
  document.getElementById('biasDaily').innerHTML = badgeHtml(r.structDaily.trend);
  document.getElementById('biasLtf').innerHTML = badgeHtml(r.structLtf.trend);
  document.getElementById('biasMtf').innerHTML = badgeHtml(r.structMtf.trend);
  document.getElementById('biasHtf').innerHTML = badgeHtml(r.structHtf.trend);

  const lastEv = r.structLtf.events.length ? r.structLtf.events[r.structLtf.events.length - 1] : null;
  document.getElementById('lastEvent').textContent = lastEv
    ? 'LTF: ' + lastEv.type + ' ' + lastEv.direction + ' at $' + fmt(lastEv.level) + ' (' + (liveData.length - 1 - lastEv.index) + ' bars ago)'
    : 'No structure break detected yet.';
  document.getElementById('priceActionLine').textContent = r.priceAction && r.priceAction.pattern
    ? 'Price action: ' + r.priceAction.pattern + ' on the latest candle.'
    : 'No price action pattern on the latest candle.';

  const obList = document.getElementById('obList');
  const activeObs = r.obs.filter(o => !o.mitigated).slice(-4).reverse();
  obList.innerHTML = activeObs.length ? activeObs.map(o => {
    const c = classifyZone(o, o.dir === 'bullish' ? 'BUY' : 'SELL', r);
    const strengthCls = c.strength === 'Strong' ? 'fpos' : c.strength === 'Weak' ? 'fneg' : 'fneu';
    const badge = c.isActive
      ? '<span class="' + strengthCls + '">' + c.strength + '</span>'
      : '<span style="color:#454a56;">Dead</span>';
    return '<div class="zone-item ' + o.dir + '" style="' + (c.isActive ? '' : 'opacity:0.55;') + '"><span>' + (o.dir === 'bullish' ? '🟢 Bullish OB' : '🔴 Bearish OB') + ' <span style="font-size:9px;">(' + badge + ')</span></span><span class="mono">$' + fmt(o.low) + ' – $' + fmt(o.high) + '</span></div>';
  }).join('') : '<div class="zone-empty">None detected in current window.</div>';

  const fvgList = document.getElementById('fvgList');
  const activeFvgs = r.fvgs.filter(f => !f.mitigated).slice(-4).reverse();
  fvgList.innerHTML = activeFvgs.length ? activeFvgs.map(f => {
    const c = classifyZone(f, f.dir === 'bullish' ? 'BUY' : 'SELL', r);
    const strengthCls = c.strength === 'Strong' ? 'fpos' : c.strength === 'Weak' ? 'fneg' : 'fneu';
    const badge = c.isActive
      ? '<span class="' + strengthCls + '">' + c.strength + '</span>'
      : '<span style="color:#454a56;">Dead</span>';
    return '<div class="zone-item ' + f.dir + '" style="' + (c.isActive ? '' : 'opacity:0.55;') + '"><span>' + (f.dir === 'bullish' ? '🟢 Bullish FVG' : '🔴 Bearish FVG') + ' <span style="font-size:9px;">(' + badge + ')</span></span><span class="mono">$' + fmt(f.low) + ' – $' + fmt(f.high) + '</span></div>';
  }).join('') : '<div class="zone-empty">None detected in current window.</div>';

  document.getElementById('liqBuySide').textContent = r.liquidity.buySideLiquidity.length;
  document.getElementById('liqSellSide').textContent = r.liquidity.sellSideLiquidity.length;

  const mapEntries = [];
  r.liquidity.buySideLiquidity.forEach(l => mapEntries.push({ price: l.price, label: 'Buy-side liquidity (equal highs)', strength: l.strength, type: 'liq-high' }));
  r.liquidity.sellSideLiquidity.forEach(l => mapEntries.push({ price: l.price, label: 'Sell-side liquidity (equal lows)', strength: l.strength, type: 'liq-low' }));
  r.roundNumbers.forEach(p => mapEntries.push({ price: p, label: 'Round number', strength: null, type: 'round' }));
  mapEntries.sort((a, b) => Math.abs(a.price - r.price) - Math.abs(b.price - r.price));
  const liqList = document.getElementById('liqMapList');
  liqList.innerHTML = mapEntries.slice(0, 7).map(e => {
    const dist = e.price - r.price;
    const pips = Math.abs(dist) / PIP_SIZE;
    const dirCls = e.type === 'liq-high' ? 'bullish' : e.type === 'liq-low' ? 'bearish' : 'bullish';
    const strengthTxt = e.strength ? ' · ' + e.strength + ' touches' : '';
    return '<div class="zone-item ' + (e.type === 'liq-low' ? 'bearish' : '') + '"><span>' + e.label + strengthTxt + '</span><span class="mono">$' + fmt(e.price) + ' (' + (dist >= 0 ? '+' : '') + pips.toFixed(0) + 'p)</span></div>';
  }).join('') || '<div class="zone-empty">No pools detected.</div>';

  const sweepEl = document.getElementById('sweepAlert');
  if (r.sweep) { sweepEl.textContent = '⚠ ' + r.sweep.note; sweepEl.classList.remove('hidden'); }
  else sweepEl.classList.add('hidden');

  // Session & Regime
  document.getElementById('sessionBadge').innerHTML = '<span class="badge neutral">' + r.sessionInfo.session + '</span>';
  document.getElementById('regimeBadge').textContent = r.regimeInfo.regime;
  const kzEl = document.getElementById('killZoneAlert');
  if (r.sessionInfo.killZone) { kzEl.textContent = '⚡ ' + r.sessionInfo.killZone + ' active — expect sharper, faster moves.'; kzEl.classList.remove('hidden'); }
  else kzEl.classList.add('hidden');
  document.getElementById('tfSourceNote').textContent = (r.mtfIsReal ? '1H: real' : '1H: aggregated') + ' · ' + (r.htfIsReal ? '4H: real' : '4H: aggregated') + ' · ' + (r.dailyIsReal ? 'Daily: real' : 'Daily: aggregated') + ' · ' + (r.weeklyIsReal ? 'Weekly: real' : 'Weekly: aggregated (thin — connect Twelve Data for a real weekly read)');

  // Historical Similarity
  const hs = document.getElementById('histSimContent');
  if (r.histSim) {
    hs.innerHTML = 'Found <strong style="color:#e8c37a;">' + r.histSim.count + '</strong> similar past setups (next ' + r.histSim.avgDurationBars + ' bars): '
      + '<span class="fpos">' + r.histSim.bullishPct + '% bullish</span> / <span class="fneg">' + r.histSim.bearishPct + '% bearish</span>. '
      + 'Avg move: ' + (r.histSim.avgMovePct >= 0 ? '+' : '') + r.histSim.avgMovePct.toFixed(2) + '%, range across outcomes: ' + r.histSim.rangePct.toFixed(2) + '%.';
  } else {
    hs.textContent = 'Not enough history yet to compare (needs 80+ candles of context).';
  }

  // Correlation Engine
  const corrList = document.getElementById('correlationList');
  if (corrList) {
    if (!correlationDetails.length) {
      corrList.innerHTML = '<div class="zone-empty">Enter a FRED key and/or connect Twelve Data, then hit Refresh.</div>';
    } else {
      corrList.innerHTML = correlationDetails.map(d => {
        const srcTag = ' <span style="color:#454a56;font-size:9px;">[' + d.source + ']</span>';
        if (!d.available) return '<div class="zone-item" style="border-left-color:#454a56;"><span>' + d.label + srcTag + '</span><span style="color:#454a56;font-size:10px;" title="' + (d.reason || '') + '">unavailable</span></div>';
        const changeCls = d.pctChange >= 0 ? 'fpos' : 'fneg';
        const corrTxt = d.corr == null ? 'n/a' : (d.corr >= 0.4 ? 'strong +' : d.corr <= -0.4 ? 'strong −' : Math.abs(d.corr) >= 0.15 ? (d.corr > 0 ? 'weak +' : 'weak −') : 'flat') + (d.corr != null ? ' (' + d.corr.toFixed(2) + ')' : '');
        const confirms = d.contribution !== 0 && lastComposite && lastComposite.direction !== 'HOLD' && Math.sign(d.contribution) === (lastComposite.direction === 'BUY' ? 1 : -1);
        const flagTxt = lastComposite && lastComposite.direction !== 'HOLD' ? (confirms ? ' <span class="fpos">✓ confirms</span>' : ' <span class="fneg">✗ contradicts</span>') : '';
        return '<div class="zone-item ' + (d.pctChange < 0 ? 'bearish' : '') + '"><span>' + d.label + srcTag + ' <span style="color:#454a56;">(' + corrTxt + ')</span></span><span class="mono ' + changeCls + '">' + (d.pctChange >= 0 ? '+' : '') + d.pctChange.toFixed(2) + '%' + flagTxt + '</span></div>';
      }).join('');
    }
  }

  // Fundamental Intelligence Engine
  const fundList = document.getElementById('fundamentalList');
  if (fundList) {
    if (!fundamentalDetails.length) {
      fundList.innerHTML = '<div class="zone-empty">Enter a FRED key above, then hit Refresh.</div>';
    } else {
      fundList.innerHTML = fundamentalDetails.map(d => {
        if (!d.available) return '<div class="zone-item" style="border-left-color:#454a56;"><span>' + d.label + '</span><span style="color:#454a56;font-size:10px;" title="' + (d.reason || '') + '">unavailable</span></div>';
        const changeCls = d.pctChange >= 0 ? 'fpos' : 'fneg';
        const confirms = d.contribution !== 0 && lastComposite && lastComposite.direction !== 'HOLD' && Math.sign(d.contribution) === (lastComposite.direction === 'BUY' ? 1 : -1);
        const flagTxt = lastComposite && lastComposite.direction !== 'HOLD' ? (confirms ? ' <span class="fpos">✓ confirms</span>' : ' <span class="fneg">✗ contradicts</span>') : '';
        const dateTxt = d.latestDate ? new Date(d.latestDate).toLocaleDateString([], { month: 'short', year: 'numeric' }) : '';
        return '<div class="zone-item ' + (d.pctChange < 0 ? 'bearish' : '') + '"><span>' + d.label + ' <span style="color:#454a56;font-size:9px;">(' + dateTxt + ')</span></span><span class="mono ' + changeCls + '">' + (d.pctChange >= 0 ? '+' : '') + d.pctChange.toFixed(2) + '%' + flagTxt + '</span></div>';
      }).join('');
    }
  }

  // News Sentiment Engine
  const newsSummaryEl = document.getElementById('newsSummary');
  const newsListEl = document.getElementById('newsList');
  if (newsSummaryEl && newsListEl) {
    if (newsError) {
      newsSummaryEl.innerHTML = '<span style="color:#454a56;">' + newsError + '</span>';
      newsListEl.innerHTML = '';
    } else if (!newsDetails.length) {
      newsSummaryEl.textContent = 'Enter an Alpha Vantage key above, then hit Refresh.';
      newsListEl.innerHTML = '';
    } else {
      const leanTxt = newsSentimentScore > 0.1 ? 'leans bullish for gold' : newsSentimentScore < -0.1 ? 'leans bearish for gold' : 'roughly neutral for gold';
      const leanCls = newsSentimentScore > 0.1 ? 'fpos' : newsSentimentScore < -0.1 ? 'fneg' : 'fneu';
      newsSummaryEl.innerHTML = 'Avg raw market sentiment: <span class="mono">' + (newsAvgScore >= 0 ? '+' : '') + newsAvgScore.toFixed(3) + '</span> across ' + newsDetails.length + ' articles → inverted reading <span class="' + leanCls + '">' + leanTxt + '</span>.';
      newsListEl.innerHTML = newsDetails.slice(0, 8).map(a => {
        const cls = a.sentimentScore > 0.15 ? 'fpos' : a.sentimentScore < -0.15 ? 'fneg' : 'fneu';
        const timeTxt = a.timePublished ? a.timePublished.slice(4, 6) + '/' + a.timePublished.slice(6, 8) + ' ' + a.timePublished.slice(9, 11) + ':' + a.timePublished.slice(11, 13) : '';
        const titleShort = a.title.length > 70 ? a.title.slice(0, 70) + '…' : a.title;
        return '<div class="zone-item"><span style="max-width:75%;">' + titleShort + ' <span style="color:#454a56;font-size:9px;">(' + (a.source || '') + ' · ' + timeTxt + ')</span></span><span class="mono ' + cls + '">' + a.sentimentLabel + '</span></div>';
      }).join('');
    }
  }

  // Contrarian theses + fusion
  const metaScoreForGrade = (r.direction !== 'HOLD' && lastPlan) ? lastPlan.metaScore : 0;
  const displayGrade = downgradeGrade(r.fusion.grade, metaScoreForGrade);
  document.getElementById('tradeGrade').textContent = displayGrade;
  const metaNote = metaScoreForGrade < -0.15 ? ('meta-labeler flags this candidate as historically weak (score: ' + metaScoreForGrade.toFixed(2) + ')') : null;
  document.getElementById('riskLevel').textContent = metaNote ? (r.fusion.riskLevel === 'Normal' ? metaNote : r.fusion.riskLevel + '; ' + metaNote) : r.fusion.riskLevel;
  document.getElementById('bullThesis').textContent = r.fusion.theses.bull.length ? r.fusion.theses.bull.join(', ') : 'No supporting factors right now.';
  document.getElementById('bearThesis').textContent = r.fusion.theses.bear.length ? r.fusion.theses.bear.join(', ') : 'No supporting factors right now.';
  document.getElementById('neutralThesis').textContent = r.fusion.theses.neutral.length ? r.fusion.theses.neutral.join(', ') : 'None.';

  checkFeedStaleness();

  const alertEl = document.getElementById('systemAlertBanner');
  if (alertEl) {
    const alert = detectSystemAlert(r.factors, r.atrArr);
    if (alert.active) { alertEl.textContent = '🔍 ' + alert.message; alertEl.classList.remove('hidden'); }
    else alertEl.classList.add('hidden');
  }

  const metaStatusEl = document.getElementById('metaLabelerStatus');
  if (metaStatusEl) {
    const numExamples = (learningState.metaExamples || []).length;
    const trained = !!(learningState.metaModel && learningState.metaModel.length);
    metaStatusEl.textContent = trained
      ? 'Trained on ' + numExamples + ' labeled trades (win/loss), ' + learningState.metaModel.length + ' boosted stumps in the ensemble. Retrains each backtest cycle.'
      : 'Collecting examples: ' + numExamples + '/15 needed before the meta-labeler can train. Run a backtest or resolve live signals to build this up.';
  }

  resizeLiveCanvas();
}

function updateSignalUI(result, plan, logIt) {
  const dirDisplay = document.getElementById('dirDisplay');
  dirDisplay.className = 'dir';
  if (result.direction === 'BUY') { dirDisplay.classList.add('buy'); dirDisplay.innerText = '📈 BUY'; }
  else if (result.direction === 'SELL') { dirDisplay.classList.add('sell'); dirDisplay.innerText = '📉 SELL'; }
  else { dirDisplay.classList.add('hold'); dirDisplay.innerText = '⏸ HOLD'; }
  document.getElementById('confidenceLabel').textContent = result.confidence + '% confidence';
  document.getElementById('sEntry').innerText = '$' + fmt(plan.entry);
  document.getElementById('sSl').innerText = '$' + fmt(plan.sl);
  document.getElementById('sTp').innerText = '$' + fmt(plan.tp);
  document.getElementById('sRr').innerText = plan.rr.toFixed(2) + ':1';
  document.getElementById('sEntryType').innerText = plan.entryType === 'market' ? 'Entry (mkt)' : 'Entry (limit)';
  document.getElementById('sSlPips').innerText = plan.slPips.toFixed(0) + ' pips';
  document.getElementById('sTpPips').innerText = plan.tpPips.toFixed(0) + ' pips';
  document.getElementById('sReason').innerText = reasoningText(result, plan);

  const metaBox = document.getElementById('metaLabelerBox');
  if (result.direction !== 'HOLD' && plan.qualityFeatures) {
    metaBox.classList.remove('hidden');
    const trained = !!(learningState.metaModel && learningState.metaModel.length);
    const scoreEl = document.getElementById('metaScoreValue');
    const s = plan.metaScore || 0;
    scoreEl.textContent = (s >= 0 ? '+' : '') + s.toFixed(2);
    scoreEl.className = 'mono ' + (s > 0.15 ? 'fpos' : s < -0.15 ? 'fneg' : 'fneu');
    document.getElementById('metaScoreStatus').textContent = trained
      ? 'Trained on ' + (learningState.metaExamples ? learningState.metaExamples.length : 0) + ' labeled trades, ' + learningState.metaModel.length + ' stumps.'
      : 'Not enough labeled trades yet (need 15+) — score is neutral until trained.';
    document.getElementById('metaFeatureTable').innerHTML = QUALITY_FEATURE_NAMES.map((name, i) => {
      const v = plan.qualityFeatures[i];
      const cls = v > 0.6 ? 'fpos' : v < 0.35 ? 'fneg' : 'fneu';
      return '<tr><td>' + name + '</td><td class="' + cls + '">' + v.toFixed(2) + '</td></tr>';
    }).join('');
  } else {
    metaBox.classList.add('hidden');
  }

  const labels = FACTOR_LABELS;
  const table = document.getElementById('factorTable');
  table.innerHTML = Object.keys(labels).map(k => {
    const val = result.factors[k], w = result.weights[k], contrib = (val * w / result.totalWeight * 100);
    const cls = contrib > 1 ? 'fpos' : contrib < -1 ? 'fneg' : 'fneu';
    const sign = contrib > 0 ? '+' : '';
    return '<tr><td>' + labels[k] + '</td><td class="' + cls + '">' + sign + contrib.toFixed(1) + '%</td></tr>';
  }).join('');

  if (logIt && result.direction !== 'HOLD') {
    addSignalToLog(result, plan);
  }
}
document.getElementById('genBtn').addEventListener('click', function () {
  const btn = this; btn.disabled = true; btn.innerText = 'Analyzing...';
  setTimeout(() => {
    refreshAll();
    if (lastComposite) { const plan = buildTradePlan(lastComposite, getTargetRR()); updateSignalUI(lastComposite, plan, true); }
    btn.disabled = false; btn.innerText = 'Generate';
  }, 450);
});

function liveTick() {
  if (dataMode !== 'simulated') return;
  const last = liveData[liveData.length - 1];
  const drift = (Math.random() - 0.5) * 1.1;
  const newClose = Math.max(1500, last.close + drift);
  last.close = +newClose.toFixed(2); last.high = Math.max(last.high, last.close); last.low = Math.min(last.low, last.close);
  refreshAll();
}
refreshAll();
window.addEventListener('resize', resizeLiveCanvas);
simTickHandle = setInterval(liveTick, 2000);
if (lastComposite) { const plan = buildTradePlan(lastComposite, getTargetRR()); updateSignalUI(lastComposite, plan, false); }

function drawEquityCurve(curve, capital) {
  const canvas = document.getElementById('equityCanvas'); const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.min(rect.width - 2, window.innerWidth - 22), h = 180;
  canvas.width = w * window.devicePixelRatio; canvas.height = h * window.devicePixelRatio;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(window.devicePixelRatio, window.devicePixelRatio); ctx.clearRect(0, 0, w, h);
  const pad = { top: 14, bottom: 14, left: 4, right: 4 }, chartW = w - pad.left - pad.right, chartH = h - pad.top - pad.bottom;
  const values = curve.map(c => c.equity);
  const minV = Math.min(...values, capital) * 0.98, maxV = Math.max(...values, capital) * 1.02, range = maxV - minV || 1;
  ctx.strokeStyle = '#1a1d26'; ctx.lineWidth = 0.5;
  for (let i = 0; i < 4; i++) { let y = pad.top + (i / 3) * chartH; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke(); }
  const baseY = pad.top + (maxV - capital) / range * chartH;
  ctx.strokeStyle = '#33384a'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.left, baseY); ctx.lineTo(w - pad.right, baseY); ctx.stroke(); ctx.setLineDash([]);
  const finalUp = values[values.length - 1] >= capital;
  ctx.strokeStyle = finalUp ? '#3ecf8e' : '#ef4d5f'; ctx.lineWidth = 2; ctx.beginPath();
  curve.forEach((c, idx) => { const x = pad.left + (idx / (curve.length - 1 || 1)) * chartW, y = pad.top + (maxV - c.equity) / range * chartH; if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
}
async function runBacktestCycle(isAuto) {
  const btn = document.getElementById('runBtBtn');
  if (isAuto && btn.disabled) return; // don't overlap with a manual run in progress
  btn.disabled = true; btn.innerText = isAuto ? 'Auto-backtesting...' : 'Running walk-forward test...';
  const autoStatus = document.getElementById('autoBacktestStatus');
  try {
    const baseWeights = getWeights();
    const params = {
      minConfidence: parseFloat(document.getElementById('pMinConf').value) || 35,
      riskPct: parseFloat(document.getElementById('pRisk').value) || 1,
      capital: parseFloat(document.getElementById('pCapital').value) || 10000
    };
    const bars = parseInt(document.getElementById('pBars').value) || 900;
    const targetRR = parseFloat(document.getElementById('pTargetRR').value) || 4;
    const costPips = parseFloat(document.getElementById('pCostPips').value) || 0;

    let histData;
    if (dataMode === 'live' && apiKey && activeProvider) {
      try {
        histData = await PROVIDERS[activeProvider].timeSeries(apiKey, LIVE_INTERVAL, Math.min(bars, 5000));
        btSourceNote.textContent = 'Data source: ' + PROVIDERS[activeProvider].label + ' — ' + histData.length + ' × 15min candles for ' + SYMBOL + '.';
      } catch (e) {
        btSourceNote.textContent = 'Live history fetch failed (' + e.message + ') — using simulated data instead.';
        histData = genData(bars, 1850, 900000);
      }
    } else {
      histData = genData(bars, 1850, 900000);
      btSourceNote.textContent = 'Data source: simulated (connect an API key above to backtest on real 15min history).';
    }

    // Pass 1: run with base weights to gather in-sample (train) trades for tuning
    const passA = runSmcBacktest(histData, params, baseWeights, targetRR, costPips);
    const splitIdx = Math.floor(histData.length * 0.7);
    const trainTrades = passA.trades.filter(t => t.entryIndex < splitIdx);
    const { tuned } = computeTunedWeights(trainTrades, baseWeights);

    // Pass 2: re-run full data with tuned weights; only trades opened after the split are genuinely out-of-sample
    const passB = runSmcBacktest(histData, params, tuned, targetRR, costPips);
    const testTrades = passB.trades.filter(t => t.entryIndex >= splitIdx);

    // Only out-of-sample outcomes feed the persisted learning system, to avoid rewarding overfit patterns
    testTrades.forEach(t => recordOutcome(t.dir, t.factors, t.result === 'win'));

    // Meta-labeler: same out-of-sample discipline. Each out-of-sample trade with a real quality-feature
    // vector becomes a labeled example (win=1, loss=-1), capped so the training set doesn't grow unbounded.
    const newExamples = testTrades.filter(t => t.qualityFeatures).map(t => ({ features: t.qualityFeatures, label: t.result === 'win' ? 1 : -1 }));
    learningState.metaExamples = (learningState.metaExamples || []).concat(newExamples).slice(-500);
    learningState.metaModel = trainAdaBoostStumps(learningState.metaExamples, 20);
    setMetaModel(learningState.metaModel);
    saveLearningState();

    lastWalkForward = { tuned, baseWeights };
    const trainWR = trainTrades.length ? (trainTrades.filter(t => t.result === 'win').length / trainTrades.length * 100) : 0;
    const testWR = testTrades.length ? (testTrades.filter(t => t.result === 'win').length / testTrades.length * 100) : 0;
    const trainPnl = trainTrades.reduce((s, t) => s + t.pnl, 0);
    const testPnl = testTrades.reduce((s, t) => s + t.pnl, 0);
    document.getElementById('wfTrainTrades').textContent = trainTrades.length;
    document.getElementById('wfTestTrades').textContent = testTrades.length;
    document.getElementById('wfTrainWR').textContent = trainWR.toFixed(1) + '%';
    document.getElementById('wfTestWR').textContent = testWR.toFixed(1) + '%';
    document.getElementById('wfTrainPnl').textContent = (trainPnl >= 0 ? '+' : '') + '$' + trainPnl.toFixed(0);
    document.getElementById('wfTestPnl').textContent = (testPnl >= 0 ? '+' : '') + '$' + testPnl.toFixed(0);

    const result = passB;
    document.getElementById('btEmpty').classList.add('hidden');
    document.getElementById('btResults').classList.remove('hidden');
    drawEquityCurve(result.equityCurve, params.capital);

    const wins = result.trades.filter(t => t.result === 'win'), losses = result.trades.filter(t => t.result === 'loss');
    const winRate = result.trades.length ? (wins.length / result.trades.length * 100) : 0;
    const totalReturn = ((result.finalEquity - params.capital) / params.capital) * 100;
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0), grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss) : (grossWin > 0 ? Infinity : 0);

    document.getElementById('btTrades').innerText = result.trades.length;
    document.getElementById('btWinrate').innerText = winRate.toFixed(1) + '%';
    const retEl = document.getElementById('btReturn');
    retEl.innerText = (totalReturn >= 0 ? '+' : '') + totalReturn.toFixed(1) + '%';
    retEl.className = 'v mono ' + (totalReturn >= 0 ? 'pos' : 'neg');
    document.getElementById('btDD').innerText = '-' + result.maxDD.toFixed(1) + '%';
    document.getElementById('btPF').innerText = isFinite(pf) ? pf.toFixed(2) : '∞';
    document.getElementById('btFinal').innerText = '$' + result.finalEquity.toFixed(0);

    const tbody = document.getElementById('btTradeBody'); tbody.innerHTML = '';
    result.trades.slice().reverse().forEach((t, idx) => {
      const seg = t.entryIndex < splitIdx ? 'train' : 'test';
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + (result.trades.length - idx) + '</td><td>' + seg + '</td><td>' + t.dir + '</td><td class="mono">' + t.confidence + '%</td><td class="mono">' + fmt(t.entry) + '</td><td class="mono">' + fmt(t.exit) + '</td><td class="mono ' + t.result + '">' + (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) + '</td><td class="' + t.result + '">' + t.result.toUpperCase() + '</td>';
      tbody.appendChild(tr);
    });
    if (isAuto && autoStatus) {
      autoStatus.textContent = 'Last auto-backtest: ' + new Date().toLocaleTimeString() + '. Next run in ~4 hours while this tab stays open and connected.';
    }
  } catch (e) {
    btSourceNote.textContent = 'Backtest failed: ' + e.message;
    if (isAuto && autoStatus) autoStatus.textContent = 'Last auto-backtest failed: ' + e.message + '. Will retry on the next cycle.';
  }
  btn.disabled = false; btn.innerText = 'Run Backtest';
}
document.getElementById('runBtBtn').addEventListener('click', () => runBacktestCycle(false));

let autoBacktestHandle = null;
function startAutoBacktest() {
  if (autoBacktestHandle) clearInterval(autoBacktestHandle);
  const cb = document.getElementById('autoBacktestCheckbox');
  const status = document.getElementById('autoBacktestStatus');
  if (!cb.checked) { status.textContent = 'Auto-backtest is off — check the box above to enable self-learning.'; return; }
  if (dataMode !== 'live') { status.textContent = 'Connect a real data provider to enable auto-backtesting.'; return; }
  status.textContent = 'Self-learning active — first auto-backtest running now, then every ~4 hours while this tab stays open.';
  runBacktestCycle(true);
  autoBacktestHandle = setInterval(() => {
    if (document.getElementById('autoBacktestCheckbox').checked && dataMode === 'live') runBacktestCycle(true);
  }, 4 * 60 * 60 * 1000);
}
document.getElementById('autoBacktestCheckbox').addEventListener('change', () => {
  if (document.getElementById('autoBacktestCheckbox').checked) startAutoBacktest();
  else { if (autoBacktestHandle) clearInterval(autoBacktestHandle); document.getElementById('autoBacktestStatus').textContent = 'Auto-backtest is off — check the box above to enable self-learning.'; }
});

let lastWalkForward = null;
document.getElementById('applyWfWeightsBtn').addEventListener('click', () => {
  if (!lastWalkForward) return;
  const idByKey = {}; weightIds.forEach(id => { idByKey[weightKeys[id]] = id; });
  Object.keys(lastWalkForward.tuned).forEach(k => {
    const el = document.getElementById(idByKey[k]);
    if (el) { el.value = lastWalkForward.tuned[k]; document.getElementById(idByKey[k] + 'V').textContent = lastWalkForward.tuned[k]; }
  });
  refreshAll(); renderLearningTable();
});

// ============================================================
// AUTONOMOUS MODE
// ------------------------------------------------------------
// The unattended operator. Once the user ticks the box, a single heartbeat
// drives everything: fetch fresh candles, grade any signal that has since hit
// its stop or target, re-analyse, commit a new signal if the gate clears, and
// periodically re-backtest and retrain on the record it has built.
//
// Three things make this survive real-world conditions rather than only a tab
// left open on a desk:
//   * One 60s heartbeat with due-time checks, not a pile of setIntervals. A
//     laptop that sleeps for six hours wakes up, sees every task is overdue,
//     and runs them once — rather than firing a backlog of missed timers.
//   * Losing the connection is expected, not exceptional. Offline is a quiet
//     pause; repeated failures back off exponentially instead of hammering a
//     rate-limited provider until the key is blocked.
//   * Time with the tab closed is recovered, not lost. catchUp() replays the
//     gap from real candle history on the next load, so signals that resolved
//     while nobody was watching still become training data.
// ============================================================

const AUTONOMY_KEY = 'smc-autonomy-v1';
const AUTONOMY_HEARTBEAT_MS = 60 * 1000;

let autonomy = {
  enabled: false,
  cycles: 0,
  signalsTaken: 0,
  autoResolved: 0,
  lastAnalysisAt: null,
  lastBacktestAt: null,
  lastSignalAt: null,
  lastReason: null,
  consecutiveErrors: 0,
  skipCycles: 0,
  lastError: null
};
let autonomyHandle = null;
let autonomyBusy = false;

function autonomyConfig() {
  const num = (id, fallback) => {
    const el = document.getElementById(id);
    const v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v : fallback;
  };
  return Object.assign({}, AUTONOMY_DEFAULTS, {
    minConfidence: num('aMinConf', AUTONOMY_DEFAULTS.minConfidence),
    cooldownMinutes: num('aCooldown', AUTONOMY_DEFAULTS.cooldownMinutes),
    maxOpenSignals: num('aMaxOpen', AUTONOMY_DEFAULTS.maxOpenSignals),
    analysisIntervalMinutes: num('aInterval', AUTONOMY_DEFAULTS.analysisIntervalMinutes),
    backtestIntervalHours: num('aBtHours', AUTONOMY_DEFAULTS.backtestIntervalHours),
    minMetaScore: num('aMinMeta', AUTONOMY_DEFAULTS.minMetaScore)
  });
}

function saveAutonomyState() {
  try {
    localStorage.setItem(AUTONOMY_KEY, JSON.stringify({
      enabled: autonomy.enabled,
      cycles: autonomy.cycles,
      signalsTaken: autonomy.signalsTaken,
      autoResolved: autonomy.autoResolved,
      lastAnalysisAt: autonomy.lastAnalysisAt,
      lastBacktestAt: autonomy.lastBacktestAt,
      lastSignalAt: autonomy.lastSignalAt,
      cfg: {
        aMinConf: document.getElementById('aMinConf').value,
        aCooldown: document.getElementById('aCooldown').value,
        aMaxOpen: document.getElementById('aMaxOpen').value,
        aInterval: document.getElementById('aInterval').value,
        aBtHours: document.getElementById('aBtHours').value,
        aMinMeta: document.getElementById('aMinMeta').value
      }
    }));
  } catch (e) { /* storage unavailable — autonomy still works, it just won't remember across reloads */ }
}

function loadAutonomyState() {
  try {
    const raw = localStorage.getItem(AUTONOMY_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(autonomy, {
      enabled: !!saved.enabled,
      cycles: saved.cycles || 0,
      signalsTaken: saved.signalsTaken || 0,
      autoResolved: saved.autoResolved || 0,
      lastAnalysisAt: saved.lastAnalysisAt || null,
      lastBacktestAt: saved.lastBacktestAt || null,
      lastSignalAt: saved.lastSignalAt || null
    });
    if (saved.cfg) {
      Object.keys(saved.cfg).forEach(id => {
        const el = document.getElementById(id);
        if (el && saved.cfg[id] != null) el.value = saved.cfg[id];
      });
    }
    document.getElementById('autonomyEnabled').checked = autonomy.enabled;
  } catch (e) { /* nothing saved yet */ }
}

function setAutonomyStatus(text, tone, reason) {
  const dot = document.getElementById('autonomyDot');
  const status = document.getElementById('autonomyStatus');
  const reasonEl = document.getElementById('autonomyReason');
  if (!status) return;
  status.textContent = text;
  const colours = { live: '#3ecf8e', warn: '#ffa726', error: '#ef4d5f', idle: '#454a56' };
  const c = colours[tone] || colours.idle;
  dot.style.background = c;
  dot.style.boxShadow = tone === 'live' ? '0 0 7px ' + c : 'none';
  status.style.color = tone === 'idle' ? '#9298a5' : c;
  if (reason !== undefined) reasonEl.textContent = reason || '';
}

function renderAutonomyStats() {
  const open = signalLog.filter(s => s.status === 'pending' || s.status === 'open').length;
  document.getElementById('aCycles').textContent = autonomy.cycles;
  document.getElementById('aSignals').textContent = autonomy.signalsTaken;
  document.getElementById('aResolved').textContent = autonomy.autoResolved;
  document.getElementById('aOpen').textContent = open;
}

// Grade every unresolved signal against `candles`. Used both by the heartbeat
// (fresh candles each cycle) and by catchUp() (deep history after downtime).
// Returns how many signals reached a win/loss verdict.
function resolveOpenSignals(candles, cfg) {
  if (!candles || candles.length < 2) return 0;
  let resolved = 0, changed = false;
  signalLog.forEach(sig => {
    if (sig.status !== 'pending' && sig.status !== 'open') return;
    const verdict = resolveSignal(sig, candles, cfg);
    if (verdict.status === 'won' || verdict.status === 'lost') {
      if (applySignalOutcome(sig, verdict.status === 'won', {
        auto: true, exitPrice: verdict.exitPrice, ambiguousBar: verdict.ambiguousBar
      })) { resolved++; changed = true; }
    } else if (verdict.status === 'expired') {
      sig.status = 'expired';
      sig.expiryReason = verdict.reason || null;
      sig.resolvedAt = new Date().toISOString();
      sig.resolvedBy = 'auto';
      changed = true; // expired signals never become training data — no outcome to learn from
    } else if (verdict.status === 'open' && sig.status === 'pending') {
      sig.status = 'open'; // limit entry got tagged; it's a live position now
      changed = true;
    }
  });
  if (changed) { saveSignalLog(); renderSignalLog(); }
  if (resolved) autonomy.autoResolved += resolved;
  return resolved;
}

// One unattended pass. Everything that can fail is inside the caller's try.
async function autonomyCycle() {
  const cfg = autonomyConfig();
  const now = Date.now();

  // 1. Fresh candles. resyncCandles() already refreshes liveData from the provider.
  await resyncCandles();

  // 2. Grade what the market has already decided since the last pass.
  const graded = resolveOpenSignals(liveData, cfg);

  // 3. Re-analyse on the new data.
  refreshAll();
  autonomy.lastAnalysisAt = now;

  // 4. Commit a signal only if the gate clears.
  let reason;
  if (lastComposite) {
    const plan = buildTradePlan(lastComposite, getTargetRR());
    const gate = autonomyGate(lastComposite, plan, signalLog, autonomy.lastSignalAt, cfg);
    if (gate.take) {
      updateSignalUI(lastComposite, plan, true); // logIt = true -> addSignalToLog
      autonomy.signalsTaken++;
      autonomy.lastSignalAt = now;
      reason = 'Took a ' + lastComposite.direction + ' at $' + fmt(plan.entry) +
               ' (' + lastComposite.confidence + '% confidence' + (gate.grade ? ', grade ' + gate.grade : '') + ').';
    } else {
      updateSignalUI(lastComposite, plan, false); // keep the panel current without logging
      reason = 'No signal taken — ' + gate.reason + '.';
    }
  } else {
    reason = 'Analysis produced no result this cycle.';
  }
  if (graded) reason = 'Self-graded ' + graded + ' signal' + (graded === 1 ? '' : 's') + '. ' + reason;
  autonomy.lastReason = reason;

  // 5. Periodic re-backtest / retrain on the accumulated record.
  const btDue = !autonomy.lastBacktestAt || (now - autonomy.lastBacktestAt) >= cfg.backtestIntervalHours * 3600 * 1000;
  if (btDue) {
    autonomy.lastBacktestAt = now;
    await runBacktestCycle(true);
  }

  autonomy.cycles++;
  autonomy.consecutiveErrors = 0;
  autonomy.lastError = null;
  saveAutonomyState();
  renderAutonomyStats();
  setAutonomyStatus('Running autonomously — last pass ' + new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.', 'live', reason);
}

// The heartbeat: decides whether a cycle is due, and handles every reason it
// might not be. Deliberately does no analysis itself.
async function autonomyHeartbeat() {
  if (!autonomy.enabled || autonomyBusy) return;

  if (!navigator.onLine) {
    setAutonomyStatus('Paused — no internet connection. Resumes automatically.', 'warn',
      'Nothing is lost while offline; the gap gets replayed from candle history once the connection is back.');
    return;
  }
  if (dataMode !== 'live') {
    setAutonomyStatus('Waiting for a live data provider — connect an API key above.', 'warn',
      'Autonomous mode needs real candles; it will not run on the simulated feed.');
    return;
  }
  if (autonomy.skipCycles > 0) {
    autonomy.skipCycles--;
    setAutonomyStatus('Backing off after an error — retrying in ' + (autonomy.skipCycles + 1) + ' min.', 'warn', autonomy.lastError);
    return;
  }

  const cfg = autonomyConfig();
  const dueAt = (autonomy.lastAnalysisAt || 0) + cfg.analysisIntervalMinutes * 60 * 1000;
  if (Date.now() < dueAt) {
    const mins = Math.ceil((dueAt - Date.now()) / 60000);
    setAutonomyStatus('Running autonomously — next pass in ' + mins + ' min.', 'live', autonomy.lastReason);
    return;
  }

  autonomyBusy = true;
  try {
    await autonomyCycle();
  } catch (e) {
    autonomy.consecutiveErrors++;
    autonomy.lastError = (e && e.message) || String(e);
    // Exponential backoff, capped at ~30 min. A rate-limited or expired key
    // should not turn into a request every minute for the rest of the day.
    autonomy.skipCycles = Math.min(Math.pow(2, autonomy.consecutiveErrors), 30);
    setAutonomyStatus('Cycle failed (' + autonomy.consecutiveErrors + ' in a row) — backing off ' + autonomy.skipCycles + ' min.', 'error', autonomy.lastError);
    saveAutonomyState();
  } finally {
    autonomyBusy = false;
  }
}

// Replay the time the app was closed or disconnected. Pulls the deepest history
// the provider allows and grades every still-open signal against it, so a signal
// that hit its target overnight is training data by the time the user looks.
async function autonomyCatchUp() {
  if (dataMode !== 'live' || !navigator.onLine) return;
  const stillOpen = signalLog.filter(s => s.status === 'pending' || s.status === 'open');
  if (!stillOpen.length) return;
  setAutonomyStatus('Catching up — replaying ' + stillOpen.length + ' unresolved signal(s) against real history…', 'warn', '');
  try {
    const history = await PROVIDERS[activeProvider].timeSeries(apiKey, LIVE_INTERVAL, 5000);
    const n = resolveOpenSignals(history, autonomyConfig());
    renderAutonomyStats();
    saveAutonomyState();
    setAutonomyStatus('Catch-up complete.', autonomy.enabled ? 'live' : 'idle',
      n ? 'Graded ' + n + ' signal(s) that resolved while the app was closed.'
        : 'No signals had resolved while the app was closed.');
  } catch (e) {
    // Not fatal — the regular heartbeat will keep trying against live candles.
    setAutonomyStatus('Catch-up could not fetch history — continuing on live candles.', 'warn', (e && e.message) || String(e));
  }
}

function startAutonomy() {
  if (autonomyHandle) clearInterval(autonomyHandle);
  autonomyHandle = setInterval(autonomyHeartbeat, AUTONOMY_HEARTBEAT_MS);
  autonomy.skipCycles = 0;
  autonomy.consecutiveErrors = 0;
  setAutonomyStatus('Autonomous mode on — first pass starting…', 'live', '');
  autonomy.lastAnalysisAt = null; // force an immediate first pass
  autonomyHeartbeat();
}

function stopAutonomy() {
  if (autonomyHandle) { clearInterval(autonomyHandle); autonomyHandle = null; }
  setAutonomyStatus('Off — check the box above to start.', 'idle', '');
}

document.getElementById('autonomyEnabled').addEventListener('change', function () {
  autonomy.enabled = this.checked;
  saveAutonomyState();
  if (autonomy.enabled) startAutonomy(); else stopAutonomy();
});
document.getElementById('autonomyAdvancedToggle').addEventListener('click', () => {
  document.getElementById('autonomyAdvanced').classList.toggle('hidden');
});
['aMinConf', 'aCooldown', 'aMaxOpen', 'aInterval', 'aBtHours', 'aMinMeta'].forEach(id => {
  document.getElementById(id).addEventListener('change', saveAutonomyState);
});

// React to connectivity changes straight away rather than waiting out a heartbeat.
window.addEventListener('online', () => {
  if (!autonomy.enabled) return;
  autonomy.skipCycles = 0;
  autonomy.consecutiveErrors = 0;
  setAutonomyStatus('Back online — catching up…', 'warn', '');
  autonomyCatchUp().then(autonomyHeartbeat);
});
window.addEventListener('offline', () => {
  if (autonomy.enabled) setAutonomyStatus('Paused — no internet connection. Resumes automatically.', 'warn', '');
});
// Coming back to a backgrounded tab is a good moment to check for missed work:
// mobile browsers in particular throttle timers hard once a tab is hidden.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && autonomy.enabled) autonomyHeartbeat();
});

// ============================================================
// BOOTSTRAP
// ------------------------------------------------------------
// Ordering matters here, which is why it is one explicit sequence rather than
// scattered top-level calls: persisted learning state has to be restored (and
// its weights applied) before the first analysis, and every DOM const further
// up this file has to exist before anything reads it.
// ============================================================
async function bootstrap() {
  await loadLearningState();
  await loadSignalLog();
  applyKnowledgeBaseWeights();
  loadAutonomyState();
  renderAutonomyStats();
  refreshAll();

  const saved = await loadSavedKeys();
  if (!saved) {
    document.getElementById('autoBacktestStatus').textContent = 'Connect a data provider to enable auto-backtesting.';
  } else {
    document.getElementById('rememberKeysCheckbox').checked = true;
    if (saved.provider) providerSelect.value = saved.provider;
    if (saved.fredKey) document.getElementById('fredKeyInput').value = saved.fredKey;
    if (saved.newsKey) document.getElementById('newsKeyInput').value = saved.newsKey;
    if (typeof saved.autoBacktest === 'boolean') document.getElementById('autoBacktestCheckbox').checked = saved.autoBacktest;
    if (saved.apiKey) {
      document.getElementById('apiKeyInput').value = saved.apiKey;
      connStatus.textContent = 'Restoring saved connection...';
      await connectProvider(); // also re-fetches correlation/fundamentals/news with the restored keys
    } else if (saved.fredKey || saved.newsKey) {
      // No price provider was connected, but FRED/news keys were saved independently — restore those engines too.
      await refreshCorrelation(activeProvider, apiKey, saved.fredKey || '');
      await refreshFundamentals(saved.fredKey || '');
      await refreshNewsSentiment(saved.newsKey || '');
      refreshAll();
      document.getElementById('autoBacktestStatus').textContent = 'Connect a data provider to enable auto-backtesting.';
    } else {
      document.getElementById('autoBacktestStatus').textContent = 'Connect a data provider to enable auto-backtesting.';
    }
  }

  // Recover anything that resolved while the app was closed, then pick the loop back up.
  if (autonomy.enabled) {
    await autonomyCatchUp();
    startAutonomy();
  } else {
    setAutonomyStatus('Off — check the box above to start.', 'idle', '');
  }
}
bootstrap();
