import { COMPETITION_STATES } from '../contracts.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

/**
 * Competition state and remaining days, evaluated in the competition timezone.
 *
 * `days_remaining` counts today as remaining while the competition is open, so the last
 * day reads "1 day left" rather than "0 days left" while people are still riding.
 */
export function competitionStatus(config, nowMs = Date.now()) {
  const today = todayInTz(config.competitionTz, nowMs);
  let state = COMPETITION_STATES.OPEN;
  if (today < config.competitionStart) state = COMPETITION_STATES.UPCOMING;
  else if (today > config.competitionEnd) state = COMPETITION_STATES.CLOSED;

  let daysRemaining = 0;
  if (state === COMPETITION_STATES.OPEN) daysRemaining = daysBetween(today, config.competitionEnd) + 1;
  else if (state === COMPETITION_STATES.UPCOMING) daysRemaining = daysBetween(today, config.competitionEnd) + 1;

  return {
    start: config.competitionStart,
    end: config.competitionEnd,
    state,
    today,
    days_remaining: daysRemaining,
    timezone: config.competitionTz,
    allowed_sport_types: config.allowedSportTypes,
    manual_rides_counted: config.countManualActivities,
  };
}

/**
 * Resolve a caller-supplied ?start=&end= into a window, CLAMPED to the configured
 * competition bounds.
 *
 * Clamping rather than validating means a hand-edited URL can narrow the view but can
 * never widen it past the competition -- otherwise `?start=2000-01-01` would quietly
 * turn the leaderboard into an all-time ranking, and whoever has the longest Strava
 * history wins a competition they did not ride.
 */
export function resolveWindow(config, query = {}) {
  const lo = config.competitionStart;
  const hi = config.competitionEnd;

  let start = isCalendarDate(query.start) ? query.start : lo;
  let end = isCalendarDate(query.end) ? query.end : hi;

  if (start < lo) start = lo;
  if (start > hi) start = hi;
  if (end > hi) end = hi;
  if (end < lo) end = lo;
  if (end < start) end = start;

  return { start, end };
}
