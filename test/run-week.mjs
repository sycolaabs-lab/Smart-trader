// PROVE THE HARNESS DOES NOT CARE WHAT DAY IT IS
// ------------------------------------------------------------
// Runs the whole harness five times, with Node's clock moved to five points
// that the engine treats differently: midweek, inside the Friday-close flatten
// window, Saturday with the market shut, Sunday just after the reopen, and
// early Monday. A harness that is genuinely independent of the calendar
// produces identical output every time; anything else is a fixture reading the
// machine clock, directly or through the code under test.
//
// This is slower than the grep in harness.test.mjs and catches strictly more:
// the last thing it found was the background worker resolving signals on
// Date.now() while every other part of the same tick used the caller's clock.
//
//   node test/run-week.mjs unit      # ~1 minute
//   node test/run-week.mjs browser   # needs a server on :8899, ~90 minutes
//   node test/run-week.mjs           # both
import { spawnSync } from 'node:child_process';

const scope = process.argv[2] || '';
const DAYS = [
  ['midweek',            Date.UTC(2026, 8, 2, 12, 0, 0)],
  ['Friday close window', Date.UTC(2026, 8, 4, 20, 50, 0)],
  ['Saturday, shut',     Date.UTC(2026, 8, 5, 12, 0, 0)],
  ['Sunday, just open',  Date.UTC(2026, 8, 6, 23, 30, 0)],
  ['Monday, early',      Date.UTC(2026, 8, 7, 3, 0, 0)]
];

const results = [];
for (const [label, at] of DAYS) {
  const r = spawnSync(process.execPath, ['test/run-all.mjs', scope].filter(Boolean), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { FAKE_NOW: String(at) })
  });
  const out = (r.stdout || '') + (r.stderr || '');
  results.push({ label, at, out, code: r.status });
  console.log(label.padEnd(22) + (r.status === 0 ? 'all suites passed' : 'FAILED')
    + '   (as ' + new Date(at).toUTCString() + ')');
}

const baseline = results[0];
const drifted = results.filter(r => r.out !== baseline.out);
console.log('');
if (drifted.length) {
  console.log('DAY-DEPENDENT: ' + drifted.length + ' of ' + (results.length - 1)
    + ' other days differ from ' + baseline.label + '.');
  for (const d of drifted) {
    const a = baseline.out.split('\n'), b = d.out.split('\n');
    const diff = b.filter((l, i) => l !== a[i]).slice(0, 6);
    console.log('\n  ' + d.label + ':');
    diff.forEach(l => console.log('    ' + l));
  }
  process.exit(1);
}
if (results.some(r => r.code !== 0)) {
  console.log('Output is identical across the week, but suites are failing on every day.');
  process.exit(1);
}
console.log('Identical output on all ' + results.length + ' days. The harness does not read the calendar.');
