# XAUUSD Smart Trader

A smart-money-concepts gold analysis dashboard that can run itself. It reads
structure across Weekly → 15min, layers on cross-market correlation, macro
fundamentals and news sentiment, grades every setup it produces, and learns from
whether those setups actually worked.

The point of the autonomous side is that the learning loop no longer needs a
human in it: signals are committed by the engine, graded against real price when
they hit stop or target, and fed back into the weights and the meta-labeler
automatically.

---

## Layout

| Path | What it is |
|---|---|
| `index.html` | Markup only. Loads `app.js` as an ES module. |
| `app.js` | The application shell: DOM, provider calls, Firebase sync, the autonomous scheduler. |
| `lib/engine.js` | The analysis engine. Pure functions — no DOM, no storage, no network. |
| `api/tick.js` | The background worker. Runs a full unattended pass server-side. |
| `api/health.js` | Setup diagnostics. Tells you which environment variables the deployment can see. |
| `api/fred.js` | Same-origin proxy for FRED (which sends no CORS headers). |
| `test/` | Node test suites — `npm test`. |

`lib/engine.js` is imported by **both** `app.js` and `api/tick.js`. That is
deliberate: the analysis that runs unattended is the same code as the analysis
on screen, so the two cannot drift apart.

---

## The two ways it runs unattended

These are independent. Either works alone; together they cover each other.

### 1. Autonomous mode (in the browser)

Tick **Autonomous Mode** on the Live Dashboard. From then on, every cycle
(default 15 min) the app will:

1. pull fresh 15-minute candles,
2. grade any open signal that has since hit its stop or target,
3. re-analyse,
4. commit a new signal **only** if confidence, grade and the meta-labeler all
   clear the thresholds,
5. re-backtest and retrain on the growing record (default every 4 h).

It needs a tab open — a pinned tab or a spare phone is enough. It is built for
real conditions rather than a desk:

- **Closed tab time is recovered.** On the next load it replays the gap from
  real candle history, so signals that resolved overnight still become training
  data.
- **Offline is a pause, not a failure.** It resumes on reconnect and replays
  what it missed.
- **Errors back off exponentially** (capped at ~30 min), so an expired or
  rate-limited key does not turn into a request every minute all day.

Nothing runs unless the box is ticked. Unticking it stops everything immediately.

### 2. Background worker (`/api/tick`, no browser at all)

A scheduler calls `/api/tick` and the server does the same pass with no device
involved, publishing a snapshot to Firestore that the dashboard's **Background
System** panel subscribes to live.

---

## Setting up the background worker

### Step 1 — environment variables

Vercel → your project → **Settings → Environment Variables**. Add these, ticking
**Production** for each:

| Variable | Required | What it is |
|---|---|---|
| `TICK_SECRET` | yes | Any password you invent. It gates `/api/tick`. |
| `TWELVEDATA_API_KEY` | yes | Your Twelve Data key. Price data. |
| `FIREBASE_SERVICE_ACCOUNT` | yes | Base64 of the service account JSON (see below). |
| `FRED_API_KEY` | no | Enables correlation + fundamentals. Free, no rate limit. |
| `ALPHAVANTAGE_API_KEY` | no | Enables news sentiment. |

> **The single most common mistake:** Vercel only applies environment variables
> to deployments created **after** the variable was added. Adding a variable
> does nothing to the deployment already running — you must redeploy afterwards.

**Getting `FIREBASE_SERVICE_ACCOUNT` right.** Firebase Console → Project
Settings → Service Accounts → *Generate new private key*. That downloads a JSON
file. Do **not** paste the JSON directly — it is multi-line and contains a
private key with `\n` escapes that dashboards mangle. Base64 it first:

```bash
# macOS / Linux
base64 -i ~/Downloads/your-service-account.json | tr -d '\n' | pbcopy

# Linux without pbcopy
base64 -w0 ~/Downloads/your-service-account.json
```

