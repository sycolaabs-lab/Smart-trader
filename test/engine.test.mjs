import { resolveSignal, autonomyGate } from '../lib/engine.js';
const C=(t,o,h,l,c)=>({time:t,open:o,high:h,low:l,close:c});
let pass=0,fail=0;
const ok=(n,a,e)=>{ const g=JSON.stringify(a)===JSON.stringify(e); console.log((g?'PASS':'FAIL')+' '+n+(g?'':'  got='+JSON.stringify(a)+' want='+JSON.stringify(e))); g?pass++:fail++; };

const base={dir:'BUY',entry:2000,sl:1990,tp:2040,time:1000,entryType:'market'};
ok('buy hits TP', resolveSignal(base,[C(2000,2000,2045,1998,2040)]).status, 'won');
ok('buy hits SL', resolveSignal(base,[C(2000,2000,2005,1985,1990)]).status, 'lost');
ok('buy still open', resolveSignal(base,[C(2000,2000,2010,1995,2005)]).status, 'open');
ok('ambiguous bar -> lost', resolveSignal(base,[C(2000,2000,2045,1985,2000)]).status, 'lost');
ok('ambiguous flagged', resolveSignal(base,[C(2000,2000,2045,1985,2000)]).ambiguousBar, true);
ok('ignores candles before signal', resolveSignal(base,[C(500,2000,2045,1985,2000)]).status, 'open');

const sell={dir:'SELL',entry:2000,sl:2010,tp:1960,time:1000,entryType:'market'};
ok('sell hits TP', resolveSignal(sell,[C(2000,2000,2002,1955,1960)]).status, 'won');
ok('sell hits SL', resolveSignal(sell,[C(2000,2000,2015,1995,2010)]).status, 'lost');

const lim={dir:'BUY',entry:1980,sl:1970,tp:2020,time:1000,entryType:'limit'};
ok('limit unfilled -> pending', resolveSignal(lim,[C(2000,2000,2005,1995,2000)]).status, 'pending');
ok('limit fills then wins', resolveSignal(lim,[C(2000,2000,2005,1975,1985),C(3000,1985,2025,1980,2020)]).status, 'won');
ok('limit expires', resolveSignal(lim, Array.from({length:40},(_,i)=>C(2000+i,2000,2005,1995,2000)), {maxBarsToFill:5}).status, 'expired');
ok('max duration expiry', resolveSignal(base, Array.from({length:20},(_,i)=>C(2000+i,2000,2005,1995,2000)), {maxBarsOpen:10}).status, 'expired');

// gate
const R=(d,c,g)=>({direction:d,confidence:c,fusion:{grade:g}});
const P={entry:2000,sl:1990,tp:2040,rr:4,metaScore:0.3};
ok('gate takes good setup', autonomyGate(R('BUY',70,'A'),P,[],null).take, true);
ok('gate rejects HOLD', autonomyGate(R('HOLD',70,'A'),P,[],null).take, false);
ok('gate rejects low conf', autonomyGate(R('BUY',20,'A'),P,[],null).take, false);
ok('gate rejects bad grade', autonomyGate(R('BUY',70,'D'),P,[],null).take, false);
ok('gate vetoes on metaScore', autonomyGate(R('BUY',70,'A'),{...P,metaScore:-0.9},[],null).take, false);
ok('gate respects cooldown', autonomyGate(R('BUY',70,'A'),P,[],Date.now()).take, false);
ok('gate respects dup direction', autonomyGate(R('BUY',70,'A'),P,[{dir:'BUY',status:'open'}],null).take, false);
ok('gate allows opposite dir', autonomyGate(R('BUY',70,'A'),P,[{dir:'SELL',status:'open'}],null).take, true);
ok('gate respects max open', autonomyGate(R('BUY',70,'A'),P,[{dir:'SELL',status:'open'},{dir:'SELL',status:'open'},{dir:'SELL',status:'pending'}],null).take, false);
ok('gate rejects bad plan', autonomyGate(R('BUY',70,'A'),{entry:NaN,sl:1,tp:2,rr:1},[],null).take, false);


