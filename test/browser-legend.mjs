// The Legend tab explains the marks this system invented — the ones a trader
// cannot guess. It is static content, so what is worth testing is that the tab
// switching still works for all three panels (the wiring used to name two by
// hand), that the legend is hidden until asked for, and that it actually
// carries the entries people get wrong.
import { chromium } from 'playwright';
import { pinPage } from './clock.mjs';
const PORT = process.env.PORT || '8899';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await pinPage(p);
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(900);

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };
const shown = () => p.evaluate(() => ['live','backtest','legend'].filter(
  id => !document.getElementById('tab-' + id).classList.contains('hidden')));
const click = (name) => p.click(`.tab[data-tab="${name}"]`);

ok('the dashboard opens on Live alone', (await shown()).join() === 'live', JSON.stringify(await shown()));

await click('legend'); await p.waitForTimeout(250);
ok('the Legend tab opens', (await shown()).join() === 'legend', JSON.stringify(await shown()));
ok('and the button is marked active',
   await p.evaluate(() => document.querySelector('.tab[data-tab="legend"]').classList.contains('active')) === true, '');

// Switching away and back must still work — the wiring named its panels by hand
// before this, so a third tab was invisible to it.
await click('backtest'); await p.waitForTimeout(250);
ok('Backtest still switches cleanly', (await shown()).join() === 'backtest', JSON.stringify(await shown()));
await click('live'); await p.waitForTimeout(250);
ok('and Live comes back', (await shown()).join() === 'live', JSON.stringify(await shown()));

await click('legend'); await p.waitForTimeout(250);
const txt = await p.evaluate(() => document.getElementById('tab-legend').innerText);

// The entries that exist because people misread them.
ok('it explains the killed marker is ungraded', /neither a win nor a loss/i.test(txt), '');
ok('and that a run of them is not a losing streak', /not a losing streak/i.test(txt), '');
ok('it explains the partial win is not a half-loss', /not a half-loss/i.test(txt), '');
ok('it states the confidence ceiling', /49%/.test(txt), '');
ok('and that confidence is not a probability', /Not a probability/i.test(txt), '');
ok('it explains HOLD blocks trading', /No trade can be taken/i.test(txt), '');
ok('it explains the weekend clock', /tradeable hours only/i.test(txt), '');
ok('it covers the three trade origins', /manual/.test(txt) && /auto/.test(txt) && /worker/.test(txt), '');
ok('it covers driver maturity', /unsupported/.test(txt) && /decaying/.test(txt), '');
ok('it decodes DFII10', /DFII10/.test(txt) && /real/i.test(txt), '');

// And it deliberately leaves out what a trader already knows.
ok('it does not pad itself with standard chart vocabulary',
   /average true range/i.test(txt) === false && /relative strength/i.test(txt) === false, '');

ok('no page errors', errs.length === 0, errs.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
