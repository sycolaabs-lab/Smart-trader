// Generate is the manual half of the same loop autonomous mode runs: analyse,
// log the signal, and — with paper trading on — place the trade. It used to do
// all of that silently, so a pass that took nothing was indistinguishable from
// a broken button.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
const STEP = { '15min':9e5, '1h':36e5, '4h':144e5, '1day':864e5, '1week':6048e5 };
// A stepped advance the engine reads as a clear BUY on every timeframe. A plain
// ramp reads HOLD — no swing structure to work with — which is what made an
// earlier version of this test flaky.
const trend = (i) => 1900 + Math.floor(i / 12) * 4 + Math.sin(i / 3) * 1.2;
// Flat noise: the engine holds on this, by design.
const flat  = (i) => 2000 + Math.sin(i / 5) * 0.6;
function candles(n, stepMs, shape) {
  const now = Date.now();
  return Array.from({length:n}, (_, i) => {
    const p = shape(i);
    return { datetime: new Date(now - (n - i) * stepMs).toISOString().slice(0,19).replace('T',' '),
      open:(p-0.5).toFixed(2), high:(p+1.2).toFixed(2), low:(p-1.2).toFixed(2), close:p.toFixed(2) };
  // Twelve Data returns newest-first and the app reverses what it receives.
  }).reverse();
}

let shape = trend;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.route('https://api.twelvedata.com/**', r => {
  const u = new URL(r.request().url());
  if (u.pathname.includes('/price')) return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({price:'2000.00'})});
  const iv = u.searchParams.get('interval');
  r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
    values: candles(Math.min(+u.searchParams.get('outputsize')||500, 900), STEP[iv]||9e5, shape) })});
});
await p.route('**/api/fred**', r => r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({observations:[]})}));

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };
const state = () => p.evaluate(() => ({
  outcome: document.getElementById('genOutcome').textContent,
  colour: document.getElementById('genOutcome').style.color,
  dir: document.getElementById('dirDisplay').innerText,
  signals: JSON.parse(localStorage.getItem('smc-signal-log-v1') || '[]'),
  positions: (JSON.parse(localStorage.getItem('smc-paper-v1') || '{}').positions) || []
}));
async function connect() {
  await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.fill('#apiKeyInput', 'TESTKEY');
  await p.click('#connectBtn');
  await p.waitForTimeout(4500);
}
async function generate() {
  await p.waitForFunction(() => !document.getElementById('genBtn').disabled, null, { timeout: 15000 });
  await p.click('#genBtn');
  await p.waitForFunction(() => !document.getElementById('genBtn').disabled, null, { timeout: 15000 });
  await p.waitForTimeout(400);
}

// --- paper trading ON: Generate must place the trade -----------------------
await connect();
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(1500);
await p.fill('#apiKeyInput', 'TESTKEY'); await p.click('#connectBtn'); await p.waitForTimeout(4500);
await p.check('#paperEnabled'); await p.waitForTimeout(300);
await generate();
const on = await state();
ok('the engine found a direction', /BUY|SELL/.test(on.dir), on.dir);
ok('Generate logged the signal', on.signals.length === 1, JSON.stringify(on.signals.length));
ok('and it is marked as hand-made', on.signals[0] && on.signals[0].source === 'manual', JSON.stringify(on.signals[0] && on.signals[0].source));
ok('and it placed the paper trade', on.positions.length === 1, JSON.stringify(on.positions.length));
ok('tied to that signal', !!on.positions[0] && on.positions[0].signalId === on.signals[0].id, JSON.stringify(on.positions[0]));
ok('the panel says what it did', /Logged a (BUY|SELL)/.test(on.outcome), on.outcome);
ok('including the paper side', /Paper (position opened|order resting)/.test(on.outcome), on.outcome);
ok('and the risk it took', /Risking \$\d/.test(on.outcome), on.outcome);

// --- paper trading OFF: logged, but nothing opened -------------------------
await p.uncheck('#paperEnabled'); await p.waitForTimeout(300);
await generate();
const off = await state();
ok('a second signal was logged', off.signals.length === 2, JSON.stringify(off.signals.length));
ok('but no second position opened', off.positions.length === 1, JSON.stringify(off.positions.length));
ok('and the panel says paper trading is off', /Paper trading is off/.test(off.outcome), off.outcome);

// --- the book fills up: the refusal is explicit, not silent ----------------
await p.check('#paperEnabled'); await p.waitForTimeout(300);
await p.click('#paperAdvancedToggle'); await p.waitForTimeout(200);
await p.fill('#pMaxPos', '1'); await p.dispatchEvent('#pMaxPos', 'change'); await p.waitForTimeout(300);
await generate();
const full = await state();
ok('a full book refuses out loud', /book is full/.test(full.outcome), full.outcome);
ok('and says how to change it', /Max concurrent/.test(full.outcome), full.outcome);
ok('no position was invented', full.positions.length === 1, JSON.stringify(full.positions.length));

// --- the engine holding: say so, do not invent a trade ---------------------
shape = flat;
await p.evaluate(() => localStorage.clear());
await connect();
await p.check('#paperEnabled'); await p.waitForTimeout(300);
await generate();
const hold = await state();
ok('a HOLD is reported as a decision', /No trade taken/.test(hold.outcome), hold.outcome);
ok('and explains the factors are cancelling', /cancelling/.test(hold.outcome), hold.outcome);
ok('it says nothing was logged', /Nothing was logged/.test(hold.outcome), hold.outcome);
ok('and nothing was', hold.signals.length === 0, JSON.stringify(hold.signals.length));
ok('nor traded', hold.positions.length === 0, JSON.stringify(hold.positions.length));
ok('the message is flagged, not silent', hold.colour !== '', hold.colour);
ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
