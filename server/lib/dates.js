import { COMPETITION_STATES, MAX_PICKER_MONTHS } from '../contracts.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** Current unix time in whole seconds. */
export function epochSeconds(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000);
}

/** ISO-8601 UTC with a trailing Z, millisecond precision. Every timestamp on the wire. */
export function isoUtcNow(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

/** unix seconds -> ISO-8601 UTC string, or null for null/undefined. */
export function isoFromEpoch(seconds) {
  if (seconds === null || seconds === undefined) return null;
  return new Date(seconds * 1000).toISOString();
}

/** True for a well-formed, real YYYY-MM-DD calendar date. */
export function isCalendarDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  // Rejects 2026-02-30, which Date.parse would otherwise roll forward.
  return new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * Today's calendar date in the competition timezone, as YYYY-MM-DD.
 *
 * This is the ONLY source of "today" in the app. Reading it from the host clock's local
 * timezone instead would make `days_remaining` and the competition state shift when the
 * process moves from a laptop to a UTC server -- the same competition would be in two
 * different states depending on where the code ran.
 *
 * `en-CA` formats as YYYY-MM-DD, which is why it is used rather than a manual assembly.
 */
export function todayInTz(timeZone, nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

/** Add (or subtract) whole days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(dateStr, days) {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(t)) throw new TypeError(`addDays: bad date ${dateStr}`);
  return new Date(t + days * 86400_000).toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD strings (b - a). Negative if b precedes a. */
export function daysBetween(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / 86400_000);
}

/** Midnight UTC of a YYYY-MM-DD date, in unix seconds. */
export function epochAtStartOfDate(dateStr) {
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);
}

/** One second before midnight UTC of the day AFTER dateStr -- i.e. an inclusive end bound. */
export function epochAtEndOfDate(dateStr) {
  return epochAtStartOfDate(addDays(dateStr, 1)) - 1;
}

/* ------------------------------------------------------------------------- months ---- */

/**
 * EVERY CALENDAR MONTH IS ITS OWN COMPETITION.
 *
 * That is the product decision the rest of this section implements: there is no single
 * season with one winner, only a series of independent monthly races that the reader picks
 * between. `state` and `days_remaining` are therefore properties of the SELECTED MONTH, not
 * of the configured window -- see `monthStatus` below.
 *
 * Months are the string `YYYY-MM` everywhere: on the wire, in the query string, and in
 * every comparison. Because the format is fixed-width and zero-padded, a plain `<`/`>`
 * string compare is a correct chronological compare, which is why no Date is constructed
 * to order two months anywhere below.
 */

/** True for a well-formed `YYYY-MM` with a real month number. */
export function isCalendarMonth(s) {
  if (typeof s !== 'string' || !MONTH_RE.test(s)) return false;
  const month = Number(s.slice(5, 7));
  return month >= 1 && month <= 12;
}

/** The month a `YYYY-MM-DD` date falls in. A slice, never a parse. */
export function monthOf(dateStr) {
  return String(dateStr ?? '').slice(0, 7);
}

/**
 * Build a UTC midnight Date from a full year plus a possibly out-of-range month/day.
 *
 * `setUTCFullYear` rather than `Date.UTC`, because `Date.UTC` maps a two-digit year onto
 * 19xx: `Date.UTC(50, 1, 0)` is 1950, so a `0050-02` month would get 1950's February and
 * therefore 1950's leap-year answer. Out-of-range month and day indexes still normalize,
 * which is what makes December + 1 roll the year and day 0 mean "last day of the previous
 * month" instead of needing a leap-year table here.
 */
