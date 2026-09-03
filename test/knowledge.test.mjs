// Accumulated knowledge: does understanding actually strengthen with evidence,
// does a fading relationship get caught, and is genuinely new territory flagged
// rather than confidently extrapolated?
import { emptyKnowledge, recordObservation, assessKnowledge, detectNovelty,
         describeKnowledge, KNOWLEDGE_DEFAULTS } from '../lib/knowledge.js';

let pass=0, fail=0;
const ok=(n,a,e)=>{const g=JSON.stringify(a)===JSON.stringify(e);console.log((g?'PASS':'FAIL')+' '+n+(g?'':`  got=${JSON.stringify(a)} want=${JSON.stringify(e)}`));g?pass++:fail++;};

let seed=11; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff-0.5;};
const SPECS=[{key:'ry',label:'Real Yield',kind:'yield'},{key:'nz',label:'Noise',kind:'price'}];

// build a store where gold genuinely responds to `ry` and ignores `nz`
function build(days, betaRy){
  let s=emptyKnowledge();
  for(let d=0; d<days; d++){
    const ry=rnd()*0.05, nz=rnd()*0.02;
    s=recordObservation(s,{day:20000+d, gold: betaRy*ry + 0.0005*rnd(), drivers:{ry,nz}});
  }
  return s;
}

console.log('-- accumulation --');
let store=emptyKnowledge();
ok('starts empty', store.rows.length, 0);
store=recordObservation(store,{day:1,gold:0.01,drivers:{ry:0.02}});
ok('records an observation', store.rows.length, 1);
store=recordObservation(store,{day:1,gold:0.02,drivers:{ry:0.03}});
ok('same day REPLACES, never stacks', store.rows.length, 1);
ok('and keeps the newer value', store.rows[0].gold, 0.02);
store=recordObservation(store,{day:2,gold:0.01,drivers:{ry:0.01}});
ok('a new day appends', store.rows.length, 2);
ok('remembers when a driver was first seen', store.firstSeen.ry, 1);
ok('ignores a malformed observation', recordObservation(store,{day:NaN,gold:1}).rows.length, 2);
ok('caps the record', build(60,-1).rows.length <= KNOWLEDGE_DEFAULTS.maxObservations, true);

console.log('\n-- understanding strengthens with evidence --');
const young = assessKnowledge(build(20,-1), SPECS);
ok('makes no claim on 20 observations', young.ok, false);
ok('and says it is still watching', /still watching/.test(young.reason), true);
ok('drivers marked watching', young.drivers[0].maturity, 'watching');

const mid = assessKnowledge(build(60,-1), SPECS);
ok('fits once there is enough', mid.ok, true);
const ryMid = mid.drivers.find(d=>d.key==='ry');
ok('real driver is at least emerging', ['emerging','established'].includes(ryMid.maturity), true);

const mature = assessKnowledge(build(400,-1), SPECS);
const ryM = mature.drivers.find(d=>d.key==='ry');
const nzM = mature.drivers.find(d=>d.key==='nz');
ok('becomes established with more evidence', ryM.maturity, 'established');
ok('sign is right', ryM.beta < 0, true);
ok('noise never becomes established', nzM.maturity === 'established', false);
ok('counts what is established', mature.established, 1);
ok('reports observation count', mature.usable, 400);

console.log('\n-- a relationship that stops working --');
// strong for the first half, gone in the second
let fading=emptyKnowledge();
for(let d=0;d<400;d++){
  const ry=rnd()*0.05, nz=rnd()*0.02;
  const b = d<200 ? -2.0 : -0.05;         // effect nearly disappears
  fading=recordObservation(fading,{day:30000+d, gold: b*ry + 0.0005*rnd(), drivers:{ry,nz}});
}
const fa = assessKnowledge(fading, SPECS).drivers.find(d=>d.key==='ry');
ok('detects the effect fading', fa.trend, 'fading');
ok('downgrades it from established', fa.maturity, 'decaying');
ok('keeps both halves for inspection', Math.abs(fa.earlyBeta) > Math.abs(fa.lateBeta), true);

