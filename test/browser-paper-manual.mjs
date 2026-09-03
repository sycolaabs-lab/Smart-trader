// Generating a trade by hand should not force a choice made in another panel:
// the signal panel decides whether hand-made signals open a paper position, and
// ticking it while the paper account is off must switch the account on rather
// than doing nothing.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
function candles(n){const o=[];const now=Date.now();let p=2000;
 for(let i=n;i>=0;i--){p=2000+Math.sin(i/9)*8;const h=p+2.5,l=p-2.5;
 o.push({datetime:new Date(now-i*9e5).toISOString().slice(0,19).replace('T',' '),open:p.toFixed(2),high:h.toFixed(2),low:l.toFixed(2),close:p.toFixed(2)});}
 return o.reverse();}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.route('https://api.twelvedata.com/**', r => {
  const u = new URL(r.request().url());
  if (u.pathname.includes('/price')) return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({price:'2000.00'})});
  r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({values:candles(Math.min(+u.searchParams.get('outputsize')||500,900))})});
});
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(700);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(1800);

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
// Generate until a non-HOLD signal is logged, so the test is about the toggle
// rather than about which way the market happened to read.
async function generateSignal() {
  const before = (await state()).signals.length;
  for (let i = 0; i < 12; i++) {
    await p.click('#genBtn'); await p.waitForTimeout(900);
    if ((await state()).signals.length > before) return true;
  }
  return false;
}

// --- toggle exists and starts in a sane place ------------------------------
const s0 = await state();
ok('the signal panel has its own paper toggle', s0.manual === true, JSON.stringify(s0));
ok('the paper account itself starts off', s0.master === false, JSON.stringify(s0));
ok('and the toggle says what ticking it would do', /switch the paper account on/.test(s0.hint), s0.hint);

// --- off: a hand-made signal is logged but opens nothing --------------------
await p.uncheck('#paperManual'); await p.waitForTimeout(300);
const s1 = await state();
ok('unticking does not switch the account on', s1.master === false, JSON.stringify(s1));
ok('and it says trades will be graded but not opened', /no position is opened/.test(s1.hint), s1.hint);
ok('a manual signal was generated', await generateSignal(), 'no signal logged after 12 tries');
const s2 = await state();
ok('the signal is still logged and learned from', s2.signals.length > 0, JSON.stringify(s2.signals.length));
ok('but no paper position was opened', s2.positions.length === 0, 'positions: ' + JSON.stringify(s2.positions));

// --- on: ticking it activates paper trading and books the next one ----------
await p.check('#paperManual'); await p.waitForTimeout(400);
const s3 = await state();
ok('ticking it switches the paper account on', s3.master === true, JSON.stringify(s3));
ok('the paper panel agrees', /^On —/.test(s3.status), s3.status);
ok('and the hint stops promising to turn anything on', /simulated only/.test(s3.hint), s3.hint);
ok('a second manual signal was generated', await generateSignal(), 'no second signal');
const s4 = await state();
ok('this one opened a paper position', s4.positions.length === 1, 'positions: ' + s4.positions.length);
ok('and it is tied to the signal that made it',
   !!s4.positions[0] && s4.positions[0].signalId === s4.signals[0].id,
   JSON.stringify({pos: s4.positions[0] && s4.positions[0].signalId, sig: s4.signals[0] && s4.signals[0].id}));

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
