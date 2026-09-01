// Same-origin proxy for FRED (St. Louis Fed) — the browser can't call api.stlouisfed.org
// directly because FRED doesn't send CORS headers for arbitrary origins. This function runs
// server-side (no CORS restriction applies to server-to-server requests) and the client fetches
// this endpoint instead. The FRED API key is whatever the user pasted into the app; it's not
// stored anywhere, just forwarded through on each request.
export default async function handler(req, res) {
  const { series_id, api_key, limit, sort_order, file_type } = req.query;
  if (!series_id || !api_key) {
    res.status(400).json({ error: 'Missing series_id or api_key' });
    return;
  }
  try {
    const qs = new URLSearchParams({
      series_id,
      api_key,
      file_type: file_type || 'json',
      sort_order: sort_order || 'asc',
      limit: limit || '120'
    });
    const r = await fetch('https://api.stlouisfed.org/fred/series/observations?' + qs.toString());
    const data = await r.json();
    res.setHeader('Cache-Control', 'no-store');
    res.status(r.ok ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || 'FRED proxy error' });
  }
}
