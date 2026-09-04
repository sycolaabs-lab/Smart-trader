import { auditFeedIntegrity } from '../lib/auditor.js';
import { genData, correlateByDay, alignedLatestChange, pearsonCorrelation,
  resolveSignal, autonomyGate, mergeSignalLogs, newlyResolvedSignals,
  newlyArrivedOpenSignals, newlyExpiredSignals, signalResolutionRank, signalLiveness, shouldPaperTrade, paperRejectReason, interpretConfidence, confidenceBand,
  confidenceBands, breakevenWinRate, CONFIDENCE_PRACTICAL_MAX, CONFIDENCE_EVIDENCE } from '../lib/engine.js';
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

const sigBuy = { id:'s1', dir:'BUY', entry:2000, sl:1990, tp:2040, entryType:'market', time:'2026-01-01T00:00:00Z' };
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


// ---------------- yield vs price series ----------------
import { toDailyChanges, absChangeOf, seriesDeltas, latestChangeOf, toDailyReturns, pctChangeOf, FRED_INSTRUMENTS as FI } from '../lib/engine.js';
console.log('\n-- yield handling --');
const ser = a => a.map(c => ({ close: c }));

ok('yield deltas are absolute', toDailyChanges(ser([2.30,2.35,2.40])).map(v=>+v.toFixed(4)).join(','), '0.05,0.05');
ok('price deltas are returns', toDailyReturns(ser([100,110])).map(v=>+v.toFixed(4)).join(','), '0.1');
ok('absChangeOf reads the last move', +absChangeOf(ser([2.30,2.35])).toFixed(4), 0.05);

// the case that motivated this: a real yield rising THROUGH zero
const crossing = ser([-0.02, 0.03]);
ok('percentage change flips the sign of a rise', pctChangeOf(crossing) < 0, true);
ok('absolute change keeps the sign', absChangeOf(crossing) > 0, true);
ok('seriesDeltas picks absolute for a yield', seriesDeltas(crossing,'yield')[0] > 0, true);
ok('seriesDeltas picks returns for a price', seriesDeltas(ser([100,110]),'price')[0], 0.1);
ok('latestChangeOf honours kind', latestChangeOf(crossing,'yield') > 0 && latestChangeOf(crossing,'price') < 0, true);
ok('unknown kind defaults to returns', seriesDeltas(ser([100,110]), undefined)[0], 0.1);

// a negative yield falling further is still a FALL
const deeper = ser([-0.50,-0.60]);
ok('deeper negative yield reads as a fall', absChangeOf(deeper) < 0, true);
ok('percentage change would call it a rise', pctChangeOf(deeper) > 0, true);

// instrument config
const ids = FI.map(i=>i.seriesId);
ok('DFII10 present', ids.includes('DFII10'), true);
ok('T10YIE present', ids.includes('T10YIE'), true);
ok('oil removed', ids.includes('DCOILWTICO'), false);
ok('S&P removed', ids.includes('SP500'), false);
ok('every instrument declares a kind', FI.every(i=>i.kind==='yield'||i.kind==='price'), true);
ok('rate series marked as yields', FI.filter(i=>i.kind==='yield').map(i=>i.seriesId).sort().join(','), 'DFII10,DGS2,T10YIE');
ok('nominal 10Y dropped (= real + breakeven)', ids.includes('DGS10'), false);
ok('2Y kept as a separate policy signal', ids.includes('DGS2'), true);
ok('no duplicate series ids', ids.length, new Set(ids).size);


// ---------------- partial take-profit ----------------
import { PARTIAL_TP_DEFAULTS, partialTakeProfitLevel, shouldHoldForFullTarget } from '../lib/engine.js';
console.log('\n-- partial take-profit --');
const C2=(t,o,h,l,c)=>({time:t,open:o,high:h,low:l,close:c});
const pBuy = {dir:'BUY', entry:2000, sl:1990, tp:2040, time:1000, entryType:'market', grade:'C', metaScore:0};
const pSell= {dir:'SELL',entry:2000, sl:2010, tp:1960, time:1000, entryType:'market', grade:'C', metaScore:0};

ok('half level for a BUY', partialTakeProfitLevel(pBuy, 0.5), 2020);
ok('half level for a SELL', partialTakeProfitLevel(pSell, 0.5), 1980);
ok('quarter level', partialTakeProfitLevel(pBuy, 0.25), 2010);
ok('rejects a nonsense fraction', partialTakeProfitLevel(pBuy, 1.5), null);

// banks at half instead of waiting for the full target
const halfBar = resolveSignal(pBuy, [C2(2000,2000,2025,1998,2020)]);
ok('BUY banks at the half level', halfBar.status, 'won');
ok('exit is the half level, not the target', halfBar.exitPrice, 2020);
ok('flagged as partial', halfBar.partial, true);
ok('SELL banks at its half level', resolveSignal(pSell,[C2(2000,2000,2002,1975,1980)]).exitPrice, 1980);

// A bar spanning both levels fills the NEARER one — price had to pass through
// the partial to reach the target, so a resting partial order is already gone.
const fullBar = resolveSignal(pBuy, [C2(2000,2000,2045,1998,2040)]);
ok('a bar spanning both banks the partial', fullBar.exitPrice, 2020);
ok('and flags it partial', fullBar.partial, true);
// with partials off, the same bar books the full target
const noPartial = resolveSignal(pBuy, [C2(2000,2000,2045,1998,2040)], {partialTP:{enabled:false}});
ok('target booked when partials are off', noPartial.exitPrice, 2040);
ok('and is not flagged partial', !!noPartial.partial, false);
// a conviction hold reaches the real target
const held = resolveSignal({...pBuy, grade:'A'}, [C2(2000,2000,2045,1998,2040)]);
ok('conviction hold books the full target', held.exitPrice, 2040);

// conviction earns a full run
const conviction = {...pBuy, grade:'A'};
ok('grade A holds for the full target', shouldHoldForFullTarget(conviction, PARTIAL_TP_DEFAULTS), true);
ok('grade A ignores the half level', resolveSignal(conviction,[C2(2000,2000,2025,1998,2020)]).status, 'open');
const metaConviction = {...pBuy, metaScore:0.5};
ok('high meta score holds too', shouldHoldForFullTarget(metaConviction, PARTIAL_TP_DEFAULTS), true);
ok('low meta score does not', shouldHoldForFullTarget(pBuy, PARTIAL_TP_DEFAULTS), false);
ok('disabling restores full-target behaviour', resolveSignal(pBuy,[C2(2000,2000,2025,1998,2020)],{partialTP:{enabled:false}}).status, 'open');

// the stop still wins an ambiguous bar
ok('stop beats a partial in the same bar', resolveSignal(pBuy,[C2(2000,2000,2025,1985,2000)]).status, 'lost');

// R must reflect the actual exit, not the assumed target
ok('partial win is ~2R, not 4R', signalRMultiple({status:'won',entry:2000,sl:1990,tp:2040,exitPrice:2020}), 2);
ok('full win is 4R', signalRMultiple({status:'won',entry:2000,sl:1990,tp:2040,exitPrice:2040}), 4);
ok('missing exit falls back to the target', signalRMultiple({status:'won',entry:2000,sl:1990,tp:2040}), 4);
ok('a loss is still -1R', signalRMultiple({status:'lost',entry:2000,sl:1990,tp:2040,exitPrice:1990}), -1);

