// The auditor is only worth having if it catches deliberately broken input.
// Every test here plants a specific fault and checks it is found — and the
// clean case checks it does not invent problems that are not there.
import { auditAnalysis, auditData, auditPlan, auditEvidence, auditFreshness,
  auditTrade, auditOpenTrades, TRADE_AUDIT_DEFAULTS,
  auditFeedIntegrity, auditCrossSeries, auditMacroSeries } from '../lib/auditor.js';

let pass=0, fail=0;
const ok=(n,a,e)=>{const g=JSON.stringify(a)===JSON.stringify(e);console.log((g?'PASS':'FAIL')+' '+n+(g?'':`  got=${JSON.stringify(a)} want=${JSON.stringify(e)}`));g?pass++:fail++;};
const has=(findings,code)=>findings.some(f=>f.code===code);

const MIN=60000, BAR=15*MIN;
function candles(n, start){
  const out=[]; const t0=(start||Date.now())-n*BAR;
  let p=2000;
  for(let i=0;i<n;i++){p+=Math.sin(i/6)*2; out.push({time:t0+i*BAR, open:p, high:p+3, low:p-3, close:p});}
  return out;
}
const good = candles(60);
const buyResult = { direction:'BUY', price: good[good.length-1].close, confidence:60,
  factors:{htf:1, ltf:1}, weights:{htf:10, ltf:10} };
const buyPlan = { entry:2000, sl:1990, tp:2040, rr:4 };

console.log('-- a clean analysis is left alone --');
const lastClose = good[good.length-1].close;
const clean = auditAnalysis({ result:{...buyResult, price:lastClose}, plan:{entry:lastClose, sl:lastClose-10, tp:lastClose+40, rr:4}, candles:good,
  expectedIntervalMs:BAR, now:good[good.length-1].time+MIN, maxAgeMs:60*MIN });
ok('finds nothing wrong with a sound plan', clean.critical, 0);
ok('does not block it', clean.blocking, false);
ok('verdict says so', /No problems found/.test(clean.verdict), true);

console.log('\n-- arithmetic faults --');
ok('stop above entry on a BUY', has(auditPlan(buyResult,{...buyPlan,sl:2010},good),'sl-wrong-side'), true);
ok('stop below entry on a SELL', has(auditPlan({...buyResult,direction:'SELL'},{entry:2000,sl:1990,tp:1960,rr:4},good),'sl-wrong-side'), true);
ok('target below entry on a BUY', has(auditPlan(buyResult,{...buyPlan,tp:1980},good),'tp-wrong-side'), true);
ok('non-finite prices', has(auditPlan(buyResult,{...buyPlan,entry:NaN},good),'plan-nonfinite'), true);
// R:R that lies: levels give 4:1 but the plan claims 10:1
ok('R:R that does not match the levels', has(auditPlan(buyResult,{...buyPlan,rr:10},good),'rr-mismatch'), true);
ok('...and it is critical', auditPlan(buyResult,{...buyPlan,rr:10},good).find(f=>f.code==='rr-mismatch').severity, 'critical');
// direction that contradicts its own factors
ok('direction contradicting its factors',
   has(auditPlan({...buyResult,factors:{htf:-1,ltf:-1}},buyPlan,good),'direction-contradiction'), true);
// a stop far tighter than normal volatility
ok('stop inside normal noise', has(auditPlan(buyResult,{entry:2000,sl:1999.5,tp:2002,rr:4},good),'stop-inside-noise'), true);
ok('price drift from the feed', has(auditPlan({...buyResult,price:2500},buyPlan,good),'price-drift'), true);
ok('a HOLD has no plan to audit', auditPlan({direction:'HOLD'},null,good).length, 0);

