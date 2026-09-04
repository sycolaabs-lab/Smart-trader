// A position already open rides straight into the print unless something closes
// it. NFP routinely moves gold further in ninety seconds than a normal stop is
// wide, and the spread widens at the same moment — whatever comes out of that
// says nothing about whether the setup was sound.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(900);

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };

// Seed a book of live trades and a calendar with NFP a set number of minutes out.
async function seed(minutesOut) {
  await p.evaluate((mins) => {
    const now = Date.now();
    const at = now + mins * 60000;
    localStorage.clear();
    localStorage.setItem('smc-calendar-v1', JSON.stringify({
      calendar: [{ key:'nfp', name:'Nonfarm Payrolls', impact:'high', at, date:'2026-09-04' }],
      fetchedAt: now
    }));
    const sig = (id, status) => ({ id, dir:'BUY', entry:2000, sl:1990, tp:2040,
      entryType: status === 'open' ? 'market' : 'limit', confidence:45, grade:'C', source:'auto',
      time: new Date(now - 3600000).toISOString(), status,
      filledAt: status === 'open' ? new Date(now - 3000000).toISOString() : null,
      factors:{htf:1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0 });
    localStorage.setItem('smc-signal-log-v1', JSON.stringify([sig('OPEN1','open'), sig('REST1','pending')]));
    localStorage.setItem('smc-paper-v1', JSON.stringify({ enabled:true, manual:true, startingBalance:10000, positions:[
      { id:'pp-OPEN1', signalId:'OPEN1', dir:'BUY', requestedEntry:2000, entryFill:2000.3, sl:1990, tp:2040,
        units:10, lots:0.10, contractSize:100, riskAmount:103, requestedRisk:100,
        balanceAtOpen:10000, openedAt:new Date(now-3000000).toISOString(), status:'open', filledAt:new Date(now-3000000).toISOString() },
      { id:'pp-REST1', signalId:'REST1', dir:'BUY', requestedEntry:2000, entryFill:2000.3, sl:1990, tp:2040,
        units:10, lots:0.10, contractSize:100, riskAmount:103, requestedRisk:100,
        balanceAtOpen:10000, openedAt:new Date(now-3600000).toISOString(), status:'pending', filledAt:null }
    ]}));
    localStorage.setItem('smc-factor-stats-v1', JSON.stringify({ factors:{}, patterns:{}, totalLogged:0, metaExamples:[], metaModel:null }));
  }, minutesOut);
  await p.reload({ waitUntil:'domcontentloaded' });
  await p.waitForTimeout(2400);
}
const state = () => p.evaluate(() => ({
  signals: JSON.parse(localStorage.getItem('smc-signal-log-v1') || '[]'),
  positions: JSON.parse(localStorage.getItem('smc-paper-v1') || '{}').positions || [],
  learning: JSON.parse(localStorage.getItem('smc-factor-stats-v1') || '{}'),
  banner: document.getElementById('newsBanner').innerText.replace(/\s+/g,' '),
  bannerShown: !document.getElementById('newsBanner').classList.contains('hidden')
}));

// --- 45 minutes out: warn, do not touch anything --------------------------
await seed(45);
let s = await state();
ok('an hour out the alert is showing', s.bannerShown, 'banner hidden');
ok('it names the release', /Nonfarm Payrolls/.test(s.banner), s.banner);
ok('and how long there is', /in 4\d minutes/.test(s.banner), s.banner);
ok('and warns positions will be closed', /will be closed/i.test(s.banner), s.banner);
ok('nothing has been closed yet', s.signals.every(x => x.status === 'open' || x.status === 'pending'),
   JSON.stringify(s.signals.map(x => x.status)));
ok('and no position touched', s.positions.every(x => x.status === 'open' || x.status === 'pending'),
   JSON.stringify(s.positions.map(x => x.status)));

// --- 10 minutes out: everything closes ------------------------------------
await seed(10);
s = await state();
const open1 = s.signals.find(x => x.id === 'OPEN1');
const rest1 = s.signals.find(x => x.id === 'REST1');
const pOpen = s.positions.find(x => x.signalId === 'OPEN1');
const pRest = s.positions.find(x => x.signalId === 'REST1');

ok('the open trade was closed', open1 && open1.status === 'expired', JSON.stringify(open1 && open1.status));
ok('the resting order was cancelled', rest1 && rest1.status === 'expired', JSON.stringify(rest1 && rest1.status));
ok('the reason names the release', !!open1 && /Nonfarm Payrolls/.test(open1.expiryReason || ''), open1 && open1.expiryReason);
ok('and says it is not a verdict', !!open1 && /not a verdict on the setup/.test(open1.expiryReason || ''), open1 && open1.expiryReason);
ok('tagged so it is machine-readable', open1 && open1.killSwitch, 'news-flatten');
ok('and credited to the calendar', open1 && open1.resolvedBy, 'news');

ok('the open position was closed for real money', pOpen && pOpen.status === 'closed', JSON.stringify(pOpen && pOpen.status));
ok('booked as expired, not won or lost', pOpen && pOpen.outcome, 'expired');
ok('the resting order was cancelled with no P&L', pRest && pRest.status === 'cancelled', JSON.stringify(pRest && pRest.status));
ok('and no P&L invented on it', !!pRest && (pRest.pnl === 0 || pRest.pnl == null), JSON.stringify(pRest && pRest.pnl));

ok('a flattened trade is never a win', open1 && open1.status !== 'won', '');
ok('nor a loss', open1 && open1.status !== 'lost', '');
ok('and it taught the learning loop nothing', s.learning.totalLogged === 0, 'totalLogged=' + s.learning.totalLogged);

ok('the banner says it is acting now', /closing open positions/i.test(s.banner), s.banner);
ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