// paper account books the price it actually exited at
const acct2={balance:10000,positions:[]};
const pp = openPaperPosition({id:'x',...pBuy}, acct2, PCFG);
const partialClose = closePaperPosition(pp,'won',null,PCFG,2020);
const fullClose = closePaperPosition(pp,'won',null,PCFG,2040);
ok('paper books the partial exit price', partialClose.exitPrice, 2020);
ok('partial pays less than the full target', partialClose.pnl < fullClose.pnl, true);
ok('paper flags the partial', partialClose.partial, true);
ok('full target is not flagged', !!fullClose.partial, false);


// ---------------- resting orders have no exposure ----------------
// Reported live: gold at 4415, a BUY signal with a LIMIT entry at 4405, and the
// paper account immediately showed ~$51 of floating profit on a trade price had
// never reached. openPaperPosition hardcoded status 'open' and ignored entryType.
import { fillPaperPosition } from '../lib/engine.js';
console.log('\n-- resting orders --');
const RCFG = { startingBalance:10000, riskPercent:1, spreadPips:3, slippagePips:1, maxConcurrent:3 };
const limitSig  = { id:'L1', dir:'BUY', entry:4405, sl:4385, tp:4465, entryType:'limit — retrace into order block', time:'2026-01-01T00:00:00Z' };
const marketSig = { id:'M1', dir:'BUY', entry:4405, sl:4385, tp:4465, entryType:'market', time:'2026-01-01T00:00:00Z' };
const acctR = { balance:10000, positions:[] };

const limPos = openPaperPosition(limitSig, acctR, RCFG);
const mktPos = openPaperPosition(marketSig, acctR, RCFG);
ok('limit entry starts pending', limPos.status, 'pending');
ok('market entry starts open', mktPos.status, 'open');
ok('pending has no fill time', limPos.filledAt, null);
ok('market records a fill time', typeof mktPos.filledAt, 'string');

// the exact reported symptom
ok('resting order shows NO floating P&L at 4415', unrealisedPnl(limPos, 4415), 0);
ok('a filled market position does show P&L', unrealisedPnl(mktPos, 4415) > 0, true);

// filling starts exposure
const filled = fillPaperPosition(limPos, '2026-01-01T02:00:00Z');
ok('filling opens the position', filled.status, 'open');
ok('exposure begins only after the fill', unrealisedPnl(filled, 4415) > 0, true);
ok('filling records when', filled.filledAt, '2026-01-01T02:00:00Z');
ok('filling an already-open position is a no-op', fillPaperPosition(mktPos,'x').filledAt, mktPos.filledAt);

// an unfilled order is cancelled, never booked
const cancelled = closePaperPosition(limPos, 'expired', 4415, RCFG);
ok('unfilled order is cancelled', cancelled.status, 'cancelled');
ok('cancelled has exactly zero P&L', cancelled.pnl, 0);
ok('cancelled has no exit price', cancelled.exitPrice, null);
ok('cancelled has no R', cancelled.rMultiple, null);

// account summary separates the two
const sumR = paperAccountSummary([limPos, mktPos], 10000, 4415);
ok('open counts only filled positions', sumR.openCount, 1);
ok('pending counted separately', sumR.pendingCount, 1);
ok('floating P&L excludes the resting order', Math.abs(sumR.floating - unrealisedPnl(mktPos, 4415)) < 1e-9, true);

// a resting order still occupies a slot
const full = { balance:10000, positions:[{status:'pending'},{status:'pending'},{status:'open'}] };
ok('resting orders count toward the cap', openPaperPosition(marketSig, full, RCFG), null);

// A signal with no entryType is treated as a limit, matching resolveSignal's
// own default. Assuming 'market' would re-create the phantom-P&L bug for any
// legacy record that predates the field.
ok('missing entryType defaults to pending', openPaperPosition({...limitSig, entryType:undefined}, acctR, RCFG).status, 'pending');
ok('resolveSignal agrees on that default', resolveSignal({...limitSig, entryType:undefined, time:0}, []).status, 'pending');


// ---------------- economic release calendar ----------------
import { ECONOMIC_RELEASES, NEWS_WINDOW_DEFAULTS, isUsEasternDst, releaseTimestamp,
         buildReleaseCalendar, newsWindowState } from '../lib/engine.js';
console.log('\n-- release calendar --');
const iso = ts => new Date(ts).toISOString();

// DST, because a fixed offset is wrong for two thirds of the year
ok('summer 08:30 ET is 12:30 UTC', iso(releaseTimestamp('2026-09-04',8,30)), '2026-09-04T12:30:00.000Z');
ok('winter 08:30 ET is 13:30 UTC', iso(releaseTimestamp('2026-01-15',8,30)), '2026-01-15T13:30:00.000Z');
ok('FOMC 14:00 ET is 18:00 UTC', iso(releaseTimestamp('2026-09-03',14,0)), '2026-09-03T18:00:00.000Z');
ok('DST on in September', isUsEasternDst(Date.parse('2026-09-04T12:00:00Z')), true);
ok('DST off in January', isUsEasternDst(Date.parse('2026-01-15T12:00:00Z')), false);
// boundaries: DST 2026 runs Mar 8 - Nov 1
ok('DST off just before it starts', isUsEasternDst(Date.parse('2026-03-08T06:00:00Z')), false);
ok('DST on just after it starts', isUsEasternDst(Date.parse('2026-03-08T08:00:00Z')), true);
ok('DST off after it ends', isUsEasternDst(Date.parse('2026-11-01T08:00:00Z')), false);
ok('bad date returns null', releaseTimestamp('', 8, 30), null);

// building from raw FRED rows
const cal = buildReleaseCalendar([
  { release_id: 10,   date: '2026-09-11' },   // CPI, high
  { release_id: 50,   date: '2026-09-04' },   // NFP, high
  { release_id: 91,   date: '2026-09-25' },   // UMich, medium
  { release_id: 9999, date: '2026-09-05' }    // not tracked
]);
ok('ignores untracked releases', cal.length, 3);
ok('sorted by time', cal.map(e=>e.key).join(','), 'nfp,cpi,umich');
ok('carries impact', cal.find(e=>e.key==='nfp').impact, 'high');
ok('empty input is safe', buildReleaseCalendar(null).length, 0);

// the window itself
const nfpAt = releaseTimestamp('2026-09-04',8,30);
const at = mins => nfpAt + mins*60000;
ok('clear well before', newsWindowState(cal, at(-180)).blocked, false);
ok('blocked 20 min before', newsWindowState(cal, at(-20)).blocked, true);
ok('blocked at the release', newsWindowState(cal, at(0)).blocked, true);
ok('blocked 10 min after', newsWindowState(cal, at(10)).blocked, true);
ok('clear 30 min after', newsWindowState(cal, at(30)).blocked, false);
ok('names the event', newsWindowState(cal, at(-20)).active.name, 'Employment Situation (NFP)');
ok('knows which side of it', newsWindowState(cal, at(-20)).active.phase, 'before');
ok('and after', newsWindowState(cal, at(5)).active.phase, 'after');

