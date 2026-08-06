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
export const MODULE_VERSION = '2';

/** Mirror of API_SCHEMA in server/contracts.js. A mismatch against the `schema` field of
 *  /api/me or /api/leaderboard shows a "reload to update" banner rather than rendering a
 *  payload we may misread. Bump BOTH SIDES in the same change: a bump here alone is
 *  indistinguishable from a stale cached module and every visitor gets the banner.
 *
 *  2: the month picker. `competition` describes one selected month. */
export const API_SCHEMA = 2;

/**
 * Hard ceiling on the number of `<option>` elements the month picker will build.
 *
 * MIRROR of MAX_PICKER_MONTHS in server/contracts.js, which caps `first_month`/`last_month` at
 * source; keep the two numbers equal or the `<select>` silently offers fewer months than
 * `prev_month` will step to. This copy is defence in depth: the server's range is a union that
 * includes every month holding ride data, so one activity row with a corrupt `start_date_local`
 * can widen it without anyone editing config, and the picker walks BACKWARDS from the last month
 * when it hits this so the months nearest "now" are the ones that survive.
 */
export const MAX_PICKER_MONTHS = 120;

/** Mirror of TEAMS / TEAM_LABELS in server/contracts.js. The wire always carries the
 *  uppercase literal; the label is presentation only. No case translation anywhere. */
export const TEAMS = Object.freeze(['EAST', 'WEST']);
export const TEAM_LABELS = Object.freeze({ EAST: 'East', WEST: 'West' });

/** Non-HttpOnly cookie holding the CSRF token, read by api.js for the double submit. */
export const CSRF_COOKIE = 'bc_csrf';

/** localStorage key for the bearer token. Only ever populated from the URL fragment on
 *  the cross-site deploy path, where the server runs with `AUTH_TOKEN_IN_FRAGMENT=true`
 *  (docs/SPEC.md "Deferred to deploy time" item 5); on the same-origin/shared-domain path it
 *  stays empty and the HttpOnly cookie does all the work. */
export const TOKEN_STORAGE_KEY = 'bc_token';

/** How long a `409 sync_in_progress` poll runs before it gives up and un-pends the
 *  button. Bounded on purpose: without the ceiling the spinner never clears. */
export const SYNC_POLL_INTERVAL_MS = 2000;
export const SYNC_POLL_MAX_MS = 15000;

const SAME_ORIGIN = '';

/**
 * ============================================================================
 * THE ONE EDIT THAT DEPLOYS THIS FRONTEND. Read the two rules before changing it.
 * ============================================================================
 * hostname -> API base. Absent hosts fall back to same origin, which is right for every
 * local and single-origin deployment and is the state this project ships in today.
 *
 * To go live, uncomment the PRODUCTION entry below and replace both halves with your real
 * hosts. `WEB_HOST` is what the browser's address bar says (the Pages host); the value is the
 * origin serving `/api/*`. `node scripts/deploy-setup.mjs` writes this line for you.
 *
 * RULE 1 -- SAME REGISTRABLE DOMAIN, OR THE BEARER PATH. Prefer two hosts on one registrable
 * domain (`www.example.com` + `api.example.com`): the session cookie stays first-party and
 * nothing else has to change. Cross-site (`you.github.io` + `<worker>.<account>.workers.dev`)
 * the cookie becomes a third-party cookie that Safari's ITP blocks unconditionally and Chrome
 * partitions, so OAuth appears to succeed and every later `/api/*` is anonymous, with no CORS
 * error and no 4xx to debug. That shape works ONLY with `AUTH_TOKEN_IN_FRAGMENT=true` on the
 * server, which hands the session token over in the callback's URL fragment for
 * `storeToken()` below to keep in localStorage. It is strictly less safe -- localStorage is
 * keyed per ORIGIN with no path component, so on `you.github.io` any other project that
 * account has published can read the token and impersonate any rider, admin included. See
 * docs/DEPLOY.md and docs/SPEC.md "Deferred to deploy time" items 1 and 5.
 *
 * RULE 2 -- WIDEN THE CSP IN THE SAME COMMIT. `connect-src 'self'` in the <meta> CSP of
 * BOTH public/index.html and public/404.html must gain this exact origin, or the browser
 * blocks every fetch to it and the site silently stops talking to its own API.
 * test/frontend-contract.test.js enforces the pair, so a half-done edit fails the suite
 * rather than the deploy.
 */
const API_BASE_BY_HOSTNAME = Object.freeze({
  localhost: SAME_ORIGIN,
  '127.0.0.1': SAME_ORIGIN,
  '[::1]': SAME_ORIGIN,
  '::1': SAME_ORIGIN,
  '0.0.0.0': SAME_ORIGIN,
  '': SAME_ORIGIN, // a file:// URL has an empty hostname

  // ---- PRODUCTION: uncomment and set both, then widen the CSP to match. ----
  // 'www.example.com': 'https://api.example.com',
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
