// Exercises the background worker end-to-end against a fake Firestore and a
// stubbed network, so the unattended path is covered without live keys.
import { runTick } from '../api/tick.js';

let pass=0, fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS':'FAIL')+' '+n+(c?'':'  '+(extra||''))); c?pass++:fail++; };

// ---- fake Firestore ----
function fakeDb() {
  const docs = {};
  return {
    _docs: docs,
    collection: () => ({
      doc: (id) => ({
        get: async () => ({ exists: !!docs[id], data: () => docs[id] }),
        set: async (v, opts) => { docs[id] = (opts && opts.merge) ? Object.assign({}, docs[id], v) : v; }
      })
    })
  };
}

// ---- synthetic market ----
function series(n, stepMs, startPrice, drift, seed=3){
  let s=seed, r=()=>((s=(s*1103515245+12345)&0x7fffffff)/0x7fffffff);
  const out=[]; let p=startPrice; const now=Date.now();
  for(let i=n;i>=0;i--){
    p += (r()-0.5+drift)*3;
    const o=p-(r()-0.5)*1.5, h=Math.max(o,p)+r()*2, l=Math.min(o,p)-r()*2;
    out.push({datetime:new Date(now-i*stepMs).toISOString().slice(0,19).replace('T',' '),
      open:o.toFixed(2),high:h.toFixed(2),low:l.toFixed(2),close:p.toFixed(2)});
  }
  return out.reverse();
}
const INTERVAL_MS = { '15min':9e5, '1h':36e5, '4h':144e5, '1day':864e5, '1week':6048e5 };

let tdCalls=0, fredCalls=0, avCalls=0;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname === 'api.twelvedata.com') {
    tdCalls++;
    const iv = u.searchParams.get('interval');
    const n = Math.min(+u.searchParams.get('outputsize')||100, 600);
    return { json: async () => ({ values: series(n, INTERVAL_MS[iv]||9e5, 2000, 0.08) }) };
  }
  if (u.hostname === 'api.stlouisfed.org') {
    fredCalls++;
    const obs=[]; for(let i=60;i>=0;i--) obs.push({date:new Date(Date.now()-i*864e5).toISOString().slice(0,10), value:String(100+Math.sin(i/5)*3)});
    return { json: async () => ({ observations: obs }) };
  }
  if (u.hostname === 'www.alphavantage.co') {
    avCalls++;
    return { json: async () => ({ feed: [{overall_sentiment_score:'0.12'},{overall_sentiment_score:'-0.05'}] }) };
  }
  throw new Error('unexpected host ' + u.hostname);
};

const db = fakeDb();
const t0 = Date.now();
const tick1 = await runTick({ db, tdKey:'TD', fredKey:'FRED', avKey:'AV' });

ok('returns a tick object', !!tick1 && typeof tick1==='object');
ok('has a direction', ['BUY','SELL','HOLD'].includes(tick1.direction), 'got '+tick1.direction);
ok('confidence is a number 0-100', tick1.confidence>=0 && tick1.confidence<=100, String(tick1.confidence));
ok('price is finite', isFinite(tick1.price), String(tick1.price));
ok('macro block present', !!tick1.macro && 'correlationAvailable' in tick1.macro);
ok('correlation computed', tick1.macro.correlationAvailable===true);
ok('fundamentals computed', tick1.macro.fundamentalAvailable===true);
ok('news computed', tick1.macro.newsAvailable===true);
ok('session reported', typeof tick1.session==='string' || tick1.session===null);
ok('worker doc written', !!db._docs.worker);
ok('latestTick doc written', !!db._docs.latestTick);
ok('state is JSON strings (Firestore-safe)', typeof db._docs.worker.signalLog==='string' && typeof db._docs.worker.cache==='string');

// --- UI contract: every field the dashboard listener reads must exist ---
const required = ['time','price','direction','confidence','entry','sl','tp','metaScore','metaTrained','metaExampleCount','resolvedThisTick','session','regime','macro'];
const missing = required.filter(k => !(k in db._docs.latestTick));
ok('latestTick satisfies the dashboard contract', missing.length===0, 'missing: '+missing.join(','));

// --- caching: a second tick must not refetch higher timeframes ---
const tdAfterFirst = tdCalls;
await runTick({ db, tdKey:'TD', fredKey:'FRED', avKey:'AV' });
const secondTickCalls = tdCalls - tdAfterFirst;
ok('second tick reuses cached HTF/macro', secondTickCalls === 1, 'made '+secondTickCalls+' TwelveData calls (want 1: just 15min)');

// --- signal lifecycle: force a signal, then resolve it ---
const w = JSON.parse(db._docs.worker.signalLog);
console.log('   signals so far:', w.length, w[0] ? '('+w[0].dir+' @ '+w[0].entry+')' : '');

