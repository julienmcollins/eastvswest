/**
 * THE MIGRATION SEAM.
 *
 * Exactly one file changes when the API moves off the origin that serves this page.
 * Nothing else in public/ may mention a host, a port, or an origin.
 *
 * `''` means "same origin": every request is issued as a root-relative path
 * (`fetch('/api/me')`), which is what we want while server/http/static.js is still
 * serving public/ from the same Node process.
 *
 * At deploy time the ONLY edit here is adding the Pages host to the table below,
 * pointing at the API origin:
 *
 *     'www.example.com': 'https://api.example.com',
 *
 * and widening the CSP `connect-src` in index.html to the same origin **in the same
 * commit** — otherwise the site silently stops talking to its own API with no 4xx to
 * debug. See docs/SPEC.md "Deferred to deploy time" items 2 and 4.
 *
 * Note this module reads `location` behind a `typeof` guard so it can be imported in
 * Node by test/frontend-contract.test.js.
 */

/** Bumped in every `?v=` import query in index.html and in the module imports below,
 *  so a contract change cannot be served from a stale HTTP cache. */
export const MODULE_VERSION = '1';

/** Mirror of API_SCHEMA in server/contracts.js. A mismatch against the `schema` field of
 *  /api/me or /api/leaderboard shows a "reload to update" banner rather than rendering a
 *  payload we may misread. */
export const API_SCHEMA = 1;

/** Mirror of TEAMS / TEAM_LABELS in server/contracts.js. The wire always carries the
 *  uppercase literal; the label is presentation only. No case translation anywhere. */
export const TEAMS = Object.freeze(['EAST', 'WEST']);
export const TEAM_LABELS = Object.freeze({ EAST: 'East', WEST: 'West' });

/** Non-HttpOnly cookie holding the CSRF token, read by api.js for the double submit. */
export const CSRF_COOKIE = 'bc_csrf';

/** localStorage key for the bearer token. Only ever populated from the URL fragment on
 *  the cross-site deploy path (docs/SPEC.md "Deferred to deploy time" item 5); on the
 *  same-origin/shared-domain path it stays empty and the cookie does all the work. */
export const TOKEN_STORAGE_KEY = 'bc_token';

/** How long a `409 sync_in_progress` poll runs before it gives up and un-pends the
 *  button. Bounded on purpose: without the ceiling the spinner never clears. */
export const SYNC_POLL_INTERVAL_MS = 2000;
export const SYNC_POLL_MAX_MS = 15000;

const SAME_ORIGIN = '';

/**
 * hostname -> API base. Absent hosts fall back to same origin, which is right for every
 * local and single-origin deployment and is the state this project ships in today.
 */
const API_BASE_BY_HOSTNAME = Object.freeze({
  localhost: SAME_ORIGIN,
  '127.0.0.1': SAME_ORIGIN,
  '[::1]': SAME_ORIGIN,
  '::1': SAME_ORIGIN,
  '0.0.0.0': SAME_ORIGIN,
  '': SAME_ORIGIN, // a file:// URL has an empty hostname
});

/**
 * Resolve the API base for a hostname. Pure, so a test can assert the seam without a
 * browser.
 *
 * @param {string} hostname e.g. `location.hostname`
 * @returns {string} origin with no trailing slash, or `''` for same origin
 */
export function apiBaseFor(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  // hasOwn, not `in`: a hostname of "constructor" must not resolve to Object.prototype.
  return Object.hasOwn(API_BASE_BY_HOSTNAME, host) ? API_BASE_BY_HOSTNAME[host] : SAME_ORIGIN;
}

/** The resolved base for this page load. `''` today. */
export const API_BASE = apiBaseFor(typeof location === 'undefined' ? '' : location.hostname);