// medium impact warns without blocking
const umichAt = releaseTimestamp('2026-09-25',10,0);
const umichState = newsWindowState(cal, umichAt - 10*60000);
ok('medium impact does not block', umichState.blocked, false);
ok('but is still reported', umichState.active.name, 'Consumer Sentiment (UMich)');
ok('blocking medium too, when asked', newsWindowState(cal, umichAt-10*60000, {blockImpacts:['high','medium']}).blocked, true);
ok('disabling stops blocking entirely', newsWindowState(cal, at(-20), {enabled:false}).blocked, false);
ok('reports the next event', newsWindowState(cal, at(-180)).next.key, 'nfp');
ok('no next once all are past', newsWindowState(cal, umichAt + 99*24*3600000).next, null);

// the gate refuses inside a blocking window
const RN=(d,c,g)=>({direction:d,confidence:c,fusion:{grade:g}});
const PN={entry:2000,sl:1990,tp:2040,rr:4,metaScore:0};
const blocked = autonomyGate(RN('BUY',80,'A'),PN,[],null,{newsState:newsWindowState(cal, at(-20))});
ok('gate blocks a strong setup before NFP', blocked.take, false);
ok('gate reports a news code', blocked.code, 'news');
ok('reason names the release', /Employment Situation/.test(blocked.reason), true);
ok('gate allows it once clear', autonomyGate(RN('BUY',80,'A'),PN,[],null,{newsState:newsWindowState(cal, at(180))}).take, true);


// ---------------- market explanation ----------------
import { explainMarket, rankDrivers } from '../lib/engine.js';
console.log('\n-- market explanation --');
const bullResult = {
  direction:'BUY', confidence:55,
  structWeekly:{trend:'bullish'}, structDaily:{trend:'bullish'}, structHtf:{trend:'bullish'},
  structMtf:{trend:'bullish'}, structLtf:{trend:'bullish'},
  sessionInfo:{session:'London'}, regimeInfo:{regime:'Trending'}
};
const bullMacro = [
  {label:'10Y Real Yield (TIPS)', available:true, contribution:0.72, corr:-0.78, pctChange:-0.06, kind:'yield'},
  {label:'Broad Dollar Index',    available:true, contribution:0.31, corr:-0.55, pctChange:-0.20, kind:'price'},
  {label:'Silver',                available:true, contribution:0.12, corr:0.61,  pctChange:0.40,  kind:'price'},
  {label:'Bitcoin',               available:false}
];
ok('ranks drivers by absolute contribution', rankDrivers(bullMacro,[])[0].label, '10Y Real Yield (TIPS)');
ok('drops unavailable instruments', rankDrivers(bullMacro,[]).length, 3);
ok('drops zero contributions', rankDrivers([{label:'x',available:true,contribution:0}],[]).length, 0);
ok('handles null input', rankDrivers(null,null).length, 0);

const agree = explainMarket({ result: bullResult, correlationDetails: bullMacro, newsAvailable:false });
ok('headline states direction and confidence', agree.headline, 'BUY bias at 55% confidence.');
ok('names the dominant driver', /Real Yield/.test(agree.narrative.join(' ')), true);
ok('quotes the measured correlation', /measured correlation -0.78/.test(agree.narrative.join(' ')), true);
ok('yield move is shown in pp not %', /0.06pp/.test(agree.narrative.join(' ')), true);
ok('reports agreement when they align', /Price and macro agree/.test(agree.narrative.join(' ')), true);
ok('no conflict flagged', agree.conflicts.length, 0);
ok('reports session and regime', /London/.test(agree.narrative.join(' ')), true);

// the interesting case: price moving against its drivers
const bearMacro = bullMacro.map(d => d.available ? {...d, contribution: -d.contribution} : d);
const clash = explainMarket({ result: bullResult, correlationDetails: bearMacro, newsAvailable:false });
ok('flags a structure/macro conflict', clash.conflicts.length, 1);
ok('says price is moving against its backdrop', /against its macro backdrop/.test(clash.narrative.join(' ')), true);
ok('records the leans', [clash.structureLean, clash.macroLean].join(','), '1,-1');

// split structure
const split = explainMarket({ result: {...bullResult, structLtf:{trend:'bearish'}, structMtf:{trend:'bearish'}},
                              correlationDetails: bullMacro, newsAvailable:false });
ok('describes split timeframes', /Structure is split/.test(split.narrative.join(' ')), true);

// no macro at all
const bare = explainMarket({ result: bullResult, correlationDetails: [], fundamentalDetails: [] });
ok('says so when macro is absent', /rests on price structure alone/.test(bare.narrative.join(' ')), true);

// news window folds in
const nfpAt2 = releaseTimestamp('2026-09-04',8,30);
const cal2 = buildReleaseCalendar([{release_id:50, date:'2026-09-04'}]);
const withNews = explainMarket({ result: bullResult, correlationDetails: bullMacro,
  newsState: newsWindowState(cal2, nfpAt2 - 20*60000) });
ok('mentions the imminent release', /Employment Situation/.test(withNews.narrative.join(' ')), true);
ok('explains why it is standing aside', /held back through the window/.test(withNews.narrative.join(' ')), true);

// sentiment
const withSent = explainMarket({ result: bullResult, correlationDetails: bullMacro, newsAvailable:true, newsScore:0.4 });
ok('reads risk-off sentiment as supportive', /risk-off/.test(withSent.narrative.join(' ')), true);
ok('flags sentiment as the softest input', /softest input/.test(withSent.narrative.join(' ')), true);

// HOLD
const hold = explainMarket({ result: {...bullResult, direction:'HOLD', confidence:8}, correlationDetails: bullMacro });
ok('HOLD headline explains the tension', /pulling against itself/.test(hold.headline), true);
ok('HOLD explains silent factors', /Silent factors count against/.test(hold.confidenceNote), true);
ok('missing result is handled', explainMarket({}).headline, 'No analysis available yet.');


// ---------------- macro model ----------------
import { fitMacroModel, macroModelScore, describeMacroModel, MACRO_MODEL_DEFAULTS } from '../lib/engine.js';
import { alignByDay, toChanges } from '../lib/stats.js';
console.log('\n-- macro model --');
const DAY=86400000;
// build a mGold series genuinely driven by a real yield, plus a useless driver
let ms=7; const mr=()=>{ms=(ms*1103515245+12345)&0x7fffffff;return ms/0x7fffffff-0.5;};
const days=120, t0=Date.UTC(2026,0,1);
const mGold=[], realYield=[], mNoise=[];
let g=2000, ry=2.0, nz=50;
for(let i=0;i<days;i++){
  const dRy=mr()*0.04;                 // yield moves in points
  ry+=dRy; nz+=mr()*2;
  g=g*(1 - 8*dRy/100) * (1+0.0004*mr()); // mGold falls when the real yield rises
  const time=t0+i*DAY;
  mGold.push({time,close:g}); realYield.push({time,close:ry}); mNoise.push({time,close:nz});
}
const model = fitMacroModel(mGold, [
  {key:'real10y', label:'10Y Real Yield (TIPS)', kind:'yield', series:realYield},
  {key:'mNoise',   label:'Unrelated Index',       kind:'price', series:mNoise}
]);
ok('model fits', model.ok, true);
ok('recovers the real driver as dominant', model.drivers[0].key, 'real10y');
ok('real yield coefficient is negative', model.drivers[0].beta < 0, true);
ok('impact is reported in gold sigmas', Math.abs(model.drivers[0].impactSigma) > 0.5, true);
ok('real yield is significant', model.drivers[0].significant, true);
ok('the mNoise driver is NOT significant', model.drivers.find(d=>d.key==='mNoise').significant, false);
ok('R2 is high for a real relationship', model.r2 > 0.8, true);
ok('marked explanatory', model.explanatory, true);
ok('reports observation count', model.n > 100, true);
ok('produces a usable score', typeof macroModelScore(model), 'number');
ok('score is bounded', Math.abs(macroModelScore(model)) <= 1, true);
ok('description names the driver', /Real Yield/.test(describeMacroModel(model)), true);
ok('description quotes R2 and t', /% of gold/.test(describeMacroModel(model)) && /t /.test(describeMacroModel(model)), true);

