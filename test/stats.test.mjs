// The statistical core, checked against data with KNOWN answers. If the algebra
// is wrong every conclusion built on it is confident nonsense, so these tests
// recover planted coefficients rather than merely asserting the code runs.
import { solveWithInverse, mean, stdDev, fitRidge } from '../lib/stats.js';

let pass=0, fail=0;
const ok=(n,a,e)=>{const g=JSON.stringify(a)===JSON.stringify(e);console.log((g?'PASS':'FAIL')+' '+n+(g?'':`  got=${JSON.stringify(a)} want=${JSON.stringify(e)}`));g?pass++:fail++;};
const near=(n,a,e,tol)=>{const g=Math.abs(a-e)<=(tol??1e-6);console.log((g?'PASS':'FAIL')+' '+n+(g?'':`  got=${a} want≈${e}`));g?pass++:fail++;};

console.log('-- linear solver --');
const s1 = solveWithInverse([[2,1],[1,3]],[5,10]);
near('solves a 2x2 system (x)', s1.x[0], 1);
near('solves a 2x2 system (y)', s1.x[1], 3);
// A * A^-1 = I
const A=[[4,7],[2,6]], inv=solveWithInverse(A,[0,0]).inverse;
near('inverse row0col0', A[0][0]*inv[0][0]+A[0][1]*inv[1][0], 1, 1e-9);
near('inverse row0col1', A[0][0]*inv[0][1]+A[0][1]*inv[1][1], 0, 1e-9);
ok('singular matrix returns null', solveWithInverse([[1,2],[2,4]],[1,2]), null);
ok('pivoting handles a zero leading entry', solveWithInverse([[0,1],[1,0]],[2,3])!==null, true);
near('...and gets it right', solveWithInverse([[0,1],[1,0]],[2,3]).x[0], 3);

console.log('\n-- moments --');
near('mean', mean([1,2,3,4]), 2.5);
ok('mean of empty is 0', mean([]), 0);
near('sample stdDev', stdDev([2,4,4,4,5,5,7,9]), 2.13809, 1e-4);
ok('stdDev needs 2 points', stdDev([5]), 0);

console.log('\n-- ridge regression recovers planted coefficients --');
// deterministic pseudo-random so the test never flakes
let seed=42; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff-0.5;};
const N=400;
const x1=[],x2=[],x3=[],y=[];
for(let i=0;i<N;i++){
  const a=rnd(), b=rnd(), c=rnd();
  x1.push(a); x2.push(b); x3.push(c);
  // y depends on x1 strongly NEGATIVE, x2 weakly positive, x3 not at all
  y.push(-2.0*a + 0.5*b + 0.02*rnd());
}
const fit = fitRidge([x1,x2,x3], y);
ok('fit succeeds', fit!==null, true);
ok('sign of the dominant driver is negative', fit.beta[0] < 0, true);
ok('second driver is positive', fit.beta[1] > 0, true);
ok('dominant driver has the largest magnitude', Math.abs(fit.beta[0])>Math.abs(fit.beta[1]), true);
ok('irrelevant driver is near zero', Math.abs(fit.beta[2]) < Math.abs(fit.beta[1])/3, true);
ok('R2 is high for a near-deterministic relationship', fit.r2 > 0.98, true);
ok('relevant drivers are significant', Math.abs(fit.tStat[0])>5 && Math.abs(fit.tStat[1])>5, true);
ok('irrelevant driver is NOT significant', Math.abs(fit.tStat[2]) < 2, true);

console.log('\n-- collinearity: the reason for doing this at all --');
// x2 is nearly a copy of x1; only x1 truly drives y
const c1=[],c2=[],cy=[];
for(let i=0;i<N;i++){const a=rnd(); c1.push(a); c2.push(a+0.01*rnd()); cy.push(3*a+0.01*rnd());}
const cf = fitRidge([c1,c2], cy);
ok('collinear fit still succeeds', cf!==null, true);
ok('credit is SPLIT, not double-counted', cf.beta[0]+cf.beta[1] > 0 && Math.abs(cf.beta[0]) < 3.5, true);
ok('combined effect is still captured', cf.r2 > 0.98, true);

console.log('\n-- refusals --');
ok('refuses too little data', fitRidge([[1,2,3],[1,2,3]],[1,2,3]), null);
ok('refuses a constant driver', fitRidge([new Array(50).fill(1), Array.from({length:50},(_,i)=>i)], Array.from({length:50},(_,i)=>i)), null);
ok('refuses mismatched lengths', fitRidge([[1,2,3,4,5,6,7,8,9,10]],[1,2,3]), null);
ok('refuses no drivers', fitRidge([], [1,2,3]), null);

console.log('\n-- prediction --');
const pf = fitRidge([x1,x2,x3], y);
const predicted = pf.predict([0.4, 0.0, 0.0]);
ok('predicts the right direction for a positive x1 move', predicted < pf.yMean, true);
ok('rejects a wrong-width row', pf.predict([1,2]), null);
ok('rejects a non-finite input', pf.predict([NaN,0,0]), null);