console.log('\n-- data integrity --');
ok('no data at all', has(auditData([],BAR),'no-data'), true);
const unordered = candles(30); [unordered[10], unordered[11]] = [unordered[11], unordered[10]];
ok('out-of-order candles', has(auditData(unordered,BAR),'unordered'), true);
ok('...and it is critical', auditData(unordered,BAR).find(f=>f.code==='unordered').severity, 'critical');
const dup = candles(30); dup[15] = {...dup[14]};
ok('duplicate timestamps', has(auditData(dup,BAR),'duplicate-candles'), true);
const bad = candles(30); bad[5] = {...bad[5], high: bad[5].low - 5};
ok('high below low', has(auditData(bad,BAR),'malformed-candles'), true);
const gappy = candles(30).filter((_,i)=>i%3!==0);
ok('a gappy feed', has(auditData(gappy,BAR),'gappy-feed'), true);
ok('a uniformly thinned feed is caught by coverage', has(auditData(gappy,BAR),'thin-coverage'), true);
const halved = candles(60).filter((_,i)=>i%2===0);
ok('half the bars missing is critical', auditData(halved,BAR).find(f=>f.code==='thin-coverage').severity, 'critical');
ok('a healthy feed is clean', auditData(good,BAR).length, 0);

console.log('\n-- freshness --');
const old = candles(30, Date.now()-6*3600000);
ok('stale data is flagged', has(auditFreshness(old, Date.now(), 30*MIN),'stale-feed'), true);
ok('very stale is critical', auditFreshness(old, Date.now(), 30*MIN)[0].severity, 'critical');
ok('fresh data passes', auditFreshness(good, good[good.length-1].time+MIN, 60*MIN).length, 0);

console.log('\n-- claims outrunning evidence --');
const macroResult = { ...buyResult, factors:{htf:1, correlation:0.5} };
ok('macro cited while the model is still noise',
   has(auditEvidence(macroResult, {ok:true, modelIsReal:false, drivers:[]}, null),'macro-unproven'), true);
ok('no complaint when the model is real',
   has(auditEvidence(macroResult, {ok:true, modelIsReal:true, drivers:[]}, null),'macro-unproven'), false);
ok('decaying drivers are noted',
   has(auditEvidence(macroResult, {ok:true, modelIsReal:true, drivers:[{label:'DXY',maturity:'decaying'}]}, null),'driver-decay'), true);
ok('no macro cited, no macro complaint',
   has(auditEvidence({...buyResult,factors:{htf:1}}, {ok:true, modelIsReal:false, drivers:[]}, null),'macro-unproven'), false);
ok('uninformative confidence is called out',
   has(auditEvidence(buyResult, null, {sample:20, discrimination:0.0}),'confidence-uninformative'), true);
ok('informative confidence is not',
   has(auditEvidence(buyResult, null, {sample:20, discrimination:0.3}),'confidence-uninformative'), false);
ok('small samples are not judged',
   has(auditEvidence(buyResult, null, {sample:3, discrimination:0.0}),'confidence-uninformative'), false);


// ============================================================
// IS THE FEED TELLING THE TRUTH?
// ============================================================
// auditData asks whether the feed is intact. This asks whether it is real: a
// well-formed feed can still be the wrong instrument, a decimal shift, a
// stalled provider, or a tick nobody traded — and none of those announce
// themselves.
const fBar = 9e5;
const fSeries = (n, fn) => Array.from({length:n}, (_, i) => {
  const p = fn ? fn(i) : 2000 + Math.sin(i/7) * 4;
  return { time: 1700000000000 + i*fBar, open: p-0.4, high: p+1, low: p-1, close: p };
});
const fClean = fSeries(60);
const hasF = (arr, code) => arr.some(f => f.code === code);
const findF = (arr, code) => arr.find(f => f.code === code);

// a fClean feed must not be accused of anything
ok('a fClean feed raises nothing', auditFeedIntegrity(fClean).length, 0);
ok('too little data to judge is not a finding', auditFeedIntegrity(fSeries(2)).length, 0);

// bars that cannot exist
const impossible = fSeries(60); impossible[30] = {...impossible[30], close: impossible[30].high + 5};
ok('a close outside its own bar is caught', hasF(auditFeedIntegrity(impossible), 'impossible-bars'), true);
ok('and it is critical', findF(auditFeedIntegrity(impossible), 'impossible-bars').severity, 'critical');
ok('and it says which bar', /bar 30/.test(findF(auditFeedIntegrity(impossible), 'impossible-bars').detail), true);
ok('and when', /1970|20\d\d-\d\d-\d\d/.test(findF(auditFeedIntegrity(impossible), 'impossible-bars').detail), true);
const nanBar = fSeries(60); nanBar[7] = {...nanBar[7], close: NaN};
ok('a non-numeric price is caught', hasF(auditFeedIntegrity(nanBar), 'impossible-bars'), true);