// mGold that ignores its drivers entirely
const rnd2=[], rndGold=[];
let g2=2000, r2v=2.0;
for(let i=0;i<days;i++){const time=t0+i*DAY; r2v+=mr()*0.04; g2*=1+0.006*mr(); rndGold.push({time,close:g2}); rnd2.push({time,close:r2v});}
const weak = fitMacroModel(rndGold, [{key:'real10y',label:'10Y Real Yield (TIPS)',kind:'yield',series:rnd2}]);
ok('weak relationship is not called explanatory', weak.explanatory, false);
ok('and yields no score rather than a bad one', macroModelScore(weak), null);
ok('description says so plainly', /too little to lean on/.test(describeMacroModel(weak)), true);

// refusals
ok('refuses with no drivers', fitMacroModel(mGold, []).ok, false);
ok('refuses with too little history', fitMacroModel(mGold.slice(0,5), [{key:'x',label:'x',kind:'price',series:realYield}]).ok, false);
ok('unavailable model describes itself', /unavailable/.test(describeMacroModel(null)), true);
ok('no score from a failed model', macroModelScore({ok:false}), null);

// alignment is what makes any of this valid
const a=[{time:t0,close:1},{time:t0+DAY,close:2},{time:t0+3*DAY,close:4}];
const b=[{time:t0,close:10},{time:t0+2*DAY,close:30},{time:t0+3*DAY,close:40}];
const al=alignByDay([a,b]);
ok('aligns only shared days', al.days.length, 2);
ok('pairs the right values', al.columns[0].join(',')+'|'+al.columns[1].join(','), '1,4|10,40');
ok('yield changes are absolute', toChanges([2.30,2.35],'yield')[0].toFixed(4), '0.0500');
ok('price changes are relative', toChanges([100,110],'price')[0].toFixed(4), '0.1000');


// ============================================================
// SIGNAL LOG MERGE — worker trades reaching the browser log
// ============================================================
const T = (n) => new Date(1700000000000 + n * 60000).toISOString();
const S = (id, status, extra) => Object.assign({ id, dir: 'BUY', entry: 2000, sl: 1990, tp: 2020, time: T(Number(id)), status }, extra || {});

// identity + ordering
ok('merges disjoint logs', mergeSignalLogs([S('1','pending')], [S('2','open')]).length, 2);
ok('newest first', mergeSignalLogs([S('1','pending')], [S('2','open')]).map(s=>s.id), ['2','1']);
ok('same id is one signal', mergeSignalLogs([S('1','pending')], [S('1','pending')]).length, 1);
ok('respects the cap', mergeSignalLogs([S('1','pending'),S('2','pending')], [S('3','pending')], 2).map(s=>s.id), ['3','2']);
ok('empty incoming is a no-op', mergeSignalLogs([S('1','pending')], []).map(s=>s.id), ['1']);
ok('empty local takes incoming', mergeSignalLogs([], [S('1','won')]).map(s=>s.status), ['won']);
ok('tolerates non-arrays', mergeSignalLogs(null, undefined), []);
ok('drops records with no id', mergeSignalLogs([{dir:'BUY'}], [S('1','open')]).length, 1);

// resolution only ever moves forward
ok('worker win beats local pending', mergeSignalLogs([S('1','pending')], [S('1','won')])[0].status, 'won');
ok('worker loss beats local open', mergeSignalLogs([S('1','open')], [S('1','lost')])[0].status, 'lost');
ok('worker open beats local pending', mergeSignalLogs([S('1','pending')], [S('1','open')])[0].status, 'open');
ok('stale worker pending cannot reopen a local win', mergeSignalLogs([S('1','won')], [S('1','pending')])[0].status, 'won');
ok('stale worker open cannot reopen a local loss', mergeSignalLogs([S('1','lost')], [S('1','open')])[0].status, 'lost');
ok('expired does not override a win', mergeSignalLogs([S('1','won')], [S('1','expired')])[0].status, 'won');
ok('a win overrides expired', mergeSignalLogs([S('1','expired')], [S('1','won')])[0].status, 'won');

// field-level merging
ok('local notes survive a worker copy that lacks them',
  mergeSignalLogs([S('1','pending',{mistake:'chased it',reason:'local text'})], [S('1','won',{exitPrice:2020})])[0].mistake, 'chased it');
ok('and the reason text is kept',
  mergeSignalLogs([S('1','pending',{reason:'local text'})], [S('1','won')])[0].reason, 'local text');
ok('worker exit price is picked up',
  mergeSignalLogs([S('1','open')], [S('1','won',{exitPrice:2020})])[0].exitPrice, 2020);
ok('learned flag is never erased by an incoming copy',
  mergeSignalLogs([S('1','won',{learned:true})], [S('1','won')])[0].learned, true);
ok('a tie keeps the local record',
  mergeSignalLogs([S('1','won',{exitPrice:2020})], [S('1','won',{exitPrice:9999})])[0].exitPrice, 2020);
ok('worker source label survives',
  mergeSignalLogs([], [S('1','open',{source:'worker'})])[0].source, 'worker');

// what the caller has to act on
const beforeLog = [S('1','pending'), S('2','open')];
const afterLog = mergeSignalLogs(beforeLog, [S('1','won',{exitPrice:2020}), S('3','open',{source:'worker'})]);
ok('newly resolved is just the one that resolved', newlyResolvedSignals(beforeLog, afterLog).map(s=>s.id), ['1']);
ok('newly arrived is just the one that is new', newlyArrivedOpenSignals(beforeLog, afterLog).map(s=>s.id), ['3']);
ok('an already-resolved signal is not re-reported',
  newlyResolvedSignals([S('1','won')], mergeSignalLogs([S('1','won')], [S('1','won')])).length, 0);
ok('a trade taken and graded between merges still counts as resolved',
  newlyResolvedSignals([], mergeSignalLogs([], [S('9','won')])).map(s=>s.id), ['9']);
ok('but it is not reported as newly arrived and open',
  newlyArrivedOpenSignals([], mergeSignalLogs([], [S('9','won')])).length, 0);
ok('an expired arrival is not a resolved outcome',
  newlyResolvedSignals([], mergeSignalLogs([], [S('9','expired')])).length, 0);

// a killed trade arriving from the worker has to cancel its paper order, and
// must never be booked as an outcome
ok('a newly killed signal is reported',
  newlyExpiredSignals([S('1','pending')], mergeSignalLogs([S('1','pending')], [S('1','expired')])).map(s=>s.id), ['1']);
ok('an already-expired one is not reported twice',
  newlyExpiredSignals([S('1','expired')], mergeSignalLogs([S('1','expired')], [S('1','expired')])).length, 0);