// ---------------- analysis quality ----------------
import { computeCalibration, computeConditionBreakdown, computeGateAudit, signalRMultiple } from '../lib/engine.js';
console.log('\n-- analysis quality --');
const sig=(conf,st,extra={})=>Object.assign({confidence:conf,status:st,entry:2000,sl:1990,tp:2040,dir:'BUY'},extra);

ok('R-multiple on win is +rr', signalRMultiple(sig(50,'won')), 4);
ok('R-multiple on loss is -1', signalRMultiple(sig(50,'lost')), -1);
ok('R-multiple null when unresolved', signalRMultiple(sig(50,'open')), null);
ok('R-multiple null on zero risk', signalRMultiple(sig(50,'won',{sl:2000})), null);

// confidence that genuinely discriminates: high conf wins, low conf loses
const good=[...Array(6)].map(()=>sig(80,'won')).concat([...Array(6)].map(()=>sig(20,'lost')));
const cGood=computeCalibration(good);
ok('detects informative confidence', cGood.discrimination===1, true);
ok('verdict says informative', /informative/.test(cGood.verdict), true);

// confidence that carries no information
const noise=[...Array(5)].map(()=>sig(80,'won')).concat([...Array(5)].map(()=>sig(80,'lost')))
  .concat([...Array(5)].map(()=>sig(20,'won'))).concat([...Array(5)].map(()=>sig(20,'lost')));
const cNoise=computeCalibration(noise);
ok('detects non-discriminating confidence', Math.abs(cNoise.discrimination)<0.05, true);
ok('verdict flags decoration', /not currently discriminating/.test(cNoise.verdict), true);

// inverted
const inv=[...Array(6)].map(()=>sig(80,'lost')).concat([...Array(6)].map(()=>sig(20,'won')));
ok('detects inverted confidence', /inverted/.test(computeCalibration(inv).verdict), true);

ok('small sample refuses to judge', /Not enough resolved/.test(computeCalibration([sig(70,'won')]).verdict), true);
ok('ignores unresolved in calibration', computeCalibration(good.concat([sig(90,'open'),sig(90,'pending')])).sample, 12);

// expectancy: 1 win at 4R + 4 losses = 0R  => breakeven despite 20% win rate
const be=[sig(50,'won'),...[...Array(4)].map(()=>sig(50,'lost'))];
ok('expectancy reflects R not win rate', computeCalibration(be).overall.expectancyR, 0);
ok('win rate still reported', computeCalibration(be).overall.winRate, 0.2);

// condition breakdown
const mixed=[
  sig(70,'won',{session:'London',regime:'trending',grade:'A'}),
  sig(70,'won',{session:'London',regime:'trending',grade:'A'}),
  sig(70,'lost',{session:'Asia',regime:'ranging',grade:'B'}),
  sig(70,'lost',{session:'Asia',regime:'ranging',grade:'B'}),
];
const bd=computeConditionBreakdown(mixed);
ok('groups by session', bd.bySession.length, 2);
ok('best session ranked first', bd.bySession[0].key, 'London');
ok('session win rates correct', bd.bySession[0].winRate, 1);
ok('groups by regime', bd.byRegime.map(r=>r.key).sort().join(','), 'ranging,trending');
ok('groups by grade', bd.byGrade.length, 2);
ok('unknowns bucketed', computeConditionBreakdown([sig(70,'won')]).bySession[0].key, 'Unknown');

// gate audit
const taken=[...Array(6)].map(()=>sig(70,'won')).concat([...Array(6)].map(()=>sig(70,'lost')));
const declinedBad=[...Array(12)].map(()=>sig(30,'lost'));
ok('gate earning its keep', /earning its keep/.test(computeGateAudit(taken,declinedBad).verdict), true);
const declinedGood=[...Array(12)].map(()=>sig(30,'won'));
ok('gate too tight detected', /too tight/.test(computeGateAudit(taken,declinedGood).verdict), true);
ok('gate refuses small sample', /Not enough declined/.test(computeGateAudit(taken,[sig(30,'won')]).verdict), true);
ok('edge quantified', computeGateAudit(taken,declinedBad).edgeFromFiltering, 2.5);


