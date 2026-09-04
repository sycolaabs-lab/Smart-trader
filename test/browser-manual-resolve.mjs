// Resolving live trades used to happen ONLY inside the autonomous cycle. With
// autonomy off, a hand-generated signal opened a paper order — most plans are a
// limit, "retrace into order block" — and then nothing ever touched it again.
// It could not fill, resolve, or be culled: it rested forever while the account
// showed no open positions and no P&L, which reads exactly like paper trading
// having ignored the trade.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
const STEP = { '15min':9e5, '1h':36e5, '4h':144e5, '1day':864e5, '1week':6048e5 };
// Price sits above 4400 and then dips THROUGH it inside the last few hours —
// after the signal was taken, which is the only window resolveSignal looks at.
function build(n, stepMs) {
  const now = Date.now();
  const dipFrom = n - 12;   // 12 bars back: three hours on the 15m series
  return Array.from({length:n}, (_, i) => {
    const p = i < dipFrom ? 4420 + Math.sin(i / 9) * 3
      : 4420 - Math.sin((i - dipFrom) / 12 * Math.PI) * 40;   // dips to ~4380
    return { datetime: new Date(now - (n-1-i)*stepMs).toISOString().slice(0,19).replace('T',' '),
      open:(p-0.6).toFixed(2), high:(p+1.6).toFixed(2), low:(p-1.6).toFixed(2), close:p.toFixed(2) };
  }).reverse();
}
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404|Failed to load/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.route('https://api.twelvedata.com/**', r => {
  const u = new URL(r.request().url());
  if (u.pathname.includes('/price')) return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({price:'4420.00'})});
  const iv = u.searchParams.get('interval');
  r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ values: build(Math.min(+u.searchParams.get('outputsize')||500,900), STEP[iv]||9e5) })});
});
await p.route('**/api/fred**', r => r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({observations:[]})}));
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(1000);

// A resting BUY limit at 4400, taken by hand an hour ago. Autonomy is OFF.
await p.evaluate(() => {
  const now = Date.now();
  localStorage.clear();
  localStorage.setItem('smc-autonomy-v1', JSON.stringify({ enabled: false }));
  localStorage.setItem('smc-signal-log-v1', JSON.stringify([{
    id:'MANUAL1', dir:'BUY', entry:4400, sl:4380, tp:4460, entryType:'limit — retrace into order block',
    confidence:45, grade:'C', source:'manual', time:new Date(now - 3600000).toISOString(),
    status:'pending', factors:{htf:1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0
  }]));
  localStorage.setItem('smc-paper-v1', JSON.stringify({ enabled:true, manual:true, startingBalance:10000, positions:[{
    id:'pp-MANUAL1', signalId:'MANUAL1', dir:'BUY', requestedEntry:4400, entryFill:4400.3, sl:4380, tp:4460,
    units:5, lots:0.05, contractSize:100, riskAmount:101.5, requestedRisk:100,
    balanceAtOpen:10000, openedAt:new Date(now - 3600000).toISOString(), status:'pending', filledAt:null
  }]}));
});
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(1500);

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };
const state = () => p.evaluate(() => ({
  autonomy: document.getElementById('autonomyEnabled').checked,
  sig: (JSON.parse(localStorage.getItem('smc-signal-log-v1')||'[]'))[0],
  pos: ((JSON.parse(localStorage.getItem('smc-paper-v1')||'{}').positions)||[])[0],
  panel: (document.getElementById('paperContent')||{}).innerText?.replace(/\s+/g,' ') || ''
}));

let s = await state();
ok('autonomy really is off', s.autonomy === false, String(s.autonomy));
ok('the order starts resting', s.sig && s.sig.status === 'pending', JSON.stringify(s.sig && s.sig.status));

// Connect a provider whose candles trade through 4400.
await p.fill('#apiKeyInput','TESTKEY');
await p.click('#connectBtn');
await p.waitForTimeout(5500);
s = await state();

ok('the resting order filled with autonomy off', s.sig && (s.sig.status === 'open' || s.sig.status === 'won' || s.sig.status === 'lost'),
   'signal is still ' + JSON.stringify(s.sig && s.sig.status));
ok('and the paper position followed it',
   s.pos && (s.pos.status === 'open' || s.pos.status === 'closed'),
   'position is still ' + JSON.stringify(s.pos && s.pos.status));
ok('the account no longer reports it as merely resting',
   !/\+1 resting/.test(s.panel) , s.panel.slice(0, 200));
ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