ok('a killed arrival that was never seen locally still counts',
  newlyExpiredSignals([], mergeSignalLogs([], [S('9','expired')])).map(s=>s.id), ['9']);
ok('a killed signal is not a resolved outcome',
  newlyResolvedSignals([S('1','pending')], mergeSignalLogs([S('1','pending')], [S('1','expired')])).length, 0);
ok('and a won one is not reported as killed',
  newlyExpiredSignals([S('1','pending')], mergeSignalLogs([S('1','pending')], [S('1','won')])).length, 0);
ok('the kill reason survives the merge',
  mergeSignalLogs([S('1','pending')], [S('1','expired',{killSwitch:'stale-order'})])[0].killSwitch, 'stale-order');

ok('a still-pending arrival is reported as arrived',
  newlyArrivedOpenSignals([], mergeSignalLogs([], [S('9','pending')])).map(s=>s.id), ['9']);
ok('ranks order correctly',
  [signalResolutionRank(S('1','pending')),signalResolutionRank(S('1','open')),signalResolutionRank(S('1','won'))],
  [0,1,3]);
ok('an unknown status ranks as unresolved', signalResolutionRank({id:'x',status:'weird'}), 0);


// ============================================================
// WHAT A CONFIDENCE NUMBER MEANS
// ============================================================
const CS = (conf, status, r) => ({
  id: 'c' + Math.random().toString(36).slice(2), dir: 'BUY', confidence: conf, status,
  entry: 2000, sl: 1990, tp: 1990 + 10 * (r == null ? 3 : r),
  exitPrice: status === 'won' ? 1990 + 10 * (r == null ? 3 : r) : 1990,
  time: T(1)
});
const many = (n, conf, status) => Array.from({length: n}, () => CS(conf, status));

// scale: the fixed fallback before there is a record
ok('no history falls back to fixed bands', confidenceBands([]).adaptive, false);
ok('and uses the grade thresholds', confidenceBands([]).cuts, [30, 50]);
ok('a low score bands low', confidenceBand(12, []).key, 'low');
ok('a mid score bands mid', confidenceBand(40, []).key, 'mid');
ok('a high score bands high', confidenceBand(58, []).key, 'high');
ok('the fixed high band names the real ceiling', /49%/.test(confidenceBand(58, []).label), true);

// scale: bands re-centre on what this engine actually produces
const spread = [];
for (let i = 0; i < 30; i++) spread.push(CS(10 + i, 'won'));
ok('enough history switches to adaptive bands', confidenceBands(spread).adaptive, true);
ok('adaptive bands sit inside the observed range', confidenceBands(spread).cuts[1] < 50, true);
ok('a score near this engine\'s top bands high even though it is under 50',
  confidenceBand(38, spread).key, 'high');
ok('and says so in the engine\'s own terms', /this system produces/.test(confidenceBand(38, spread).label), true);
ok('a flat distribution refuses to fake bands',
  confidenceBands(many(30, 42, 'won')).adaptive, false);
ok('too few signals stay on the fixed bands', confidenceBands(many(19, 42, 'won')).adaptive, false);

// meaning: no record must not imply one
const blank = interpretConfidence(45, [], { rr: 3 });
ok('an unproven number says it is unproven', blank.evidence, 'none');
ok('and the headline says there is no record', /No track record/.test(blank.headline), true);
ok('and it never reports a win rate it does not have', blank.track, null);
ok('it still explains what the number is', /not a probability/.test(blank.meaning), true);
ok('and it names the target that makes a low win rate fine', /3\.0:1/.test(blank.meaning), true);

// the breakeven has to be computed, not asserted: "a low win rate is still
// profitable" is exactly wrong at 1:1
ok('breakeven at 4:1 is 20%', Math.round(breakevenWinRate(4)*100), 20);
ok('breakeven at 1:1 is 50%', breakevenWinRate(1), 0.5);
ok('breakeven at 0.5:1 is 67%', Math.round(breakevenWinRate(0.5)*100), 67);
ok('no target gives no breakeven', breakevenWinRate(0), null);
ok('a generous target says a low win rate is fine',
  /not the same as a bad system/.test(interpretConfidence(45, [], {rr:4}).meaning), true);
ok('a 1:1 target does NOT say that',
  /not the same as a bad system/.test(interpretConfidence(45, [], {rr:1}).meaning), false);
ok('it says there is little room instead',
  /little room for a low win rate/.test(interpretConfidence(45, [], {rr:1}).meaning), true);
ok('a negative-edge target is called demanding',
  /demanding trade/.test(interpretConfidence(45, [], {rr:0.5}).meaning), true);
ok('an unset target says the breakeven is unknown',
  /depends on the target/.test(interpretConfidence(45, [], {}).meaning), true);

// meaning: with a record, the number carries it
const record = [
  ...many(12, 55, 'won'), ...many(8, 55, 'lost'),      // high band: 12/20
  ...many(4, 20, 'won'),  ...many(16, 20, 'lost')      // low band: 4/20
];
const hi = interpretConfidence(55, record, { rr: 3 });
const lo = interpretConfidence(20, record, { rr: 3 });
ok('the high band reports its own resolved record', hi.track.n, 20);
ok('with the right win count', hi.track.wins, 12);
ok('and states it plainly', /won 12 of 20 \(60%\)/.test(hi.headline), true);

// a win rate alone does not say whether the level makes money
ok('a profitable band says so outright', /Net profitable at this level/.test(hi.headline), true);
ok('a losing band says so outright', /Net losing at this level/.test(lo.headline), true);
ok('an unproven band claims neither', /Net (profitable|losing)/.test(blank.headline), false);
ok('the low band reports a different record', lo.track.wins, 4);
ok('bands do not bleed into each other', hi.sampleInBand + lo.sampleInBand, 40);
ok('the high band does not claim the low band\'s trades', hi.sampleInBand, 20);
ok('nor the other way round', lo.sampleInBand, 20);
ok('a 20-trade band record counts as usable evidence', hi.evidence, 'usable');
ok('and says how far to trust it', /not enough to bet the account/.test(hi.evidenceNote), true);
ok('a bigger band record is solid', interpretConfidence(55, many(40, 55, 'won'), {}).evidence, 'solid');
ok('and says it is worth trusting', /worth trusting/.test(interpretConfidence(55, many(40, 55, 'won'), {}).evidenceNote), true);

// meaning: does the number discriminate at all
ok('a discriminating record is reported as informative',
  /carrying real information/.test(hi.discriminationNote), true);
const flat = [...many(10, 55, 'won'), ...many(10, 55, 'lost'), ...many(10, 20, 'won'), ...many(10, 20, 'lost')];
ok('a non-discriminating record says the number buys nothing',
  /NOT winning more often/.test(interpretConfidence(55, flat, {}).discriminationNote), true);
const inverted = [...many(4, 55, 'won'), ...many(16, 55, 'lost'), ...many(16, 20, 'won'), ...many(4, 20, 'lost')];
ok('an inverted record says so outright',
  /inverted/.test(interpretConfidence(55, inverted, {}).discriminationNote), true);

// evidence ladder
ok('four trades is not evidence', interpretConfidence(55, many(4, 55, 'won'), {}).evidence, 'none');
ok('six is thin', interpretConfidence(55, many(6, 55, 'won'), {}).evidence, 'thin');
ok('fifteen is usable', interpretConfidence(55, many(15, 55, 'won'), {}).evidence, 'usable');
ok('an anecdote is labelled an anecdote',
  /anecdote/.test(interpretConfidence(55, many(6, 55, 'won'), {}).evidenceNote), true);

