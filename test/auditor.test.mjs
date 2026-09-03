// The auditor is only worth having if it catches deliberately broken input.
// Every test here plants a specific fault and checks it is found — and the
// clean case checks it does not invent problems that are not there.
import { auditAnalysis, auditData, auditPlan, auditEvidence, auditFreshness } from '../lib/auditor.js';

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

console.log('\n-- assembly --');
const broken = auditAnalysis({ result:{...buyResult, factors:{htf:-1}, weights:{htf:10}}, plan:{...buyPlan, sl:2010, rr:99},
  candles:unordered, expectedIntervalMs:BAR, now:Date.now(), maxAgeMs:30*MIN });
ok('a badly broken analysis blocks', broken.blocking, true);
ok('and reports several criticals', broken.critical >= 3, true);
ok('verdict says unsafe', /unsafe to act on/.test(broken.verdict), true);
ok('criticals are sorted first', broken.findings[0].severity, 'critical');
ok('every finding explains itself', broken.findings.every(f=>f.detail && f.detail.length>20), true);
ok('handles empty input without throwing', typeof auditAnalysis({}).verdict, 'string');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
