// Same-origin proxy for FRED (St. Louis Fed) — the browser can't call api.stlouisfed.org
// directly because FRED doesn't send CORS headers for arbitrary origins. This function runs
// server-side (no CORS restriction applies to server-to-server requests) and the client fetches
// this endpoint instead. The FRED API key is whatever the user pasted into the app; it's not
// stored anywhere, just forwarded through on each request.
//
// THE ONE RULE THIS ENDPOINT ENFORCES: it returns the MOST RECENT observations.
//
// FRED applies `limit` AFTER sorting, so `sort_order=asc&limit=48` returns the 48 oldest
// observations the series has ever had — 1913 for PPI, 1947 for CPI, 1954 for the Fed funds
// rate. That is never what a live analysis wants, and it fails silently: the values are real,
// the maths works, and a confident number comes out the other end describing the Eisenhower
// administration.
//
// This proxy exists solely to serve this app, and every caller in it wants recency, so recency
// is the contract rather than a parameter each caller has to remember. Requests are fetched
// newest-first and returned oldest-first (which is what the analysis code expects), whatever
// sort_order the caller asked for. A stale cached client that still sends `asc` therefore gets
// correct data too, without needing to reload first.
//
// `oldest=1` opts out, for the rare case where the start of a series is genuinely wanted.
export default async function handler(req, res) {
  const { series_id, api_key, limit, sort_order, file_type, oldest } = req.query;
  if (!series_id || !api_key) {
    res.status(400).json({ error: 'Missing series_id or api_key' });
    return;
  }
  const wantOldest = oldest === '1' || oldest === 'true';
  try {
    const qs = new URLSearchParams({
      series_id,
      api_key,
      file_type: file_type || 'json',
      // Newest-first unless the caller explicitly asked for the start of the series.
      sort_order: wantOldest ? 'asc' : 'desc',
      limit: limit || '120'
    });
    const r = await fetch('https://api.stlouisfed.org/fred/series/observations?' + qs.toString());
    const data = await r.json();

    // Hand back oldest-first, which is the order every consumer here assumes.
    if (!wantOldest && data && Array.isArray(data.observations)) {
      data.observations = data.observations.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
      // Say what was actually done, so a caller that asked for something else can tell.
      data.proxy_note = 'Returned the ' + data.observations.length +
        ' most recent observations, oldest-first. Pass oldest=1 for the start of the series.';
      if (sort_order === 'asc') {
        data.proxy_note += ' Note: sort_order=asc was overridden — with a limit it returns the oldest ' +
          'observations in the series, which is never current data.';
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(r.ok ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || 'FRED proxy error' });
  }
}