// one that reverses sign outright
let flip=emptyKnowledge();
for(let d=0;d<400;d++){
  const ry=rnd()*0.05, nz=rnd()*0.02;
  const b = d<200 ? -2.0 : 2.0;
  flip=recordObservation(flip,{day:40000+d, gold: b*ry + 0.0005*rnd(), drivers:{ry,nz}});
}
const fl = assessKnowledge(flip, SPECS).drivers.find(d=>d.key==='ry');
ok('detects a reversal', fl.trend, 'reversed');
ok('marks it unstable', fl.maturity, 'unstable');

console.log('\n-- novelty: knowing when today is unlike the record --');
const known = build(300,-1);
ok('ordinary conditions are not novel', detectNovelty(known,{ry:0.01,nz:0.005}).novel, false);
const shock = detectNovelty(known,{ry:0.9,nz:0.005});
ok('an extreme move is flagged novel', shock.novel, true);
ok('and names the driver', shock.unusual[0].key, 'ry');
ok('explains it is extrapolating', /extrapolated/.test(shock.reason), true);
ok('no baseline yet is honest', detectNovelty(emptyKnowledge(),{ry:0.5}).novel, false);
ok('...and says why', /not enough history/.test(detectNovelty(emptyKnowledge(),{ry:0.5}).reason), true);

console.log('\n-- description --');
const desc = describeKnowledge(mature);
ok('states how much it is built from', /accumulated daily observations/.test(desc), true);
ok('names what is established', /Established:/.test(desc), true);
ok('young store describes itself honestly', /still watching/.test(describeKnowledge(young)), true);
ok('fading store reports weakening', /Weakening:/.test(describeKnowledge(assessKnowledge(fading,SPECS))), true);
ok('handles null', /No accumulated knowledge/.test(describeKnowledge(null)), true);


console.log('\n-- NOISE MUST NEVER BECOME KNOWLEDGE --');
// gold that responds to nothing, with seven drivers along for the ride
const NOISE_SPECS = ['a','b','c','d','e','f','g'].map(k=>({key:k,label:'Driver '+k,kind:'price'}));
let noiseStore = emptyKnowledge();
for (let d=0; d<300; d++) {
  const drivers = {}; NOISE_SPECS.forEach(s=>{ drivers[s.key] = rnd()*0.02; });
  noiseStore = recordObservation(noiseStore, { day: 50000+d, gold: rnd()*0.01, drivers });
}
const na = assessKnowledge(noiseStore, NOISE_SPECS);
ok('noise still produces a flattering in-sample R2', na.r2 > 0.01, true);
ok('but the permutation test is not fooled', na.beatsChance, false);
ok('and out-of-sample skill is absent', na.predictsOutOfSample, false);
ok('so the model is not treated as real', na.modelIsReal, false);
ok('NOTHING is established', na.drivers.filter(d=>d.maturity==='established').length, 0);
ok('the description leads with the caveat', /yet distinguishable from noise/.test(describeKnowledge(na)), true);
ok('...and says the fit is what chance would give', /by chance/.test(describeKnowledge(na)), true);

console.log('\n-- REAL SIGNAL MUST STILL GET THROUGH --');
const REAL_SPECS = [{key:'ry',label:'Real Yield',kind:'yield'},{key:'x2',label:'Other',kind:'price'},{key:'x3',label:'Spare',kind:'price'}];
let realStore = emptyKnowledge();
for (let d=0; d<300; d++) {
  const ry=rnd()*0.05, x2=rnd()*0.02, x3=rnd()*0.02;
  realStore = recordObservation(realStore, { day: 60000+d, gold: -1.8*ry + 0.15*rnd()*0.01, drivers:{ry,x2,x3} });
}
const ra = assessKnowledge(realStore, REAL_SPECS);
ok('permutation test confirms it', ra.beatsChance, true);
ok('it predicts out of sample', ra.predictsOutOfSample, true);
ok('model counted as real', ra.modelIsReal, true);
const ryR = ra.drivers.find(d=>d.key==='ry');
ok('the true driver is established', ryR.maturity, 'established');
ok('and survives multiple-testing correction', ryR.survivesFdr, true);
ok('spare drivers do not survive it', ra.drivers.filter(d=>d.key!=='ry').every(d=>!d.survivesFdr), true);
ok('description reports the out-of-sample check', /out of sample/.test(describeKnowledge(ra)), true);
ok('p-value recorded per driver', ryR.pValue < 0.01, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
