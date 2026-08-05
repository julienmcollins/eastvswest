import { randomBytes } from 'node:crypto';
import { sha256b64u, hmacB64u, safeEqual } from './hash.js';
import { insertState, consumeState, enforceStateCap } from '../db/oauthStates.js';
import { HttpError } from '../http/respond.js';
import { epochSeconds } from '../lib/dates.js';
import { ERROR_CODES, OAUTH_FRAGMENT_ERRORS, OAUTH_STATE_TTL_SECONDS, OAUTH_STATE_MAX_ROWS } from '../contracts.js';

/**
 * The OAuth `state` parameter: unguessable, signed, expiring, single-use, and -- the part
 * that is easy to skip and impossible to add later without a schema change -- BOUND TO THE
 * BROWSER that started the flow.
 *
 * ==========================================================================
 * WHY THE COOKIE NONCE EXISTS. Read this before "simplifying" anything here.
 * ==========================================================================
 * Signing the state and consuming it once does NOT stop login CSRF. The attack:
 *
 *   1. The attacker hits /api/auth/strava/login themselves and gets a genuine, correctly
 *      signed, unused `state`.
 *   2. The attacker completes Strava's consent screen with THEIR OWN Strava account and
 *      stops at the callback URL, capturing a genuine `code` + `state` pair.
 *   3. The attacker mails that callback link to the victim.
 *   4. The victim's browser follows it. Every signature check passes, the state has never
 *      been consumed, nothing is expired. The server exchanges the code, gets the
 *      ATTACKER's athlete id, and issues the victim a session for the attacker's account.
 *
 * The victim is now silently logged into an account the attacker also controls -- so the
 * attacker sees and controls everything the victim does in it. HMAC does not help: the
 * state is genuine. Single-use does not help: it has not been used yet.
 *
 * The fix is that a state must only be redeemable by the browser that requested it. On
 * login we mint randomBytes(32), put it in an HttpOnly `bc_oauth` cookie, and store only
 * its SHA-256 in oauth_states.nonce_hash. At callback time the presented cookie nonce must
 * hash to the stored value. The attacker cannot plant that cookie in the victim's browser
 * (HttpOnly, and scoped to our own origin), so their link dies at step 4.
 */

/** How stale a state may be. Long enough for a slow consent screen, short enough to bound
 *  the table -- GET /login is unauthenticated and writes a row. */
const TTL_SECONDS = OAUTH_STATE_TTL_SECONDS;

/**
 * Every failure here surfaces to the user as a browser redirect to
 * `WEB_ORIGIN/#error=state_expired`, never as JSON -- the caller is a top-level navigation
 * from Strava, not a fetch. `extra.fragment` carries the code for the route to use.
 *
 * All failures deliberately share one message. Distinguishing "bad signature" from
 * "unknown state" from "wrong browser" would tell someone probing the callback exactly
 * which leg of the check they had already cleared.
 */
function stateRejected(reason) {
  const err = new HttpError(400, ERROR_CODES.BAD_REQUEST, 'This sign-in link is no longer valid. Please try again.', {
    fragment: OAUTH_FRAGMENT_ERRORS.STATE_EXPIRED,
  });
  // Which leg failed is for the server log only. It must NOT live in `extra`, because
  // HttpError.extra is spread into the response body.
  err.reason = reason;
  return err;
}

/**
 * Mint a state + nonce pair for one login attempt.
 *
 * `state` is `<random>.<hmac>`: the random half makes it unguessable, and the HMAC half
 * lets the callback reject obvious garbage with zero database work -- which matters because
 * the callback is an unauthenticated endpoint that anyone can hammer.
 *
 * @param {object} config
 * @param {{returnTo?:string, nowMs?:number}} opts
 * @returns {{state:string, nonce:string, stateHash:string, nonceHash:string, expiresAt:number, returnTo:string}}
 */
export function createOAuthState(config, { returnTo, nowMs = Date.now() } = {}) {
  const nowEpoch = epochSeconds(nowMs);

  const random = randomBytes(32).toString('base64url');
  const state = `${random}.${hmacB64u(config.sessionSecret, random)}`;

  // The browser-binding secret. It goes out in an HttpOnly cookie and NEVER into the URL:
  // a nonce in the query string would end up in Strava's logs, our access logs, and the
  // Referer header -- at which point it binds nothing.
  const nonce = randomBytes(32).toString('base64url');

  return {
    state,
    nonce,
    // Only digests are persisted. A leaked oauth_states table cannot be replayed, because
    // neither the state nor the nonce is recoverable from its SHA-256.
    stateHash: sha256b64u(state),
    nonceHash: sha256b64u(nonce),
    expiresAt: nowEpoch + TTL_SECONDS,
    // Sanitized on the WRITE side. safeReturnTo runs again on read; see its comment.
    returnTo: safeReturnTo(config, returnTo),
  };
}

/**
 * Persist a pending state row.
 *
 * The row cap is load-bearing rather than tidiness: GET /api/auth/strava/login is the one
 * mutating GET in the system and it is unauthenticated, so without purge-on-write and a hard
 * cap anyone with curl can grow this table without limit. (The purge itself lives inside
 * `insertState`, in the same transaction as the insert, which is strictly better than a
 * separate statement here -- so this function only adds the cap.)
 */
