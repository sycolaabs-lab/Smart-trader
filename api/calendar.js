// ============================================================
// /api/calendar — economic release calendar proxy
// ------------------------------------------------------------
// FRED publishes a forward-looking release schedule, but sends no CORS headers,
// so the browser cannot read it directly. Same reason api/fred.js exists.
//
// This returns only the releases the engine cares about — the ones that
// actually move gold — rather than the ~3,000 entries FRED lists, so the client
// gets a small payload it can cache for hours.
// ============================================================
import { ECONOMIC_RELEASES, buildReleaseCalendar } from '../lib/engine.js';

export default async function handler(req, res) {
  const apiKey = (req.query && req.query.api_key) || process.env.FRED_API_KEY || '';
  if (!apiKey) {
    res.status(400).json({ error: 'Missing api_key (and no FRED_API_KEY configured on this deployment)' });
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const wanted = new Set(ECONOMIC_RELEASES.map(r => r.id));

  try {
    // One call for every scheduled release, then filtered locally. Asking FRED
    // per release would be nine round trips for the same information.
    const qs = new URLSearchParams({
      api_key: apiKey, file_type: 'json', include_release_dates_with_no_data: 'true',
      realtime_start: today, sort_order: 'asc', limit: '1000'
    });
    const r = await fetch('https://api.stlouisfed.org/fred/releases/dates?' + qs);
    const j = await r.json();
    if (j.error_code) throw new Error(j.error_message || 'FRED error');

    const rows = (j.release_dates || []).filter(d => wanted.has(d.release_id));
    const calendar = buildReleaseCalendar(rows).filter(e => e.at >= Date.now() - 24 * 3600 * 1000);

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).json({ calendar, fetchedAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'calendar proxy error' });
  }
}
