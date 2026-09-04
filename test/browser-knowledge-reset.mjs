// Observations recorded before the FRED sort-order fix paired a current gold day
// with macro values from 1976-2006. They cannot be repaired and cannot be told
// apart by day, so the record is discarded once — and the panel has to say why,
// because a knowledge base that silently returns to zero looks like a bug.
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
const stored = () => p.evaluate(() => JSON.parse(localStorage.getItem('smc-knowledge-v1') || 'null'));
const panel = () => p.evaluate(() => (document.getElementById('knowledgeContent')||{}).innerText || '');

// --- an old store, from before the fix -------------------------------------
await p.evaluate(() => {
  localStorage.clear();
  const rows = Array.from({length: 40}, (_, i) => ({
    day: 20000 + i, gold: 4400 + i, drivers: { dxy: 100 + i*0.1, real10y: 2 + i*0.01 } }));
  // no schema marker: this is the shape the bad data was stored in
  localStorage.setItem('smc-knowledge-v1', JSON.stringify({ rows, firstSeen: { dxy: 20000 }, updatedAt: Date.now() }));
});
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(2200);
const after = await stored();
const text = await panel();
ok('the contaminated record was discarded', after && after.rows.length === 0, JSON.stringify(after && after.rows.length));
ok('and a schema marker was written', after && after.schema === 2, JSON.stringify(after && after.schema));
ok('firstSeen was cleared too', after && Object.keys(after.firstSeen || {}).length === 0, JSON.stringify(after && after.firstSeen));
ok('the panel says the record was cleared', /cleared/i.test(text), text.slice(0, 260));
ok('and says why', /1976-2006|oldest observations/i.test(text), text.slice(0, 260));
ok('and that it is rebuilding', /rebuilding/i.test(text), text.slice(0, 260));

// --- a store already on the new schema is left alone ------------------------
await p.evaluate(() => {
  const rows = Array.from({length: 12}, (_, i) => ({
    day: 20500 + i, gold: 4400 + i, drivers: { dxy: 118 + i*0.05 } }));
  localStorage.setItem('smc-knowledge-v1', JSON.stringify({ rows, firstSeen: { dxy: 20500 }, updatedAt: Date.now(), schema: 2 }));
});
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(2200);
const kept = await stored();
const text2 = await panel();
ok('a current record survives a reload', kept && kept.rows.length === 12, JSON.stringify(kept && kept.rows.length));
ok('and the reset notice is gone', !/cleared/i.test(text2), text2.slice(0, 200));

// --- a second reload does not re-clear or re-announce -----------------------
await p.reload({ waitUntil:'domcontentloaded' }); await p.waitForTimeout(2000);
ok('the discard happens once, not on every load', (await stored()).rows.length === 12, JSON.stringify((await stored()).rows.length));
ok('no page errors', errs.length === 0, JSON.stringify(errs));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
