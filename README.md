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

## Why it may take no signals — the gate

Grade and confidence are **not independent controls**, which is the single most
confusing thing about the autonomous gate.

Grade is derived from confidence — A ≥70, B ≥50, C ≥30 — and then downgraded a
further step for a ranging market, and again if similar past setups disagree.
The gate then requires both a confidence floor *and* a grade floor. So setting
min confidence to 45 while demanding grade B does nothing: 45 grades as C and
is rejected on grade regardless.

### Confidence runs structurally low

Confidence is `|sum(factor x weight)| / sum(ALL weights)`. The denominator
includes every factor, **including ones that are silent** — an order block only
speaks when price is sitting inside one, a liquidity factor only when a sweep
just happened. A setup where ten of fourteen factors have no opinion is
therefore scored as low conviction even when everything that *is* speaking
agrees.

Ceilings, assuming every listed factor reads a perfect ±1 and all agree:

| Scenario | Max confidence | Grade |
|---|---|---|
| All 14 factors aligned (theoretical) | 100% | A |
| 5 timeframes + price action + order block | 65% | B |
| **All 5 timeframes agree, nothing else** | **49%** | C |
| 4 timeframes agree | 35% | C |
| 3 timeframes agree | 24% | D |

Grade A (≥70) needs nearly the whole framework to agree at once and is genuinely
rare. Ordinary market conditions sit in **D**.

This is a defensible design — a setup with little confluence *is* less certain —
but it means the grade bands are far tighter than they appear, and it is the
main reason an unattended engine can run for hours taking nothing.

### What the confidence number means

A bare "58%" is decoration. It looks like a probability and is not one, and it
is read against a scale that does not exist: the practical ceiling is about
**49%**, so 45% is near the top of the range rather than below average. The
signal panel therefore reports the number with the three things that give it
meaning.

**Where it sits.** Once 20+ signals are logged the bands are computed from the
system's *own* distribution — bottom, middle and top third of what this engine
actually produces — rather than from an uncalibrated 0-100. Below that the fixed
grade thresholds stand in, and the panel says which is in use. The bar shows the
score as a share of the realistic ceiling, not of 100.

**What it has meant.** The resolved record of past signals in the same band:
"Signals in this band have won 12 of 20 (60%) at +1.40R per trade. Net
profitable at this level." A win rate alone cannot answer whether a level makes
money — 20% at 4:1 is profitable, 45% at 1:1 is not — so the expectancy and the
verdict are stated outright.

**How much that is worth.** Sample size in the band, laddered: under 5 resolved
is not evidence and the panel says the number is an opinion, not a record; 5-11
is "an anecdote"; 12-29 is worth reading; 30+ is worth trusting. Alongside it,
whether confidence *discriminates* at all — if high-confidence setups are not
beating low-confidence ones, a big number is buying nothing, and the panel says
so in those words.

The explainer also states the breakeven win rate for the actual target on the
table. That is computed, not asserted: "a low win rate is still fine" is true at
4:1 (20% breakeven) and exactly wrong at 1:1 (50%).

Signal-log rows are coloured by the same bands and carry the same reading on
hover, so a column of bare percentages reads as high/mid/low *for this engine*.

When there is no record, the panel says there is no record. It never implies one.

### The grade floor in practice

At the default **B** floor:

| Confidence | Trending, history agrees | Ranging *or* history disagrees | Ranging *and* history disagrees |
|---|---|---|---|
| 45% | rejected (C) | rejected | rejected |
| 50–69% | **taken** (B) | rejected (C) | rejected (D) |
| 70%+ | **taken** (A) | **taken** (B) | rejected (C) |

A ranging market with disagreeing history cannot qualify at *any* confidence.
That is right for trading real money and far too tight for gathering data — a
cautious setup collects nothing, and the knowledge base never starts.

**Minimum grade is the knob that actually decides how much it trades.** Given
the ceilings above, a C floor still rejects ordinary conditions — use **D** to
genuinely collect, accepting that you are gathering low-conviction setups on
purpose so there are outcomes to learn from. *Use data-collection settings* in
the thresholds panel does this (grade D, confidence 15, cooldown 30 min, 5 open,
meta floor -0.5).

The panel tallies **why** each cycle ended, which matters because two causes
need opposite responses:

- *"No directional edge — engine flat"* — no setup existed. Loosening
  thresholds will not help; the market simply wasn't offering anything.
- *"Grade below floor"* — the filter is the blocker. Lower the grade floor.

Server-side, `/api/tick` takes the same thresholds from `TICK_GRADE_FLOOR` and
`TICK_MIN_CONFIDENCE` environment variables, and reports `gateCode` and
`gateReason` in every tick so the same diagnosis works without a browser.

---

## Kill switch — stale orders are a liability, not an opportunity

An order that rests for a day is not still waiting for its setup. The move it
was placed for has already happened. When price finally comes back to that
level it is **retesting a zone that is spent**, not offering the trade that was
analysed — and filling it there records an outcome the system would never
actually have taken. That is how a self-learning loop quietly poisons itself:
not with wrong answers, but with answers to questions it never asked.

Three arms, all configurable in the autonomy panel (and by environment variable
on the worker). Set any to `0` to disable that arm.

