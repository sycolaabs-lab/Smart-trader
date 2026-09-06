// Resetting used to delete every position. That zeroed the balance by throwing
// away the record of how the system's own signals turned out — which is the one
// thing the paper trader exists to produce, and what the meta-labeler, the
// journal and the win rate all read. A reset now moves a line instead.
import { chromium } from 'playwright';
const PORT = process.env.PORT || '8899';
// Inside the trading week and clear of the Friday-close flatten window, so the
// weekend sweep does not clear the book out from under this suite.
const PIN = Date.parse('2026-09-02T12:00:00Z');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/ERR_|net::|404/.test(m.text())) errs.push('CONSOLE: '+m.text()); });
await p.clock.setFixedTime(new Date(PIN));
await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
await p.waitForTimeout(900);

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };

// Two graded trades and one live position.
await p.evaluate(() => {
  const pos = (id, pnl, outcome, status) => ({
    id: 'pp-' + id, signalId: id, dir:'BUY', requestedEntry:2000, entryFill:2000,
    sl:1990, tp:2040, units:10, lots:0.10, contractSize:100, riskAmount:100,
    requestedRisk:100, balanceAtOpen:10000,
    openedAt:'2026-09-01T10:00:00.000Z',
    closedAt: status === 'closed' ? '2026-09-01T12:00:00.000Z' : null,
    filledAt:'2026-09-01T10:05:00.000Z',
    status, pnl, outcome, rMultiple: pnl / 100, exitPrice: 2000 + pnl / 10
  });
  localStorage.clear();
  localStorage.setItem('smc-paper-v1', JSON.stringify({
    enabled:true, manual:true, startingBalance:10000, epoch:null,
    positions:[ pos('W', 200, 'won', 'closed'), pos('L', -100, 'lost', 'closed'),
                pos('O', 0, null, 'open') ]
  }));
});
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(1400);

const read = () => p.evaluate(() => {
  const t = document.getElementById('paperContent').innerText;
  const st = JSON.parse(localStorage.getItem('smc-paper-v1') || '{}');
  return { text: t.replace(/\s+/g,' '), count: (st.positions||[]).length, epoch: st.epoch };
});

const before = await read();
ok('the account starts with its history counted', /\$10,?100\.00|\$10100\.00/.test(before.text) || /100\.00/.test(before.text), before.text.slice(0,120));
ok('three positions on record', before.count === 3, String(before.count));
ok('no epoch yet', before.epoch == null, String(before.epoch));

// Reset, accepting the confirm.
p.once('dialog', d => d.accept());
await p.click('#paperReset');
await p.waitForTimeout(900);
const after = await read();

ok('nothing was deleted', after.count === 3, String(after.count));
ok('an epoch was recorded', after.epoch > 0, String(after.epoch));
ok('the balance is back to the starting figure', /\$10,?000\.00/.test(after.text), after.text.slice(0,160));
ok('the current era shows no closed trades', /Closed trades 0/.test(after.text), after.text.slice(0,220));
ok('the lifetime record is shown instead of hidden', /Lifetime record/.test(after.text), '');
ok('and still counts the graded trades', /Graded trades 2/.test(after.text), after.text.slice(0,400));
ok('with the win rate intact', /50% won/.test(after.text), after.text.slice(0,400));
ok('it says how many are excluded from the balance', /from before the last reset are excluded/.test(after.text), '');
ok('and the empty era says the record is intact', /record above is intact/.test(after.text), '');

// The live position must not straddle the reset.
const settled = await p.evaluate(() => {
  const st = JSON.parse(localStorage.getItem('smc-paper-v1') || '{}');
  const o = (st.positions||[]).find(x => x.signalId === 'O');
  return { status: o.status, reason: o.closeReason, outcome: o.outcome };
});
ok('the open position was settled by the reset', settled.status === 'closed', settled.status);
ok('marked as a reset, not an outcome', settled.reason === 'account reset' && settled.outcome === null, JSON.stringify(settled));

// A second reset on an already-empty era must be harmless.
p.once('dialog', d => d.accept());
await p.click('#paperReset');
await p.waitForTimeout(700);
const twice = await read();
ok('resetting twice still deletes nothing', twice.count === 3, String(twice.count));
ok('and the lifetime record is unchanged', /Graded trades 2/.test(twice.text), '');

ok('no page errors', errs.length === 0, errs.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