// ================= NOISE VS SIGNAL =================
// The point of the whole exercise: these must REJECT noise and ACCEPT signal.
// If they cannot tell the two apart, everything built on them is false
// confidence with statistics painted on.
import { normalCdf, twoSidedP, benjaminiHochberg, blockPermutationTest, walkForwardR2 } from '../lib/stats.js';
console.log('\n-- distributions --');
near('normalCdf(0)', normalCdf(0), 0.5, 1e-6);
near('normalCdf(1.96)', normalCdf(1.96), 0.975, 1e-3);
near('normalCdf(-1.96)', normalCdf(-1.96), 0.025, 1e-3);
near('two-sided p at t=1.96', twoSidedP(1.96), 0.05, 1e-3);
near('two-sided p at t=0', twoSidedP(0), 1.0, 1e-6);
ok('non-finite t is not significant', twoSidedP(NaN), 1);

console.log('\n-- false discovery rate --');
ok('a clearly real p survives', benjaminiHochberg([0.0001, 0.9, 0.8, 0.7], 0.10)[0], true);
ok('the noise around it does not', benjaminiHochberg([0.0001, 0.9, 0.8, 0.7], 0.10).slice(1).some(Boolean), false);
ok('seven borderline p-values all get rejected', benjaminiHochberg([0.04,0.04,0.04,0.04,0.04,0.04,0.04], 0.01).some(Boolean), false);
ok('empty input is safe', benjaminiHochberg([]).length, 0);

// ---- generators ----
let ns=99; const nr=()=>{ns=(ns*1103515245+12345)&0x7fffffff;return ns/0x7fffffff-0.5;};
function pureNoise(n,k){
  const cols=[]; for(let i=0;i<k;i++) cols.push(Array.from({length:n},()=>nr()));
  const y=Array.from({length:n},()=>nr());          // y depends on NOTHING
  return {cols,y};
}
function realSignal(n,k){
  const cols=[]; for(let i=0;i<k;i++) cols.push(Array.from({length:n},()=>nr()));
  const y=cols[0].map((v,t)=> -1.5*v + 0.3*cols[1][t] + 0.25*nr());
  return {cols,y};
}

console.log('\n-- IN-SAMPLE R2 IS NOT EVIDENCE (the problem being solved) --');
const noiseFit = fitRidge(...Object.values(pureNoise(60,7)).reverse().reverse() && (()=>{const d=pureNoise(60,7);return [d.cols,d.y];})());
ok('7 drivers on 60 rows of pure noise still produce a flattering R2', noiseFit.r2 > 0.05, true);

console.log('\n-- permutation test --');
const N1=pureNoise(200,5);
const permNoise = blockPermutationTest(N1.cols, N1.y, {iterations:150});
ok('permutation runs on noise', permNoise!==null, true);
ok('NOISE is not significant', permNoise.pValue > 0.05, true);
ok('observed R2 sits inside the null distribution', permNoise.observedR2 <= permNoise.null95R2*1.5, true);

const S1=realSignal(200,5);
const permSignal = blockPermutationTest(S1.cols, S1.y, {iterations:150});
ok('SIGNAL is significant', permSignal.pValue < 0.05, true);
ok('and beats the null decisively', permSignal.observedR2 > permSignal.null95R2, true);
ok('p can never be exactly zero', permSignal.pValue > 0, true);
ok('is deterministic across runs', blockPermutationTest(S1.cols,S1.y,{iterations:150}).pValue, permSignal.pValue);

console.log('\n-- walk-forward out-of-sample --');
const N2=pureNoise(300,5);
const wfNoise = walkForwardR2(N2.cols, N2.y, {minTrain:60});
ok('walk-forward runs on noise', wfNoise!==null, true);
ok('NOISE has no out-of-sample skill', wfNoise.r2 <= 0.02, true);
ok('...and its hit rate is a coin flip', Math.abs(wfNoise.hitRate-0.5) < 0.12, true);

const S2=realSignal(300,5);
const wfSignal = walkForwardR2(S2.cols, S2.y, {minTrain:60});
ok('SIGNAL survives out of sample', wfSignal.r2 > 0.5, true);
ok('...with a real directional edge', wfSignal.hitRate > 0.7, true);
ok('predictions never see their own target', wfSignal.n < 300, true);
ok('refuses on too little data', walkForwardR2([[1,2,3]],[1,2,3],{minTrain:40}), null);

console.log('\n-- the combined bar rejects what it should --');
const noiseVerdict = permNoise.pValue > 0.05 || wfNoise.r2 <= 0;
const signalVerdict = permSignal.pValue < 0.05 && wfSignal.r2 > 0;
ok('noise fails at least one gate', noiseVerdict, true);
ok('signal passes both gates', signalVerdict, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