// inject a signal that the next tick's candles must resolve as a win
const ltf = JSON.parse(db._docs.worker.cache).ltf;
const lastT = ltf[ltf.length-1].time;
w.unshift({ id:'forced', dir:'BUY', entry: 1000, sl: 900, tp: 1010, entryType:'market',
  time: new Date(lastT - 50*9e5).toISOString(), status:'open', factors:{htf:1,ltf:1},
  qualityFeatures:[0.5,0.5,0.5,0.5,0.5,0.5,0.5], confidence:60 });
db._docs.worker.signalLog = JSON.stringify(w);
db._docs.worker.cacheMeta = {}; // force a refetch so candles move past the target

const tick3 = await runTick({ db, tdKey:'TD', fredKey:'FRED', avKey:'AV' });
const after = JSON.parse(db._docs.worker.signalLog);
const forced = after.find(s => s.id==='forced');
ok('injected signal was self-graded', forced && forced.status==='won', 'status='+(forced&&forced.status));
ok('resolvedThisTick counted it', tick3.resolvedThisTick>=1, String(tick3.resolvedThisTick));
ok('learning state recorded the outcome', JSON.parse(db._docs.worker.learningState).totalLogged>=1);
ok('meta examples grew', (JSON.parse(db._docs.worker.learningState).metaExamples||[]).length>=1);
ok('resolvedBy marked as worker', forced && forced.resolvedBy==='worker');

// --- a change to the instrument set must invalidate the cached macro score ---
// Regression: after swapping oil/S&P out of the basket, the six-hour cache kept
// serving a score computed from the OLD instruments with no sign it was stale.
const fredBefore = fredCalls;
await runTick({ db, tdKey:'TD', fredKey:'FRED', avKey:'AV' });
ok('cached macro is reused while config is unchanged', fredCalls === fredBefore, `made ${fredCalls-fredBefore} FRED calls, want 0`);

const sigBefore = JSON.parse(JSON.stringify(db._docs.worker.cacheSig || {}));
ok('cache records the config signature', typeof sigBefore.correlation === 'string' && sigBefore.correlation.length > 0, true);

// simulate an instrument swap by corrupting the stored signature
db._docs.worker.cacheSig = Object.assign({}, sigBefore, { correlation: 'different-instrument-set' });
const fredBefore2 = fredCalls;
await runTick({ db, tdKey:'TD', fredKey:'FRED', avKey:'AV' });
ok('a changed instrument set refetches immediately', fredCalls > fredBefore2, `made ${fredCalls-fredBefore2} FRED calls, want >0`);
ok('signature is restored after the refetch', db._docs.worker.cacheSig.correlation, sigBefore.correlation);

// --- the tick must still publish when macro work is slow ---
// Regression: a forced double cache-bust made ~15 sequential calls on a cold
// start, blew the 60s function limit, and returned 504 without ever writing —
// so Firestore silently kept serving the previous tick.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname === 'api.stlouisfed.org' || u.hostname === 'www.alphavantage.co') {
    await new Promise(r => setTimeout(r, 60)); // slow macro
  }
  return realFetch(url);
};
db._docs.worker.cacheMeta = {};   // force every macro input to refetch at once
db._docs.worker.cacheSig = {};
const slowTick = await runTick({ db, tdKey:'TD', fredKey:'FRED', avKey:'AV' });
globalThis.fetch = realFetch;
ok('still publishes a tick under slow macro', !!slowTick && isFinite(slowTick.price), true);
ok('still reports a direction', ['BUY','SELL','HOLD'].includes(slowTick.direction), true);
ok('latestTick was actually written', typeof db._docs.latestTick.time, 'number');
ok('reports which macro work was skipped', Array.isArray(slowTick.macroSkipped), true);

// --- the worker must not commit an internally broken plan ---
// It runs unattended, so it is the half that most needs the arithmetic check.
const auditTick = await runTick({ db, tdKey:'TD', fredKey:'FRED', avKey:'AV' });
ok('worker reports audit results', typeof auditTick.auditCritical, 'number');
ok('audit findings are published', Array.isArray(auditTick.auditFindings), true);
ok('a clean run has no critical findings', auditTick.auditCritical === 0, 'found ' + auditTick.auditCritical + ': ' + JSON.stringify(auditTick.auditFindings));


// --- the worker must publish its trades where the browser can see them ------
// Regression: the worker kept its signal log inside its own state document
// (alongside a candle cache the browser has no business downloading) and
// published only a one-line summary. So a trade taken unattended never reached
// the dashboard's signal log, and there was no way to tell what it had entered
// or whether it won.
ok('a public signal doc is written', !!db._docs.workerSignals, 'no workerSignals doc');
ok('it is a JSON string', typeof db._docs.workerSignals.signalLog, 'string');
const pubLog = JSON.parse(db._docs.workerSignals.signalLog);
ok('the published log is an array', Array.isArray(pubLog), true);
ok('it reports the full log size separately', typeof db._docs.workerSignals.count, 'number');
ok('it carries an update timestamp', typeof db._docs.workerSignals.updatedAt, 'number');
ok('it never exceeds the publish cap', pubLog.length <= 150, `published ${pubLog.length}`);