// the wrong instrument, or a decimal shift — the shape is unchanged, so
// nothing else in the system notices
const shifted = fSeries(60, i => 200.0 + Math.sin(i/7) * 0.4);
ok('a decimal shift is caught', hasF(auditFeedIntegrity(shifted), 'price-out-of-band'), true);
ok('and it is critical', findF(auditFeedIntegrity(shifted), 'price-out-of-band').severity, 'critical');
ok('and it names the cause', /decimal shift/.test(findF(auditFeedIntegrity(shifted), 'price-out-of-band').detail), true);
ok('a plausible gold price is left alone', hasF(auditFeedIntegrity(fSeries(60, () => 4400)), 'price-out-of-band'), false);
ok('the band is configurable',
  hasF(auditFeedIntegrity(shifted, {minPrice: 100}), 'price-out-of-band'), false);

// a tick nobody traded
const badTick = fSeries(60); badTick[40] = {...badTick[40], close: badTick[40].close + 900, high: badTick[40].close + 901};
ok('a bad tick is caught', hasF(auditFeedIntegrity(badTick), 'impossible-jump'), true);
ok('and it says how far out of line it is',
  /x the typical/.test(findF(auditFeedIntegrity(badTick), 'impossible-jump').detail), true);
ok('and which bar it was', /bar 40/.test(findF(auditFeedIntegrity(badTick), 'impossible-jump').detail), true);
ok('ordinary volatility is not a bad tick', hasF(auditFeedIntegrity(fSeries(60, i => 2000 + i*3)), 'impossible-jump'), false);

// a provider that stopped updating
const frozen = fSeries(60); for (let i = 20; i < 32; i++) frozen[i] = {...frozen[i], close: 2000};
ok('a stalled provider is caught', hasF(auditFeedIntegrity(frozen), 'frozen-feed'), true);
ok('and it counts the run', /12 consecutive bars/.test(findF(auditFeedIntegrity(frozen), 'frozen-feed').detail), true);
ok('and says why nothing else would notice',
  /looks exactly like a flat market/.test(findF(auditFeedIntegrity(frozen), 'frozen-feed').detail), true);
ok('a short flat stretch is not a stall',
  hasF(auditFeedIntegrity((()=>{const c=fSeries(60); for(let i=20;i<23;i++) c[i]={...c[i],close:2000}; return c;})()), 'frozen-feed'), false);

// a feed that is generated rather than reported
const padded = fSeries(60).map((c, i) => i % 2 ? c : {...c, high: c.close, low: c.close});
ok('range-less bars are caught', hasF(auditFeedIntegrity(padded), 'synthetic-feed'), true);
ok('a couple of quiet bars are not',
  hasF(auditFeedIntegrity((()=>{const c=fSeries(60); c[3]={...c[3],high:c[3].close,low:c[3].close}; return c;})()), 'synthetic-feed'), false);

// timeframes that cannot all be the same instrument
console.log('\n-- cross-series --');
const okSeries = { ltf: fSeries(20), mtf: fSeries(20), htf: fSeries(20) };
ok('agreeing timeframes raise nothing', auditCrossSeries(okSeries).length, 0);
const mismatched = { ltf: fSeries(20, () => 4400), htf: fSeries(20, () => 2000) };
ok('a timeframe on the wrong instrument is caught', hasF(auditCrossSeries(mismatched), 'timeframe-mismatch'), true);
ok('and it is critical', findF(auditCrossSeries(mismatched), 'timeframe-mismatch').severity, 'critical');
ok('and it names both levels', /ltf 4400\.00.*htf 2000\.00/.test(findF(auditCrossSeries(mismatched), 'timeframe-mismatch').detail), true);
ok('and says the alignment is meaningless',
  /alignment is meaningless/.test(findF(auditCrossSeries(mismatched), 'timeframe-mismatch').detail), true);
ok('one series alone cannot disagree', auditCrossSeries({ ltf: fSeries(20) }).length, 0);
ok('empty series are skipped', auditCrossSeries({ ltf: fSeries(20), htf: [] }).length, 0);
ok('nothing at all is fine', auditCrossSeries(null).length, 0);

// macro inputs that are stale or constant
console.log('\n-- macro inputs --');
const MNOW = Date.parse('2026-03-10T00:00:00Z');
const obsFrom = (daysAgo, n, val) => Array.from({length:n}, (_, i) => ({
  date: new Date(MNOW - (daysAgo + n - i) * 86400000).toISOString().slice(0,10),
  value: typeof val === 'function' ? val(i) : val }));