| Arm | Default | Env var | Fires when |
|---|---|---|---|
| Resting order | 12h | `TICK_KILL_FILL_HOURS` | A limit entry has not filled in that much **real** time |
| Open position | 72h | `TICK_KILL_OPEN_HOURS` | A filled position has neither hit its stop nor its target |
| Zone left behind | 1.5R | `TICK_KILL_DRIFT_R` | Price ran that much *further* from the entry without ever tagging it |

### Every live trade says whether it is still working

The log used to show `awaiting entry` or `filled` and nothing more. Both are
equally true of a trade placed a minute ago and of one that has been resting for
eleven hours with the kill switch about to take it — which is exactly the
distinction you need when scanning the list.

Each live row now carries a liveness chip:

```
● resting 1.0h · alive                 green
◐ resting 7.0h · going stale           amber   (past half its allotted time)
○ resting 11.0h · about to be killed   red     (85%+ of the way to the cull)
● running 5.0h · alive · +1.60R        green
○ running 70.0h · about to be scratched · -0.60R
```

A resting order is aged against the fill limit, a filled one against the hold
limit, and a filled limit ages from the **fill**, not from when the order was
placed. Hovering says when it will be cancelled or scratched, and how far price
sits from the entry. Filled positions also show progress in R, because a
position at -0.8R with an hour left is dead in every sense the clock alone
cannot express.

On the simulated feed no R reading is shown at all — a number computed from
generated candles is a made-up figure wearing a real one's clothes. The clock
half of the chip is true either way.

Ages refresh once a minute while anything is live, so a chip never sits frozen
at whatever it read when the log was last drawn.

### The clock is real time, not bars

The old expiry counted candles, inside the candle loop. That cannot fire when no
candle arrives — and "no candle arrives" is exactly when orders go stale: gold
is shut all weekend, a provider stalls, an API quota runs out. Real time keeps
passing while the bar counter is frozen, so an order could rest for days and
still be treated as live. Elapsed time is now checked **before any candle is
looked at**, so a weekend expires an order instead of freezing it.

Replays are told apart from live automatically: if the newest candle is more
than a week behind the wall clock, the newest candle *is* now. No live feed is
ever that stale and no weekend comes close, so a backtest is judged by its data
while a live order is judged by the clock. Callers that know pass `cfg.now`.

### The drift arm measures the right thing

A limit entry sits away from price by design — "retrace into the order block"
starts life below the market. Measuring drift from the entry alone would cancel
almost every order on its first bar. So the opening gap is the baseline, and
only movement **beyond** it counts as the market leaving the zone behind.

### A killed trade is not an outcome

Expired signals are never training data. No win, no loss, no factor votes, no
meta-labeler example. The paper order is **cancelled**, not closed, so no P&L is
invented from a trade that never happened, and the freed slot stops a dead order
blocking new signals through the `maxOpenSignals` cap.

The autonomy panel shows **Killed Stale** and **Oldest Resting** — the latter
ages each live trade against the limit that applies to it (a resting order
against the fill limit, a filled one against the hold limit) and turns amber at
75% of that limit, red past it. Log rows show `⊘ killed` with the reason.

## Economic release calendar

### Flattening: everything closes before the print

Standing aside from *new* trades was only half the protection. A position
already open rides straight into the release, and NFP routinely moves gold
further in ninety seconds than a normal stop is wide — with the spread widening
at the same moment, so the stop fills well past its level. Whatever comes out of
that says nothing about whether the setup was sound.

The escalation, for a high-impact release:

| Time before | What happens |
|---|---|
| 60 min | **Alert** — banner, and a desktop notification if permitted |
| 30 min | No new positions taken |
| **15 min** | **Open positions closed at market, resting orders cancelled** |
| 0 → +15 min | Still standing aside while the spike settles |

All four are configurable; flattening can be switched off entirely. Nothing is
flattened once the release has printed — there is no longer anything to get out
of the way of, and re-closing afterwards would cut short trades taken *since*.

**The money is booked, the verdict is not.** The position really was closed at
the market, so its P&L is real and belongs in the balance, the equity curve and
the drawdown. But the *signal* is recorded as `expired`, never won or lost, so a
scheduled release can never masquerade as evidence about the analysis. Same
principle as the kill switch.

That distinction reaches the account stats too: **win rate, profit factor and
average R are computed from graded trades only** — the ones that actually
reached their stop or target. Trades cut short by a rule are counted separately
as `cutShortCount`. Counting a flattened trade as a loss would claim the
analysis was wrong when nothing of the sort was established.

The check runs on its own 30-second timer and **immediately on load**, not only
inside an analysis cycle. Cycles can be fifteen minutes apart and a release does
not wait for one; a tab opened ten minutes before NFP must act at once rather
than on its first heartbeat. The worker does the same on every tick
(`TICK_NEWS_FLATTEN=0` to disable, `TICK_NEWS_FLATTEN_MIN` to change the lead) —
it needs this more than the browser does, since nobody is watching to do it by
hand.



The fundamental series tracked here are *published* numbers, which arrive with a
lag — they say what CPI was, never that CPI is out in twenty minutes. NFP, CPI
and FOMC routinely move gold tens of dollars in seconds: spreads widen, and a
stop sitting inside the noise gets taken on a spike that then reverses.