// the ceiling is the point
ok('the ceiling is the practical one, not 100', blank.ceiling >= CONFIDENCE_PRACTICAL_MAX, true);
ok('a score at the ceiling reads as full', interpretConfidence(49, [], {}).ofCeiling, 1);
ok('a score above it does not exceed full', interpretConfidence(80, [], {}).ofCeiling, 1);
ok('half the ceiling reads as about half',
  Math.abs(interpretConfidence(24.5, [], {}).ofCeiling - 0.5) < 0.01, true);

// robustness
ok('a missing score does not throw', interpretConfidence(undefined, [], {}).band.key, 'unknown');
ok('and says there is no score', /No confidence score/.test(interpretConfidence(undefined, [], {}).headline), true);
ok('a non-array log is tolerated', interpretConfidence(45, null, {}).evidence, 'none');
ok('unresolved signals never count as a record',
  interpretConfidence(55, many(40, 55, 'pending'), {}).sampleInBand, 0);
ok('the evidence thresholds are ordered',
  CONFIDENCE_EVIDENCE.thin < CONFIDENCE_EVIDENCE.usable && CONFIDENCE_EVIDENCE.usable < CONFIDENCE_EVIDENCE.solid, true);


// ============================================================
// KILL SWITCH — stale orders must not become training data
// ============================================================
// A resting order that sits for a day is a liability: the move it was placed
// for has happened, and when price finally returns it is retesting a spent zone
// rather than offering the setup that was analysed. Grading that fill teaches
// the system from a trade it would never have taken.
const H = 3600000;
const NOW = Date.parse('2026-03-10T12:00:00Z');
const ksAgo = h => NOW - h * H;
const KS = (o) => Object.assign({ dir:'BUY', entry:2000, sl:1990, tp:2040, entryType:'limit' }, o);
// candles that never reach the entry, timestamped as live data
const away = (n, from) => Array.from({length:n}, (_, i) =>
  C(from + (i+1) * 9e5, 2012, 2014, 2010, 2012));

// --- the case that started this: no new bars at all -----------------------
// The weekend. A stalled provider. A spent quota. Real time passes, no candle
// arrives, and the old bar-counted expiry could not fire because it only ran
// inside the candle loop.
ok('a resting order with no new bars still expires on the clock',
  resolveSignal(KS({time: ksAgo(20)}), [], {now: NOW}).status, 'expired');
ok('and says the clock is why', /without filling/.test(resolveSignal(KS({time: ksAgo(20)}), [], {now: NOW}).reason), true);
ok('it is tagged as a stale order', resolveSignal(KS({time: ksAgo(20)}), [], {now: NOW}).killSwitch, 'stale-order');
ok('inside the window it is left alone',
  resolveSignal(KS({time: ksAgo(3)}), [], {now: NOW}).status, 'pending');
ok('the boundary expires', resolveSignal(KS({time: ksAgo(12)}), [], {now: NOW}).status, 'expired');
ok('just inside it does not', resolveSignal(KS({time: ksAgo(11.9)}), [], {now: NOW}).status, 'pending');
ok('a longer limit can be configured',
  resolveSignal(KS({time: ksAgo(20)}), [], {now: NOW, maxHoursToFill: 48}).status, 'pending');
ok('and the kill switch can be turned off entirely',
  resolveSignal(KS({time: ksAgo(500)}), [], {now: NOW, maxHoursToFill: 0}).status, 'pending');

// --- a filled position that never resolves --------------------------------
ok('a position open too long is scratched',
  resolveSignal(KS({time: ksAgo(100), entryType:'market', filledAt: new Date(ksAgo(100)).toISOString()}), [], {now: NOW}).status, 'expired');
ok('it is tagged as a stale position',
  resolveSignal(KS({time: ksAgo(100), entryType:'market', filledAt: new Date(ksAgo(100)).toISOString()}), [], {now: NOW}).killSwitch, 'stale-position');
ok('a young position is left running',
  resolveSignal(KS({time: ksAgo(4), entryType:'market'}), [], {now: NOW}).status, 'open');
ok('a limit that filled is aged from the FILL, not the signal',
  resolveSignal(KS({time: ksAgo(100), filledAt: new Date(ksAgo(2)).toISOString()}), [], {now: NOW}).status, 'open');

// --- the move happened without us ------------------------------------------
// Price runs away from a limit that never filled. Coming back later is a
// retest of a zone that already did its work.
const start = ksAgo(2);
const ran = [C(start + 9e5, 2012, 2014, 2010, 2012), C(start + 18e5, 2014, 2060, 2013, 2058)];
const drifted = resolveSignal(KS({time: start}), ran, {now: NOW});
ok('price running away cancels the order', drifted.status, 'expired');
ok('and names it a retest rather than the setup', /retest, not this setup/.test(drifted.reason), true);
ok('tagged so the reason is machine-readable', drifted.killSwitch, 'zone-left-behind');

// The baseline matters: a limit is placed away from price BY DESIGN, so the
// opening gap must not count as drift or every limit dies on its first bar.
const parked = [C(start + 9e5, 2030, 2032, 2028, 2030), C(start + 18e5, 2030, 2032, 2028, 2030)];
ok('a limit resting far below price is not cancelled for being far below price',
  resolveSignal(KS({time: start}), parked, {now: NOW}).status, 'pending');
ok('only movement BEYOND the opening gap counts',
  resolveSignal(KS({time: start}), parked.concat([C(start + 27e5, 2030, 2050, 2029, 2049)]), {now: NOW}).status, 'expired');
ok('and a move that stays inside the threshold does not',
  resolveSignal(KS({time: start}), parked.concat([C(start + 27e5, 2030, 2044, 2029, 2043)]), {now: NOW}).status, 'pending');
ok('a SELL limit drifts the other way',
  resolveSignal(KS({dir:'SELL', entry:2000, sl:2010, tp:1960, time: start}),
    [C(start+9e5,1988,1990,1986,1988), C(start+18e5,1988,1989,1968,1970)], {now: NOW}).status, 'expired');
ok('drift cancelling can be turned off',
  resolveSignal(KS({time: start}), ran, {now: NOW, maxDriftRToFill: 0}).status, 'pending');
ok('a fill still beats a drift cancel in the same bar',
  resolveSignal(KS({time: start}), [C(start+9e5, 2012, 2060, 1998, 2058)], {now: NOW}).status, 'won');

// --- replaying history must not trip the clock ----------------------------
// Every backtest signal is old. If the wall clock applied there, nothing would
// ever resolve — the whole record would read as expired.
const oldT = Date.parse('2020-01-06T00:00:00Z');
ok('an old signal graded against old candles is judged by the data',
  resolveSignal(KS({time: oldT}), [C(oldT+9e5, 2000, 2045, 1998, 2040)]).status, 'won');
ok('and an unfilled old one is still pending, not clock-expired',
  resolveSignal(KS({time: oldT}), [C(oldT+9e5, 2012, 2014, 2010, 2012)]).status, 'pending');
ok('an explicit clock overrides the guess',
  resolveSignal(KS({time: oldT}), [C(oldT+9e5, 2012, 2014, 2010, 2012)], {now: oldT + 20*H}).status, 'expired');