ok('a current, moving series raises nothing',
  auditMacroSeries([{ key:'dxy', label:'Dollar', observations: obsFrom(0, 30, i => 100 + i*0.1) }], MNOW).length, 0);
const frozenMacro = [{ key:'vix', label:'Volatility', observations: obsFrom(0, 30, 18) }];
ok('a constant macro series is caught', hasF(auditMacroSeries(frozenMacro, MNOW), 'macro-frozen'), true);
ok('and says it is not information',
  /not information/.test(findF(auditMacroSeries(frozenMacro, MNOW), 'macro-frozen').detail), true);
const staleMacro = [{ key:'real10y', label:'10Y Real Yield', observations: obsFrom(200, 30, i => 2 + i*0.01) }];
ok('a long-stale series is caught', hasF(auditMacroSeries(staleMacro, MNOW), 'macro-stale'), true);
ok('badly stale is critical', findF(auditMacroSeries(staleMacro, MNOW), 'macro-stale').severity, 'critical');
ok('and it says how old', /days ago/.test(findF(auditMacroSeries(staleMacro, MNOW), 'macro-stale').detail), true);
const mildlyStale = [{ key:'t10', label:'Breakeven', observations: obsFrom(60, 30, i => 2 + i*0.01) }];
ok('mildly stale is a warning, not a block', findF(auditMacroSeries(mildlyStale, MNOW), 'macro-stale').severity, 'warning');
ok('an empty list is fine', auditMacroSeries([], MNOW).length, 0);
// the engine keeps {time, close}; FRED returns {date, value}. Both must work,
// because a conversion at each call site is one more place to get it wrong.
const engineShape = [{ key:'vix', label:'Volatility',
  series: Array.from({length:30}, (_, i) => ({ time: MNOW - (30-i)*86400000, close: 18 })) }];
ok('the engine\'s own series shape is understood', hasF(auditMacroSeries(engineShape, MNOW), 'macro-frozen'), true);
const engineStale = [{ key:'r', label:'Real Yield',
  series: Array.from({length:30}, (_, i) => ({ time: MNOW - (200+30-i)*86400000, close: 2 + i*0.01 })) }];
ok('and staleness in that shape too', hasF(auditMacroSeries(engineStale, MNOW), 'macro-stale'), true);
ok('with a readable date', /\d{4}-\d{2}-\d{2}/.test(findF(auditMacroSeries(engineStale, MNOW), 'macro-stale').detail), true);
ok('a series with one observation is not judged',
  auditMacroSeries([{ key:'x', label:'X', observations: obsFrom(0, 1, 5) }], MNOW).length, 0);

console.log('\n-- assembly --');
const broken = auditAnalysis({ result:{...buyResult, factors:{htf:-1}, weights:{htf:10}}, plan:{...buyPlan, sl:2010, rr:99},
  candles:unordered, expectedIntervalMs:BAR, now:Date.now(), maxAgeMs:30*MIN });
ok('a badly broken analysis blocks', broken.blocking, true);
ok('and reports several criticals', broken.critical >= 3, true);
// The fixture's candles are out of order, so the fault is in the DATA. Saying
// "the analysis has errors" would send you looking in the wrong place.
ok('verdict blames the feed, not the reasoning', /data feeding this analysis is wrong/.test(broken.verdict), true);
ok('and it is flagged as a data problem', broken.dataProblem, true);
ok('with the data faults listed separately', broken.dataFaults.length > 0, true);
// Clean data, broken reasoning: now it is the analysis that is unsafe.
const badLogic = auditAnalysis({ result:{...buyResult, factors:{htf:-1}, weights:{htf:10}},
  plan:{...buyPlan, sl:2010, rr:99}, candles:good, expectedIntervalMs:BAR,
  now:good[good.length-1].time, maxAgeMs:30*MIN });
ok('a reasoning fault says the analysis is unsafe', /unsafe to act on/.test(badLogic.verdict), true);
ok('and is not blamed on the data', badLogic.dataProblem, false);
ok('criticals are sorted first', broken.findings[0].severity, 'critical');
ok('every finding explains itself', broken.findings.every(f=>f.detail && f.detail.length>20), true);
ok('handles empty input without throwing', typeof auditAnalysis({}).verdict, 'string');


