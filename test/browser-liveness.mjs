// Every taken trade must say whether it is still working or effectively dead.
// "awaiting entry" and "filled" are true of a trade placed a minute ago and of
// one about to be culled — the log has to tell those apart at a glance.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
function candles(n){return Array.from({length:n},(_,i)=>{const p=2012+Math.sin(i/11)*1.2;const now=Date.now();
  return {datetime:new Date(now-(n-i)*9e5).toISOString().slice(0,19).replace('T',' '),
   open:p.toFixed(2),high:(p+0.8).toFixed(2),low:(p-0.8).toFixed(2),close:p.toFixed(2)};})
 // Twelve Data returns newest-first and the app reverses what it receives.
 .reverse();}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.route('https://api.twelvedata.com/**', r => {
  const u = new URL(r.request().url());
  if (u.pathname.includes('/price')) return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({price:'2012.00'})});
  r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({values:candles(Math.min(+u.searchParams.get('outputsize')||500,900))})});
});
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(700);

await p.evaluate(() => {
  const ago = h => new Date(Date.now() - h*3600000).toISOString();
  const base = (id, o) => Object.assign({ id, dir:'BUY', entry:2000, sl:1990, tp:2040,
    entryType:'limit', confidence:40, grade:'C', source:'worker',
    factors:{htf:1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0 }, o);
  localStorage.clear();
  localStorage.setItem('smc-signal-log-v1', JSON.stringify([
    base('FRESH',   { status:'pending', time:ago(1) }),
    base('STALING', { status:'pending', time:ago(7) }),
    base('DYING',   { status:'pending', time:ago(11) }),
    base('RUNNING', { status:'open', time:ago(6), filledAt:ago(5), entryType:'market' }),
    base('OLD',     { status:'open', time:ago(80), filledAt:ago(70), entryType:'market' }),
    base('DONE',    { status:'won', time:ago(90), resolvedBy:'worker', exitPrice:2040 })
  ]));
});
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(2200);

const rows = await p.evaluate(() => Array.from(document.querySelectorAll('#tradeLog .log-item')).map(el => {
  const chips = Array.from(el.querySelectorAll('.mono[title]'));
  return { text: el.innerText.replace(/\s+/g,' ').trim(),
           titles: chips.map(c => c.getAttribute('title')),
           colours: chips.map(c => c.style.color) };
}));
const all = rows.map(r => r.text).join('\n');
const allTitles = rows.flatMap(r => r.titles).join('\n');

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };

ok('every signal rendered', rows.length === 6, 'got ' + rows.length);
ok('a fresh order reads as alive', /resting 1\.0h · alive/.test(all), all);
ok('one past half its life reads as going stale', /resting 7\.0h · going stale/.test(all), all);
ok('one near the limit reads as about to be killed', /resting 11\.0h · about to be killed/.test(all), all);
ok('a filled position reads as running', /running 5\.0h · alive/.test(all), all);
// On the simulated feed there is no honest price, so no R reading is shown —
// a made-up number here would be worse than none. The arithmetic itself is
// covered in the unit tests.
ok('no R reading is invented from simulated candles', !/running 5\.0h · alive · [+-]/.test(all), all);
ok('an old position reads as about to be scratched', /running 70\.0h · about to be scratched/.test(all), all);
ok('the old "awaiting entry" wording is gone', !/awaiting entry/.test(all), all);
ok('and the bare "filled" wording is gone', !/· filled/.test(all), all);
ok('a closed trade shows its outcome, not a liveness chip', /✓ won/.test(all) && !/running 90/.test(all), all);

ok('hovering explains when a resting order gets cancelled', /Cancelled in .* if price has not reached the entry/.test(allTitles), allTitles);
ok('and when a position gets scratched', /Scratched in .* if it has not hit its stop or target/.test(allTitles), allTitles);
ok('and does not claim a distance it cannot measure', !/R away from the entry/.test(allTitles), allTitles);

const chipColours = await p.evaluate(() => Array.from(document.querySelectorAll('#tradeLog .log-item')).map(el => {
  const c = Array.from(el.querySelectorAll('.mono[title]')).map(x => x.style.color);
  return c.join('|');
}));
ok('a healthy trade is green', chipColours.some(c => /62, 207, 142|#3ecf8e/.test(c)), JSON.stringify(chipColours));
ok('a stalling one is amber', chipColours.some(c => /255, 167, 38|#ffa726/.test(c)), JSON.stringify(chipColours));
ok('a dying one is red', chipColours.some(c => /239, 77, 95|#ef4d5f/.test(c)), JSON.stringify(chipColours));
ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
