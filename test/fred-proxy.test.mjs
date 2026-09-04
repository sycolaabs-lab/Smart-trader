// The FRED proxy is the last line of defence for data recency. FRED applies
// `limit` AFTER sorting, so asc+limit returns the oldest observations a series
// ever had — 1913 for PPI, 1947 for CPI. Every caller here wants recency, and a
// stale cached client that still sends asc must get correct data anyway.
import handler from '../api/fred.js';

let pass=0, fail=0;
const ok=(n,a,e)=>{const g=JSON.stringify(a)===JSON.stringify(e);console.log((g?'PASS':'FAIL')+' '+n+(g?'':`  got=${JSON.stringify(a)} want=${JSON.stringify(e)}`));g?pass++:fail++;};

let lastUrl = null;
function stubFred(observations) {
  globalThis.fetch = async (url) => {
    lastUrl = new URL(String(url));
    return { ok: true, json: async () => ({ observations }) };
  };
}
function res() {
  const r = { code: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const call = async (query) => { const r = res(); await handler({ query }, r); return r; };

// newest-first from FRED, as desc returns it
const recent = [
  { date: '2026-09-03', value: '2.35' },
  { date: '2026-09-02', value: '2.34' },
  { date: '2026-09-01', value: '2.33' }
];

stubFred(recent);
let r = await call({ series_id: 'T10YIE', api_key: 'K', limit: '48' });
ok('it asks FRED for the newest observations', lastUrl.searchParams.get('sort_order'), 'desc');
ok('and passes the limit through', lastUrl.searchParams.get('limit'), '48');
ok('it returns them oldest-first', r.body.observations.map(o => o.date), ['2026-09-01','2026-09-02','2026-09-03']);
ok('and says what it did', /most recent observations, oldest-first/.test(r.body.proxy_note), true);
ok('with a no-store header', r.headers['Cache-Control'], 'no-store');
ok('and a 200', r.code, 200);

// A stale client still sending asc must not get 1913 data.
stubFred(recent);
r = await call({ series_id: 'PPIACO', api_key: 'K', limit: '48', sort_order: 'asc' });
ok('an asc request is overridden', lastUrl.searchParams.get('sort_order'), 'desc');
ok('the client still gets recent data', r.body.observations[r.body.observations.length-1].date, '2026-09-03');
ok('and is told the override happened', /sort_order=asc was overridden/.test(r.body.proxy_note), true);
ok('with the reason', /never current data/.test(r.body.proxy_note), true);

// The escape hatch still works.
const ancient = [
  { date: '1913-01-01', value: '10.0' },
  { date: '1913-02-01', value: '10.1' }
];
stubFred(ancient);
r = await call({ series_id: 'PPIACO', api_key: 'K', limit: '48', oldest: '1' });
ok('oldest=1 asks for the start of the series', lastUrl.searchParams.get('sort_order'), 'asc');
ok('and returns it untouched', r.body.observations[0].date, '1913-01-01');
ok('with no override note', r.body.proxy_note, undefined);

// housekeeping
r = await call({ api_key: 'K' });
ok('a missing series is rejected', r.code, 400);
r = await call({ series_id: 'X' });
ok('a missing key is rejected', r.code, 400);
stubFred(recent);
r = await call({ series_id: 'X', api_key: 'K' });
ok('the default limit is applied', lastUrl.searchParams.get('limit'), '120');
globalThis.fetch = async () => { throw new Error('network down'); };
r = await call({ series_id: 'X', api_key: 'K' });
ok('a network failure is a 500, not a crash', r.code, 500);
globalThis.fetch = async () => ({ ok: true, json: async () => ({ error_code: 400, error_message: 'Bad key' }) });
r = await call({ series_id: 'X', api_key: 'K' });
ok('a FRED error passes through untouched', r.body.error_message, 'Bad key');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
