// Moves Node's idea of "now" to whatever FAKE_NOW says, so the whole suite can
// be run as if it were a Saturday, a Sunday, or five minutes before the Friday
// close. Loaded with --import; does nothing when FAKE_NOW is unset.
//
// This is the check that a grep cannot make. A suite is only genuinely
// date-independent if it produces the same result on every day of the week, and
// the only way to know that is to run it on every day of the week.
const fake = Number(process.env.FAKE_NOW);
if (Number.isFinite(fake) && fake > 0) {
  const Real = Date;
  const shift = fake - Real.now();
  class FakeDate extends Real {
    constructor(...args) {
      if (args.length === 0) super(Real.now() + shift);
      else super(...args);
    }
    static now() { return Real.now() + shift; }
  }
  FakeDate.parse = Real.parse;
  FakeDate.UTC = Real.UTC;
  globalThis.Date = FakeDate;
}