function utcMidnight(year, monthIndex, day) {
  const d = new Date(0);
  d.setUTCFullYear(year, monthIndex, day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function monthParts(month) {
  return [Number(String(month).slice(0, 4)), Number(String(month).slice(5, 7))];
}

/** First calendar date of a month, `YYYY-MM-DD`. */
export function startOfMonth(month) {
  return `${month}-01`;
}

/** Last calendar date of a month, `YYYY-MM-DD`. 28/29/30/31 all come out right. */
export function endOfMonth(month) {
  const [year, m] = monthParts(month);
  // Day 0 of the NEXT month is the last day of THIS one.
  const last = utcMidnight(year, m, 0).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

/** Add (or subtract) whole months, rolling the year. `YYYY-MM` in, `YYYY-MM` out. */
export function addMonths(month, n) {
  const [year, m] = monthParts(month);
  const d = utcMidnight(year, m - 1 + n, 1);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Clamp a month into `[lo, hi]`. Plain string compares; see the section note above. */
export function clampMonth(month, lo, hi) {
  if (month < lo) return lo;
  if (month > hi) return hi;
  return month;
}

/** Whole months from `a` to `b` counting BOTH ends, so the same month twice is 1. */
export function monthSpan(a, b) {
  const [ay, am] = monthParts(a);
  const [by, bm] = monthParts(b);
  return (by * 12 + bm) - (ay * 12 + am) + 1;
}

/** Earliest of the arguments, ignoring anything that is not a `YYYY-MM`. */
function minMonth(...months) {
  return months.reduce((best, m) => (isCalendarMonth(m) && (best === null || m < best) ? m : best), null);
}

/** Latest of the arguments, ignoring anything that is not a `YYYY-MM`. */
function maxMonth(...months) {
  return months.reduce((best, m) => (isCalendarMonth(m) && (best === null || m > best) ? m : best), null);
}

/**
 * The set of months a caller may select, plus which one is "now".
 *
 * THE RANGE IS A UNION, NOT A CONFIGURED WINDOW. Gating what a reader may browse on one
 * `COMPETITION_START`..`COMPETITION_END` season is a leftover of the model that "every calendar
 * month is its own competition" replaced, and it had a concrete, reported failure: a one-month
 * `.env` (START=2026-09-01, END=2026-09-30) made exactly one month selectable, so the client
 * hid the entire picker and the feature looked unimplemented. Three sources are unioned, each
 * of which is a month a reader can legitimately ask to see:
 *
 *   1. every month that HAS ride data (`dataMonths`, queried by the caller) -- rides are stored
 *      regardless of the configured window (server/strava/sync.js rule 1), so a month with real
 *      miles in it must never be unreachable;
 *   2. the CURRENT month in COMPETITION_TZ -- the only month that can be `open`. A range that
 *      excludes it is a picker that cannot show today, whatever else it offers;
 *   3. the configured `COMPETITION_START`..`COMPETITION_END` months -- so an explicitly
 *      configured season is never NARROWER than it was before this rule, only wider.
 *
 * What comes back is a CONTIGUOUS run from the earliest to the latest of that union. Contiguity
 * is the point of returning a range rather than a set: `prev_month`/`next_month` step one month
 * at a time, so a hole in the middle would be a dead end that no client-side arithmetic could
 * see coming. Months inside the run with no rides render as an empty board, which is a supported
 * state on the first of every month anyway.
 *
 * `dataMonths` is OPTIONAL and omitting it degrades to the config-plus-clock range. It cannot be
 * read here because this module must stay database-free (server/config.js imports it), so every
 * request-serving caller passes it in -- see `selectableMonthBounds` in server/db/activities.js.
 *
 * @param {object} config
 * @param {number} nowMs
 * @param {{first: string|null, last: string|null}|null} dataMonths extent of stored ride data
 */
export function monthBounds(config, nowMs = Date.now(), dataMonths = null) {
  const today = todayInTz(config.competitionTz, nowMs);
  const currentMonth = monthOf(today);

  let firstMonth = minMonth(config.competitionFirstMonth, currentMonth, dataMonths?.first);
  let lastMonth = maxMonth(config.competitionLastMonth, currentMonth, dataMonths?.last);

  if (monthSpan(firstMonth, lastMonth) > MAX_PICKER_MONTHS) {
    const trimmed = addMonths(lastMonth, -(MAX_PICKER_MONTHS - 1));
    if (trimmed <= currentMonth) {
      // Normal overflow: drop the oldest months and keep the ones nearest now.
      firstMonth = trimmed;
    } else {
      // `lastMonth` is more than a cap's worth of months in the FUTURE, which only a typo
      // (`COMPETITION_END=2260-12-31`) produces. Anchoring the cap on it would trim the current
      // month out of its own picker, so the future end absorbs the trim instead. Priority order
      // is: the current month is always selectable, THEN the cap, THEN trim the oldest first.
      firstMonth = currentMonth;
      lastMonth = addMonths(currentMonth, MAX_PICKER_MONTHS - 1);
    }
  }

  return {
    today,
    firstMonth,
    lastMonth,
    currentMonth,
    /**
     * WHAT A REQUEST WITH NO `?month=` GETS -- and deliberately NOT just `currentMonth`.
     *
     * The RANGE widened to a union; the DEFAULT did not, and that asymmetry is the point. The
     * configured season is still the operator's statement about which month a reader should land
     * on, and it is also the floor of the months sync fetches (`computeSyncMonths`). Defaulting to
     * the current month regardless would mean that a September-only competition viewed in August
     * opens on August: a board that is guaranteed empty because those rides are never fetched,
     * captioned "open, 27 days to go" beside zero miles, which reads as a broken sync rather than
     * as a competition that has not started. Clamped into the configured season, that visitor
     * lands on September ("Not started yet") and can still reach August through the picker.
     *
     * Clamped a SECOND time into the surviving range, because the cap can trim the configured
     * season away entirely (`COMPETITION_START=1900-01-01` with a 1900 END). Without it this
     * would name a month the `<select>` has no `<option>` for -- the exact class of bug the old
     * single clamp existed to prevent.
     */
    defaultMonth: clampMonth(
      clampMonth(currentMonth, config.competitionFirstMonth, config.competitionLastMonth),
      firstMonth,
      lastMonth,
    ),
  };
}

/**
 * Resolve a caller-supplied `?month=` into `{month, start, end}`.
 *
 * Anything unusable -- absent, malformed, a 13th month -- falls back to the default month.
 * Routes validate the FORMAT strictly and answer 400 before getting here (see
 * `requireMonthParam` in server/routes/leaderboard.js); this function is the last line of
 * defence, so a bug that skips that check degrades into "the current month" rather than
 * into SQL bound with `undefined`.
 *
 * A well-formed month outside the bounds is CLAMPED, not rejected, because GET /api/leaderboard
 * is contractually 200-always with no "no data" branch. Clamping is also why the bounds must be
 * the widened ones: with the old config-only range, `?month=2026-05` for a month that HAS rides
 * silently answered with a different month's board. Every month holding data is now inside the
 * range, so clamping can only ever discard a month that has nothing to show. The resolved month
 * is echoed back as `competition.month` so a client that asked for something else can correct
 * itself instead of guessing.
 *
 * @param {{firstMonth: string, lastMonth: string, defaultMonth: string}} [bounds] pass the
 *   widened bounds; omitting them silently narrows the range to config plus the clock.
 */
export function resolveMonth(config, month, nowMs = Date.now(), bounds = monthBounds(config, nowMs)) {
  const wanted = isCalendarMonth(month) ? month : bounds.defaultMonth;
  const resolved = clampMonth(wanted, bounds.firstMonth, bounds.lastMonth);
  return { month: resolved, start: startOfMonth(resolved), end: endOfMonth(resolved) };
}

/**
 * The `competition` block: everything true about ONE month's race.
 *
 * `state` is derived from the month alone, which is the whole point of the monthly model:
 *
 *   month  <  current month  ->  closed    (that race is over; the result is final)
 *   month === current month  ->  open      (riders are still out)
 *   month  >  current month  ->  upcoming  (nothing can have been ridden for it yet)
 *
 * `days_remaining` counts today as remaining, so the last day of the month reads "1 day
 * to go" rather than "0 days to go" while people are still riding, and it is 0 for any
 * month that is not the current one -- a finished race has no days left and a future one
 * has none yet. The client renders `state` first for those two, so the 0 is never shown.
 *
 * Note `current_month` is ALWAYS inside `[first_month, last_month]` now, because the range is a
 * union that includes it (see `monthBounds`). It is still reported separately rather than left
 * for the client to derive from a clock: the browser's clock is not COMPETITION_TZ, and a client
 * that decided for itself which option to badge "current" would disagree with the server's
 * `state` for the hours either side of a month boundary.
 *
 * @param {{firstMonth: string, lastMonth: string, defaultMonth: string, currentMonth: string,
 *          today: string}} [bounds] pass the widened bounds; omitting them silently narrows the
 *   range to config plus the clock, which is what hid the picker in the first place.
 */
export function monthStatus(config, month, nowMs = Date.now(), bounds = monthBounds(config, nowMs)) {
  // Re-clamped even when the caller already resolved it. Cheap, and it means this function
  // cannot be the one that emits a month the picker has no option for.
  const selected = clampMonth(
    isCalendarMonth(month) ? month : bounds.defaultMonth,
    bounds.firstMonth,
    bounds.lastMonth,
  );
  const end = endOfMonth(selected);

  let state = COMPETITION_STATES.OPEN;
  if (selected > bounds.currentMonth) state = COMPETITION_STATES.UPCOMING;
  else if (selected < bounds.currentMonth) state = COMPETITION_STATES.CLOSED;

  return {
    month: selected,
    start: startOfMonth(selected),
    end,
    state,
    today: bounds.today,
    days_remaining: state === COMPETITION_STATES.OPEN ? daysBetween(bounds.today, end) + 1 : 0,
    timezone: config.competitionTz,
    first_month: bounds.firstMonth,
    last_month: bounds.lastMonth,
    // Precomputed so the client never does month arithmetic to decide whether the prev/next
    // buttons are live; null IS the disabled state.
    prev_month: selected > bounds.firstMonth ? addMonths(selected, -1) : null,
    next_month: selected < bounds.lastMonth ? addMonths(selected, 1) : null,
    current_month: bounds.currentMonth,
    allowed_sport_types: config.allowedSportTypes,
    manual_rides_counted: config.countManualActivities,
  };
}
