// The confidence number must arrive with its meaning attached: where it sits on
// the scale this engine actually reaches, and what signals at that level have
// gone on to do. A bare percentage is the thing being fixed.
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

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };
const read = () => p.evaluate(() => ({
  band: document.getElementById('confBandLabel').textContent,
  tag: document.getElementById('confEvidenceTag').textContent,
  headline: document.getElementById('confHeadline').textContent,
  detail: document.getElementById('confDetail').textContent,
  more: document.getElementById('confMore').textContent,
  barWidth: document.getElementById('confBarFill').style.width,
  barColour: document.getElementById('confBarFill').style.background
}));

// --- with no record at all -------------------------------------------------
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(1800);
await p.click('#genBtn'); await p.waitForTimeout(1200);
const cold = await read();
ok('an unproven number says it is unproven', /No track record/.test(cold.headline), JSON.stringify(cold));
ok('it does not invent a win rate', !/won \d+ of \d+/.test(cold.headline), cold.headline);
ok('it reports zero resolved trades in the band', /^0 resolved/.test(cold.tag), cold.tag);
ok('the band is named, not just the number', /third|thin|moderate|high/.test(cold.band), cold.band);
ok('and it is read against the real ceiling', /ceiling/.test(cold.band), cold.band);
ok('the bar reflects the ceiling, not 100', cold.barWidth !== '' && cold.barWidth !== '0%', cold.barWidth);
ok('it warns the record is too thin to read', /opinion, not a record/.test(cold.detail), cold.detail);
ok('and says whether confidence discriminates at all', /not measurable yet/.test(cold.detail), cold.detail);
ok('the explainer denies it is a probability', /not a probability/.test(cold.more), cold.more);

// --- with a real record at this level --------------------------------------
// Seed 40 resolved signals split into a strong high band and a weak low band,
// so the panel has something true to say.
await p.evaluate(() => {
  const mk = (conf, status, i) => ({
    id: 'S' + conf + '-' + i, dir: 'BUY', confidence: conf, status,
    entry: 2000, sl: 1990, tp: 2030, exitPrice: status === 'won' ? 2030 : 1990,
    entryType: 'market', time: new Date(Date.now() - (i+1) * 36e5).toISOString(),
    factors: { htf: 1 }, qualityFeatures: [.5,.5,.5,.5,.5,.5,.5], metaScore: 0, source: 'auto',
    resolvedBy: 'auto', resolvedAt: new Date().toISOString(), learned: true
  });
  const log = [];
  for (let i = 0; i < 12; i++) log.push(mk(46, 'won', i));
  for (let i = 12; i < 20; i++) log.push(mk(46, 'lost', i));
  for (let i = 20; i < 24; i++) log.push(mk(8, 'won', i));
  for (let i = 24; i < 40; i++) log.push(mk(8, 'lost', i));
  localStorage.setItem('smc-signal-log-v1', JSON.stringify(log));
});
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(1800);
await p.click('#genBtn'); await p.waitForTimeout(1200);
const warm = await read();
ok('with a record, the number carries it', /won \d+ of \d+/.test(warm.headline), warm.headline);
ok('the record includes expectancy in R', /R per trade/.test(warm.headline), warm.headline);
ok('the band tag counts real resolved trades', /^\d+ resolved in band/.test(warm.tag) && !/^0 /.test(warm.tag), warm.tag);
ok('it reports whether higher confidence actually wins more',
   /(carrying real information|too small to lean on|NOT winning more often|inverted)/.test(warm.detail), warm.detail);
ok('the scale note says the bands came from this system',
   /this system's own \d+ logged signals/.test(warm.more), warm.more);
ok('no page errors', errs.length === 0, JSON.stringify(errs));

// --- the log rows read against the same scale ------------------------------
const logRow = await p.evaluate(() => {
  const el = document.querySelector('#tradeLog .log-item .mono[title]');
  return el ? { title: el.getAttribute('title'), colour: el.style.color } : null;
});
ok('log rows explain their own confidence', !!logRow && /realistic ceiling|ceiling is about/.test(logRow.title),
   JSON.stringify(logRow));
ok('and are coloured by band rather than left grey', !!logRow && logRow.colour !== '', JSON.stringify(logRow));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
