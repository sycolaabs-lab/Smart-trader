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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
