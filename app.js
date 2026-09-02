// ============================================================
// SMART TRADER — APPLICATION SHELL
// ------------------------------------------------------------
// Everything with a side effect lives here: DOM rendering, provider network
// calls, localStorage, Firebase sync, and the autonomous scheduler. The maths
// itself comes from lib/engine.js, which is shared verbatim with the
// server-side worker so unattended analysis can't drift from what's on screen.
// ============================================================
import {
  genData, calcEMA, fmt, parseUtcDatetime, premiumDiscount, downgradeGrade,
  detectSystemAlert, FRED_INSTRUMENTS, CORRELATION_INSTRUMENTS,
  FUNDAMENTAL_INSTRUMENTS, pearsonCorrelation, toDailyReturns,
  computeComposite, PIP_SIZE, QUALITY_FEATURE_NAMES, classifyZone,
  trainAdaBoostStumps, buildTradePlan, reasoningText, FACTOR_LABELS,
  patternSignature, computeTunedWeights, runSmcBacktest, setMetaModel,
  AUTONOMY_DEFAULTS, resolveSignal, autonomyGate, macroContribution,
  aggregateMacroScore, pctChangeOf, computeCalibration,
  computeConditionBreakdown, computeGateAudit, dataInventory, utcDayKey, rollQuota,
  canSpend, spendQuota, quotaSummary, criticalReserveFor, PAPER_DEFAULTS,
  openPaperPosition, closePaperPosition, unrealisedPnl, paperAccountSummary,
  GATE_LABELS
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

// The setups the gate turned down, tracked and resolved exactly like real ones.
// This is the ledger no trading journal has: without it, "should I loosen my
// filter?" can only ever be answered by feel. Capped, and never counted as a
// trade — these are measurements, not signals.
const SHADOW_LOG_KEY = 'smc-shadow-log-v1';
const SHADOW_LOG_MAX = 250;
let shadowLog = [];
async function loadShadowLog() {
  try {
    const raw = localStorage.getItem(SHADOW_LOG_KEY);
    if (raw) shadowLog = JSON.parse(raw);
  } catch (e) { shadowLog = []; }
}
async function saveShadowLog() {
  try { localStorage.setItem(SHADOW_LOG_KEY, JSON.stringify(shadowLog.slice(0, SHADOW_LOG_MAX))); }
  catch (e) { /* storage unavailable */ }
}
function addShadowSignal(result, plan, declineReason) {
  if (!result || result.direction === 'HOLD' || !plan) return;
  if (!isFinite(plan.entry) || !isFinite(plan.sl) || !isFinite(plan.tp) || plan.rr <= 0) return;
  // One shadow per bar at most, so a 15-minute cadence doesn't log the same
  // standing setup dozens of times and swamp the comparison.
  const lastBarTime = liveData.length ? liveData[liveData.length - 1].time : null;
  if (shadowLog.length && shadowLog[0].barTime === lastBarTime) return;
  shadowLog.unshift({
    id: 'sh-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    dir: result.direction, entry: plan.entry, sl: plan.sl, tp: plan.tp,
    entryType: plan.entryType, confidence: result.confidence,
    session: result.sessionInfo ? result.sessionInfo.session : null,
    regime: result.regimeInfo ? result.regimeInfo.regime : null,
    grade: result.fusion ? downgradeGrade(result.fusion.grade, plan.metaScore || 0) : null,
    metaScore: plan.metaScore || 0,
    declineReason: declineReason || null,
    barTime: lastBarTime,
    time: new Date().toISOString(), status: plan.entryType === 'market' ? 'open' : 'pending'
  });
  shadowLog = shadowLog.slice(0, SHADOW_LOG_MAX);
  saveShadowLog();
}
async function loadSignalLog() {
  try {
    const raw = localStorage.getItem(SIGNAL_LOG_KEY);
    if (raw) signalLog = JSON.parse(raw);
  } catch (e) { signalLog = []; }
  renderSignalLog();
}
// Newest-first, so trimming takes from the TAIL. slice(-N) here kept the OLDEST
// N instead, which meant that once the log filled, every newly logged signal was
// dropped on the very next save — it could never be resolved, so the knowledge
// base stopped accumulating entirely at the cap.
const SIGNAL_LOG_MAX = 600;
async function saveSignalLog() {
  if (signalLog.length > SIGNAL_LOG_MAX) signalLog = signalLog.slice(0, SIGNAL_LOG_MAX);
  try { localStorage.setItem(SIGNAL_LOG_KEY, JSON.stringify(signalLog)); } catch (e) { /* storage unavailable */ }
  if (fbReady && fbAuth.currentUser) pushCloudState(fbAuth.currentUser.uid);
}
function addSignalToLog(result, plan) {
  const sig = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    dir: result.direction, entry: plan.entry, sl: plan.sl, tp: plan.tp,
    confidence: result.confidence, factors: Object.assign({}, result.factors),
    session: result.sessionInfo ? result.sessionInfo.session : null,
    regime: result.regimeInfo ? result.regimeInfo.regime : null,
    entryType: plan.entryType,
    grade: result.fusion ? downgradeGrade(result.fusion.grade, plan.metaScore || 0) : null,
    qualityFeatures: plan.qualityFeatures || null, metaScore: plan.metaScore || 0,
    reason: reasoningText(result, plan),
    time: new Date().toISOString(), status: 'pending', mistake: null
  };
  signalLog.unshift(sig);
  saveSignalLog();
  renderSignalLog();
  paperOpenForSignal(sig);
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
  paperCloseForSignal(sig.id, won ? 'won' : 'lost');
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
  renderAnalysisQuality();
  renderDataInventory();
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
      detailEl.innerHTML = '<div class="zone-item"><span>' + d.direction + ' <span style="color:#454a56;">(' + d.confidence + '%, full engine — structure + macro + meta-labeler)</span></span><span class="mono ' + dirCls + '">$' + fmt(d.price) + '</span></div>'
        + (d.direction !== 'HOLD' ? '<div class="zone-item"><span>Entry / SL / TP</span><span class="mono">$' + fmt(d.entry) + ' / $' + fmt(d.sl) + ' / $' + fmt(d.tp) + '</span></div>' : '')
        + (d.direction !== 'HOLD' ? '<div class="zone-item"><span>Meta-labeler score</span><span class="mono">' + (d.metaTrained ? ((d.metaScore >= 0 ? '+' : '') + fmt(d.metaScore)) : 'not trained yet') + ' <span style="color:#454a56;font-size:9px;">(' + d.metaExampleCount + ' examples)</span></span></div>' : '')
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
// Mutable state that functions defined further up this file reach into.
// Declared here, above the first top-level refreshAll(), because `let` bindings
// are in their temporal dead zone until evaluated — declaring them beside their
// own sections put them after the code that reads them and threw on load.
let paper = { enabled: false, startingBalance: PAPER_DEFAULTS.startingBalance, positions: [] };
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
  lastError: null,
  gateTally: {}
};

