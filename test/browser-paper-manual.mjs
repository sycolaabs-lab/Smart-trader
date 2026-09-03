// Generating a trade by hand should not force a choice made in another panel:
// the signal panel decides whether hand-made signals open a paper position, and
// ticking it while the paper account is off must switch the account on rather
// than doing nothing.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
// A clean, deterministic uptrend. The simulated feed the app falls back to is
// randomised per load, so a flat draw makes the engine hold on every click and
// nothing is ever logged — which is a property of the fixture, not of the
// toggle under test. Routed candles remove that.
function candles(n, stepMs){
  const now = Date.now();
  return Array.from({length:n}, (_, i) => {
    const p = 1900 + (i / n) * 180 + Math.sin(i / 6) * 1.5;
    return { datetime: new Date(now - (n - i) * (stepMs || 9e5)).toISOString().slice(0,19).replace('T',' '),
      open:(p-0.6).toFixed(2), high:(p+1.4).toFixed(2), low:(p-1.4).toFixed(2), close:p.toFixed(2) };
  });
}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
const STEP = { '15min':9e5, '1h':36e5, '4h':144e5, '1day':864e5, '1week':6048e5 };
await p.route('https://api.twelvedata.com/**', r => {
  const u = new URL(r.request().url());
  if (u.pathname.includes('/price')) return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({price:'2080.00'})});
  const iv = u.searchParams.get('interval');
  r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
    values: candles(Math.min(+u.searchParams.get('outputsize')||500, 900), STEP[iv] || 9e5) })});
});
await p.route('**/api/fred**', r => r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({observations:[]})}));
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(700);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(1500);
// Connect the routed provider so every timeframe reads the same deterministic
// trend and the engine has something to be directional about.
await p.fill('#apiKeyInput', 'TESTKEY');
await p.click('#connectBtn');
await p.waitForTimeout(4000);

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };
const state = () => p.evaluate(() => ({
  manual: document.getElementById('paperManual').checked,
  master: document.getElementById('paperEnabled').checked,
  hint: document.getElementById('paperManualHint').textContent,
  status: document.getElementById('paperStatus').textContent,
  positions: JSON.parse(localStorage.getItem('smc-paper-v1') || '{}').positions || [],
  signals: JSON.parse(localStorage.getItem('smc-signal-log-v1') || '[]')
}));
// --- toggle exists and starts in a sane place ------------------------------
const s0 = await state();
ok('the signal panel has its own paper toggle', s0.manual === true, JSON.stringify(s0));
ok('the paper account itself starts off', s0.master === false, JSON.stringify(s0));
ok('and the toggle says what ticking it would do', /switch the paper account on/.test(s0.hint), s0.hint);

// --- off: the panel says trades will be graded but not opened ---------------
// Whether a position is actually opened is decided by shouldPaperTrade, which
// is unit-tested exhaustively in test/engine.test.mjs. It is not asserted here
// because it would need the engine to produce a directional signal on demand,
// and the engine holds on flat data by design — a HOLD is its judgement, not a
// failure of this toggle.
await p.uncheck('#paperManual'); await p.waitForTimeout(300);
const s1 = await state();
ok('unticking does not switch the account on', s1.master === false, JSON.stringify(s1));
ok('and it says trades will be graded but not opened', /no position is opened/.test(s1.hint), s1.hint);
ok('no positions exist either way', s1.positions.length === 0, JSON.stringify(s1.positions));

// --- on: ticking it activates paper trading --------------------------------
await p.check('#paperManual'); await p.waitForTimeout(400);
const s3 = await state();
ok('ticking it switches the paper account on', s3.master === true, JSON.stringify(s3));
ok('the paper panel agrees', /^On —/.test(s3.status), s3.status);
ok('and the hint stops promising to turn anything on', /simulated only/.test(s3.hint), s3.hint);

// --- the master switch stays independent -----------------------------------
await p.uncheck('#paperEnabled'); await p.waitForTimeout(300);
const s3b = await state();
ok('turning the account off leaves the panel toggle alone', s3b.manual === true, JSON.stringify(s3b));
ok('and the hint offers to turn it back on', /switch the paper account on/.test(s3b.hint), s3b.hint);
await p.check('#paperEnabled'); await p.waitForTimeout(300);

// --- the setting survives a reload -----------------------------------------
await p.uncheck('#paperManual'); await p.waitForTimeout(300);
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(1800);
const s5 = await state();
ok('the choice is remembered', s5.manual === false, JSON.stringify(s5));
ok('and the account stays on for the engine\'s own signals', s5.master === true, JSON.stringify(s5));
ok('the paper panel explains the exclusion', /generate by hand are excluded/.test(s5.status), s5.status);

ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
