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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