Paste that single long line as the value. (The worker also accepts raw JSON if
you'd rather, but base64 is far less error-prone.)

### Step 2 — check your work

Open:

```
https://your-app.vercel.app/api/health
```

This needs no secret — precisely so it still works when `TICK_SECRET` is the
thing that's wrong. It reports exactly which variables the deployment can see,
and parses the service account to tell you if it's malformed. It never returns
any value, so the URL is safe to open anywhere.

You want `"ok": true`. If not, `blocking` names what to fix.

### Step 3 — Firestore rules

The dashboard reads the worker's published tick without signing in, so the
`system` collection needs public read. In Firebase Console → Firestore →
**Rules**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Each signed-in user owns their own learning state and signal log.
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    // The worker's published snapshot is world-readable but only the worker
    // (via the Admin SDK, which bypasses these rules) can write it.
    match /system/{doc} {
      allow read: if true;
      allow write: if false;
    }
  }
}
```

### Step 4 — run it once by hand

```
https://your-app.vercel.app/api/tick?secret=YOUR_TICK_SECRET
```

A healthy response is JSON with `"ok": true` and a `direction`, `confidence` and
`price`. If something is wrong you get a JSON error saying what — not a silent
failure. Once this works in a browser, it will work from a scheduler.

### Step 5 — schedule it

Vercel's free tier only allows **one cron run per day**. `vercel.json` registers
that daily run as a safety net, but for real background operation use a free
external scheduler:

- [cron-job.org](https://cron-job.org) → new cron job
- URL: `https://your-app.vercel.app/api/tick?secret=YOUR_TICK_SECRET`
- Schedule: every 5–15 minutes

The endpoint also accepts `Authorization: Bearer YOUR_TICK_SECRET` if you'd
rather keep the secret out of the URL.

> If a scheduler was previously failing against this endpoint with a 404: the
> `/api/tick` function did not exist in earlier deployments. It does now.

---

## Deploying

The Vercel project `xauusd-smc-assistant` is linked to this repository, so a
push to the **production branch** deploys automatically.

Check which branch that is under **Vercel → Settings → Git → Production
Branch**. If it is not `main`, either change it to `main` or keep pushing to
whichever branch is set — a push to any other branch produces a *preview*
deployment, which will not update the live `xauusd-smc-assistant.vercel.app`
URL. A preview that looks correct while production still serves the old build
is almost always this.

Preview URLs sit behind Vercel Authentication, so opening one in a browser
bounces through an SSO redirect. Production is public. That means `/api/health`
and `/api/tick` are only reachable from an external scheduler once the build is
on **production**, not on a preview URL.

---

## API quota

Twelve Data's free tier allows ~8 requests/minute and 800/day. Refetching every
timeframe on every tick would exhaust the daily quota by mid-morning, so the
worker caches higher timeframes in Firestore and refreshes each on its own
schedule:

| Input | Refresh |
|---|---|
| 15min candles | every tick |
| 1H | hourly |
| 4H | every 4 h |
| Daily / Weekly | every 12 h / 24 h |
| Correlation | every 6 h |
| Fundamentals (FRED) | every 3 h |
| News (Alpha Vantage) | every 2 h |

A tick therefore costs about **one** Twelve Data request instead of eight, which
keeps a 5-minute schedule inside the free tier. This is covered by a test.

---

## Tests

```bash
npm install
npm test
```

`test/engine.test.mjs` covers the signal resolver and the autonomy gate —
including the case where one candle covers both stop and target, which is
resolved pessimistically as a loss (OHLC can't say which came first, and biasing
the training data toward scepticism is the right way to be wrong).

`test/tick.test.mjs` runs the whole background worker against a fake Firestore
and a stubbed network, and asserts both the dashboard field contract and the
caching behaviour above.

---

## A note on what this is

Pattern-based interpretation, not prediction. Order blocks, FVGs, structure
breaks and liquidity zones are readings that can be wrong, especially in choppy
or thin conditions. The meta-labeler learns from a few hundred examples at best,
which is a heuristic, not a trained model in any serious sense. Backtest results
do not carry over to live markets cleanly. Use it for analysis; it is not
financial advice.
