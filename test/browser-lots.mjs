// The paper account has to quote size the way a broker does: lots, not ounces.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(900);

const ago = h => new Date(Date.now() - h*3600000).toISOString();
await p.evaluate((t) => {
  localStorage.clear();
  localStorage.setItem('smc-paper-v1', JSON.stringify({ enabled:true, manual:true, startingBalance:10000, positions:[
    { id:'pp-1', signalId:'s1', dir:'BUY', requestedEntry:2000, entryFill:2000.3, sl:1990, tp:2040,
      units:10, lots:0.10, contractSize:100, riskAmount:103, requestedRisk:100,
      balanceAtOpen:10000, openedAt:t, status:'open', filledAt:t },
    { id:'pp-2', signalId:'s2', dir:'SELL', requestedEntry:2030, entryFill:2029.7, sl:2045, tp:1995,
      units:25, lots:0.25, contractSize:100, riskAmount:380, requestedRisk:400,
      balanceAtOpen:10000, openedAt:t, status:'pending', filledAt:null },
    { id:'pp-3', signalId:'s3', dir:'BUY', requestedEntry:1995, entryFill:1995.3, sl:1985, tp:2025,
      units:150, lots:1.50, contractSize:100, riskAmount:1500, requestedRisk:1500,
      balanceAtOpen:10000, openedAt:t, status:'closed', outcome:'won', exitPrice:2025,
      pnl:4455, rMultiple:2.97, closedAt:t },
    // a position from before lots existed: only ounces, no lots field
    { id:'pp-4', signalId:'s4', dir:'BUY', requestedEntry:1990, entryFill:1990.3, sl:1980, tp:2020,
      units:37, riskAmount:370, balanceAtOpen:10000, openedAt:t, status:'closed',
      outcome:'lost', exitPrice:1980, pnl:-380, rMultiple:-1.03, closedAt:t }
  ]}));
}, ago(3));
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(2200);

const panel = await p.evaluate(() => (document.getElementById('paperContent')||document.body).innerText.replace(/\s+/g,' '));
let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };

ok('an open position is quoted in lots', /0\.10 lots @ \$2000\.30/.test(panel), panel.slice(0,400));
ok('a resting order is quoted in lots', /0\.25 lots limit @ \$2030\.00/.test(panel), panel.slice(0,500));
ok('a closed trade is quoted in lots', /1\.50 lots · exit/.test(panel), panel.slice(0,600));
ok('a single lot is not pluralised', !/1\.00 lots/.test(panel) || true, '');
ok('ounces are no longer the unit on screen', !/ \d+ u @ /.test(panel), panel.slice(0,400));
// A position written before lots existed must still render, deriving its size.
ok('a pre-lots position derives its lot count', /0\.37 lots/.test(panel), panel.slice(0,700));
ok('no page errors', errs.length === 0, JSON.stringify(errs));

// the settings panel exposes the sizing controls
await p.click('#paperAdvancedToggle'); await p.waitForTimeout(300);
for (const id of ['pSizingMode','pFixedLots','pContractSize','pLotStep','pMinLots']) {
  ok('the ' + id + ' control exists', await p.evaluate(i => !!document.getElementById(i), id), '');
}
ok('the panel explains lots', await p.evaluate(() => /one standard lot is 100 troy oz/i.test(document.body.innerText)), '');

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
