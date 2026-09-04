// Higher-timeframe resyncs used to end in `.catch(() => {})`. A failure was
// completely silent: the series stopped updating while the engine kept scoring
// structure off it, and weekly + daily + 4H + 1H carry roughly 45 of the
// composite's ~109 weight. The only symptom was that structure stopped moving.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
const STEP = { '15min':9e5, '1h':36e5, '4h':144e5, '1day':864e5, '1week':6048e5 };
function build(n, stepMs, endAt) {
  return Array.from({length:n}, (_, i) => {
    const p = 2000 + Math.sin(i/9) * 6;
    return { datetime: new Date(endAt - (n-1-i)*stepMs).toISOString().slice(0,19).replace('T',' '),
      open:(p-0.5).toFixed(2), high:(p+1.2).toFixed(2), low:(p-1.2).toFixed(2), close:p.toFixed(2) };
  }).reverse();   // newest-first, as the provider returns it
}

let failHtf = false;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
// The 500s below are deliberate, injected by this test's own route.
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404|Failed to load resource/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.route('https://api.twelvedata.com/**', r => {
  const u = new URL(r.request().url());
  const iv = u.searchParams.get('interval');
  if (u.pathname.includes('/price')) return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({price:'2000.00'})});
  if (failHtf && iv === '4h') return r.fulfill({status:500,contentType:'application/json',body:JSON.stringify({message:'upstream unavailable'})});
  const n = Math.min(+u.searchParams.get('outputsize')||500, 900);
  r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ values: build(n, STEP[iv]||9e5, Date.now()) })});
});
await p.route('**/api/fred**', r => r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({observations:[]})}));
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(1200);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(1500);

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };
const health = () => p.evaluate(() => {
  const el = document.getElementById('timeframeHealth');
  return { shown: el && !el.classList.contains('hidden'), text: el ? el.innerText.replace(/\s+/g,' ') : '' };
});

// --- a healthy connection reports nothing ---------------------------------
await p.fill('#apiKeyInput', 'TESTKEY');
await p.click('#connectBtn');
await p.waitForTimeout(5000);
let h = await health();
ok('a healthy feed shows no warning', !h.shown, h.text);

// --- now make the 4H resync fail, and drive one -----------------------------
failHtf = true;
const before = await p.evaluate(async () => {
  // Drive the same path the hourly timer drives, without waiting four hours.
  const r = await fetch('https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=4h&outputsize=200&apikey=TESTKEY');
  return r.status;
});
ok('the routed 4H endpoint is failing as intended', before === 500, String(before));

// The app's own resync path: trigger it through the exposed timer function by
// advancing nothing — instead reconnect, which refetches every timeframe.
await p.click('#connectBtn');
await p.waitForTimeout(5000);
h = await health();
ok('a failing higher timeframe is reported, not swallowed', h.shown, JSON.stringify(h));
ok('it names the timeframe', /4H/.test(h.text), h.text);
// With no real 4H bars the engine aggregates 4H structure from 15-minute
// candles. That is a reasonable fallback and NOT the same thing, so the message
// has to say which is happening rather than implying real bars.
ok('it says the structure is being aggregated', /aggregated/i.test(h.text), h.text);
ok('naming what it is aggregated from', /15-minute candles/i.test(h.text), h.text);
ok('and that it still counts in the score', /full weight/i.test(h.text), h.text);
ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