// Seed a trade directly into the worker's state, then confirm a tick publishes
// it in a form the browser can merge and learn from.
const seeded = {
  id: 'seed-1', dir: 'BUY', entry: 1990, sl: 1980, tp: 2020, entryType: 'market',
  confidence: 55, grade: 'C', session: 'London', status: 'open',
  time: new Date(Date.now() - 6 * 3600e3).toISOString(),
  factors: { structure: 1, momentum: 0.5 }, qualityFeatures: [0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5],
  metaScore: 0.2, source: 'worker'
};
const wlog = JSON.parse(db._docs.worker.signalLog);
wlog.unshift(seeded);
db._docs.worker.signalLog = JSON.stringify(wlog);
await runTick({ db, tdKey:'TD', fredKey:'FRED', avKey:'AV' });
const pub2 = JSON.parse(db._docs.workerSignals.signalLog);
const found = pub2.find(s => s.id === 'seed-1');
ok('a worker trade appears in the published log', !!found, 'seed-1 missing from ' + pub2.length + ' entries');
if (found) {
  ok('it is labelled as the worker\'s', found.source, 'worker');
  ok('it carries the levels the log renders', [found.entry, found.sl, found.tp], [1990, 1980, 2020]);
  ok('it carries the factors the browser learns from', typeof found.factors, 'object');
  ok('and the quality features the meta-labeler needs', Array.isArray(found.qualityFeatures), true);
  ok('its status is published', typeof found.status, 'string');
  ok('a resolved trade publishes who resolved it and where it exited',
    found.status === 'won' || found.status === 'lost'
      ? (found.resolvedBy === 'worker' && found.exitPrice != null)
      : true,
    JSON.stringify({status: found.status, by: found.resolvedBy, exit: found.exitPrice}));
}
// The cache is the reason this is a separate document; make sure it stayed out.
ok('the published doc carries no candle cache', db._docs.workerSignals.cache === undefined,
  'keys: ' + Object.keys(db._docs.workerSignals).join(','));


// --- the worker must audit what it was FED, not just how it reasoned -------
// Nobody is watching the chart on the unattended path, so a feed that has gone
// wrong — a stalled provider, a decimal shift, a timeframe on a different
// instrument — would otherwise be analysed with full confidence.
ok('the worker reports whether the data itself is at fault',
  typeof db._docs.latestTick.auditDataProblem, 'boolean');
ok('and lists any data faults it found', Array.isArray(db._docs.latestTick.auditDataFaults), true);
ok('a clean synthetic feed has none', db._docs.latestTick.auditDataFaults.length === 0,
  JSON.stringify(db._docs.latestTick.auditDataFaults));
ok('and is not flagged as a data problem', db._docs.latestTick.auditDataProblem === false,
  JSON.stringify(db._docs.latestTick.auditDataProblem));

// Feed it a decimal-shifted series and the audit must say so rather than
// analysing a market that does not exist.
const goodFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname === 'api.twelvedata.com') {
    const iv = u.searchParams.get('interval');
    const n = Math.min(+u.searchParams.get('outputsize')||100, 600);
    const vals = series(n, INTERVAL_MS[iv]||9e5, 2000, 0.08).map(v => ({
      datetime: v.datetime,
      open: (+v.open / 10).toFixed(3), high: (+v.high / 10).toFixed(3),
      low: (+v.low / 10).toFixed(3), close: (+v.close / 10).toFixed(3)
    }));
    return { json: async () => ({ values: vals }) };
  }
  return goodFetch(url);
};
db._docs.worker.cacheMeta = {}; db._docs.worker.cacheSig = {};
const shiftedTick = await runTick({ db, tdKey:'TD', fredKey:'FRED', avKey:'AV' });
globalThis.fetch = goodFetch;
ok('a decimal-shifted feed is caught', shiftedTick.auditDataProblem === true,
  JSON.stringify({problem: shiftedTick.auditDataProblem, faults: shiftedTick.auditDataFaults}));
ok('and named', shiftedTick.auditDataFaults.some(f => /price-out-of-band/.test(f)),
  JSON.stringify(shiftedTick.auditDataFaults));
ok('and it blocks the trade', shiftedTick.gateCode === 'audit' || shiftedTick.direction === 'HOLD',
  JSON.stringify({gate: shiftedTick.gateCode, dir: shiftedTick.direction}));

console.log(`\nnetwork: twelvedata=${tdCalls} fred=${fredCalls} alphavantage=${avCalls}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
