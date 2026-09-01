// ============================================================
// /api/health — setup diagnostics
// ------------------------------------------------------------
// Getting the background worker running means setting five environment
// variables across two dashboards, and a wrong one fails as a generic 500 from
// a scheduler you can't see inside. This endpoint reports what the deployment
// can actually see, so setup can be checked from a browser in one request.
//
// It reports only whether each variable is PRESENT and, where cheap, whether it
// is well-formed — never the values themselves, so the URL stays safe to open
// anywhere. It needs no secret precisely so it still works when TICK_SECRET is
// the thing that's misconfigured.
// ============================================================
export default function handler(req, res) {
  const present = name => !!(process.env[name] && process.env[name].trim());

  // The service account is the variable that most often goes in wrong, so it
  // gets parsed (not just presence-checked) and reports which field is missing.
  let serviceAccount = { present: false, parses: false, detail: 'not set' };
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim()) {
    serviceAccount.present = true;
    try {
      const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      const parsed = JSON.parse(json);
      const missing = ['project_id', 'client_email', 'private_key'].filter(k => !parsed[k]);
      if (missing.length) {
        serviceAccount.detail = 'parsed, but missing field(s): ' + missing.join(', ');
      } else {
        serviceAccount.parses = true;
        serviceAccount.detail = 'valid service account for project "' + parsed.project_id + '"';
      }
    } catch (e) {
      serviceAccount.detail = 'set, but not valid JSON or base64-encoded JSON — re-copy it from the Firebase console and base64 the whole file';
    }
  }

  const checks = {
    TICK_SECRET: present('TICK_SECRET'),
    TWELVEDATA_API_KEY: present('TWELVEDATA_API_KEY'),
    FRED_API_KEY: present('FRED_API_KEY'),
    ALPHAVANTAGE_API_KEY: present('ALPHAVANTAGE_API_KEY'),
    FIREBASE_SERVICE_ACCOUNT: serviceAccount
  };

  const blocking = [];
  if (!checks.TICK_SECRET) blocking.push('TICK_SECRET is not set — /api/tick will refuse every request with a 500.');
  if (!checks.TWELVEDATA_API_KEY) blocking.push('TWELVEDATA_API_KEY is not set — the worker has no price data and cannot run.');
  if (!serviceAccount.present) blocking.push('FIREBASE_SERVICE_ACCOUNT is not set — the worker cannot persist state or publish a tick.');
  else if (!serviceAccount.parses) blocking.push('FIREBASE_SERVICE_ACCOUNT ' + serviceAccount.detail);

  const optional = [];
  if (!checks.FRED_API_KEY) optional.push('FRED_API_KEY is not set — correlation and fundamentals will report as unavailable.');
  if (!checks.ALPHAVANTAGE_API_KEY) optional.push('ALPHAVANTAGE_API_KEY is not set — news sentiment will report as unavailable.');

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: blocking.length === 0,
    ready: blocking.length === 0
      ? 'All required environment variables are set. Call /api/tick?secret=YOUR_TICK_SECRET to run a tick.'
      : 'Not ready — see "blocking" below.',
    blocking,
    warnings: optional,
    checks,
    note: 'Values are never returned by this endpoint, only whether they are present and well-formed. Remember Vercel only applies new environment variables to deployments created AFTER the variable was added — redeploy after changing them.'
  });
}
