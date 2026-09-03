// A trade the background worker took must be visible in the signal log as the
// system's own trade, with its outcome and its paper result — not as a blank
// row waiting for someone to click Won or Lost.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
function candles(n){const o=[];const now=Date.now();let p=2000;
 for(let i=n;i>=0;i--){p=2000+Math.sin(i/9)*6;const h=p+2,l=p-2;
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
await p.waitForTimeout(800);

const ago = m => new Date(Date.now() - m*60000).toISOString();
await p.evaluate((t) => {
  localStorage.clear();
  localStorage.setItem('smc-signal-log-v1', JSON.stringify([
    // taken by the worker overnight and graded by the worker — a win
    { id:'W1', dir:'BUY', entry:1990, sl:1980, tp:2020, entryType:'market', time:t.t1,
      status:'won', resolvedBy:'worker', resolvedAt:t.t0, exitPrice:2020, confidence:58, grade:'C',
      source:'worker', factors:{htf:1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0.1 },
    // taken by the worker and still resting
    { id:'W2', dir:'SELL', entry:2030, sl:2045, tp:1995, entryType:'limit', time:t.t2,
      status:'pending', confidence:52, grade:'D', source:'worker',
      factors:{htf:-1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0 },
    // taken by autonomous mode in this tab, filled and running
    { id:'A1', dir:'BUY', entry:1995, sl:1985, tp:2025, entryType:'market', time:t.t3,
      status:'open', confidence:61, grade:'C', source:'auto',
      factors:{htf:1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0.2 },
    // a hand-generated one, for contrast
    { id:'M1', dir:'SELL', entry:2010, sl:2020, tp:1980, entryType:'market', time:t.t4,
      status:'pending', confidence:44, grade:'D', source:'manual',
      factors:{htf:-1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0 }
  ]));
  localStorage.setItem('smc-paper-v1', JSON.stringify({ enabled:true, startingBalance:10000, positions:[
    { id:'pp-W1', signalId:'W1', dir:'BUY', requestedEntry:1990, entryFill:1990.3, sl:1980, tp:2020,
      units:10, riskAmount:100, balanceAtOpen:10000, openedAt:t.t1, status:'closed', outcome:'won',
      exitPrice:2020, pnl:297, rMultiple:2.97, closedAt:t.t0 },
    { id:'pp-W2', signalId:'W2', dir:'SELL', requestedEntry:2030, entryFill:2029.7, sl:2045, tp:1995,
      units:6.6, riskAmount:100, balanceAtOpen:10297, openedAt:t.t2, status:'pending', filledAt:null },
    { id:'pp-A1', signalId:'A1', dir:'BUY', requestedEntry:1995, entryFill:1995.3, sl:1985, tp:2025,
      units:10, riskAmount:100, balanceAtOpen:10297, openedAt:t.t3, status:'open', filledAt:t.t3 }
  ]}));
}, { t0:ago(10), t1:ago(400), t2:ago(300), t3:ago(200), t4:ago(100) });

await p.reload({ waitUntil:'domcontentloaded' });
await p.waitForTimeout(2200);

const rows = await p.evaluate(() => Array.from(document.querySelectorAll('#tradeLog .log-item')).map(el => el.innerText.replace(/\s+/g,' ').trim()));
let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };
const row = id => rows.find(r => r.includes(id)) || '';
const W1 = rows.find(r => /2020|1990/.test(r) && /worker/.test(r) && /won/.test(r)) || '';
const all = rows.join('\n');

ok('the log rendered every signal', rows.length === 4, 'got ' + rows.length + ':\n' + all);
ok('a worker trade is labelled as the worker\'s', /worker/.test(all), all);
ok('an autonomous trade is labelled auto', /auto/.test(all), all);
ok('a hand-made one is labelled manual', /manual/.test(all), all);
ok('the worker win shows as won without anyone clicking', /✓ won \(worker\)/.test(all), all);
ok('its paper result is on the row', /paper: \+\$297\.00 \(\+2\.97R\)/.test(all), all);
ok('a resting worker order says so', /paper: resting/.test(all), all);
ok('a live position shows floating P&L', /paper: [+-]\$[\d.]+ floating/.test(all), all);
ok('unresolved system trades say they grade themselves', (all.match(/self-grading/g)||[]).length === 2,
   'expected 2 (W2 pending + A1 open), got ' + (all.match(/self-grading/g)||[]).length);
ok('the manual one does not claim to self-grade', !/manual[\s\S]{0,80}self-grading/.test(row('manual')), row('manual'));
ok('the manual override buttons are still there', (all.match(/Won/g)||[]).length >= 3, all);
ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