console.log('\n-- market hours: the auditor must not cry wolf --');
// Gold trades 24/5. A coverage check that assumes continuous bars reads ~71%
// on EVERY window purely from the weekend — a permanent false warning that
// teaches you to ignore the auditor, and close enough to the critical
// threshold that a holiday would have blocked trading outright.
import { expectedBarsExcludingWeekend } from '../lib/auditor.js';
function weekdayBars(n, startUtc){
  const out=[]; let t=startUtc; let p=2000;
  while(out.length<n){
    const dow=new Date(t).getUTCDay();
    if(dow!==0&&dow!==6){p+=0.5; out.push({time:t,open:p,high:p+2,low:p-2,close:p});}
    t+=BAR;
  }
  return out;
}
const realistic = weekdayBars(500, Date.UTC(2026,7,3,0,0,0)); // Monday
const realAudit = auditData(realistic, BAR);
ok('a normal weekday feed raises NOTHING', realAudit.length, 0);
ok('no false coverage warning', has(realAudit,'thin-coverage'), false);
ok('no false gap warning', has(realAudit,'gappy-feed'), false);
ok('weekend-aware count matches the bars received',
   expectedBarsExcludingWeekend(realistic[0].time, realistic[realistic.length-1].time, BAR), 500);

// starting on a Friday, so the span definitely straddles a weekend
const fri = weekdayBars(400, Date.UTC(2026,7,7,0,0,0));
ok('still fClean when the span straddles a weekend', auditData(fri, BAR).length, 0);

// a genuinely thinned feed must STILL be caught
const genuinelyThin = weekdayBars(500, Date.UTC(2026,7,3,0,0,0)).filter((_,i)=>i%2===0);
ok('real thinning is still detected', has(auditData(genuinelyThin,BAR),'thin-coverage'), true);
ok('and half-missing is still critical', auditData(genuinelyThin,BAR).find(f=>f.code==='thin-coverage').severity, 'critical');


// ============================================================
// AUDITING TRADES THAT ARE ALREADY LIVE
// ============================================================
// The auditor, not the engine, decides which live trades are past saving —
// the engine judging whether its own trade has gone bad is not a check.
const TNOW = Date.parse('2026-03-10T12:00:00Z');
const tAgo = h => new Date(TNOW - h * 3600000).toISOString();
const TC = (t,o,h,l,c) => ({time:t,open:o,high:h,low:l,close:c});
const T = (o) => Object.assign({ id:'t1', dir:'BUY', entry:2000, sl:1990, tp:2040,
  entryType:'limit', status:'pending' }, o);
const aud = (sig, candles, cfg) => auditTrade(sig, candles || [], cfg || {}, { now: TNOW });
// bars that hover above a 2000 entry and never reach it
const hovering = (fromH, n) => Array.from({length:n||4}, (_, i) =>
  TC(TNOW - fromH*3600000 + (i+1)*9e5, 2012, 2013, 2011, 2012));

// --- the clock ------------------------------------------------------------
ok('a fresh resting order passes', aud(T({time:tAgo(1)})).verdict, 'ok');
ok('one past its limit is killed', aud(T({time:tAgo(30)})).verdict, 'kill');
ok('and the reason names the limit', /past the 12h limit/.test(aud(T({time:tAgo(30)})).reason), true);
ok('tagged as a stale order', aud(T({time:tAgo(30)})).code, 'stale-order');
ok('one approaching the limit is flagged to watch', aud(T({time:tAgo(10)})).verdict, 'watch');
ok('with a warning, not a critical', aud(T({time:tAgo(10)})).findings[0].severity, 'warning');
ok('a kill raises a critical finding', aud(T({time:tAgo(30)})).findings[0].severity, 'critical');
ok('and explains why the outcome would not be evidence',
  /not evidence about the setup/.test(aud(T({time:tAgo(30)})).findings[0].detail), true);

// a filled position gets the longer limit, aged from the fill
ok('an open position uses the hold limit',
  aud(T({status:'open', entryType:'market', time:tAgo(30)})).verdict, 'ok');
ok('and is killed past it',
  aud(T({status:'open', entryType:'market', time:tAgo(90)})).verdict, 'kill');
