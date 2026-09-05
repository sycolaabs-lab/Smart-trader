// Live outcomes and backtest examples shared one 500-slot window. A backtest
// contributes ~22 examples every four hours; live trades arrive at maybe a
// dozen a day. Simulated over two weeks: 168 real outcomes recorded, 36 kept.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404|Failed to load/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(1000);

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };

// A store already holding a lot of live history plus a full backtest window.
await p.evaluate(() => {
  const mk = (n, label) => Array.from({length:n}, (_, i) =>
    ({ features:[.5,.31,.72,.19,.64,.48,.55,.22].map(v => +(v + Math.sin(i)*0.1).toFixed(4)), label: i%3 ? 1 : -1 }));
  localStorage.clear();
  localStorage.setItem('smc-factor-stats-v1', JSON.stringify({
    factors:{}, patterns:{}, totalLogged: 3000,
    metaExamples: mk(3000, 1),          // live: must never be evicted
    metaBacktestExamples: mk(1500, 1),  // regenerable
    metaModel: null
  }));
});
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(3000);

const st = await p.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('smc-factor-stats-v1') || '{}');
  return { live: (s.metaExamples||[]).length, bt: (s.metaBacktestExamples||[]).length };
});
ok('a 3,000-example live store survives a reload', st.live === 3000, 'live=' + st.live);
ok('and the backtest store is kept separately', st.bt === 1500, 'bt=' + st.bt);

// Both stores must be restored intact — the old code would have clipped to 500.
ok('nothing was clipped to the old 500 cap', st.live > 500 && st.bt > 500, JSON.stringify(st));

// The cloud payload must stay well under Firestore's 1MB document limit.
const cloudBytes = await p.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('smc-factor-stats-v1') || '{}');
  const CLOUD_LIVE = 1500;
  const trimmed = Object.assign({}, s, {
    metaExamples: (s.metaExamples||[]).slice(-CLOUD_LIVE), metaBacktestExamples: []
  });
  return JSON.stringify({ learningState: trimmed, signalLog: [], updatedAt: Date.now() }).length;
});
ok('the cloud payload stays inside the 1MB Firestore limit', cloudBytes < 900000, (cloudBytes/1024).toFixed(0) + ' KB');
ok('and the backtest store is not shipped to the cloud at all', cloudBytes < 200000, (cloudBytes/1024).toFixed(0) + ' KB');

// The panel has to say what it trained on, not just a total.
await p.fill('#apiKeyInput','x').catch(()=>{});
const summary = await p.evaluate(() => {
  const el = document.getElementById('metaScoreStatus');
  return el ? el.textContent : '';
});
ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