FRED publishes a forward release schedule, so this needs **no new provider and
no new key** — the same FRED key the correlation engine uses.

| Release | Impact | Time (ET) |
|---|---|---|
| Employment Situation (NFP) | high | 08:30 |
| Consumer Price Index | high | 08:30 |
| FOMC Press Release | high | 14:00 |
| Personal Income & Outlays (PCE) | high | 08:30 |
| Producer Price Index | medium | 08:30 |
| Retail Sales | medium | 08:30 |
| Gross Domestic Product | medium | 08:30 |
| Consumer Sentiment (UMich) | medium | 10:00 |
| Jobless Claims | medium | 08:30 |

By default the engine **stands aside from 30 minutes before to 15 minutes
after** a high-impact release. Medium-impact events warn but do not block,
adjustable in the panel. A blocked cycle records `gateCode: news` so the tally
shows it.

FRED supplies the date but not the time of day, so each release carries its
known publication time in US Eastern, converted with real DST rules — a fixed
offset would put every release an hour out for two thirds of the year.

The calendar is fetched **before** the gate consults it. Refreshing it at the
end of a cycle meant the first pass after a reconnect ran against an empty
calendar and could open a position straight into a release.

---

## Separating signal from noise

This is the part most likely to produce confident nonsense, so it is defended
three ways rather than trusted.

**The problem, quantified.** Seven drivers on sixty observations of *pure noise*
produce an in-sample R² of about **0.12**. The original `minR2` threshold was
0.08 — below what randomness gives you. Testing seven drivers at 5% each also
carries a **30%** chance that at least one looks real when none is, and refitting
daily makes a false positive a certainty rather than a risk.

**Three independent defences**, all of which must pass before a relationship is
called established:

| Test | Question it answers | Why it is needed |
|---|---|---|
| **Block permutation** | Does randomly reshuffled data produce a fit this good? | Assumption-free. Shuffling in blocks preserves the autocorrelation that makes spurious fits easy. |
| **Walk-forward R²** | Does it predict days it has never seen? | In-sample R² rises mechanically with drivers. Out-of-sample can go negative — and negative is the honest answer. |
| **Benjamini-Hochberg FDR** | Does it survive having six others tested alongside it? | Controls the *proportion* of false discoveries across the family. |

The tests are decisive in both directions and pinned as such:

- **Pure noise** → permutation p > 0.05, out-of-sample R² ≤ 0.02, hit rate ≈ 50%, nothing established.
- **Real signal** → permutation p < 0.05, out-of-sample R² > 0.5, hit rate > 70%, the true driver established and the spare ones rejected.

Permutation uses a fixed seed. Significance that changes between reloads would
itself be noise, and would make the whole exercise unfalsifiable.

When nothing passes, the panel says so first, before any coefficient:

> *Built from 300 accumulated observations, but nothing here is yet
> distinguishable from noise: randomly reshuffled data produces a fit this good
> 6% of the time, out-of-sample R² is −3% — worse than simply predicting the
> average. Still watching.*

---

## Independent audit

The auditor's remit is the whole pipeline, not just the reasoning at the end of
it. Three jobs:

**1. Is the analysis sound?** Price, R:R, stop distance against independently
recomputed ATR, and the direction implied by the factor weights are all
re-derived from raw candles and compared. Nothing the engine claims is taken on
trust — an auditor that reuses the engine's own numbers is the engine agreeing
with itself.

**2. Was it given the truth?** A feed can be perfectly well-formed and still be
wrong, and none of these announce themselves:

| Fault | What it looks like without the auditor |
|---|---|
| Open/close outside the bar's own range | Impossible bars become swing points |
| Prices outside anything gold trades at | A wrong symbol, or a decimal shift — chart shape unchanged, every level off by 10x |
| A jump far beyond the feed's own volatility | A bad tick becomes structure |
| Many identical consecutive closes | A stalled provider is indistinguishable from a flat market |
| Most bars with no high-low range | A padded or generated feed read as real |
| Timeframes disagreeing on the price | One series is a different instrument; MTF alignment is meaningless |
| A macro series frozen, or months out of date | A constant contributing to the score, or a number that stopped being true |

Every finding names **where**: the bar index, its timestamp, and the offending
values. And the verdict distinguishes the two cases, because "the analysis has
errors" would send you looking in the wrong place:

> ⛔ The data feeding this analysis is wrong — prices outside anything this
> instrument trades at. Nothing downstream can be trusted until the feed is fixed.

The audit re-runs whenever the feed changes — on connect and on every Generate —
not just at boot, since a stale clean audit is worse than none.

**3. Are the live trades still worth having?** See the kill switch below: the
auditor, not the engine, decides which resting orders and open positions have
gone stale, and it re-derives fill state from raw candles rather than trusting
the signal's stored status. That also catches bookkeeping that has drifted from
what price actually did — a "pending" order price already traded through, or an
"open" position that never filled.

It never silently overrides anything. It returns verdicts; applying them is the
caller's job.

### What it caught

**Every macro number in the system was computed from 1976–2006 data.**

FRED applies `limit` *after* sorting, and the request used `sort_order=asc`. So
asking for 120 observations returned the 120 **oldest** the series had ever
published:

| Series | What arrived | Should have been |
|---|---|---|
| DGS2 (2Y Treasury) | Jun–Nov **1976** | last ~4 months |
| VIXCLS | Jan–Jun **1990** | last ~4 months |
| DFII10 (10Y real yield) | Jan–Jun **2003** | last ~4 months |
| T10YIE (breakeven) | Jan–Jun **2003** | last ~4 months |
| DTWEXBGS (broad dollar) | Jan–Jun **2006** | last ~4 months |

Nothing failed. The values were finite, correlations came out, the score looked
reasonable, the reasoning layer wrote confident sentences about the dollar. The
correlation was between gold's returns *this year* and the dollar's returns *in
2006*, zipped index by index. Both the browser and the worker had it.

Fixed by requesting `sort_order=desc` and re-sorting to oldest-first. Verified
against live FRED: every series now arrives 1–7 days old.

**A second fault in the same path:** correlation zipped the two series by array
position. Gold trades Sunday evening to Friday evening; FRED publishes on US
business days and skips federal holidays. Every holiday in the window offset the
pairing by a day for everything before it. On a test series where a single day
is missing, that turns a true correlation of 0.98 into 0.41. Correlation is now
aligned on the calendar via `alignByDay`, and refuses (returns null) rather than
reporting a number when the overlap is too small — or when a series only moves
at the far end of floating point, where Pearson's denominator is not quite zero
and it will happily return a correlation made entirely of rounding error.

**The accumulated knowledge was discarded once.** Every observation paired a
current gold day with driver values from the wrong decade. The rows cannot be
repaired and cannot be told apart by day — the day was right, only the drivers
were wrong. The store carries a schema marker so this happens exactly once, and
the panel says what was cleared and why, because a knowledge base that silently
returns to zero looks like a bug.

**And the staleness threshold itself was wrong.** It used a flat 45 days, which
false-alarms on any monthly series and lets a dead daily one run for six weeks.
It now measures each series against its own widest observed publication gap, so
a daily rate is late after ~12 days and monthly CPI is not late until it has
missed a print.

### The proxy enforces recency, whatever the caller asks

`/api/fred` returns the **most recent** observations, oldest-first, regardless of
the `sort_order` the caller sends. That is not a convenience — it is the last
line of defence against the failure that started all this.

FRED applies `limit` after sorting, so `sort_order=asc&limit=48` returns the 48
*oldest* observations a series ever had: 1913 for PPI, 1947 for CPI, 1954 for the
Fed funds rate. It fails silently. The values are real, the arithmetic works, and
a confident number comes out the other end describing the Eisenhower
administration.

This proxy exists solely to serve this app, and every caller in it wants
recency — so recency is the contract rather than a parameter each caller has to
remember. It also means a **browser still running a cached pre-fix `app.js` gets
correct data anyway**, without needing to reload first, which matters because
that tab has no way of knowing it is wrong. When an `asc` request is overridden
the response says so in `proxy_note`. `oldest=1` opts out, for the rare case
where the start of a series is genuinely wanted.

### Why a tab can still show the old numbers

The fix shipping does not mean your open tab is running it. This app is built to
be left open for days doing unattended analysis, so a tab goes on running the ES
modules it loaded when it was opened — including whatever bug the new version
fixes. That is not hypothetical: it is exactly how the 1976–2006 macro data
could still be on screen after the fix deployed.

Two things now guard that:

* **The tab checks its own build.** It compares the ETag of `app.js` against the
  one it saw at startup, at boot and every 30 minutes. When they differ, a
  banner says the running code is superseded and offers a reload. No version
  constant to keep in sync and no build step — the server already sends
  `must-revalidate`, so the check is a conditional HEAD.
* **The worker's cache signature covers how data was fetched, not just which
  instruments were asked for.** Cached macro values live in Firestore for hours,
  so a fix to the *retrieval* would otherwise keep being ignored while the
  worker served results the old code had collected. The FRED sort order was
  precisely that case: the instrument set never changed, so the signature
  matched, so the 1976–2006 values stayed in service after the fix shipped.

And every macro row — correlation and fundamental alike — now carries the
publication date of its newest observation, amber past 45 days and red past 120.
The whole episode was possible because nothing on screen carried a date.

### The higher timeframes could freeze without a word

Two faults that only mattered together, and together were the most consequential
thing in the system.

**The resyncs swallowed their own failures.** The 1H, 4H, daily and weekly
refetches each ended in `.catch(() => {})`. A failure was completely silent: the
series stopped updating while the engine went on scoring structure off it.

**Nothing audited their age.** `auditFreshness` watches the 15-minute feed;
`auditCrossSeries` compares the timeframes' price *levels* but never their
*ages*. A 4H series frozen nine days ago still holds a perfectly plausible gold
price, so it passed. Verified before fixing: a nine-day-stale 4H series produced
`No problems found`.

Weekly, daily, 4H and 1H carry roughly **45 of the composite's ~109 weight**, so
the largest block of the score could be describing a market from days ago at
full confidence.

Now: every resync reports its failures, and the audit checks each series against
**its own cadence** — staleness measured in *bars missed*, so three hours is
nothing for a weekly series and an outage for a 15-minute one.