let lastComposite = null;
let lastPlan = null;

const connectBtn = document.getElementById('connectBtn');
const connStatus = document.getElementById('connStatus');
const modeLabel = document.getElementById('modeLabel');
const liveDot = document.getElementById('liveDot');
const btSourceNote = document.getElementById('btSourceNote');
const providerSelect = document.getElementById('providerSelect');

// ---------- API quota accounting ----------
// Every Twelve Data call goes through spendCredit() so the day's usage is a real
// measured number rather than an estimate. The cap is deliberately below the
// tier limit: the background worker shares this key and must not be starved by
// a browser tab that was left open.
const QUOTA_KEY = 'smc-quota-v1';
const DEFAULT_DAILY_CAP = 500; // of Twelve Data's 800/day; the rest is reserved for /api/tick
let quotaState = { day: utcDayKey(), used: 0 };

function loadQuota() {
  try {
    const raw = localStorage.getItem(QUOTA_KEY);
    if (raw) quotaState = rollQuota(JSON.parse(raw), Date.now());
  } catch (e) { /* fresh start */ }
  quotaState = rollQuota(quotaState, Date.now());
}
function saveQuota() {
  try { localStorage.setItem(QUOTA_KEY, JSON.stringify(quotaState)); } catch (e) { /* storage unavailable */ }
}
function dailyCap() {
  const el = document.getElementById('aDailyCap');
  const v = el ? parseInt(el.value, 10) : NaN;
  return isFinite(v) && v > 0 ? v : DEFAULT_DAILY_CAP;
}
// Ring-fenced for the analysis path, sized from the cadence actually configured.
// Tightening the interval raises the reserve, so speeding autonomy up cannot
// quietly leave it short of credits later in the day.
function analysisReserve() {
  const el = document.getElementById('aInterval');
  const mins = el ? parseFloat(el.value) : NaN;
  return criticalReserveFor(isFinite(mins) && mins > 0 ? mins : AUTONOMY_DEFAULTS.analysisIntervalMinutes);
}
// Returns false when this call would breach the budget for its priority.
// During connect, activeProvider is still null while the first calls are already
// going out — so metering keys off the SELECTED provider. Reading activeProvider
// here let the whole connect burst through unmetered.
function meteredProvider() {
  return activeProvider || (providerSelect && providerSelect.value) || null;
}
function spendCredit(priority, cost) {
  quotaState = rollQuota(quotaState, Date.now());
  if (meteredProvider() !== 'twelvedata') return true; // only Twelve Data is metered here
  if (!canSpend(quotaState, dailyCap(), priority, cost || 1, analysisReserve())) return false;
  quotaState = spendQuota(quotaState, cost || 1);
  saveQuota();
  renderQuota();
  return true;
}
function renderQuota() {
  const el = document.getElementById('quotaReadout');
  if (!el) return;
  if (meteredProvider() !== 'twelvedata') { el.textContent = 'API budget tracking applies to Twelve Data only.'; return; }
  const q = quotaSummary(quotaState, dailyCap(), analysisReserve());
  const colour = q.pct >= 85 ? '#ef4d5f' : q.pct >= 55 ? '#ffa726' : '#3ecf8e';
  el.innerHTML = '<span style="color:' + colour + ';">' + q.used + ' / ' + q.cap + ' credits used today (' + q.pct + '%)</span>'
    + ' <span style="color:#454a56;">· ' + q.reserve + ' ring-fenced for analysis · resets 00:00 UTC</span>'
    + '<br><span style="color:#454a56;">' + q.note + '</span>';
}