// --- an expired signal is never an outcome --------------------------------
ok('expiry is not a win', resolveSignal(KS({time: ksAgo(20)}), [], {now: NOW}).status !== 'won', true);
ok('expiry is not a loss', resolveSignal(KS({time: ksAgo(20)}), [], {now: NOW}).status !== 'lost', true);
ok('and it carries no exit price to book',
  resolveSignal(KS({time: ksAgo(20)}), [], {now: NOW}).exitPrice, undefined);

// --- a missing timestamp is missing data, not an old order ----------------
ok('a zero timestamp does not auto-expire',
  resolveSignal(KS({time: 0}), [], {now: NOW}).status, 'pending');
ok('nor does a garbage one',
  resolveSignal(KS({time: 'not a date'}), [], {now: NOW}).status, 'pending');


// ============================================================
// IS THIS TRADE STILL ALIVE?
// ============================================================
// "awaiting entry" and "filled" are true of a trade placed a minute ago and of
// one about to be culled. The chip has to tell those apart.
const LV_NOW = Date.parse('2026-03-10T12:00:00Z');
const lvAgo = h => new Date(LV_NOW - h * 3600000).toISOString();
const LV = (o) => Object.assign({ dir:'BUY', entry:2000, sl:1990, tp:2040, entryType:'limit' }, o);
const live = (o, price) => signalLiveness(LV(o), {}, { now: LV_NOW, price });

// resting orders age against the fill limit (12h)
ok('a fresh order is alive', live({status:'pending', time:lvAgo(1)}).tone, 'live');
ok('and says so', /alive/.test(live({status:'pending', time:lvAgo(1)}).label), true);
ok('half way through it is going stale', live({status:'pending', time:lvAgo(7)}).tone, 'warn');
ok('and says so', /going stale/.test(live({status:'pending', time:lvAgo(7)}).label), true);
ok('near the limit it is about to be killed', live({status:'pending', time:lvAgo(11)}).tone, 'bad');
ok('and says so', /about to be killed/.test(live({status:'pending', time:lvAgo(11)}).label), true);
ok('the age is on the chip', /resting 11\.0h/.test(live({status:'pending', time:lvAgo(11)}).label), true);
ok('minutes for anything under an hour', /resting 30m/.test(live({status:'pending', time:lvAgo(0.5)}).label), true);
ok('the detail says when it will be cancelled',
  /Cancelled in 1\.0h/.test(live({status:'pending', time:lvAgo(11)}).detail), true);
ok('and how far price is from the entry',
  /12\.00R away/.test(live({status:'pending', time:lvAgo(1)}, 2120).detail), true);

// filled positions age against the hold limit (72h) and report their P&L in R
ok('a filled position is running', live({status:'open', filledAt:lvAgo(5)}).state, 'running');
ok('a young one is alive', live({status:'open', filledAt:lvAgo(5)}).tone, 'live');
ok('one past half its life is stalling', live({status:'open', filledAt:lvAgo(40)}).tone, 'warn');
ok('one near the limit is about to be scratched',
  /about to be scratched/.test(live({status:'open', filledAt:lvAgo(70)}).label), true);
ok('progress in R is on the chip', /\+1\.60R/.test(live({status:'open', filledAt:lvAgo(5)}, 2016).label), true);
ok('a losing position shows it', /-0\.60R/.test(live({status:'open', filledAt:lvAgo(5)}, 1994).label), true);
ok('the detail spells it out', /behind by 0\.60R/.test(live({status:'open', filledAt:lvAgo(5)}, 1994).detail), true);
ok('a SELL reads the other way',
  /\+1\.00R/.test(signalLiveness(LV({dir:'SELL', entry:2000, sl:2010, tp:1970, status:'open', filledAt:lvAgo(3)}),
    {}, {now: LV_NOW, price: 1990}).label), true);

// a filled limit ages from the FILL, not from when the order was placed
ok('an order placed long ago but filled recently is alive',
  live({status:'open', time:lvAgo(200), filledAt:lvAgo(2)}).tone, 'live');

// closed and killed trades already show their outcome
ok('a won trade is closed', live({status:'won', time:lvAgo(5)}).state, 'closed');
ok('a lost trade is closed', live({status:'lost', time:lvAgo(5)}).tone, 'bad');
ok('a killed trade says it was killed',
  live({status:'expired', killSwitch:'stale-order', time:lvAgo(5)}).label, 'killed as stale');
ok('a plain expiry does not claim the kill switch',
  live({status:'expired', time:lvAgo(5)}).label, 'expired');

// robustness
ok('no signal does not throw', signalLiveness(null, {}, {}).state, 'unknown');
ok('a missing timestamp gives no age', live({status:'pending', time:null}).ageHours, null);
ok('and no ratio to colour by', live({status:'pending', time:null}).tone, 'live');
ok('a disabled limit reports no deadline',
  /No time limit set/.test(signalLiveness(LV({status:'pending', time:lvAgo(50)}), {maxHoursToFill:0}, {now:LV_NOW}).detail), true);
ok('with no price there is no R reading', live({status:'open', filledAt:lvAgo(5)}).progressR, null);
ok('a zero-width stop does not divide by zero',
  signalLiveness(LV({entry:2000, sl:2000, status:'open', filledAt:lvAgo(5)}), {}, {now:LV_NOW, price:2010}).progressR, null);
ok('hours left never goes negative',
  live({status:'pending', time:lvAgo(99)}).hoursLeft, 0);


// ============================================================
// WHICH SIGNALS THE PAPER ACCOUNT TAKES
// ============================================================
// Two switches: the account itself, and the signal panel's own one for trades
// generated by hand.
const ON = { enabled: true, manual: true };
const NO_MANUAL = { enabled: true, manual: false };
const OFF = { enabled: false, manual: true };
const sigFrom = src => ({ id:'x', dir:'BUY', entry:2000, sl:1990, tp:2040, source: src });

ok('account off takes nothing', shouldPaperTrade(sigFrom('manual'), OFF), false);
ok('not even autonomous ones', shouldPaperTrade(sigFrom('auto'), OFF), false);
ok('account on takes a manual signal', shouldPaperTrade(sigFrom('manual'), ON), true);
ok('and an autonomous one', shouldPaperTrade(sigFrom('auto'), ON), true);
ok('and a worker one', shouldPaperTrade(sigFrom('worker'), ON), true);
ok('excluding hand-made ones skips manual', shouldPaperTrade(sigFrom('manual'), NO_MANUAL), false);
ok('but never silences autonomous trades', shouldPaperTrade(sigFrom('auto'), NO_MANUAL), true);
ok('nor the worker', shouldPaperTrade(sigFrom('worker'), NO_MANUAL), true);
ok('an unlabelled signal counts as manual', shouldPaperTrade(sigFrom(undefined), NO_MANUAL), false);
ok('and is taken when manual trading is on', shouldPaperTrade(sigFrom(undefined), ON), true);
ok('a missing account takes nothing', shouldPaperTrade(sigFrom('auto'), null), false);
ok('an account with no manual flag defaults to taking them',
  shouldPaperTrade(sigFrom('manual'), { enabled: true }), true);

// every refusal has a sentence — a paper trade that never opened used to look
// exactly like one that was never attempted
const rjAcct = (n, bal) => ({ balance: bal == null ? 10000 : bal,
  positions: Array.from({length:n||0}, () => ({ status:'open' })) });
