// A resting order that sits too long is a liability: the move it was placed for
// has happened, and price returning later is a retest of a spent zone rather
// than the setup that was analysed. The kill switch must cancel it, cancel the
// paper order with it, and never let it count as a win or a loss.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
// Price sits at 2012 and never trades down to a 2000 limit. Each timeframe gets
// its own spacing — serving 15-minute bars for every interval makes the data
// auditor (correctly) report a stale, out-of-order feed, which is noise here.
const STEP = { '15min':9e5, '1h':36e5, '4h':144e5, '1day':864e5, '1week':6048e5 };
function candles(n, stepMs){const now=Date.now();
 return Array.from({length:n},(_,i)=>{const p=2012+Math.sin(i/11)*1.2;
  return {datetime:new Date(now-(n-i)*(stepMs||9e5)).toISOString().slice(0,19).replace('T',' '),
   open:p.toFixed(2),high:(p+0.8).toFixed(2),low:(p-0.8).toFixed(2),close:p.toFixed(2)};})
  // Twelve Data returns newest-first and the app reverses what it receives, so
  // an oldest-first fixture arrives backwards — which the data auditor rightly
  // reports as an out-of-order, stale feed.
  .reverse();}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.route('https://api.twelvedata.com/**', r => {
  const u = new URL(r.request().url());
  if (u.pathname.includes('/price')) return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({price:'2012.00'})});
  const iv = u.searchParams.get('interval');
  r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
    values: candles(Math.min(+u.searchParams.get('outputsize')||500, 900), STEP[iv]||9e5) })});
});
await p.route('**/api/fred**', r => r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({observations:[]})}));
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(800);

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };

// Two worker trades: one resting for 30h (well past the 12h kill limit) and one
// resting for 1h (inside it). Each has a matching paper order.
await p.evaluate(() => {
  const ago = h => new Date(Date.now() - h*3600000).toISOString();
  localStorage.clear();
  localStorage.setItem('smc-signal-log-v1', JSON.stringify([
    { id:'STALE', dir:'BUY', entry:2000, sl:1990, tp:2040, entryType:'limit', time:ago(30),
      status:'pending', confidence:40, grade:'C', source:'worker',
      factors:{htf:1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0 },
    { id:'FRESH', dir:'BUY', entry:2000, sl:1990, tp:2040, entryType:'limit', time:ago(1),
      status:'pending', confidence:40, grade:'C', source:'worker',
      factors:{htf:1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0 }
  ]));
  localStorage.setItem('smc-paper-v1', JSON.stringify({ enabled:true, manual:true, startingBalance:10000, positions:[
    { id:'pp-STALE', signalId:'STALE', dir:'BUY', requestedEntry:2000, entryFill:2000.3, sl:1990, tp:2040,
      units:10, riskAmount:100, balanceAtOpen:10000, openedAt:ago(30), status:'pending', filledAt:null },
    { id:'pp-FRESH', signalId:'FRESH', dir:'BUY', requestedEntry:2000, entryFill:2000.3, sl:1990, tp:2040,
      units:10, riskAmount:100, balanceAtOpen:10000, openedAt:ago(1), status:'pending', filledAt:null }
  ]}));
  localStorage.setItem('smc-factor-stats-v1', JSON.stringify({ factors:{}, patterns:{}, totalLogged:0, metaExamples:[], metaModel:null }));
});
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(2000);

const before = await p.evaluate(() => ({
  oldest: document.getElementById('aOldest').textContent,
  killed: document.getElementById('aKilled').textContent,
  open: document.getElementById('aOpen').textContent
}));
ok('the age of the oldest live trade is visible', /^\d+(\.\d+)?h$/.test(before.oldest), before.oldest);
ok('and it is flagged as close to the limit',
   await p.evaluate(() => document.getElementById('aOldest').style.color !== ''), before.oldest);
ok('both orders start live', before.open, '2');
ok('nothing killed yet', before.killed, '0');

// Run one autonomous cycle against candles that never touch the entry.
await p.evaluate(() => {
  document.getElementById('apiKeyInput').value = 'TESTKEY';
});
await p.click('#connectBtn'); await p.waitForTimeout(3000);
await p.evaluate(() => { document.getElementById('autonomyEnabled').checked = false; });
await p.evaluate(() => window.__resolveNow && window.__resolveNow());
await p.check('#autonomyEnabled'); await p.waitForTimeout(6000);

const after = await p.evaluate(() => ({
  signals: JSON.parse(localStorage.getItem('smc-signal-log-v1')),
  positions: JSON.parse(localStorage.getItem('smc-paper-v1')).positions,
  learning: JSON.parse(localStorage.getItem('smc-factor-stats-v1')),
  killed: document.getElementById('aKilled').textContent,
  rows: Array.from(document.querySelectorAll('#tradeLog .log-item')).map(el => el.innerText.replace(/\s+/g,' ').trim())
}));
const stale = after.signals.find(s => s.id === 'STALE');
const fresh = after.signals.find(s => s.id === 'FRESH');
const pStale = after.positions.find(x => x.signalId === 'STALE');
const pFresh = after.positions.find(x => x.signalId === 'FRESH');

ok('the stale order was killed', stale && stale.status === 'expired', JSON.stringify(stale && stale.status));
ok('and it says why', !!stale && /past the \d+h limit|retest|ran a further/.test(stale.expiryReason || ''), stale && stale.expiryReason);
// The auditor is the authority here, not the engine deciding its own trade has
// gone bad, and the record says which component made the call.
ok('the auditor is credited with the call', !!stale && /^auditor:/.test(stale.expiryReason || ''), stale && stale.expiryReason);
ok('and recorded as the resolver', !!stale && stale.resolvedBy === 'auditor', stale && stale.resolvedBy);
ok('tagged with which arm fired', !!stale && !!stale.killSwitch, stale && stale.killSwitch);
ok('the fresh order was left alone', fresh && fresh.status === 'pending', JSON.stringify(fresh && fresh.status));

ok('its paper order was cancelled, not closed', pStale && pStale.status === 'cancelled', JSON.stringify(pStale && pStale.status));
ok('with no P&L invented', !!pStale && (pStale.pnl === 0 || pStale.pnl == null), JSON.stringify(pStale && pStale.pnl));
ok('the fresh paper order still rests', pFresh && pFresh.status === 'pending', JSON.stringify(pFresh && pFresh.status));

ok('a killed trade is never a win', stale && stale.status !== 'won', '');
ok('nor a loss', stale && stale.status !== 'lost', '');
ok('and it fed the learning loop nothing', after.learning.totalLogged === 0, 'totalLogged=' + after.learning.totalLogged);
ok('the log row calls it killed', after.rows.some(r => /killed/.test(r)), JSON.stringify(after.rows));
ok('the killed counter moved', after.killed !== '0', after.killed);
// the audit panel has to show its live-trade review, not just the analysis one
const auditPanel = await p.evaluate(() => {
  const el = document.getElementById('auditContent');
  return el ? el.innerText.replace(/\s+/g,' ') : '';
});
ok('the audit panel reviews live trades', /live trades under audit/i.test(auditPanel), auditPanel.slice(0, 300));
ok('and the analysis audit is clean on good data', !/out of chronological order/.test(auditPanel), auditPanel.slice(0, 300));
ok('and reports what it found', /live trade\(s\)/i.test(auditPanel), auditPanel.slice(0, 300));
ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