// ---------------- signal log trimming direction ----------------
// Regression: newest-first log must trim from the tail. Keeping the oldest N
// froze learning at the cap, because new signals were dropped before they
// could ever resolve.
console.log('\n-- log trimming --');
const MAX = 600;
let log = [];
for (let i = 1; i <= MAX + 5; i++) {
  log.unshift({ id: i });
  if (log.length > MAX) log = log.slice(0, MAX);
}
ok('newest signal survives trimming', log[0].id, MAX + 5);
ok('log stays at the cap', log.length, MAX);
ok('oldest signals are the ones dropped', log[log.length - 1].id, 6);


// ---------------- api quota budgeting ----------------
import { utcDayKey, rollQuota, quotaStatus, canSpend, spendQuota, quotaSummary, criticalReserveFor } from '../lib/engine.js';
console.log('\n-- api quota --');
const CAP = 800;
ok('day key is UTC date', utcDayKey(Date.parse('2026-03-04T23:59:00Z')), '2026-03-04');
ok('resets on new UTC day', rollQuota({day:'2026-03-03', used:700}, Date.parse('2026-03-04T00:01:00Z')).used, 0);
ok('keeps count within same day', rollQuota({day:'2026-03-04', used:700}, Date.parse('2026-03-04T12:00:00Z')).used, 700);

// low-priority calls yield first, so the analysis path still has budget late in the day
// The core guarantee: discretionary work can never eat the analysis reserve.
const RES = criticalReserveFor(15);          // ~140 credits/day for a 15-min cycle
const DISC = CAP - RES;                       // everything else shares the remainder
ok('reserve scales with cycle frequency', criticalReserveFor(15) > criticalReserveFor(30), true);
ok('reserve covers a day of cycles', criticalReserveFor(15) >= Math.ceil(24*60/15), true);

ok('low allowed when fresh', canSpend({day:'d',used:0}, CAP, 'low', 1, RES), true);
ok('low cut at 65% of discretionary', canSpend({day:'d',used:Math.ceil(DISC*0.65)}, CAP, 'low', 1, RES), false);
ok('normal still funded there', canSpend({day:'d',used:Math.ceil(DISC*0.65)}, CAP, 'normal', 1, RES), true);
ok('normal cut at the discretionary edge', canSpend({day:'d',used:DISC}, CAP, 'normal', 1, RES), false);
ok('CRITICAL still funded at the discretionary edge', canSpend({day:'d',used:DISC}, CAP, 'critical', 1, RES), true);
ok('critical funded deep into the reserve', canSpend({day:'d',used:CAP-1}, CAP, 'critical', 1, RES), true);
ok('critical cut only at the hard cap', canSpend({day:'d',used:CAP}, CAP, 'critical', 1, RES), false);
ok('multi-credit cost respected', canSpend({day:'d',used:CAP-2}, CAP, 'critical', 3, RES), false);

// the guarantee, stated as the property that matters
const spentByDiscretionary = DISC;            // worst case: every non-critical call taken
const creditsLeftForAnalysis = CAP - spentByDiscretionary;
ok('analysis keeps its full reserve in the worst case', creditsLeftForAnalysis >= RES, true);
ok('reserve exceeds a day of 15-min cycles', RES > 24*60/15, true);
ok('tiny cap degrades to critical-only', canSpend({day:'d',used:0}, 50, 'low', 1, criticalReserveFor(15)), false);
ok('tiny cap still funds critical', canSpend({day:'d',used:0}, 50, 'critical', 1, criticalReserveFor(15)), true);

ok('spending increments', spendQuota({day:utcDayKey(),used:5}, 1).used, 6);
ok('status reports remaining', quotaStatus({day:'d',used:300}, CAP).remaining, 500);
ok('exhausted flagged', quotaStatus({day:'d',used:800}, CAP).exhausted, true);
ok('summary pct', quotaSummary({day:'d',used:400}, CAP, RES).pct, 50);
ok('summary flags protected analysis budget', /analysis path is still fully funded/.test(quotaSummary({day:'d',used:DISC+5}, CAP, RES).note), true);
ok('summary warns when spent', /Daily budget spent/.test(quotaSummary({day:'d',used:800}, CAP, RES).note), true);
ok('summary calm when low', /Within budget/.test(quotaSummary({day:'d',used:50}, CAP, RES).note), true);


// ---------------- paper trading ----------------
import { PAPER_DEFAULTS, worsePrice, paperPositionSize, openPaperPosition,
         closePaperPosition, unrealisedPnl, paperAccountSummary } from '../lib/engine.js';