There is also a quieter case on the connect path, which did not fail silently so
much as fail *invisibly*: when a higher timeframe cannot be fetched the series is
set empty, and the engine then **aggregates** that timeframe from 15-minute
candles. That is a reasonable fallback and it is not the same thing — the score
still reports 4H trend at full weight while reading synthesised bars. The banner
now says which is happening.

### The trading week, properly

Fixing the above surfaced a third: the weekend model excluded whole UTC *days*,
but gold trades Sunday ~22:00 UTC to Friday ~21:00 UTC. Those few hours of
phantom Friday evening were enough to make a normal Friday close read as a
stalled feed all weekend. `isMarketOpen` now models the real session, which also
makes the data-coverage percentage correct rather than approximately correct.

### Earlier finds

The feed checks found a real bug on their first run. `genData`, the demo feed
the app shows before you connect and the one the backtest replays, computed each
candle's close as an average of the other four prices plus noise, with nothing
keeping it inside the bar. On a narrow range the noise pushed it past the high
or low, so a few percent of every generated series consisted of candles that
could not exist — and backtests ran on them. The close is now drawn first and
the extremes taken around it. (The same fix corrected `genData(n)` with no start
price silently producing an all-NaN series.)

### The original design

An auditor that reuses the engine's computed values is the engine agreeing with
itself, so this one takes nothing on trust. Where a claim can be re-derived from
raw candles, it is re-derived and compared.

**Arithmetic** — stop and target on the correct sides of entry, R:R recomputed
from the actual prices, direction checked against the weighted factor sum, stop
distance measured against an independently computed ATR (a stop inside half the
average range gets hit by ordinary movement, not by being wrong).

**Data integrity** — out-of-order or duplicate timestamps, high below low,
non-finite prices, gaps, and *coverage*: a uniformly thinned feed produces
regular spacing and no anomalous gap, yet half the market is invisible.
Comparing bars received against bars the span should contain catches it.

**Evidence** — whether the reasoning cites macro support the noise tests have
rejected, whether any driver has decayed, and whether confidence is being
reported when the record says it does not discriminate.

It **reports, never edits** — with one exception. A *critical* finding blocks an
autonomous trade (`gateCode: audit`), because an analysis that contradicts its
own arithmetic is not a risk preference and no confidence score should override
it.

Every check is tested by planting the specific fault and confirming it is
caught. Writing those tests found a genuine weakness — a feed missing a third of
its bars passed unflagged — which is why the coverage check exists.

---

## Market Reasoning

The engine collects far more than price — measured correlations, macro prints,
sentiment, session, regime, and the release calendar. Those were all just
numbers feeding a score, so the output could say *what* it thought without ever
saying *why*.

The reasoning panel assembles a causal reading from evidence the system already
holds:

- **What price is doing** — structure across five timeframes, and whether they
  agree. A split is reported as a split, since disagreeing timeframes are
  themselves the reason confidence is low.
- **What is driving it** — macro inputs ranked by *measured* correlation, not
  assumed relationships. "10Y Real Yield down 0.06pp (measured correlation
  -0.78), supportive of gold."
- **Whether those agree** — and when they do not, it says so. A move
  unsupported by its drivers is flagged as lower quality rather than averaged
  into a comfortable middle.
- **Context** — session, regime, sentiment (explicitly labelled the softest
  input, since it is a classifier reading headlines rather than a measured
  relationship), and what is scheduled next.
- **Why confidence is what it is** — including that silent factors count
  against the score.

**No language model is involved.** Every sentence derives from a number the
engine measured, which is what makes it checkable rather than plausible-sounding.

---

## Correlation basket

| Instrument | Source | Series | Type |
|---|---|---|---|
| Broad Dollar Index | FRED | DTWEXBGS | price |
| **10Y Real Yield (TIPS)** | FRED | **DFII10** | yield |
| **10Y Breakeven Inflation** | FRED | **T10YIE** | yield |
| Volatility (VIX) | FRED | VIXCLS | price |
| US 2Y Treasury Yield | FRED | DGS2 | yield |
| Silver | Twelve Data | XAG/USD | price |
| Bitcoin | Twelve Data | BTC/USD | price |

Oil (DCOILWTICO) and the S&P (SP500) were removed. Oil's relationship with gold
has historically been unstable, and the S&P's is indirect risk sentiment that
VIX already covers. Real yields are the cleanest single driver — gold pays no
coupon, so when the inflation-adjusted return on a risk-free bond rises, the
opportunity cost of holding metal rises with it. Breakeven inflation is the
other half of that decomposition and carries the inflation-hedge channel.

The nominal 10Y (DGS10) is deliberately **not** here: nominal = real +
breakeven by construction. A live check gave 4.75 against 2.44 + 2.35, so
carrying all three would count the rates channel twice and let redundancy
decide the weighting. The 2Y stays because the short end is policy
expectations, which is separate information from duration.

### Yields are not prices

A yield moving 0.05 → 0.10 is a **5 basis point** rise, not a 100% one. Worse,
DFII10 traded *below zero* through 2020–2022, and a percentage change with a
negative denominator flips the sign of a rise: −0.02 → 0.03 computes as −250%.

