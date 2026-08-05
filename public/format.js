/**
 * Pure formatting and URL-sanitising helpers. No DOM, no fetch, no module-level side
 * effects beyond building the Intl formatters, so this file is directly importable in
 * Node by test/frontend-contract.test.js.
 *
 * Every function here is TOTAL: given literally any input it returns a string (or the
 * documented fallback) and never throws. That is not politeness — render.js calls these
 * inside `riders.map(...)`, so a single throw on one malformed rider blanks the whole
 * roster with no error visible to the user.
 */

/** Rendered for a null rank, and for any value we cannot format. U+2014. */
export const EM_DASH = '—';

/** Local asset served for a rider with no usable avatar. Relative: the Pages artifact
 *  root is public/, so a root-absolute path 404s under a project-site subpath. */
export const AVATAR_FALLBACK = './assets/avatar-fallback.svg';

const MONTHS = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

// Pinned to en-US rather than the user locale: every other string in this UI is English,
// and a locale-dependent decimal separator would make the contract tests non-deterministic.
const MILES_FMT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const INT_FMT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * Distances arrive from the server already in miles, already rounded to 1 dp. This only
 * pads the display so columns line up; it never converts anything. The client never
 * divides by 1609.344.
 *
 * @param {unknown} value miles
 * @returns {string} e.g. `"412.8"`, `"1,423.7"`, `"0.0"`; EM_DASH if not a finite number
 */
export function miles(value) {
  const n = Number(value);
  return Number.isFinite(n) ? MILES_FMT.format(n) : EM_DASH;
}

/**
 * @param {unknown} value
 * @returns {string} grouped integer, e.g. `"163"`; EM_DASH if not a finite number
 */
export function int(value) {
  const n = Number(value);
  return Number.isFinite(n) ? INT_FMT.format(n) : EM_DASH;
}

/**
 * `share` is precomputed server-side (both teams 0.5 when the total is 0), so this only
 * clamps and rounds for display.
 *
 * @param {unknown} fraction 0..1
 * @returns {string} e.g. `"54%"`; EM_DASH if not a finite number
 */
export function pct(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return EM_DASH;
  const clamped = Math.min(1, Math.max(0, n));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * `share` as a CSS percentage with one decimal, for the split bar width. Kept separate
 * from `pct` because the bar wants precision the label does not.
 *
 * @param {unknown} fraction 0..1
 * @returns {string} e.g. `"54.2%"`
 */
export function pctCss(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return '50%';
  const clamped = Math.min(1, Math.max(0, n));
  return `${(clamped * 100).toFixed(1)}%`;
}

/**
 * Coarse relative time. TOTAL: `null` (nobody has ever synced) is the expected input on
 * day one, not an error, so it gets an honest word rather than a crash or a blank.
 *
 * @param {unknown} iso ISO-8601 UTC timestamp, or null/undefined
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {string} `"never"` for null-ish, EM_DASH for unparseable, else e.g. `"2 hr ago"`
 */
export function relTime(iso, now = Date.now()) {
  if (iso === null || iso === undefined || iso === '') return 'never';
  if (typeof iso !== 'string') return EM_DASH;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return EM_DASH;

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return 'just now'; // also covers small clock skew into the future
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} days ago`;
  return `on ${shortDate(iso.slice(0, 10)) || iso.slice(0, 10)}`;
}

/**
 * Format a `YYYY-MM-DD` calendar date. Parsed with a regex rather than `new Date` on
 * purpose: `new Date('2026-06-01')` is midnight UTC, which formats as May 31 for anyone
 * west of Greenwich. Competition dates are calendar dates, not instants.
 *
 * @param {unknown} ymd
 * @returns {string} e.g. `"Jun 1"`, or `''` if unparseable
 */
function shortDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  if (!m) return '';
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return '';
  return `${MONTHS[monthIndex]} ${Number(m[3])}`;
}

/**
 * The competition window as one readable phrase.
 *
 * @param {unknown} start `YYYY-MM-DD`
 * @param {unknown} end `YYYY-MM-DD`
 * @returns {string} `"Jun 1 – Aug 31, 2026"`, or `"Dec 1, 2025 – Feb 28, 2026"` across a
 *   year boundary; EM_DASH if either date is unparseable
 */
export function dateRange(start, end) {
  const s = shortDate(start);
  const e = shortDate(end);
  if (!s || !e) return EM_DASH;
  const startYear = String(start).slice(0, 4);
  const endYear = String(end).slice(0, 4);
  return startYear === endYear
    ? `${s} – ${e}, ${endYear}`
    : `${s}, ${startYear} – ${e}, ${endYear}`;
}

/**
 * Sanitise an avatar URL for an `<img src>`. TOTAL — this is the trap that matters:
 * Strava hands back the bare relative string `avatar/athlete/large.png` for a photo-less
 * athlete, and `new URL('avatar/athlete/large.png')` THROWS. Uncaught inside
 * `riders.map(rowFor)` that one rider blanks the entire roster.
 *
 * The server already normalises non-https values to null; this is the second line of
 * defence, because the client must not depend on that to stay upright.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string} an absolute https: URL, or the local fallback asset
 */
export function safeAvatar(value, fallback = AVATAR_FALLBACK) {
  if (typeof value !== 'string' || value === '') return fallback;
  let url;
  try {
    url = new URL(value);
  } catch {
    return fallback; // relative string, empty, or garbage
  }
  return url.protocol === 'https:' ? url.href : fallback;
}

/**
 * Sanitise a link target for an `<a href>`. TOTAL, and allow-list based: only absolute
 * `https:` survives, which rejects `javascript:`, `data:`, `vbscript:`, `blob:`, `file:`
 * and protocol-relative junk without needing to enumerate them.
 *
 * Returns the fallback (`null` by default) rather than a string, so render.js can decide
 * to emit a plain label instead of a dead link.
 *
 * @param {unknown} value
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
export function safeHref(value, fallback = null) {
  if (typeof value !== 'string' || value === '') return fallback;
  let url;
  try {
    url = new URL(value);
  } catch {
    return fallback;
  }
  return url.protocol === 'https:' ? url.href : fallback;
}

/**
 * @param {unknown} team the wire literal `'EAST'` / `'WEST'`
 * @returns {string} display label, or the raw value if we somehow get a third team
 */
export function teamLabel(team, labels) {
  const table = labels ?? { EAST: 'East', WEST: 'West' };
  const key = String(team ?? '');
  return Object.hasOwn(table, key) ? table[key] : key || EM_DASH;
}

/**
 * @param {unknown} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string} e.g. `"1 rider"`, `"11 riders"`
 */
export function plural(count, singular, pluralForm = `${singular}s`) {
  const n = Number(count);
  if (!Number.isFinite(n)) return `${EM_DASH} ${pluralForm}`;
  return `${int(n)} ${n === 1 ? singular : pluralForm}`;
}
