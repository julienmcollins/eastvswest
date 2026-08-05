import { randomBytes } from 'node:crypto';
import { safeEqual } from './hash.js';
import { HttpError } from '../http/respond.js';
import { COOKIES, ERROR_CODES } from '../contracts.js';

/**
 * CSRF defense for every state-changing route, applied once at the router level.
 *
 * Three independent checks, all required:
 *
 *   1. `Content-Type: application/json` — an HTML form can only send
 *      urlencoded/multipart/text-plain, so requiring JSON eliminates the entire
 *      "invisible auto-submitting form" class without any token at all.
 *   2. An `Origin` header present in the allowlist — the browser sets Origin on every
 *      cross-site request and script cannot forge it.
 *   3. `X-CSRF-Token` matching the `bc_csrf` cookie (double-submit) — a custom header
 *      cannot be sent cross-origin at all without passing a CORS preflight we control.
 *
 * WHY BUILD THIS NOW, when `SameSite=Lax` already covers most of it? Because at deploy time
 * the frontend moves to its own origin, and that single change removes SameSite's protection
 * from every mutating route simultaneously -- there is no per-route reminder and no error to
 * notice. It also shapes `public/api.js`: the fetch wrapper has to attach the header from
 * day one, which is much harder to retrofit into a working client than to start with.
 */

/** Fresh CSRF token. Same 256 bits as a session token; it is not secret from JS by design,
 *  only from other origins. */
export function issueCsrfToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Cookie attributes for `bc_csrf`, shaped for `http/cookies.js#serializeCookie`.
 *
 * `httpOnly: false` is the one place in this codebase where that is correct and deliberate:
 * the double-submit pattern requires JavaScript on our own origin to read the value and echo
 * it in a header. It is not a credential -- a session is still required -- so reading it buys
 * an attacker nothing unless they already have script execution on our origin, in which case
 * CSRF is the least of the problems.
 *
 * `Secure` is gated on config.isProduction, never on X-Forwarded-Proto, which the client can
 * spoof to downgrade the cookie.
 */
export function csrfCookieOptions(config) {
  return {
    httpOnly: false,
    secure: config.isProduction,
    // Lax, not Strict: the OAuth callback is a cross-site top-level navigation, and Strict
    // would withhold the cookie on exactly that request -- so the freshly logged-in rider
    // would have no CSRF token until a second navigation.
    sameSite: 'Lax',
    path: '/',
    // Matches the session lifetime. If this expired first, every mutating request would 403
    // with a valid session, which reads like a broken server rather than an expired token.
    maxAge: config.sessionTtlSeconds,
  };
}

/** Read one cookie from either a Map (what parseCookies returns) or a plain object. */
function cookieValue(cookies, name) {
  if (!cookies) return undefined;
  if (typeof cookies.get === 'function') return cookies.get(name);
  return Object.prototype.hasOwnProperty.call(cookies, name) ? cookies[name] : undefined;
}

/** One shared message and one shared code for all three failures: telling a caller which
 *  check they failed is free reconnaissance for no user benefit. */
function csrfFailed(reason) {
  const err = new HttpError(403, ERROR_CODES.CSRF_FAILED, 'Request blocked: missing or invalid CSRF token.');
  // Server-log only. Not in `extra`, which is spread into the response body.
  err.reason = reason;
  return err;
}

/**
 * Enforce CSRF on a mutating request. Returns nothing; throws HttpError(403) on any failure.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object} config
 * @param {{cookies: Map<string,string>|Record<string,string>}} ctx
 */
export function requireCsrf(req, config, { cookies } = {}) {
  const headers = req?.headers ?? {};

  // --- 1. Content type. ---
  // A cross-site <form> cannot produce application/json, so this check alone stops the
  // classic no-script CSRF. Parsed by splitting on ';' because a legitimate request carries
  // `application/json; charset=utf-8`.
  const contentType = String(headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') throw csrfFailed(`content_type:${contentType || 'absent'}`);

  // --- 2. Origin allowlist. ---
  // Origin is set by the browser on every cross-site request and on all CORS requests, and
  // page script cannot override it. A MISSING Origin is treated as a failure, not waved
  // through: the "some old browsers omit it" exception is what makes this check optional in
  // practice, and every browser this app supports sends it.
  const origin = String(headers.origin ?? '');
  if (origin === '' || !config.corsAllowedOrigins.includes(origin)) {
    throw csrfFailed(`origin:${origin || 'absent'}`);
  }

  // --- 3. Double-submit token. ---
  const headerToken = headers['x-csrf-token'];
  const cookieToken = cookieValue(cookies, COOKIES.CSRF);
  // safeEqual compares lengths FIRST -- node's timingSafeEqual throws
  // ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on unequal buffers, which would turn a wrong-length
  // token from a clean 403 into a 500. Never "fix" that by switching to ===.
  if (typeof headerToken !== 'string' || headerToken === '' || typeof cookieToken !== 'string' || cookieToken === '') {
    throw csrfFailed('token_absent');
  }
  if (!safeEqual(headerToken, cookieToken)) throw csrfFailed('token_mismatch');
}