So every instrument declares `kind`. Yield series use absolute differences,
price series use percentage returns (`seriesDeltas` / `latestChangeOf`).
Correlation is scale-invariant, so comparing gold *returns* against yield
*changes* is sound — each side just has to be the right transform of itself.
This also fixed a latent bug in the pre-existing DGS10/DGS2 handling, dormant
only because those yields happen to be positive today.

Each instrument's influence is weighted by its **measured** correlation with
gold, not the assumed polarity, so a relationship that turns out weak shrinks
its own contribution toward zero. The `polarity` field is only a fallback for
when correlation cannot be computed yet.

---

## Partial take-profit

A 1:4 target on 15-minute structure can sit open for days, and an unrealised
target is not a profit — the trade is exposed the whole time it waits. So a
setup banks at **50% of the distance to target** by default, unless its own
analysis says otherwise.

**The exception is conviction.** Grade A/A+, or a meta-labeler score at or above
`holdIfMetaScore` (0.35), runs to the full target. Clipping every winner would
cut short exactly the trades that pay for the losers.

Three details that matter:

**The nearer level fills first.** When one candle spans both the partial and the
full target, the partial books it. Price had to travel through the halfway mark
to reach the target, so a resting partial order is already gone by then. Booking
the full target would credit reward a real exit never collected.

**The stop still wins an ambiguous bar.** Unchanged — if a candle covers the
stop and a profit level, it resolves as a loss, since OHLC cannot say which came
first.

**It changes what the engine learns, not just P&L.** Signals resolve at the
level they actually exited, so a banked half-target records as a ~2R win, not
4R. That is deliberate: `signalRMultiple` uses the real exit price rather than
assuming the target, so expectancy, the gate audit and the calibration table all
measure the strategy you are actually running. A simulator that books unearned
reward trains the meta-labeler on a strategy that does not exist.

Configurable in the Paper Trading panel: the fraction, the conviction threshold,
and a switch to turn it off entirely and restore full-target-only behaviour.

---

## Data Collected — how much it actually knows

Most of the learning machinery sits dormant below a threshold, and none of that
is visible from the outside. It is easy to run for days assuming learning is
happening when every store is still short of the point where it does anything.

The panel counts each store and shows how far it is from mattering:

| Capability | Needs | What it unlocks |
|---|---|---|
| Knowledge base | 15 resolved outcomes | auto-tunes the factor weights |
| Meta-labeler | 15 labelled examples | scores setup quality at all |
| Calibration | 8 resolved signals | whether confidence discriminates |
| Gate audit | 10 resolved declines | whether the filter is too tight |
| Journal insights | 5 resolved trades | per-session breakdown |

It also shows **per-factor evidence** — a factor only learns from outcomes where
it actually voted, so an order block can sit at 3 votes while the headline
count reads 12. A factor needs 5 votes before its win rate is shown at all.

### The two learning stores are separate — the trade log is not

The browser keeps its learning in `localStorage` (and in Firestore under
`users/<uid>` when signed in). The background worker keeps its own in Firestore
under `system/worker`. **Neither reads the other's factor statistics.** They
accumulate independently, so the totals are shown side by side rather than
summed — adding them would imply a shared brain that does not exist.

If you want one pool of *learning*, the worker is the one to trust: it runs
whether or not a tab is open.

The **trade log is shared**, and that is deliberate. A trade the worker took at
3am is not a different trade because the tab was closed, so the worker publishes
its recent trades to `system/workerSignals` and the dashboard merges them into
the signal log as they arrive. Each row says where the trade came from — ✋
manual, ⚙ auto (this tab), ☁ worker — and carries its paper result. Merged
trades are graded server-side and arrive already won or lost; the Won/Lost
buttons remain as a manual override.

Merge rules: same `id` is the same trade; the more resolved copy wins (a status
only moves forward, so a stale cached copy can never reopen a graded trade); at
equal resolution the local copy wins, so a mistake note typed here is never
overwritten. Learning is applied exactly once per trade, tracked by a flag on
the trade itself so a reload, a cloud pull and a worker merge cannot triple-count
the same outcome.

`system/workerSignals` exists separately from `system/worker` because the
worker's own document carries its candle cache — hundreds of KB the browser has
no reason to re-download every tick. The published copy is the most recent 150
trades, trimmed to the fields the log renders and the fields the meta-labeler
learns from.

---

## Paper trading — a simulated account

**Simulated only. No broker, no money, no orders leave the page.** Off by
default, and independent of autonomous mode: signals generated by hand open
positions too.

The learning loop already grades signals against real price. What this adds is
the accounting a signal log cannot show — position sizing, money P&L, equity,
drawdown. It is the difference between *"62% of signals won"* and *"this would
have been up 4.3% with an 11% drawdown"*, and only the second tells you whether
the analysis is worth anything.

### Sizing is in lots

A broker quotes XAUUSD in lots: one standard lot is **100 troy oz** and orders
move in **0.01-lot steps**. The account used to size in raw ounces — "5.26
units" — which is not a size you can place anywhere.

Rounding to a real step also makes the simulation honest. A position cannot be
sized to arbitrary precision, so the risk actually taken differs slightly from
the risk requested, exactly as on a live account. Both numbers are recorded, and
the P&L and R-multiples are built from the **taken** one. Sizes round *down*, so
the account never risks more than asked.