export async function persistOAuthState(db, { stateHash, nonceHash, expiresAt, returnTo, nowEpoch }) {
  const now = Number.isFinite(nowEpoch) ? nowEpoch : epochSeconds();

  await insertState(db, {
    stateHash,
    nonceHash,
    expiresAt,
    // return_to is NOT NULL in the schema and `undefined` cannot be bound at all. This does
    // not re-run safeReturnTo (there is no config here); createOAuthState already did.
    returnTo: typeof returnTo === 'string' && returnTo !== '' ? returnTo : '/',
    nowEpoch: now,
  });
  await enforceStateCap(db, OAUTH_STATE_MAX_ROWS);
}

/**
 * Validate a callback's `state` against the `bc_oauth` cookie nonce, then consume the row.
 *
 * @param {object} db
 * @param {object} config
 * @param {{state?:string, nonce?:string, nowMs?:number}} presented — `nonce` is the raw
 *        value of the bc_oauth cookie the browser sent back.
 * @returns {Promise<{returnTo:string}>}
 * @throws {HttpError} 400 on every failure mode
 */
export async function verifyAndConsumeOAuthState(db, config, { state, nonce, nowMs = Date.now() } = {}) {
  if (typeof state !== 'string' || state === '') throw stateRejected('state_missing');
  if (typeof nonce !== 'string' || nonce === '') {
    // No cookie at all is the signature of the login-CSRF attack described above (the
    // victim's browser holds no bc_oauth for a flow it never started). It is also what a
    // cookie-blocking browser looks like. Both must fail closed.
    throw stateRejected('nonce_cookie_missing');
  }

  // --- Leg 1: signature. Cheap and I/O-free, so garbage never reaches the database. ---
  const dot = state.lastIndexOf('.');
  if (dot <= 0) throw stateRejected('state_malformed');
  const random = state.slice(0, dot);
  const signature = state.slice(dot + 1);
  // safeEqual length-checks BEFORE timingSafeEqual, which THROWS
  // ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on differing lengths. Never "fix" that crash by
  // switching to ===.
  if (!safeEqual(signature, hmacB64u(config.sessionSecret, random))) throw stateRejected('bad_signature');

  // --- Leg 2: single-use consume. DELETE..RETURNING is atomic, so two concurrent
  // callbacks presenting the same state cannot both win. ---
  //
  // The consume deliberately happens BEFORE the expiry and nonce checks: a failed attempt
  // must burn the state. Otherwise an attacker whose victim had no cookie could keep
  // re-sending the same genuine state until one attempt landed.
  const row = await consumeState(db, sha256b64u(state));
  if (!row) throw stateRejected('unknown_or_already_consumed');

  // --- Leg 3: expiry, enforced server-side against our own clock. ---
  if (!Number.isFinite(row.expires_at) || row.expires_at <= epochSeconds(nowMs)) {
    throw stateRejected('expired');
  }

  // --- Leg 4: BROWSER BINDING. See the header comment. This is the check that closes login
  // CSRF, and it is the least obvious control in the codebase. ---
  if (!safeEqual(sha256b64u(nonce), String(row.nonce_hash ?? ''))) throw stateRejected('nonce_mismatch');

  // Re-sanitized on READ. The write side already ran safeReturnTo, but a row written by an
  // older build (or by hand) must still be neutralized -- otherwise fixing the validator
  // does nothing about the values already sitting in the table.
  return { returnTo: safeReturnTo(config, row.return_to) };
}

/**
 * True if a string contains a backslash, a C0 control character, or DEL.
 *
 * Written as an explicit char-code scan rather than a regex literal so the control
 * characters appear as numbers in the source: a regex like `[\x00-\x1f]` is one careless
 * copy-paste away from embedding a real NUL byte in this file.
 *
 * Backslash matters because browsers normalize it to '/', so `/\evil.com` becomes the
 * protocol-relative `//evil.com`. CR and LF matter because they are header injection. TAB
 * and the rest matter because URL parsers strip them, changing what the string means after
 * validation.
 */
function hasHostileChars(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 92 /* \ */ || c < 32 /* C0 controls incl. TAB, CR, LF, NUL */ || c === 127 /* DEL */) {
      return true;
    }
  }
  return false;
}

/**
 * Reduce an arbitrary caller-supplied value to a safe same-origin path, or '/'.
 *
 * This RESOLVES the value instead of pattern-matching it. The tempting
 * `v.startsWith('/') && !v.startsWith('//')` form is wrong in at least three ways that all
 * end in an open redirect:
 *
 *   - `/\evil.com` passes it, and the browser normalizes the backslash, producing the
 *     protocol-relative `//evil.com`.
 *   - `/..//evil.com` passes it, and URL normalization collapses it to `//evil.com`.
 *   - `/%09/evil.com` passes it, and the percent-encoded TAB is a character URL parsers
 *     strip, so what is validated is not what is fetched.
 *
 * So: reject hostile characters in both the raw and the percent-decoded form, resolve
 * against WEB_ORIGIN, require an exact origin match, and reject a normalized result that is
 * itself protocol-relative.
 */
export function safeReturnTo(config, value) {
  if (typeof value !== 'string' || value === '') return '/';

  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding. Never guess at what it was supposed to mean.
    return '/';
  }
  if (hasHostileChars(value) || hasHostileChars(decoded)) return '/';

  let u;
  try {
    u = new URL(value, config.webOrigin);
  } catch {
    return '/';
  }
  // Catches `https://evil.com` (different origin) and `javascript:alert(1)` (origin
  // 'null'). Comparing origins rather than hostnames also pins the scheme and the port.
  if (u.origin !== config.webOrigin) return '/';

  const path = `${u.pathname}${u.search}`;
  // After normalization `/..//evil.com` is `//evil.com`, which becomes protocol-relative
  // the moment it lands in a Location header on its own.
  if (!path.startsWith('/') || path.startsWith('//')) return '/';
  return path;
}
