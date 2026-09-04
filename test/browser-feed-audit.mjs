// The auditor's remit is not only "is the reasoning sound" but "was it given
// the truth". A feed can be perfectly well-formed and still be the wrong
// instrument, a decimal shift, or a provider that stopped updating — and none
// of those announce themselves.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
const STEP = { '15min':9e5, '1h':36e5, '4h':144e5, '1day':864e5, '1week':6048e5 };
function build(n, stepMs, shape) {
  const now = Date.now();
  return Array.from({length:n}, (_, i) => {
    const p = shape(i);
    return { datetime: new Date(now - (n - i) * stepMs).toISOString().slice(0,19).replace('T',' '),
      open:(p-0.5).toFixed(3), high:(p+1.2).toFixed(3), low:(p-1.2).toFixed(3), close:p.toFixed(3) };
  // newest-first, as the provider returns it
  }).reverse();
}
const healthy = (i) => 2000 + Math.sin(i/9) * 6;
let mode = 'healthy';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.route('https://api.twelvedata.com/**', r => {
  const u = new URL(r.request().url());
  const iv = u.searchParams.get('interval');
  if (u.pathname.includes('/price')) return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({price:'2000.00'})});
  let shape = healthy;
  if (mode === 'shifted')  shape = (i) => healthy(i) / 10;          // decimal shift
  if (mode === 'frozen')   shape = (i) => (i > 60 ? 2000 : healthy(i)); // provider stalled
  if (mode === 'mismatch' && iv !== '15min') shape = (i) => healthy(i) / 2; // 4H on another instrument
  r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
    values: build(Math.min(+u.searchParams.get('outputsize')||500, 900), STEP[iv]||9e5, shape) })});
});
await p.route('**/api/fred**', r => r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({observations:[]})}));

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };
const panel = () => p.evaluate(() => {
  const el = document.getElementById('auditContent');
  return el ? el.innerText.replace(/\s+/g,' ') : '';
});
async function load() {
  await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
  await p.waitForTimeout(1000);
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(1200);
  await p.fill('#apiKeyInput', 'TESTKEY');
  await p.click('#connectBtn');
  await p.waitForTimeout(4500);
  await p.click('#genBtn'); await p.waitForTimeout(1500);
}

// --- a healthy feed must not be accused ------------------------------------
mode = 'healthy'; await load();
const good = await panel();
ok('a healthy feed is not accused of anything', !/data feeding this analysis is wrong/i.test(good), good.slice(0,220));
ok('no decimal-shift claim', !/decimal shift/i.test(good), good.slice(0,220));
ok('no stall claim', !/stopped moving/i.test(good), good.slice(0,220));

// --- a decimal shift: the chart shape is unchanged, every level is wrong ----
mode = 'shifted'; await load();
const shifted = await panel();
ok('a decimal shift is caught', /outside anything this instrument trades at/i.test(shifted), shifted.slice(0,400));
ok('the verdict blames the feed, not the reasoning', /data feeding this analysis is wrong/i.test(shifted), shifted.slice(0,300));
ok('and says nothing downstream can be trusted', /nothing downstream can be trusted/i.test(shifted), shifted.slice(0,300));
ok('it names the cause', /wrong symbol or a decimal shift/i.test(shifted), shifted.slice(0,400));
ok('and points at specific bars', /bar \d+ \(/.test(shifted), shifted.slice(0,500));

// --- a provider that stopped updating --------------------------------------
mode = 'frozen'; await load();
const frozen = await panel();
ok('a stalled provider is caught', /the feed stopped moving/i.test(frozen), frozen.slice(0,400));
ok('and counts the frozen run', /consecutive bars share the identical close/i.test(frozen), frozen.slice(0,400));
ok('and says why nothing else would notice', /looks exactly like a flat market/i.test(frozen), frozen.slice(0,500));

// --- one timeframe on a different instrument -------------------------------
mode = 'mismatch'; await load();
const mismatch = await panel();
ok('timeframes that disagree about the price are caught', /timeframes disagree about the price/i.test(mismatch), mismatch.slice(0,400));
ok('it lists the levels', /latest close by series/i.test(mismatch), mismatch.slice(0,400));
ok('and says the alignment is meaningless', /alignment is meaningless/i.test(mismatch), mismatch.slice(0,500));
ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