| Setting | Meaning |
|---|---|
| Sizing | `Risk %` — lots follow the stop, every trade risks the same percentage. `Fixed lots` — size is constant, risk varies with the stop. |
| Fixed lot size | The size placed in fixed mode |
| Contract size | Ounces per standard lot (100 for XAUUSD) |
| Lot step | Smallest increment the broker accepts |
| Minimum lots | Below this there is no trade to place |

Below the minimum the account refuses and says why, rather than inventing a
fractional position no venue would fill:

> No paper position opened: the trade would need 0.0049 lots, below the 0.01
> minimum — the stop is too wide for this balance at 1% risk (raise the risk
> percentage or the starting balance).

Positions opened before lots existed still render: their lot count is derived
from the ounces rather than assumed present.

### Settings persist

Only the paper account's balance and the autonomy thresholds were ever saved.
Everything else a person could change — risk per trade, spread, slippage, max
concurrent, the partial-take-profit rules, all fourteen factor weights, the
target R:R, every backtest parameter, the news-window settings — was read
straight off the DOM and lost the moment the page reloaded. Tuning was something
you had to redo from memory each session, and an autonomous run reverted to
defaults after any refresh without saying so.

They now save as you change them and are restored **before the first analysis
runs**, so the weights are in force when it does. A short "Settings saved."
confirms it. Resetting the weights persists too, so the reset is not undone by
the next reload.

API keys are deliberately not swept up here — they stay opt-in through
*Remember keys*.

### Live trades advance whether or not autonomy is on

Filling, grading and culling live trades used to happen **only inside the
autonomous cycle**. With autonomy off, a signal generated by hand opened a paper
order — and most plans are a limit, "retrace into order block" — and then
nothing ever touched it again. It could not fill, could not resolve, could not
be killed by the kill switch. It simply rested forever while the account
reported `OPEN 0`, no P&L and an unchanged balance, which reads exactly like
paper trading having ignored the trade.

Manual trading is a first-class path, so the resolver now runs on its own
cadence for everyone: every 30 seconds, immediately after Generate (a market
entry is live the moment it is taken), and whenever fresh candles arrive. It
only touches pending and open signals, so overlapping with an autonomous cycle
is harmless.

### Two ways into the paper account

Autonomous mode and the Generate button run the same loop — analyse, log the
signal, place the trade. Autonomy just does it on a heartbeat instead of on a
click. So with paper trading on, pressing **Generate** places the trade exactly
as an unattended pass would; the only difference is who decided to run it.

Generate now says what it did, because silence used to be the answer to "why
did nothing happen":

```
Logged a BUY at $2004.10 (49% confidence, grade C).
  Paper position opened at $2004.40. Risking $100.00 on 24.39 units.

No trade taken: the engine reads HOLD — the factors are cancelling, so there
  is no direction to trade. Nothing was logged and no paper position was opened.

Logged a BUY at $2004.10 (49% confidence, grade C).
  No paper position opened: the book is full — 3 position(s) already open or
  resting, cap is 3 (raise "Max concurrent" in paper settings).
```

A HOLD is a decision, not a failure, and the button says so rather than doing
nothing quietly. There is deliberately no "trade it anyway" on a HOLD: with no
direction there is no plan — the entry, stop and target shown are a placeholder
built from ATR around the current price, identical whichever way you would take
it. Forcing a trade there would invent an outcome and feed it to the learning
loop, which is the one thing this system must not do. If the engine holds more
often than you want, the grade floor and confidence threshold are the controls.

Every other refusal is spelled out too — paper trading off, hand-made trades
excluded, a full book, a flat account, a plan whose stop sits on its entry.

### Turning it on for a hand-made trade

The paper panel's switch is the account's master on/off. The **signal panel**
carries its own toggle — *"Paper-trade the signals I generate here"* — because
generating a trade by hand should not require going to another panel first.

* Ticking it while the account is off **switches the account on**, and the hint
  under it says so before you click. A toggle that silently did nothing would
  read as broken.
* Unticking it excludes only hand-made signals. Autonomous and worker trades
  keep opening positions, so turning off your own experiments never silences the
  unattended account.
* Either way the signal is still logged, graded and learned from. The toggle
  decides whether money is simulated against it, not whether it counts.

The choice persists, and the paper panel's status line says which mode it is in.

### A resting order is not a position

Most plans the engine produces are a **limit** entry — "retrace into order
block" — not a market fill. Such an order has no exposure until price reaches
the level, so it cannot have a profit or a loss.

Positions therefore mirror the signal's own fill state:

| State | Meaning | Floating P&L |
|---|---|---|
| `pending` | limit order resting, price hasn't reached it | **none** |
| `open` | filled, carrying exposure | live |
| `closed` | hit target, partial or stop | realised |
| `cancelled` | expired without ever filling | **exactly zero** |

An unfilled order that expires is **cancelled**, never booked at the current
mark — inventing a result from a trade that never existed is worse than
recording nothing. Resting orders still occupy a slot against the concurrency
cap, since a live order commits you.

A signal with no `entryType` is treated as a limit, matching `resolveSignal`'s
own default. Assuming "market" would re-create the phantom-P&L bug for any
record predating the field.

When enabled, every signal the engine logs opens a position sized so that being
stopped out costs exactly your configured risk percentage of the current
balance. The account compounds as it goes, so drawdown means something. The
position runs to the signal's own take-profit or stop, and closes when the
signal does.

