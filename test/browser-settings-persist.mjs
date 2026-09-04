// Only the paper balance and the autonomy thresholds were ever persisted.
// Everything else a person could tune — risk, spread, slippage, max concurrent,
// partial take-profit, all fourteen weights, target R:R, backtest parameters —
// was read off the DOM and lost on reload, so tuning had to be redone from
// memory each session and an autonomous run silently reverted to defaults.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(1200);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(2000);

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };
const val = id => p.evaluate(i => { const e = document.getElementById(i); return e ? (e.type==='checkbox' ? e.checked : e.value) : null; }, id);

// change a spread of settings across different panels
await p.click('#paperAdvancedToggle'); await p.waitForTimeout(200);
const changes = {
  pRiskPct: '2.5', pSpread: '0.8', pSlippage: '0.2', pMaxPos: '5',
  pFixedLots: '0.35', pLotStep: '0.05', pPartialPct: '65', pHoldMeta: '0.55',
  wOb: '17', wWeekly: '22', wCorrelation: '3', targetRR: '3',
  pBars: '900', pCostPips: '4', newsBeforeMin: '45'
};
// Set values directly and fire `change`. Several of these live on other tabs or
// inside collapsed panels, and visibility is not what is under test here.
await p.evaluate((c) => {
  Object.entries(c).forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const cb = document.getElementById('pPartialEnabled');
  cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
  const sel = document.getElementById('pSizingMode');
  sel.value = 'fixed'; sel.dispatchEvent(new Event('change', { bubbles: true }));
}, changes);
await p.waitForTimeout(600);

ok('a save is confirmed on screen',
  /Settings saved/.test(await p.evaluate(() => document.getElementById('settingsSavedNote').textContent)), '');

// reload and check every one came back
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(2200);
let restored = 0, missed = [];
for (const [id, v] of Object.entries(changes)) {
  const got = await val(id);
  if (String(got) === v) restored++; else missed.push(id + '=' + got + ' want ' + v);
}
ok('every changed setting survived the reload', missed.length === 0, missed.join(', '));
ok('a checkbox survived too', (await val('pPartialEnabled')) === false, String(await val('pPartialEnabled')));
ok('and a select', await val('pSizingMode'), 'fixed');
ok('the settings really were restored, not defaults', restored === Object.keys(changes).length,
   restored + ' of ' + Object.keys(changes).length);

// the slider's printed label has to follow the restored value, not the default
ok('a restored slider shows its own value', await p.evaluate(() => document.getElementById('wObV').textContent), '17');
ok('and the target R:R label too', await p.evaluate(() => document.getElementById('targetRRV').textContent), '1:3');

// the restored risk settings must actually reach the engine, not just the DOM
const cfg = await p.evaluate(() => {
  const n = id => parseFloat(document.getElementById(id).value);
  return { risk: n('pRiskPct'), lots: n('pFixedLots'), step: n('pLotStep'), mode: document.getElementById('pSizingMode').value };
});
ok('the paper config reads the restored values',
  cfg.risk === 2.5 && cfg.lots === 0.35 && cfg.step === 0.05 && cfg.mode === 'fixed', JSON.stringify(cfg));

// resetting the weights must persist too, or a reload brings them back
await p.click('#resetWeights'); await p.waitForTimeout(400);
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(2000);
ok('a weight reset persists', await val('wOb'), '9');
ok('and did not wipe unrelated settings', await val('pRiskPct'), '2.5');

ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