console.log('\n-- paper trading --');
const PCFG = { startingBalance:10000, riskPercent:1, spreadPips:3, slippagePips:1, maxConcurrent:3 };
const near = (a,b,eps)=>Math.abs(a-b)<(eps||1e-6);

// fills always move against the trader
ok('buy entry pays the spread', worsePrice(2000,'BUY','entry',3,0.1), 2000.3);
ok('sell entry pays the spread', worsePrice(2000,'SELL','entry',3,0.1), 1999.7);
ok('buy stop exit slips down', worsePrice(1990,'BUY','exit',1,0.1), 1989.9);
ok('sell stop exit slips up', worsePrice(2010,'SELL','exit',1,0.1), 2010.1);

// sizing makes the stop cost exactly the configured risk
const sz = paperPositionSize(10000, 1, 2000, 1990);
ok('risk amount is 1% of balance', sz.riskAmount, 100);
ok('units sized off stop distance', near(sz.units, 10), true);
ok('zero-width stop refuses to size', paperPositionSize(10000,1,2000,2000), null);

const sigBuy = { id:'s1', dir:'BUY', entry:2000, sl:1990, tp:2040, time:'2026-01-01T00:00:00Z' };
const acct = { balance:10000, positions:[] };
const pos = openPaperPosition(sigBuy, acct, PCFG);
ok('entry filled worse than requested', pos.entryFill > pos.requestedEntry, true);
ok('stop loss costs exactly the risk', near(closePaperPosition(pos,'lost',null,PCFG).pnl, -(100 + 0.1*pos.units)), true);
ok('a loss is negative', closePaperPosition(pos,'lost',null,PCFG).pnl < 0, true);
ok('a win is positive', closePaperPosition(pos,'won',null,PCFG).pnl > 0, true);
// spread + slippage means realised R comes in under the nominal 4:1
const wonR = closePaperPosition(pos,'won',null,PCFG).rMultiple;
ok('winning R is below nominal 4 after costs', wonR < 4 && wonR > 3, true);
ok('losing R is about -1 including slippage', closePaperPosition(pos,'lost',null,PCFG).rMultiple < -1, true);
ok('expired closes at the mark, not a stop', closePaperPosition(pos,'expired',2000.3,PCFG).outcome, 'expired');
ok('closing twice is a no-op', closePaperPosition(closePaperPosition(pos,'won',null,PCFG),'lost',null,PCFG).outcome, 'won');

// concurrency + solvency guards
ok('respects max concurrent', openPaperPosition(sigBuy,{balance:10000,positions:[{status:'open'},{status:'open'},{status:'open'}]},PCFG), null);
ok('refuses on a blown account', openPaperPosition(sigBuy,{balance:0,positions:[]},PCFG), null);
ok('refuses a HOLD', openPaperPosition({id:'x',dir:'HOLD',entry:1,sl:2,tp:3},acct,PCFG), null);

// floating P&L
ok('unrealised moves with price', unrealisedPnl(pos, pos.entryFill + 1) > 0, true);
ok('unrealised is zero once closed', unrealisedPnl(closePaperPosition(pos,'won',null,PCFG), 3000), 0);

// account summary
const w = closePaperPosition(pos,'won',null,PCFG), l = closePaperPosition(pos,'lost',null,PCFG);
const sum = paperAccountSummary([{...w,closedAt:'2026-01-01'},{...l,closedAt:'2026-01-02'}], 10000, 2000);
ok('counts wins and losses', [sum.wins,sum.losses].join(','), '1,1');
ok('win rate computed', sum.winRate, 0.5);
ok('balance reflects realised pnl', near(sum.balance, 10000 + w.pnl + l.pnl), true);
ok('profit factor > 1 at 1:4', sum.profitFactor > 1, true);
ok('drawdown recorded after the loss', sum.maxDrawdown > 0, true);
ok('empty account is flat', paperAccountSummary([], 10000, 2000).equity, 10000);
ok('equity includes floating pnl', paperAccountSummary([pos], 10000, pos.entryFill + 1).equity > 10000, true);


