// Gold is shut from Friday ~21:00 UTC to Sunday ~22:00 UTC, and the app had no
// idea. The header dot meant "a provider is connected" but read as "the market
// is trading"; the session panel ran an hour-of-day lookup and called Sunday
// lunchtime the London-NY overlap. Both are checked here against a frozen clock
// so the result does not depend on the day the suite happens to run.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };

async function pageAt(iso) {
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
  await p.clock.install({ time: new Date(iso) });
  await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
  await p.waitForTimeout(1200);
  return { p, errs };
}

// ---- Sunday lunchtime: shut -----------------------------------------------
{
  const { p, errs } = await pageAt('2026-09-06T12:00:00Z');
  const mode = await p.textContent('#modeLabel');
  const dotOn = await p.evaluate(() => document.getElementById('liveDot').classList.contains('on'));
  const session = await p.textContent('#sessionBadge');

  ok('the header says the market is closed', /market closed/i.test(mode || ''), mode);
  ok('and how long until it reopens', /reopens in/i.test(mode || ''), mode);
  ok('the live dot is not pulsing', dotOn === false, String(dotOn));
  ok('the session panel says Closed', /Closed/.test(session || ''), session);
  ok('and not the London-NY overlap', /Overlap/.test(session || '') === false, session);
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await p.close();
}

// ---- Wednesday midday: open ------------------------------------------------
{
  const { p, errs } = await pageAt('2026-09-02T13:00:00Z');
  const mode = await p.textContent('#modeLabel');
  const session = await p.textContent('#sessionBadge');
  ok('midweek the header says nothing about a closure', /market closed/i.test(mode || '') === false, mode);
  ok('and the real session is named', /London|New York|Asian|Overlap/.test(session || ''), session);
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await p.close();
}

// ---- the liveness chip says the clock is paused ----------------------------
// A limit placed two hours before Friday's close. Elapsed, it is 41 hours old
// by Sunday lunchtime — three times past the 12h fill limit — but the market
// was open for only two of them.
{
  const { p, errs } = await pageAt('2026-09-06T12:00:00Z');
  await p.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('smc-signal-log-v1', JSON.stringify([{
      id:'FRI', dir:'BUY', entry:2000, sl:1990, tp:2040, entryType:'limit',
      confidence:40, grade:'C', source:'worker', status:'pending',
      time:'2026-09-04T19:00:00.000Z',
      factors:{htf:1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0
    }]));
  });
  await p.reload({ waitUntil:'domcontentloaded' });
  await p.waitForTimeout(1800);
  const row = await p.evaluate(() => {
    const el = document.querySelector('#tradeLog .log-item');
    if (!el) return null;
    const chips = Array.from(el.querySelectorAll('.mono[title]'));
    return { text: el.innerText.replace(/\s+/g,' ').trim(), titles: chips.map(c => c.getAttribute('title')) };
  });
  const all = row ? row.text + ' ' + row.titles.join(' ') : '';
  ok('the Friday order is still resting, not killed', /resting/i.test(all) && /killed as stale/i.test(all) === false, all.slice(0, 160));
  ok('it is aged in tradeable hours, not elapsed ones', /resting 2\.0h/.test(all), all.slice(0, 160));
  ok('and the chip says the market is shut', /market shut/i.test(all), all.slice(0, 160));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await p.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
