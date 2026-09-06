// Runs every suite and reports one line per suite.
//
// With FAKE_NOW set, Node's clock is moved first, so the same command can ask
// "what does this harness do on a Saturday?". A harness that is genuinely
// independent of the calendar gives byte-identical output for every value.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const only = process.argv[2];            // 'unit' | 'browser' | undefined
const files = readdirSync(new URL('.', import.meta.url))
  .filter(f => f.endsWith('.mjs'))
  .filter(f => f.endsWith('.test.mjs') || f.startsWith('browser-'))
  .filter(f => only === 'unit' ? f.endsWith('.test.mjs')
             : only === 'browser' ? f.startsWith('browser-') : true)
  .sort();

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath,
    ['--import', new URL('./fake-clock-preload.mjs', import.meta.url).pathname, 'test/' + f],
    { encoding: 'utf8', env: process.env });
  const out = (r.stdout || '').trim().split('\n');
  // The last line carrying a tally, or the last line at all for the suites that
  // report differently (corrupt-state prints per-case rows).
  const tally = [...out].reverse().find(l => /passed, \d+ failed/.test(l)) || out[out.length - 1] || '(no output)';
  const bad = r.status !== 0;
  if (bad) failed++;
  console.log((bad ? 'FAIL ' : 'ok   ') + f.replace('.mjs', '').padEnd(30) + ' ' + tally.trim());
}
console.log(failed ? '\n' + failed + ' suite(s) failed' : '\nall suites passed');
process.exit(failed ? 1 : 0);
