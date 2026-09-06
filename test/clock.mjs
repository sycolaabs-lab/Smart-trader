// ONE "NOW" FOR THE WHOLE TEST HARNESS
// ------------------------------------------------------------
// Four times in one week of work, a suite passed on a weekday and failed on a
// Saturday, and each time the failure looked like a bug in the code rather than
// in the test. The cause was always the same shape: a fixture built from the
// wall clock, checked against an engine that has opinions about the calendar.
//
// The engine now has several. Gold's week ends Friday 21:00 UTC. Orders age in
// tradeable hours. The book is flattened before the weekly close. Analysis
// stands down while the market is shut. A fixture dated "three hours ago" means
// something different on a Sunday than on a Wednesday, so a suite built on it
// is measuring the day it ran on.
//
// So nothing in test/ reads the wall clock. Everything starts here.

// Wednesday, 2 September 2026, 12:00 UTC.
//
// Chosen deliberately: midweek, so the market is open and no weekend rule
// fires; midday, so a fixture can reach several hours in either direction and
// stay inside the same trading day; and 12:00 UTC puts it in the London-NY
// overlap, the session most of the engine's session logic cares about.
export const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

// Friday, 4 September 2026, 20:00 UTC — one hour before the weekly close.
//
// For suites whose fixtures reach back further than NOW allows. Ninety hours
// before this is still Tuesday, so "N hours ago" stays inside one trading week
// and tradeable hours equal elapsed hours. Anything testing the close itself
// should use an explicit offset from here rather than a second constant.
export const LATE_WEEK = Date.UTC(2026, 8, 4, 20, 0, 0);

// Sunday, 6 September 2026, 12:00 UTC — market shut, ten hours from the open.
export const CLOSED = Date.UTC(2026, 8, 6, 12, 0, 0);

export const MINUTE = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;

// Relative helpers. `at` defaults to NOW so a suite that wants the common case
// writes agoHours(3) and nothing else.
export const agoHours = (h, at) => (at == null ? NOW : at) - h * HOUR;
export const agoMinutes = (m, at) => (at == null ? NOW : at) - m * MINUTE;
export const isoAgo = (h, at) => new Date(agoHours(h, at)).toISOString();

// Pin a Playwright page's clock, so Date.now() inside p.evaluate agrees with the
// fixtures built out here in Node. Call it BEFORE the first goto — a page that
// has already booted has read the wall clock.
//
// setFixedTime rather than install: install pauses timers, and several suites
// depend on the app's own 30-second watch and polling actually running.
export async function pinPage(page, at) {
  await page.clock.setFixedTime(new Date(at == null ? NOW : at));
}