ok('tagged as a stale position',
  aud(T({status:'open', entryType:'market', time:tAgo(90)})).code, 'stale-position');

// --- fill state is re-derived, not trusted --------------------------------
// An order the record calls "pending" that price actually traded through must
// be aged as a POSITION, not cancelled as an unfilled order.
const tagged = [TC(TNOW - 20*3600000, 2005, 2006, 1995, 2000), TC(TNOW - 19*3600000, 2000, 2002, 1999, 2001)];
ok('a fill the record missed is noticed',
  has(aud(T({time:tAgo(21)}), tagged).findings, 'trade-missed-fill'), true);
ok('and the order is not culled as unfilled',
  aud(T({time:tAgo(21)}), tagged).verdict !== 'kill', true);
ok('a position that never actually filled is noticed',
  has(aud(T({status:'open', time:tAgo(2)}), hovering(2, 4)).findings, 'trade-phantom-fill'), true);
ok('a market entry needs no fill evidence',
  has(aud(T({status:'open', entryType:'market', time:tAgo(2)}), hovering(2,4)).findings, 'trade-phantom-fill'), false);

// --- the market leaving the order behind ----------------------------------
const ranAway = [TC(TNOW - 2*3600000, 2012, 2014, 2010, 2012), TC(TNOW - 1*3600000, 2014, 2060, 2013, 2058)];
ok('an order the market ran away from is killed', aud(T({time:tAgo(3)}), ranAway).verdict, 'kill');
ok('tagged as a spent zone', aud(T({time:tAgo(3)}), ranAway).code, 'zone-left-behind');
ok('and the finding says it is a retest, not the setup',
  /retest of a spent zone/.test(aud(T({time:tAgo(3)}), ranAway).findings[0].detail), true);
ok('a limit resting far from price is not punished for that alone',
  aud(T({time:tAgo(1)}), hovering(1, 4)).verdict, 'ok');
ok('drift is checked before the clock — the spent zone is the stronger call',
  aud(T({time:tAgo(30)}), ranAway).code, 'zone-left-behind');
ok('drift checking can be disabled',
  aud(T({time:tAgo(3)}), ranAway, {maxDriftRToFill:0}).verdict, 'ok');

// --- malformed and unknowable ---------------------------------------------
ok('a live trade with no direction is killed', aud(T({dir:'HOLD', time:tAgo(1)})).code, 'malformed');
ok('a resolved trade is not reviewed', aud(T({status:'won', time:tAgo(99)})).verdict, 'ok');
ok('nor a killed one', aud(T({status:'expired', time:tAgo(99)})).verdict, 'ok');
ok('no timestamp means the clock cannot apply', aud(T({time:0})).verdict, 'ok');
ok('and it says so as a note', has(aud(T({time:0})).findings, 'trade-no-timestamp'), true);
ok('limits can be turned off', aud(T({time:tAgo(500)}), [], {maxHoursToFill:0}).verdict, 'ok');

// --- the whole book -------------------------------------------------------
const book = [T({id:'ok1', time:tAgo(1)}), T({id:'dead', time:tAgo(30)}),
              T({id:'closed', status:'won', time:tAgo(50)}), T({id:'near', time:tAgo(10)})];
const all = auditOpenTrades(book, [], {}, { now: TNOW });
ok('only live trades are reviewed', all.reviewed, 3);
ok('the dead one is listed for killing', all.kills.map(k=>k.id), ['dead']);
ok('the ageing one is listed to watch', all.watch.map(k=>k.id), ['near']);
ok('the verdict counts them', /1 of 3 live trade\(s\) should be closed out/.test(all.verdict), true);
ok('an empty book says so', auditOpenTrades([], [], {}, {now:TNOW}).verdict, 'No live trades to review.');
ok('a fClean book says so',
  /All 1 live trade\(s\) are within limits/.test(auditOpenTrades([T({time:tAgo(1)})], [], {}, {now:TNOW}).verdict), true);
ok('nulls in the book are ignored', auditOpenTrades([null, T({time:tAgo(1)})], [], {}, {now:TNOW}).reviewed, 1);
ok('the defaults are the documented ones',
  [TRADE_AUDIT_DEFAULTS.maxHoursToFill, TRADE_AUDIT_DEFAULTS.maxHoursOpen, TRADE_AUDIT_DEFAULTS.maxDriftRToFill],
  [12, 72, 1.5]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
