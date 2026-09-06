// THE HARNESS CHECKS ITSELF
// ------------------------------------------------------------
// Four separate times, a suite passed on a weekday and failed on a Saturday,
// and every time the failure read as a bug in the engine rather than in the
// test. The fixes were individually correct and collectively useless, because
// nothing stopped the next fixture being written the same way.
//
// So the rule is now enforced rather than remembered: no test reads the wall
// clock. This suite is the enforcement. It is deliberately mechanical — it
// reads the other suites as text — because the alternative is noticing.
//
// The stronger check lives in test/run-all.mjs, which runs everything with
// Node's clock moved to a Saturday, a Sunday and five minutes before the
// Friday close. This one is the cheap version that runs every time.
import { readdirSync, readFileSync } from 'node:fs';
import { NOW, LATE_WEEK, CLOSED, agoHours, agoMinutes, isoAgo, HOUR } from './clock.mjs';

let pass = 0, fail = 0;
// Compares actual against expected rather than taking a truthy value, because
// the truthy form silently passes for the two things this suite most needs to
// catch: a day-of-week of 0 (Sunday), and an empty-array expectation, which is
// truthy however many offenders it actually holds. The first draft of this file
// used the truthy form and reported a clean harness while proving nothing.
const ok = (n, actual, expected, extra) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((good ? 'PASS' : 'FAIL') + ' ' + n +
    (good ? '' : '  got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected) +
      (extra ? '\n     ' + extra : '')));
  good ? pass++ : fail++;
};

const dir = new URL('.', import.meta.url).pathname;
const suites = readdirSync(dir).filter(f => f.endsWith('.mjs'))
  .filter(f => f.endsWith('.test.mjs') || f.startsWith('browser-'))
  .filter(f => f !== 'harness.test.mjs');
const browser = suites.filter(f => f.startsWith('browser-'));
const read = (f) => readFileSync(dir + f, 'utf8');

console.log('-- the shared clock --');
ok('NOW is a Wednesday, so no weekend rule fires', new Date(NOW).getUTCDay(), 3);
ok('and midday, so fixtures can reach either way', new Date(NOW).getUTCHours(), 12);
ok('LATE_WEEK is a Friday inside the trading week', new Date(LATE_WEEK).getUTCDay(), 5);
ok('and before the 21:00 close', new Date(LATE_WEEK).getUTCHours() < 21, true);
ok('ninety hours before it is still the same trading week',
   new Date(agoHours(90, LATE_WEEK)).getUTCDay(), 2);
ok('CLOSED is a Sunday with the market shut', new Date(CLOSED).getUTCDay(), 0);
ok('agoHours counts back from NOW by default', NOW - agoHours(3), 3 * HOUR);
ok('agoMinutes likewise', NOW - agoMinutes(90), 90 * 60000);
ok('isoAgo returns a parseable stamp', Date.parse(isoAgo(2)), agoHours(2));

// ---- no suite may read the wall clock outside the page --------------------
// Date.now() inside a p.evaluate is fine: the page clock is pinned, so the page
// answers with the fixture instant. Outside one, it is the machine's clock.
function nodeSideWallClock(src) {
  // Blank out every .evaluate(...) argument list by matching parentheses, then
  // look at what is left. A line-counting heuristic got this wrong in both
  // directions — it missed reads in unit suites, and it flagged in-page code,
  // which produced an edit that put a Node constant inside a browser callback.
  let out = src;
  const call = /\.(evaluate|evaluateHandle|addInitScript)\s*\(/g;
  let m;
  while ((m = call.exec(out)) !== null) {
    let i = m.index + m[0].length - 1, depth = 0, end = -1;
    for (let j = i; j < out.length; j++) {
      const c = out[j];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) break;
    // Keep the newlines so reported line numbers stay honest.
    const blanked = out.slice(i, end).replace(/[^\n]/g, ' ');
    out = out.slice(0, i) + blanked + out.slice(end);
    call.lastIndex = end;
  }
  return out.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /Date\.now\(\)|new Date\(\s*\)/.test(l) && !/^\s*\/\//.test(l))
    .map(([n, l]) => n + ': ' + l.trim().slice(0, 80));
}

// The detector itself, checked both ways — a false positive here does real
// damage: it argues for moving a Node constant into a browser callback, where
// it is not defined.
console.log('\n-- the detector tells Node from page --');
ok('a bare read in Node is caught',
   nodeSideWallClock("const t = Date.now();").length, 1);
ok('the same read inside p.evaluate is not',
   nodeSideWallClock("await p.evaluate(() => {\n  const t = Date.now();\n});").length, 0);
ok('a multi-line evaluate is blanked to its closing paren',
   nodeSideWallClock("await p.evaluate((x) => {\n  const a = f(g(1));\n  return Date.now();\n});\nconst z = Date.now();"),
   ['5: const z = Date.now();']);
ok('and a read after the callback is still caught',
   nodeSideWallClock("await p.evaluate(() => 1);\nconst t = new Date();").length, 1);
ok('a commented-out read is ignored',
   nodeSideWallClock("// const t = Date.now();").length, 0);

console.log('\n-- no suite reads the machine clock --');
const offenders = suites.filter(f => nodeSideWallClock(read(f)).length);
ok('every suite builds its fixtures from the shared clock', offenders, [],
   offenders.map(f => f + ' -> ' + nodeSideWallClock(read(f)).join(' | ')).join('\n'));

console.log('\n-- every browser suite pins its page --');
const unpinned = browser.filter(f => !/pinPage\s*\(/.test(read(f)));
ok('a page that has booted has already read the wall clock', unpinned, []);

// A pin after the first goto is no pin at all — the app reads the clock while
// it boots, so the order matters and is easy to get wrong.
const latePins = browser.filter(f => {
  const src = read(f);
  const firstGoto = src.search(/\.goto\(/);
  const firstPin = src.search(/pinPage\s*\(/);
  return firstGoto !== -1 && firstPin > firstGoto;
});
ok('and pins it before the first goto, not after', latePins, []);

console.log('\n-- the clock is defined once --');
const ownConstants = suites.filter(f => {
  const src = read(f);
  // A suite may use absolute dates to test calendar logic; what it may not do
  // is declare its own idea of "now".
  return /const\s+\w*(NOW|PIN)\w*\s*=\s*Date\.(UTC|parse)\(/.test(src);
});
ok('no suite declares its own "now"', ownConstants, []);

const importers = suites.filter(f => /from '\.\/clock\.mjs'/.test(read(f)));
// Every browser suite needs it to pin its page; the unit suites that build
// dated fixtures need it too. Anything that touches a date imports from here.
const missing = browser.filter(f => importers.indexOf(f) === -1);
ok('every browser suite imports the shared clock', missing, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