// Each provider exposes: timeSeries(key, interval, outputsize) -> candle[], price(key) -> number,
// plus mtfInterval/htfInterval — the native interval strings for that provider's real 1H/4H data
// (null if the provider doesn't support that granularity, in which case the app falls back to
// aggregating from the 15min feed automatically). Adding a new provider means adding one entry here.
const PROVIDERS = {
  twelvedata: {
    // pollSeconds is the dedicated /price cadence. At 60s it cost 1,440 credits/day
    // on an 800/day tier — more than the entire quota, for a value the candle resync
    // already provides. 600s keeps a live-ish tick for the header at ~144/day, and it
    // is low-priority so it stops entirely once the budget tightens.
    label: 'Twelve Data', pollSeconds: 600, resyncMinutes: 15, mtfInterval: '1h', htfInterval: '4h', dailyInterval: '1day', weeklyInterval: '1week',
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
  if (provider.mtfInterval && spendCredit('normal')) {
    try { mtfData = await provider.timeSeries(key, provider.mtfInterval, 300); }
    catch (e) { mtfData = []; }
  } else mtfData = [];
  if (provider.htfInterval && spendCredit('normal')) {
    try { htfData = await provider.timeSeries(key, provider.htfInterval, 200); }
    catch (e) { htfData = []; }
  } else htfData = [];
  if (provider.dailyInterval && spendCredit('normal')) {
    try { dailyData = await provider.timeSeries(key, provider.dailyInterval, 200); }
    catch (e) { dailyData = []; }
  } else dailyData = [];
  if (provider.weeklyInterval && spendCredit('normal')) {
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
    try { if (!spendCredit('low')) throw new Error('budget'); xauDaily = await PROVIDERS.twelvedata.timeSeries(tdKey, '1day', 60); await sleep(1200); }
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
          if (!spendCredit('low')) throw new Error('Skipped to stay inside the daily API budget.');
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
    spendCredit('critical');
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
  renderQuota();
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
  // Autonomy resyncs candles as step 1 of its own cycle. Running this loop as well
  // would pay for the same 15-minute candles twice.
  resyncHandle = setInterval(() => { if (!autonomy.enabled) resyncCandles(); }, provider.resyncMinutes * 60 * 1000);
  // Higher timeframes resync on their own natural cadence — no point re-fetching a 4H
  // candle that hasn't closed yet, and it's cheaper on the API quota than constant polling.
  if (provider.mtfInterval) mtfResyncHandle = setInterval(() => { if (!spendCredit('normal')) return; PROVIDERS[activeProvider].timeSeries(apiKey, provider.mtfInterval, 300).then(d => { mtfData = d; refreshAll(); }).catch(() => {}); }, 60 * 60 * 1000);
  if (provider.htfInterval) htfResyncHandle = setInterval(() => { if (!spendCredit('normal')) return; PROVIDERS[activeProvider].timeSeries(apiKey, provider.htfInterval, 200).then(d => { htfData = d; refreshAll(); }).catch(() => {}); }, 4 * 60 * 60 * 1000);
  // Daily/weekly candles barely move intraday — resyncing a few times a day (daily) or once a day
  // (weekly) is plenty and keeps this well clear of any provider's rate limit.
  if (provider.dailyInterval) dailyResyncHandle = setInterval(() => { if (!spendCredit('normal')) return; PROVIDERS[activeProvider].timeSeries(apiKey, provider.dailyInterval, 200).then(d => { dailyData = d; refreshAll(); }).catch(() => {}); }, 12 * 60 * 60 * 1000);
  if (provider.weeklyInterval) weeklyResyncHandle = setInterval(() => { if (!spendCredit('normal')) return; PROVIDERS[activeProvider].timeSeries(apiKey, provider.weeklyInterval, 104).then(d => { weeklyData = d; refreshAll(); }).catch(() => {}); }, 24 * 60 * 60 * 1000);
  // Correlation uses daily bars — no point checking more than a few times a day.
  if (corrResyncHandle) clearInterval(corrResyncHandle);
  corrResyncHandle = setInterval(() => {
    if (!canSpend(quotaState, dailyCap(), 'low', 3, analysisReserve())) return; // 3 Twelve Data credits per refresh
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
// The dedicated price endpoint costs one credit per call and only nudges the
// last candle's close — which the candle resync already refreshes properly. At
// a 60s interval it alone came to 1,440 credits/day against an 800/day tier,
// which exhausted the quota (and the background worker's share of it) by early
// afternoon. It is now a low-priority extra: nice while there is budget spare,
// first to be dropped when there isn't.
async function pollPrice() {
  if (!apiKey || !activeProvider) return;
  if (!spendCredit('low')) return;
  try {
    const p = await PROVIDERS[activeProvider].price(apiKey);
    const last = liveData[liveData.length - 1];
    last.close = p; last.high = Math.max(last.high, p); last.low = Math.min(last.low, p);
    lastPriceUpdateTime = Date.now();
    refreshAll();
  } catch (e) { connStatus.textContent = 'Price update failed: ' + e.message; connStatus.className = 'conn-status err'; }
}
let candlesStaleForBudget = false;
async function resyncCandles() {
  if (!apiKey || !activeProvider) return;
  // Only reachable once the FULL cap is gone, reserve included. Analysis still
  // runs on the last candles fetched rather than stopping — degraded, not dead —
  // and the panel says so instead of quietly showing old numbers as current.
  if (!spendCredit('critical')) { candlesStaleForBudget = true; renderQuota(); return; }
  candlesStaleForBudget = false;
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
  if (typeof renderPaper === 'function' && paper && paper.positions.length) renderPaper();
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
        const corrTxt = d.corr == null ? 'n/a' : (d.corr >= 0.4 ? 'strong +' : d.corr <= -0.4 ? 'strong −' : Math.abs(d.corr) >= 0.15 ? (d.corr > 0 ? 'weak +' : 'weak −') : 'flat') + (d.corr != null ? ' (' + fmt(d.corr) + ')' : '');
        const confirms = d.contribution !== 0 && lastComposite && lastComposite.direction !== 'HOLD' && Math.sign(d.contribution) === (lastComposite.direction === 'BUY' ? 1 : -1);
        const flagTxt = lastComposite && lastComposite.direction !== 'HOLD' ? (confirms ? ' <span class="fpos">✓ confirms</span>' : ' <span class="fneg">✗ contradicts</span>') : '';
        return '<div class="zone-item ' + (d.pctChange < 0 ? 'bearish' : '') + '"><span>' + d.label + srcTag + ' <span style="color:#454a56;">(' + corrTxt + ')</span></span><span class="mono ' + changeCls + '">' + (d.pctChange >= 0 ? '+' : '') + fmt(d.pctChange) + '%' + flagTxt + '</span></div>';
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
        return '<div class="zone-item ' + (d.pctChange < 0 ? 'bearish' : '') + '"><span>' + d.label + ' <span style="color:#454a56;font-size:9px;">(' + dateTxt + ')</span></span><span class="mono ' + changeCls + '">' + (d.pctChange >= 0 ? '+' : '') + fmt(d.pctChange) + '%' + flagTxt + '</span></div>';
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
// DATA INVENTORY PANEL
// ------------------------------------------------------------
// Answers "how much has it actually learned", which nothing else here does.
// It also shows the worker's totals alongside the browser's, because the two
// keep SEPARATE learning stores — the browser in localStorage (and Firestore
// under users/<uid> when signed in), the worker in Firestore under
// system/worker. Neither reads the other, so they accumulate independently and
// a total from one says nothing about the other.
// ============================================================
let workerTotals = null; // populated from the worker's public tick snapshot

function bar(p, colour) {
  return '<div style="height:4px;background:#1a1d26;border-radius:2px;overflow:hidden;margin-top:3px;">'
    + '<div style="height:100%;width:' + p + '%;background:' + colour + ';"></div></div>';
}
function capRow(label, cap, unit) {
  const colour = cap.ready ? '#3ecf8e' : cap.pct >= 50 ? '#ffa726' : '#5c6270';
  const right = cap.ready
    ? '<span style="color:#3ecf8e;">active</span>'
    : '<span style="color:#9298a5;">' + cap.have + ' / ' + cap.need + ' ' + (unit || '') + '</span>';
  return '<div style="margin-bottom:8px;">'
    + '<div style="display:flex;justify-content:space-between;font-size:11px;">'
    + '<span>' + label + '</span>' + right + '</div>'
    + bar(cap.pct, colour) + '</div>';
}

function renderDataInventory() {
  const root = document.getElementById('dataContent');
  if (!root) return;
  const inv = dataInventory({
    learningState, signalLog, shadowLog, paperPositions: paper.positions
  });
  const st = inv.stores;

  let html = '<div class="metrics" style="margin-bottom:10px;">'
    + '<div class="card"><div class="label">Resolved</div><div class="value mono">' + st.signalsResolved + '</div></div>'
    + '<div class="card"><div class="label">Learned From</div><div class="value mono">' + st.totalLogged + '</div></div>'
    + '<div class="card"><div class="label">Meta Examples</div><div class="value mono">' + st.metaExamples + '</div></div>'
    + '<div class="card"><div class="label">Declined Tracked</div><div class="value mono">' + st.shadowsResolved + '</div></div>'
    + '</div>';

  html += '<div style="font-size:10px;color:#454a56;margin:10px 0 6px;">What each store unlocks</div>';
  html += capRow('Knowledge base — auto-tunes factor weights', inv.capabilities.knowledgeBase, 'outcomes');
  html += capRow('Meta-labeler — scores setup quality', inv.capabilities.metaLabeler, 'examples');
  html += capRow('Calibration — is confidence meaningful', inv.capabilities.calibration, 'resolved');
  html += capRow('Gate audit — is the filter too tight', inv.capabilities.gateAudit, 'declined');
  html += capRow('Journal insights', inv.capabilities.journal, 'resolved');

  html += '<div style="font-size:10px;color:#454a56;margin:10px 0 6px;">Raw stores (this browser)</div>';
  const row = (k, v, extra) => '<div class="zone-item" style="padding:3px 0;"><span style="font-size:11px;">' + k
    + '</span><span class="mono" style="font-size:11px;">' + v
    + (extra ? ' <span style="color:#454a56;">' + extra + '</span>' : '') + '</span></div>';
  html += row('Signals logged', st.signalsTotal, 'cap ' + inv.caps.signalLog);
  html += row('&nbsp;&nbsp;· resolved / open / expired', st.signalsResolved + ' / ' + st.signalsOpen + ' / ' + st.signalsExpired, '');
  html += row('Declined setups tracked', st.shadowsTotal, 'cap ' + inv.caps.shadowLog);
  html += row('Meta-labeler examples', st.metaExamples, 'cap ' + inv.caps.metaExamples + (inv.metaTrained ? ' · trained' : ' · untrained'));
  html += row('Paper trades closed / open', st.paperClosed + ' / ' + st.paperOpen, '');
  html += row('Distinct patterns seen', st.patterns, '');
  html += row('Factors with usable history', st.factorsWithData + ' / ' + st.factorsTotal, '5+ votes each');

  if (inv.factorStats.length && inv.factorStats[0].votes > 0) {
    html += '<div style="font-size:10px;color:#454a56;margin:10px 0 6px;">Per-factor evidence</div>';
    html += inv.factorStats.filter(f => f.votes > 0).map(f => {
      const wr = f.votes ? (f.wins / f.votes * 100) : null;
      const cls = f.votes < 5 ? 'fneu' : wr >= 55 ? 'fpos' : wr <= 45 ? 'fneg' : 'fneu';
      return '<div class="zone-item" style="padding:2px 0;"><span style="font-size:11px;">' + (FACTOR_LABELS[f.key] || f.key)
        + '</span><span class="mono ' + cls + '" style="font-size:11px;">' + f.votes + ' votes'
        + (f.votes >= 5 ? ' · ' + wr.toFixed(0) + '%' : ' <span style="color:#454a56;">(needs 5)</span>') + '</span></div>';
    }).join('');
  }

  // The worker's pool is genuinely separate — showing them side by side rather
  // than summed, because adding them would imply a shared brain that does not exist.
  html += '<div style="font-size:10px;color:#454a56;margin:10px 0 6px;">Background worker (separate store)</div>';
  if (workerTotals) {
    html += row('Outcomes learned from', workerTotals.totalLogged, '');
    html += row('Meta examples', workerTotals.metaExampleCount, workerTotals.metaTrained ? 'trained' : 'untrained');
    html += row('Open signals', workerTotals.openSignals, '');
    html += row('Last tick', workerTotals.ageMin + ' min ago', '');
  } else {
    html += '<div class="zone-empty">No worker tick read yet — press refresh, or the worker has not run.</div>';
  }
  html += '<div class="conn-note" style="margin-top:6px;">The worker keeps its own learning store in Firestore and this browser keeps its own locally. They accumulate independently and neither reads the other, so these totals are not additive.</div>';

  root.innerHTML = html;
}

// Read the worker's public snapshot for its side of the ledger.
async function refreshWorkerTotals() {
  if (!fbReady || !fbDb) return;
  try {
    const doc = await fbDb.collection('system').doc('latestTick').get();
    if (!doc.exists) { workerTotals = null; return; }
    const d = doc.data();
    workerTotals = {
      totalLogged: d.totalLogged || 0,
      metaExampleCount: d.metaExampleCount || 0,
      metaTrained: !!d.metaTrained,
      openSignals: d.openSignals || 0,
      ageMin: Math.round((Date.now() - (d.time || Date.now())) / 60000)
    };
  } catch (e) { workerTotals = null; }
}

document.getElementById('dataRefresh').addEventListener('click', async () => {
  await refreshWorkerTotals();
  renderDataInventory();
});

// ============================================================
// PAPER TRADING ACCOUNT
// ------------------------------------------------------------
// A simulated account attached to the signals the engine already produces. No
// broker, no money, no orders leave this page — it exists to turn "62% of
// signals won" into "this would have been up 4.3% with an 11% drawdown", which
// is the number that actually tells you whether the analysis is worth anything.
//
// It is off until switched on, and independent of autonomous mode: signals
// generated by hand get paper positions too.
//
// Positions are opened and closed by the SIGNAL's lifecycle, never their own.
// The signal already resolves against real candles and records the outcome for
// learning; a position that also reported would double-count every trade in the
// factor statistics.
// ============================================================
const PAPER_KEY = 'smc-paper-v1';

function paperConfig() {
  const num = (id, fb) => {
    const el = document.getElementById(id);
    const v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v : fb;
  };
  return Object.assign({}, PAPER_DEFAULTS, {
    startingBalance: num('pStartBalance', PAPER_DEFAULTS.startingBalance),
    riskPercent: num('pRiskPct', PAPER_DEFAULTS.riskPercent),
    spreadPips: num('pSpread', PAPER_DEFAULTS.spreadPips),
    slippagePips: num('pSlippage', PAPER_DEFAULTS.slippagePips),
    maxConcurrent: num('pMaxPos', PAPER_DEFAULTS.maxConcurrent)
  });
}
async function loadPaper() {
  try {
    const raw = localStorage.getItem(PAPER_KEY);
    if (raw) paper = Object.assign(paper, JSON.parse(raw));
  } catch (e) { /* fresh account */ }
  const cb = document.getElementById('paperEnabled');
  if (cb) cb.checked = !!paper.enabled;
}
async function savePaper() {
  try { localStorage.setItem(PAPER_KEY, JSON.stringify(paper)); } catch (e) { /* storage unavailable */ }
}
function currentMarkPrice() {
  return liveData.length ? liveData[liveData.length - 1].close : NaN;
}
function paperBalance() {
  const cfg = paperConfig();
  return paperAccountSummary(paper.positions, cfg.startingBalance, currentMarkPrice()).balance;
}

// Called when a signal is logged. Sizing uses the balance at that moment, so
// the account compounds (or shrinks) as it goes rather than sizing off a
// constant, which is what makes drawdown meaningful.
function paperOpenForSignal(sig) {
  if (!paper.enabled) return;
  const cfg = paperConfig();
  const pos = openPaperPosition(sig, { balance: paperBalance(), positions: paper.positions }, cfg);
  if (!pos) return;
  paper.positions.unshift(pos);
  paper.positions = paper.positions.slice(0, 500);
  savePaper();
  renderPaper();
}
function paperCloseForSignal(signalId, outcome) {
  if (!paper.positions.length) return;
  const idx = paper.positions.findIndex(p => p.signalId === signalId && p.status === 'open');
  if (idx === -1) return;
  paper.positions[idx] = closePaperPosition(paper.positions[idx], outcome, currentMarkPrice(), paperConfig());
  savePaper();
  renderPaper();
}

function money(v) {
  if (v == null || !isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return sign + '$' + Math.abs(v).toFixed(2);
}
function renderPaper() {
  const root = document.getElementById('paperContent');
  if (!root) return;
  const cfg = paperConfig();
  const price = currentMarkPrice();
  const a = paperAccountSummary(paper.positions, cfg.startingBalance, price);

  const pnlCls = v => v > 0 ? 'fpos' : v < 0 ? 'fneg' : 'fneu';
  let html = '<div class="metrics" style="margin-bottom:10px;">'
    + '<div class="card"><div class="label">Equity</div><div class="value mono ' + pnlCls(a.equity - a.startingBalance) + '">' + money(a.equity) + '</div></div>'
    + '<div class="card"><div class="label">Return</div><div class="value mono ' + pnlCls(a.returnPct) + '">' + (a.returnPct >= 0 ? '+' : '') + a.returnPct.toFixed(2) + '%</div></div>'
    + '<div class="card"><div class="label">Max DD</div><div class="value mono">' + (a.maxDrawdown * 100).toFixed(1) + '%</div></div>'
    + '<div class="card"><div class="label">Open</div><div class="value mono">' + a.openCount + '</div></div>'
    + '</div>';

  html += '<div class="zone-item"><span>Balance (realised)</span><span class="mono ' + pnlCls(a.realised) + '">' + money(a.balance) + ' <span style="color:#454a56;">(' + (a.realised >= 0 ? '+' : '') + money(a.realised).replace('$','$') + ')</span></span></div>';
  if (a.openCount) html += '<div class="zone-item"><span>Floating P&amp;L</span><span class="mono ' + pnlCls(a.floating) + '">' + money(a.floating) + '</span></div>';
  html += '<div class="zone-item"><span>Closed trades</span><span class="mono">' + a.closedCount + (a.winRate != null ? ' · ' + (a.winRate * 100).toFixed(0) + '% won' : '') + '</span></div>';
  if (a.profitFactor != null) html += '<div class="zone-item"><span>Profit factor</span><span class="mono ' + pnlCls(a.profitFactor - 1) + '">' + (a.profitFactor === Infinity ? '∞' : a.profitFactor.toFixed(2)) + '</span></div>';
  if (a.avgR != null) html += '<div class="zone-item"><span>Average R per trade</span><span class="mono ' + pnlCls(a.avgR) + '">' + (a.avgR >= 0 ? '+' : '') + a.avgR.toFixed(2) + 'R</span></div>';

  const open = paper.positions.filter(p => p.status === 'open');
  if (open.length) {
    html += '<div style="font-size:10px;color:#454a56;margin:10px 0 6px;">Open positions</div>';
    html += open.map(p => {
      const u = unrealisedPnl(p, price);
      return '<div class="zone-item"><span><span class="dirtag ' + p.dir + '">' + p.dir + '</span> ' + fmt(p.units) + ' u @ $' + fmt(p.entryFill) + '</span>'
        + '<span class="mono ' + pnlCls(u) + '">' + money(u) + '</span></div>';
    }).join('');
  }

  const closed = paper.positions.filter(p => p.status === 'closed').slice(0, 8);
  if (closed.length) {
    html += '<div style="font-size:10px;color:#454a56;margin:10px 0 6px;">Recent closed</div>';
    html += closed.map(p =>
      '<div class="zone-item"><span><span class="dirtag ' + p.dir + '">' + p.dir + '</span> ' + (p.outcome === 'won' ? '✓' : p.outcome === 'lost' ? '✗' : '–')
      + ' <span style="color:#454a56;">exit $' + fmt(p.exitPrice) + '</span></span>'
      + '<span class="mono ' + pnlCls(p.pnl) + '">' + money(p.pnl) + (p.rMultiple != null ? ' <span style="color:#454a56;">' + (p.rMultiple >= 0 ? '+' : '') + fmt(p.rMultiple) + 'R</span>' : '') + '</span></div>'
    ).join('');
  }

  if (!paper.positions.length) {
    html += '<div class="zone-empty">No paper trades yet. Positions open automatically as the engine logs signals.</div>';
  }
  root.innerHTML = html;
}

document.getElementById('paperEnabled').addEventListener('change', function () {
  paper.enabled = this.checked;
  savePaper();
  renderPaper();
  const note = document.getElementById('paperStatus');
  if (note) note.textContent = paper.enabled
    ? 'On — new signals will open simulated positions. No real orders are placed.'
    : 'Off — no positions will be opened.';
});
document.getElementById('paperAdvancedToggle').addEventListener('click', () => {
  document.getElementById('paperAdvanced').classList.toggle('hidden');
});
['pStartBalance', 'pRiskPct', 'pSpread', 'pSlippage', 'pMaxPos'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => { paper.startingBalance = paperConfig().startingBalance; savePaper(); renderPaper(); });
});
document.getElementById('paperReset').addEventListener('click', async () => {
  if (!window.confirm('Reset the paper account? This clears all simulated positions and P&L. Signals and learning data are not affected.')) return;
  paper.positions = [];
  await savePaper();
  renderPaper();
});

// ============================================================
// ANALYSIS QUALITY PANEL
// ------------------------------------------------------------
// Renders the three self-audits. Every number here is deliberately allowed to
// say "not enough data yet" rather than show a confident-looking figure built
// on four trades — a reassuring number from a tiny sample is worse than no
// number, because it gets believed.
// ============================================================
function fmtR(v) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + 'R'; }
function fmtPct(v) { return v == null ? '—' : (v * 100).toFixed(0) + '%'; }
function rClass(v) { return v == null ? 'fneu' : v > 0.05 ? 'fpos' : v < -0.05 ? 'fneg' : 'fneu'; }

function renderAnalysisQuality() {
  const root = document.getElementById('qualityContent');
  if (!root) return;

  const cal = computeCalibration(signalLog);
  const bd = computeConditionBreakdown(signalLog);
  const audit = computeGateAudit(signalLog, shadowLog);

  const rows = (list, label) => {
    const usable = list.filter(r => r.n >= 3);
    if (!usable.length) return '<div class="zone-empty">' + label + ': not enough resolved trades yet (need 3+ per group).</div>';
    return usable.map(r =>
      '<div class="zone-item"><span>' + r.key + ' <span style="color:#454a56;">(' + r.n + ')</span></span>' +
      '<span class="mono ' + rClass(r.expectancyR) + '">' + fmtR(r.expectancyR) + ' · ' + fmtPct(r.winRate) + '</span></div>'
    ).join('');
  };

  const o = bd.overall;
  let html = '';

  html += '<div class="data-source-note" style="margin-bottom:8px;">Expectancy is shown in R — average profit per unit risked. At a 1:4 target a 30% win rate is already profitable, so win rate alone is a poor scorecard and R is the honest one.</div>';

  html += '<div class="metrics" style="margin-bottom:10px;">'
    + '<div class="card"><div class="label">Resolved</div><div class="value mono">' + o.n + '</div></div>'
    + '<div class="card"><div class="label">Win Rate</div><div class="value mono">' + fmtPct(o.winRate) + '</div></div>'
    + '<div class="card"><div class="label">Expectancy</div><div class="value mono ' + rClass(o.expectancyR) + '">' + fmtR(o.expectancyR) + '</div></div>'
    + '<div class="card"><div class="label">Total</div><div class="value mono ' + rClass(o.totalR) + '">' + fmtR(o.totalR) + '</div></div>'
    + '</div>';

  // 1. Is the confidence number worth anything?
  html += '<div class="panel-title" style="font-size:11px;margin-top:12px;">Is the confidence score meaningful?</div>';
  html += '<div class="event-line" style="border-left-color:#e8c37a;">' + cal.verdict + '</div>';
  if (cal.discrimination != null) {
    html += '<div class="zone-item"><span>High-confidence half vs low-confidence half</span><span class="mono ' + rClass(cal.discrimination) + '">'
      + (cal.discrimination >= 0 ? '+' : '') + (cal.discrimination * 100).toFixed(0) + ' pp win rate</span></div>';
  }
  if (cal.buckets.length) {
    html += '<table class="factor-table"><tr><th style="text-align:left;color:#5c6270;font-weight:500;">Confidence band</th><th style="color:#5c6270;font-weight:500;">Win rate</th><th style="color:#5c6270;font-weight:500;">Expectancy</th></tr>';
    html += cal.buckets.map(b =>
      '<tr><td>' + b.lo + '–' + b.hi + '% <span style="color:#454a56;">(' + b.n + ')</span></td>'
      + '<td>' + fmtPct(b.winRate) + '</td>'
      + '<td class="' + rClass(b.expectancyR) + '">' + fmtR(b.expectancyR) + '</td></tr>').join('');
    html += '</table>';
  }

  // 2. Where does the edge actually live?
  html += '<div class="panel-title" style="font-size:11px;margin-top:14px;">Where the edge actually lives</div>';
  html += '<div style="font-size:10px;color:#454a56;margin-bottom:6px;">By session</div>' + rows(bd.bySession, 'Session');
  html += '<div style="font-size:10px;color:#454a56;margin:8px 0 6px;">By market regime</div>' + rows(bd.byRegime, 'Regime');
  html += '<div style="font-size:10px;color:#454a56;margin:8px 0 6px;">By grade</div>' + rows(bd.byGrade, 'Grade');
  html += '<div style="font-size:10px;color:#454a56;margin:8px 0 6px;">By direction</div>' + rows(bd.byDirection, 'Direction');

  // 3. The roads not taken.
  html += '<div class="panel-title" style="font-size:11px;margin-top:14px;">The setups it turned down</div>';
  html += '<div class="data-source-note" style="margin-bottom:6px;">Every setup the filter rejected is tracked and resolved against real price anyway. This is the comparison a human journal can never make, because nobody records their non-trades.</div>';
  html += '<div class="zone-item"><span>Taken</span><span class="mono ' + rClass(audit.taken.expectancyR) + '">'
    + fmtR(audit.taken.expectancyR) + ' <span style="color:#454a56;">(' + audit.taken.n + ')</span></span></div>';
  html += '<div class="zone-item"><span>Declined</span><span class="mono ' + rClass(audit.declined.expectancyR) + '">'
    + fmtR(audit.declined.expectancyR) + ' <span style="color:#454a56;">(' + audit.declined.n + ')</span></span></div>';
  const pending = shadowLog.filter(s => s.status === 'pending' || s.status === 'open').length;
  if (pending) html += '<div class="zone-item"><span>Declined, still running</span><span class="mono">' + pending + '</span></div>';
  html += '<div class="event-line" style="border-left-color:#c99bff;margin-top:6px;">' + audit.verdict + '</div>';

  root.innerHTML = html;
}
document.getElementById('resetQuality').addEventListener('click', async () => {
  shadowLog = [];
  await saveShadowLog();
  renderAnalysisQuality();
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
    minMetaScore: num('aMinMeta', AUTONOMY_DEFAULTS.minMetaScore),
    gradeFloor: (document.getElementById('aMinGrade') || {}).value || AUTONOMY_DEFAULTS.gradeFloor
  });
}

function saveAutonomyState() {
  try {
    localStorage.setItem(AUTONOMY_KEY, JSON.stringify({
      enabled: autonomy.enabled,
      cycles: autonomy.cycles,
      gateTally: autonomy.gateTally,
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
        aMinMeta: document.getElementById('aMinMeta').value,
        aDailyCap: document.getElementById('aDailyCap').value,
        aMinGrade: document.getElementById('aMinGrade').value
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
      gateTally: saved.gateTally || {},
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

  const el = document.getElementById('gateTally');
  if (!el) return;
  const entries = Object.keys(autonomy.gateTally || {})
    .map(k => ({ code: k, n: autonomy.gateTally[k] }))
    .sort((a, b) => b.n - a.n);
  if (!entries.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div style="font-size:10px;color:#454a56;margin:8px 0 4px;">Why cycles ended this way</div>'
    + entries.map(e => '<div class="zone-item" style="padding:3px 0;"><span style="font-size:11px;">'
        + (GATE_LABELS[e.code] || e.code) + '</span><span class="mono" style="font-size:11px;color:'
        + (e.code === 'taken' ? '#3ecf8e' : '#5c6270') + ';">' + e.n + '</span></div>').join('');
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
      paperCloseForSignal(sig.id, 'expired');
      changed = true; // expired signals never become training data — no outcome to learn from
    } else if (verdict.status === 'open' && sig.status === 'pending') {
      sig.status = 'open'; // limit entry got tagged; it's a live position now
      changed = true;
    }
  });
  if (changed) { saveSignalLog(); renderSignalLog(); }
  if (resolved) autonomy.autoResolved += resolved;
  resolveShadowSignals(candles, cfg);
  return resolved;
}

// Shadows get the same treatment, minus the learning updates — a setup the
// engine declined should inform the audit, not train the weights as though it
// had been traded.
function resolveShadowSignals(candles, cfg) {
  if (!candles || candles.length < 2 || !shadowLog.length) return;
  let changed = false;
  shadowLog.forEach(sig => {
    if (sig.status !== 'pending' && sig.status !== 'open') return;
    const verdict = resolveSignal(sig, candles, cfg);
    if (verdict.status === 'won' || verdict.status === 'lost') {
      sig.status = verdict.status;
      sig.resolvedAt = new Date().toISOString();
      changed = true;
    } else if (verdict.status === 'expired') {
      sig.status = 'expired'; sig.expiryReason = verdict.reason || null; changed = true;
    } else if (verdict.status === 'open' && sig.status === 'pending') {
      sig.status = 'open'; changed = true;
    }
  });
  if (changed) { saveShadowLog(); renderAnalysisQuality(); }
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
    // Tally why each cycle ended as it did. One latest-reason line cannot show
    // whether 13 quiet cycles mean "no setup existed" or "the filter blocked
    // every one" — and those need opposite responses.
    const code = gate.code || 'unknown';
    autonomy.gateTally[code] = (autonomy.gateTally[code] || 0) + 1;
    if (gate.take) {
      updateSignalUI(lastComposite, plan, true); // logIt = true -> addSignalToLog
      autonomy.signalsTaken++;
      autonomy.lastSignalAt = now;
      reason = 'Took a ' + lastComposite.direction + ' at $' + fmt(plan.entry) +
               ' (' + lastComposite.confidence + '% confidence' + (gate.grade ? ', grade ' + gate.grade : '') + ').';
    } else {
      updateSignalUI(lastComposite, plan, false); // keep the panel current without logging
      // Track what was passed on, so the filter can be audited later rather
      // than trusted forever.
      addShadowSignal(lastComposite, plan, gate.reason);
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

  renderAnalysisQuality();
  renderDataInventory();
  autonomy.cycles++;
  autonomy.consecutiveErrors = 0;
  autonomy.lastError = null;
  saveAutonomyState();
  renderAutonomyStats();
  if (candlesStaleForBudget) {
    setAutonomyStatus('Running on cached candles — daily API budget spent, resumes 00:00 UTC.', 'warn',
      'Still grading open signals and re-analysing, but on the last candles fetched rather than fresh ones. ' + reason);
  } else {
    setAutonomyStatus('Running autonomously — last pass ' + new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.', 'live', reason);
  }
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
providerSelect.addEventListener('change', renderQuota);

// A posture for building up a record rather than protecting capital. The engine
// learns from resolved trades, and at the default B floor a ranging market
// simply never qualifies — so a cautious setup collects nothing and the
// knowledge base never starts.
document.getElementById('aPresetCollect').addEventListener('click', () => {
  // D, not C: even a perfect five-timeframe alignment only scores ~49%, so a C
  // floor (>=30%) still rejects ordinary conditions and collects almost nothing.
  document.getElementById('aMinGrade').value = 'D';
  document.getElementById('aMinConf').value = 15;
  document.getElementById('aCooldown').value = 30;
  document.getElementById('aMaxOpen').value = 5;
  document.getElementById('aMinMeta').value = -0.5;
  saveAutonomyState();
  autonomy.lastAnalysisAt = null; // re-evaluate immediately under the new thresholds
  setAutonomyStatus('Data-collection thresholds applied — re-evaluating now.', 'live', '');
  autonomyHeartbeat();
});
document.getElementById('autonomyAdvancedToggle').addEventListener('click', () => {
  document.getElementById('autonomyAdvanced').classList.toggle('hidden');
});
['aMinConf', 'aCooldown', 'aMaxOpen', 'aInterval', 'aBtHours', 'aMinMeta', 'aDailyCap', 'aMinGrade'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => { saveAutonomyState(); renderQuota(); });
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
  await loadShadowLog();
  applyKnowledgeBaseWeights();
  await loadPaper();
  loadAutonomyState();
  loadQuota();
  renderQuota();
  renderAutonomyStats();
  renderAnalysisQuality();
  renderPaper();
  renderDataInventory();
  refreshWorkerTotals().then(renderDataInventory);
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
