// Nothing is carried through the weekly close. A position held across it is
// graded by the Sunday gap rather than by the setup, and a resting order would
// fill at its limit price in simulation when the real fill was far worse — both
// put fabricated evidence into the record the system learns from.
import { chromium } from 'playwright';
import { pinPage } from './clock.mjs';
const PORT = process.env.PORT || '8899';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };

async function pageAt(iso) {
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
  await pinPage(p, Date.parse(iso));
  await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    const sig = (id, status) => ({ id, dir:'BUY', entry:2000, sl:1990, tp:2040,
      entryType: status === 'open' ? 'market' : 'limit', confidence:40, grade:'C', source:'worker',
      time:'2026-09-04T18:00:00.000Z', status,
      filledAt: status === 'open' ? '2026-09-04T18:05:00.000Z' : null,
      factors:{htf:1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0 });
    localStorage.clear();
    localStorage.setItem('smc-signal-log-v1', JSON.stringify([sig('OPEN1','open'), sig('REST1','pending')]));
    localStorage.setItem('smc-paper-v1', JSON.stringify({ enabled:true, manual:true,
      startingBalance:10000, epoch:null, positions:[
      { id:'pp-OPEN1', signalId:'OPEN1', dir:'BUY', requestedEntry:2000, entryFill:2000, sl:1990, tp:2040,
        units:10, lots:0.10, contractSize:100, riskAmount:100, requestedRisk:100, balanceAtOpen:10000,
        openedAt:'2026-09-04T18:05:00.000Z', status:'open', filledAt:'2026-09-04T18:05:00.000Z' },
      { id:'pp-REST1', signalId:'REST1', dir:'BUY', requestedEntry:2000, entryFill:2000, sl:1990, tp:2040,
        units:10, lots:0.10, contractSize:100, riskAmount:100, requestedRisk:100, balanceAtOpen:10000,
        openedAt:'2026-09-04T18:00:00.000Z', status:'pending', filledAt:null }
    ]}));
  });
  await p.reload({ waitUntil:'domcontentloaded' });
  await p.waitForTimeout(2200);
  const log = await p.evaluate(() => JSON.parse(localStorage.getItem('smc-signal-log-v1') || '[]'));
  const book = await p.evaluate(() => JSON.parse(localStorage.getItem('smc-paper-v1') || '{}').positions || []);
  return { p, errs, log, book };
}

// ---- Friday, well before the close: leave it alone -------------------------
{
  const { p, errs, log } = await pageAt('2026-09-04T19:00:00Z');
  ok('two hours out, both trades are left running',
     log.filter(s => s.status === 'open' || s.status === 'pending').length === 2,
     JSON.stringify(log.map(s => s.status)));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await p.close();
}

// ---- inside the window: clear the book -------------------------------------
{
  const { p, errs, log, book } = await pageAt('2026-09-04T20:45:00Z');
  const open1 = log.find(s => s.id === 'OPEN1');
  const rest1 = log.find(s => s.id === 'REST1');
  ok('the open position is closed', open1.status === 'expired', open1.status);
  ok('the resting order is cancelled too', rest1.status === 'expired', rest1.status);
  ok('both are tagged as a weekend flatten',
     open1.killSwitch === 'weekend-flatten' && rest1.killSwitch === 'weekend-flatten', '');
  ok('and the reason says it is not a verdict',
     /not a verdict on the setup/.test(open1.expiryReason), open1.expiryReason);
  ok('neither is recorded as a win or a loss',
     ['won','lost'].indexOf(open1.status) === -1 && ['won','lost'].indexOf(rest1.status) === -1, '');
  ok('the paper book is flat', book.filter(x => x.status === 'open' || x.status === 'pending').length === 0,
     JSON.stringify(book.map(x => x.status)));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await p.close();
}

// ---- market already shut: sweep anything that slipped through --------------
{
  const { p, errs, log } = await pageAt('2026-09-06T12:00:00Z');
  ok('a book left live over the weekend is cleared on sight',
     log.filter(s => s.status === 'open' || s.status === 'pending').length === 0,
     JSON.stringify(log.map(s => s.status)));
  ok('described as after the close rather than counting down',
     /after the weekly close/.test(log.find(s => s.id === 'OPEN1').expiryReason), '');
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await p.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