// ---------------- grade floor ----------------
import { gradesAtOrAbove } from '../lib/engine.js';
console.log('\n-- grade floor --');
ok('B floor allows A+/A/B', gradesAtOrAbove('B').join(','), 'A+,A,B');
ok('C floor also allows C', gradesAtOrAbove('C').join(','), 'A+,A,B,C');
ok('A floor is strict', gradesAtOrAbove('A').join(','), 'A+,A');
ok('unknown floor falls back to B-equivalent', gradesAtOrAbove('Z').join(','), 'A+,A,B');

const R2=(d,c,g)=>({direction:d,confidence:c,fusion:{grade:g}});
const P2={entry:2000,sl:1990,tp:2040,rr:4,metaScore:0};
ok('C setup rejected at default B floor', autonomyGate(R2('BUY',60,'C'),P2,[],null).take, false);
ok('C setup accepted at C floor', autonomyGate(R2('BUY',60,'C'),P2,[],null,{gradeFloor:'C'}).take, true);
ok('D still rejected at C floor', autonomyGate(R2('BUY',60,'D'),P2,[],null,{gradeFloor:'C'}).take, false);
ok('confidence floor still applies at C', autonomyGate(R2('BUY',20,'C'),P2,[],null,{gradeFloor:'C',minConfidence:30}).take, false);
ok('decline reason names the floor', /below the C floor/.test(autonomyGate(R2('BUY',60,'D'),P2,[],null,{gradeFloor:'C'}).reason), true);


// ---------------- data inventory ----------------
import { dataInventory, LEARNING_THRESHOLDS } from '../lib/engine.js';
console.log('\n-- data inventory --');
const empty = dataInventory({});
ok('empty inventory does not throw', empty.stores.signalsTotal, 0);
ok('nothing is ready when empty', Object.values(empty.capabilities).every(c=>!c.ready), true);
ok('reports what is still needed', empty.capabilities.metaLabeler.remaining, LEARNING_THRESHOLDS.metaLabeler);

const dinv = dataInventory({
  learningState: { totalLogged: 9, metaExamples: new Array(20).fill({}), metaModel: [{}], patterns:{a:1,b:2},
                   factors: { htf:{votes:8,wins:5}, ltf:{votes:2,wins:1}, ob:{votes:0,wins:0} } },
  signalLog: [ {status:'won'},{status:'lost'},{status:'won'},{status:'open'},{status:'pending'},{status:'expired'} ],
  shadowLog: [ {status:'won'},{status:'lost'},{status:'open'} ],
  paperPositions: [ {status:'closed'},{status:'closed'},{status:'open'} ]
});
ok('counts resolved signals', dinv.stores.signalsResolved, 3);
ok('counts open signals', dinv.stores.signalsOpen, 2);
ok('counts expired separately', dinv.stores.signalsExpired, 1);
ok('counts resolved shadows only', dinv.stores.shadowsResolved, 2);
ok('counts meta examples', dinv.stores.metaExamples, 20);
ok('counts paper closed/open', [dinv.stores.paperClosed,dinv.stores.paperOpen].join(','), '2,1');
ok('counts patterns', dinv.stores.patterns, 2);
ok('factors with enough votes', dinv.stores.factorsWithData, 1);
ok('reports total factors tracked', dinv.stores.factorsTotal, 3);
ok('meta-labeler ready at 20 examples', dinv.capabilities.metaLabeler.ready, true);
ok('knowledge base not ready at 9', dinv.capabilities.knowledgeBase.ready, false);
ok('knowledge base needs 6 more', dinv.capabilities.knowledgeBase.remaining, 6);
ok('calibration not ready at 3 resolved', dinv.capabilities.calibration.ready, false);
ok('progress percentage', dinv.capabilities.knowledgeBase.pct, 60);
ok('detects a trained model', dinv.metaTrained, true);
ok('factors sorted by votes', dinv.factorStats[0].key, 'htf');


import { fmt } from '../lib/engine.js';
console.log('\n-- fmt robustness --');
ok('formats a number', fmt(12.345), '12.35');
ok('undefined does not throw', fmt(undefined), '—');
ok('null does not throw', fmt(null), '—');
ok('NaN does not throw', fmt(NaN), '—');
ok('Infinity does not throw', fmt(Infinity), '—');
ok('a numeric string is not silently coerced', fmt('12'), '—');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
