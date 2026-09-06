// The paper book and the signal log can drift, and nothing put them back.
//
// A position is normally closed by the same pass that resolves its signal. But
// the signal log syncs across devices and survives a closed tab; the paper book
// is local and does neither. So a trade the worker resolves while this tab is
// shut comes back as a signal that is already `won` — the newly-resolved diff
// sees no change, and the position stays open accruing floating P&L against a
// trade the system considers finished. Seeded here it read -$3,951 of phantom
// floating loss on a $10,000 account with "Closed trades 0".
import { chromium } from 'playwright';
import { NOW, pinPage } from './clock.mjs';
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

await p.evaluate((now) => {
  const iso = (h) => new Date(now - h*3600000).toISOString();
  const sig = (id, status, extra) => Object.assign({ id, dir:'BUY', entry:2000, sl:1990, tp:2040,
    entryType:'market', confidence:40, grade:'C', source:'worker', time: iso(5), status,
    filledAt: iso(4), factors:{htf:1}, qualityFeatures:[.5,.5,.5,.5,.5,.5,.5], metaScore:0 }, extra||{});
  const pos = (id, signalId, status) => ({ id, signalId, dir:'BUY', requestedEntry:2000, entryFill:2000,
    sl:1990, tp:2040, units:10, lots:0.1, contractSize:100, riskAmount:100, requestedRisk:100,
    balanceAtOpen:10000, openedAt: iso(4), status, filledAt: iso(4), pnl: 0 });
  localStorage.clear();
  localStorage.setItem('smc-signal-log-v1', JSON.stringify([
    sig('WON1','won',{exitPrice:2040}), sig('LOST1','lost'), sig('EXP1','expired'), sig('LIVE1','open')
  ]));
  localStorage.setItem('smc-paper-v1', JSON.stringify({ enabled:true, manual:true,
    startingBalance:10000, epoch:null, positions:[
      pos('pp-1','WON1','open'), pos('pp-2','LOST1','open'), pos('pp-3','EXP1','pending'),
      pos('pp-4','GHOST','open'), pos('pp-5','LIVE1','open'), pos('pp-6','LIVE1','open')
    ]}));
}, NOW);
await p.reload({ waitUntil:'domcontentloaded' });
await p.waitForTimeout(2600);

const st = await p.evaluate(() => {
  const log = JSON.parse(localStorage.getItem('smc-signal-log-v1')||'[]');
  const pos = JSON.parse(localStorage.getItem('smc-paper-v1')||'{}').positions||[];
  const byId = Object.fromEntries(log.map(s=>[s.id,s.status]));
  const live = pos.filter(x=>x.status==='open'||x.status==='pending');
  const get = (id) => pos.find(x=>x.id===id) || {};
  return {
    orphans: live.filter(x => !byId[x.signalId]).map(x=>x.id),
    stale: live.filter(x => ['won','lost','expired'].includes(byId[x.signalId])).map(x=>x.id),
    dupes: Object.entries(live.reduce((a,x)=>{a[x.signalId]=(a[x.signalId]||0)+1;return a;},{})).filter(([,n])=>n>1).map(([k])=>k),
    won: get('pp-1'), lost: get('pp-2'), ghost: get('pp-4'), liveOne: get('pp-5'), dupe: get('pp-6'),
    panel: document.getElementById('paperContent').innerText.replace(/\s+/g,' ')
  };
});

ok('no position is left open against a finished signal', st.stale.length === 0, JSON.stringify(st.stale));
ok('no position is left open with no signal at all', st.orphans.length === 0, JSON.stringify(st.orphans));
ok('no signal carries two live positions', st.dupes.length === 0, JSON.stringify(st.dupes));
ok('the won trade is booked as a win', st.won.outcome === 'won', JSON.stringify(st.won.outcome));
ok('at the exit its signal recorded, not the current mark', st.won.exitPrice === 2040, String(st.won.exitPrice));
ok('the lost trade is booked as a loss', st.lost.outcome === 'lost', String(st.lost.outcome));
ok('the ghost is closed without an outcome',
   st.ghost.status === 'closed' && st.ghost.outcome !== 'won' && st.ghost.outcome !== 'lost',
   JSON.stringify([st.ghost.status, st.ghost.outcome]));
ok('and says it was reconciled', /reconciled:/.test(st.ghost.closeReason || ''), st.ghost.closeReason);
ok('the genuinely live position is untouched', st.liveOne.status === 'open', st.liveOne.status);
ok('its duplicate is not', st.dupe.status !== 'open', st.dupe.status);
// Floating P&L is only legitimate for a position that is genuinely still open.
// Before reconciliation five finished trades were marking to market alongside
// the one live one; now exactly one is.
ok('only the one genuinely live position still floats',
   /OPEN 1(?! )/.test(st.panel) || /OPEN 1 /.test(st.panel), st.panel.slice(0, 120));
const floatOnly = await p.evaluate(() => {
  const pos = JSON.parse(localStorage.getItem('smc-paper-v1')||'{}').positions||[];
  return pos.filter(x => x.status === 'open').length;
});
ok('and the book agrees there is exactly one', floatOnly === 1, String(floatOnly));
ok('and the closed trades are now counted', /Closed trades [1-9]/.test(st.panel), st.panel.slice(0, 200));
ok('no page errors', errs.length === 0, errs.join(' | '));

// A book that already agrees with its log must be left completely alone.
await p.evaluate(() => {
  const before = JSON.parse(localStorage.getItem('smc-paper-v1')||'{}');
  localStorage.setItem('smc-paper-check', JSON.stringify(before.positions.map(p=>p.id+':'+p.status)));
});
await p.reload({ waitUntil:'domcontentloaded' });
await p.waitForTimeout(2200);
const stable = await p.evaluate(() => {
  const now = JSON.parse(localStorage.getItem('smc-paper-v1')||'{}').positions.map(p=>p.id+':'+p.status);
  return JSON.stringify(now) === localStorage.getItem('smc-paper-check');
});
ok('a reconciled book is stable across reloads', stable === true, String(stable));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