**Fills are deliberately pessimistic.** Entries pay the spread and stops take
slippage, so a nominal 1:4 winner returns slightly under 4R and a loss costs
slightly more than 1R. A simulator that assumes perfect execution produces
training data that teaches the wrong lesson.

**Positions never feed the learning loop.** The *signal* is the unit of learning
and already records its own outcome; a position is an accounting mirror of that
signal. If both reported, every trade would be counted twice in the factor
statistics. This is why closing is driven by the signal's verdict rather than
the position watching price itself.

| Setting | Default |
|---|---|
| Starting balance | $10,000 |
| Risk per trade | 1% of balance |
| Spread | 3 pips |
| Stop slippage | 1 pip |
| Max open positions | 3 |

Resetting the account clears simulated positions and P&L only — signals and
learning data are untouched.

---

## Analysis Quality — auditing its own judgement

This is deliberately not about predicting better. It is about the engine being
honest with itself on **one pair**, which is where single-market specialisation
actually pays: enough resolved gold trades accumulate to say something real.

Three questions, none of which a person can answer about themselves:

**Is the confidence score meaningful?** Saying "72%" and being right 72% of the
time are unrelated skills. The panel splits the resolved record into a
high-confidence half and a low-confidence half and compares them. If
high-confidence setups do not win more often, the number is decoration — and
the panel says so plainly, including when confidence is *inverted*.

Note the target is not "70% confidence → 70% win rate". At a 1:4 target a 30%
win rate is profitable, so everything is scored in **R** (average profit per
unit risked) rather than win rate, which flatters a strategy that takes small
wins and large losses.

**Where does the edge actually live?** Win rate and expectancy broken down by
session, market regime, grade and direction. A strategy that works in trending
conditions and bleeds in ranging ones shows up as exactly that, instead of
averaging into a mediocre whole. Groups with fewer than 3 resolved trades are
withheld rather than shown as a confident-looking number.

**Were the rejected setups actually bad?** Every setup the gate turns down is
recorded as a *shadow signal* and resolved against real price anyway — same
resolver, but it never trains the weights. Comparing the expectancy of declined
setups against taken ones answers the question no trading journal can, because
nobody records their non-trades. If the rejected pile is outperforming, the
filter is too tight and the panel says to loosen it.

Everything here refuses to report on small samples. A reassuring number built on
four trades is worse than no number, because it gets believed.

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

## API quota — Twelve Data free tier

The free tier allows **800 credits/day and 8/minute**, and the browser and the
background worker share one key. Exhausting it does not degrade gracefully:
every later call fails, so an over-eager afternoon blinds the engine for the
rest of the day, worker included.

### What it actually costs

| | credits/day |
|---|---|
| Browser, autonomous mode, tab open 24h | **285** |
| Worker, cron every 15 min | 141 |
| Worker, cron every 10 min | 189 |
| Worker, cron every 5 min | 333 |

Browser + a 15-minute cron is ~426/day, comfortably inside 800. Browser + a
5-minute cron is ~618/day, which still fits but leaves little slack.

### How it stays inside the limit

**The worker caches higher timeframes** in Firestore and refreshes each on its
own schedule, so a tick costs ~1 credit instead of 8:

| Input | Refresh |
|---|---|
| 15min candles | every tick |
| 1H | hourly |
| 4H | every 4 h |
| Daily / Weekly | every 12 h / 24 h |
| Correlation (3 credits) | every 6 h |
| Fundamentals (FRED) | every 3 h — free, not metered |
| News (Alpha Vantage) | every 2 h — separate quota |

**The browser meters every call against a daily budget**, shown live in the
Autonomous Mode panel. The cap is split rather than shared, so budgeting can
never throttle the core function:

- A **reserve** is ring-fenced for the analysis path — fresh candles, signal
  grading, re-analysis. Nothing else can touch it.
- Everything else competes for the **remainder**: *low* (price ticks,
  correlation) stops at 65% of that remainder, *normal* (higher-timeframe
  refreshes) at 100% of it.

The reserve is sized from the cadence you actually configured, so tightening
the interval claims more budget automatically instead of quietly running short
later in the day:

| Analysis interval | Cycles/day | Reserve | Discretionary pool |
|---|---|---|---|
| 5 min | 288 | 399 | 101 |
| 10 min | 144 | 205 | 295 |
| 15 min (default) | 96 | 140 | 360 |
| 30 min | 48 | 75 | 425 |

Even with the **entire** cap spent, autonomy does not stop: it keeps grading
open signals and re-analysing on the last candles fetched, and the panel says
*"Running on cached candles — daily API budget spent"* rather than showing stale
numbers as if they were current. Degraded, not dead, and never silently.

The browser cap defaults to **500**, below the 800 tier limit on purpose — the
rest is reserved for `/api/tick`, so a tab left open cannot starve the worker.
Adjustable under *thresholds*. The counter resets at 00:00 UTC and counts
conservatively: a call is charged before it is made, so a failed request still
costs budget rather than silently under-reporting.

FRED is free and effectively unmetered. Alpha Vantage has its own much tighter
free limit (~25/day), which is why news refreshes only every 2 hours.

---|---|
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