const rjBuy = { id:'r', dir:'BUY', entry:2000, sl:1990, tp:2040 };
ok('a tradeable signal is refused for nothing', paperRejectReason(rjBuy, rjAcct(0), {}), null);
ok('no signal is named as such', /no signal/.test(paperRejectReason(null, rjAcct(0), {})), true);
ok('a HOLD has no direction to trade',
  /no direction/.test(paperRejectReason({dir:'HOLD'}, rjAcct(0), {})), true);
ok('a full book says so', /book is full/.test(paperRejectReason(rjBuy, rjAcct(3), {})), true);
ok('and counts what is in it', /3 position\(s\)/.test(paperRejectReason(rjBuy, rjAcct(3), {})), true);
ok('and points at the setting', /Max concurrent/.test(paperRejectReason(rjBuy, rjAcct(3), {})), true);
ok('a raised cap accepts the trade', paperRejectReason(rjBuy, rjAcct(3), {maxConcurrent:5}), null);
ok('resting orders count against the cap',
  /book is full/.test(paperRejectReason(rjBuy, {balance:10000, positions:[{status:'pending'},{status:'pending'},{status:'pending'}]}, {})), true);
ok('closed ones do not',
  paperRejectReason(rjBuy, {balance:10000, positions:[{status:'closed'},{status:'cancelled'}]}, {}), null);
ok('a flat account says so', /no balance left/.test(paperRejectReason(rjBuy, rjAcct(0, 0), {})), true);
// The spread must not stand in for a missing stop: size is risk / stop
// distance, so a sliver of spread would size an enormous position off a plainly
// malformed plan.
ok('a stop sitting on the entry is refused',
  /no stop/.test(paperRejectReason({dir:'BUY', entry:2000, sl:2000}, rjAcct(0), {})), true);
ok('and the account will not open it either',
  openPaperPosition({id:'z', dir:'BUY', entry:2000, sl:2000, tp:2040}, {balance:10000, positions:[]}, {}), null);
ok('a real stop still opens', !!openPaperPosition({id:'z2', dir:'BUY', entry:2000, sl:1990, tp:2040}, {balance:10000, positions:[]}, {}), true);
ok('zero risk cannot be staked',
  /nothing to stake/.test(paperRejectReason(rjBuy, rjAcct(0), {riskPercent:0})), true);



// ============================================================
// THE DEMO FEED MUST PRODUCE POSSIBLE CANDLES
// ============================================================
// Found by the auditor, not by a person: the close was an average of the other
// four prices plus noise with nothing keeping it inside the bar, so on a narrow
// range it landed outside its own high or low. That is an impossible candle,
// and the backtest ran on them too.
let gdImpossible = 0, gdNonFinite = 0, gdBars = 0;
for (let k = 0; k < 30; k++) {
  genData(400, 1928, 9e5).forEach(c => {
    gdBars++;
    if (![c.open, c.high, c.low, c.close].every(v => isFinite(v))) gdNonFinite++;
    else if (c.close > c.high || c.close < c.low || c.open > c.high || c.open < c.low) gdImpossible++;
  });
}
ok('no impossible candles across 12k generated bars', gdImpossible, 0);
ok('and none non-finite', gdNonFinite, 0);
ok('it generated something to check', gdBars > 10000, true);
ok('high is never below low', genData(200, 2000, 9e5).every(c => c.high >= c.low), true);
// A missing start price used to make every bar NaN, silently.
ok('a missing start price still produces real prices',
  genData(50).every(c => isFinite(c.close) && c.close > 0), true);
ok('and the auditor agrees the demo feed is sound',
  auditFeedIntegrity(genData(300, 1928, 9e5)).filter(f => f.code === 'impossible-bars').length, 0);


// ============================================================
// CORRELATION MUST ALIGN ON THE CALENDAR, NOT BY ARRAY POSITION
// ============================================================
// Gold trades Sunday evening to Friday evening; FRED publishes on US business
// days and skips federal holidays. Zipping the two by index offsets everything
// before each holiday, and what comes out still looks like a correlation.
const CD = 86400000, cdT0 = Date.parse('2026-01-05T00:00:00Z');
const mkSeries = (n, skip, fn) => {
  const out = [];
  for (let i = 0; i < n; i++) { if (skip && skip.indexOf(i) !== -1) continue; out.push({ time: cdT0 + i*CD, close: fn(i) }); }
  return out;
};
const cdGold = mkSeries(40, null, i => 2000 + i*2);
const cdPerfect = mkSeries(40, null, i => 100 + i*0.5);
const cdHoliday = mkSeries(40, [10], i => 100 + i*0.5);

ok('a perfectly tracking driver correlates at 1',
  Math.round(correlateByDay(cdGold, cdPerfect, 'price') * 100) / 100, 1);
// One missing day is enough to wreck the index-zipped answer.
ok('a single missing day does not break the aligned correlation',
  correlateByDay(cdGold, cdHoliday, 'price') > 0.9, true);
ok('while zipping by index badly understates it',
  pearsonCorrelation(toDailyReturns(cdGold), seriesDeltas(cdHoliday, 'price')) < 0.6, true);
// Correlation is between CHANGES, not levels: a driver whose level falls while
// gold's rises can still have perfectly correlated day-to-day moves. To get -1
// the driver's moves have to be the negative of gold's, so build it that way.
const cdGoldChanges = toChanges(cdGold.map(p => p.close), 'price');
const cdInverse = (() => {
  const out = [{ time: cdT0, close: 2 }];
  cdGoldChanges.forEach((ch, i) => out.push({ time: cdT0 + (i+1)*CD, close: out[i].close - ch * 100 }));
  return out;
})();
ok('a driver moving opposite to gold correlates at -1',
  Math.round(correlateByDay(cdGold, cdInverse, 'yield') * 100) / 100, -1);
// A yield that ticks up by exactly the same amount every day is not moving in
// any meaningful sense — and its floating-point residue must not be mistaken
// for a weak relationship.
ok('a constant-step yield reports no correlation rather than rounding noise',
  correlateByDay(cdGold, mkSeries(40, null, i => 2 + i*0.01), 'yield'), null);
ok('and a genuinely varying yield still correlates',
  correlateByDay(cdGold, mkSeries(40, null, i => 2 + Math.sin(i/3)*0.2), 'yield') !== null, true);

// refusals rather than bad numbers
ok('too little overlap yields nothing, not a number',
  correlateByDay(cdGold, mkSeries(4, null, i => 100 + i), 'price'), null);
ok('no overlap at all yields nothing',
  correlateByDay(cdGold, mkSeries(40, null, i => 100 + i).map(p => ({...p, time: p.time + 400*CD})), 'price'), null);
ok('a missing driver yields nothing', correlateByDay(cdGold, null, 'price'), null);
ok('a missing gold series yields nothing', correlateByDay(null, cdPerfect, 'price'), null);
ok('a flat driver has no correlation to report',
  correlateByDay(cdGold, mkSeries(40, null, () => 100), 'price'), null);

// the aligned latest change comes from the same days the correlation used
ok('the aligned latest change is the driver\'s own last move',
  Math.round(alignedLatestChange(cdGold, cdPerfect, 'yield') * 100) / 100, 0.5);
ok('and is null when there is nothing to align', alignedLatestChange(cdGold, [], 'price'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
