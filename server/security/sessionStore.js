import { randomBytes } from 'node:crypto';
import { sha256b64u } from './hash.js';
import {
  insertSession,
  findSessionByHash,
  touchSession,
  deleteSession,
  deleteSessionsForAthlete,
} from '../db/sessions.js';
import { epochSeconds } from '../lib/dates.js';

/**
 * Server-side session storage.
 *
 * The whole design is one sentence: the browser holds a 256-bit random token, the database
 * holds only its SHA-256, and the raw token is returned exactly once. A leaked or committed
 * database file therefore yields no usable credentials -- there is nothing in `sessions` an
 * attacker can present.
 *
 * A consequence worth stating explicitly, because it looks like an omission: there is NO
 * constant-time comparison anywhere in this file, and none is needed. Lookup is a primary-key
 * match on a 256-bit digest, so the only thing a timing side channel could reveal is whether
 * a row exists for a hash the attacker would have to have guessed in the first place. Adding
 * a timingSafeEqual here would be cargo cult. (Where a secret IS compared as a value -- the
 * CSRF double-submit and the OAuth state signature -- safeEqual() is used.)
 */

/**
 * How stale `last_seen_at` may get before a read refreshes it.
 *
 * Writing on every single request would turn every authenticated GET into a write and take
 * the SQLite write lock on the leaderboard path.
 */
const TOUCH_AFTER_SECONDS = 300;

/** A User-Agent header is unbounded attacker-controlled text; it is stored for forensics
 *  only, so cap it rather than letting a 40 KB header into every session row. */
const MAX_USER_AGENT = 256;

/**
 * Mint a session. The returned `rawToken` is the ONLY time it exists outside the browser --
 * it is not persisted, not logged, and cannot be recovered.
 *
 * Callers must mint a fresh session on every successful OAuth callback (and delete any
 * inbound one first): that is the session-fixation defense.
 *
 * @param {object} db
 * @param {object} config
 * @param {number} athleteId
 * @param {{userAgent?:string, nowMs?:number}} opts
 * @returns {Promise<{rawToken:string, expiresAt:number}>}
 */
export async function createSession(db, config, athleteId, { userAgent = '', nowMs = Date.now() } = {}) {
  if (!Number.isInteger(athleteId) || athleteId <= 0) {
    throw new TypeError(`createSession needs a positive integer athleteId, got ${String(athleteId)}.`);
  }

  const now = epochSeconds(nowMs);
  // 32 bytes = 256 bits of entropy. base64url so it is safe in a cookie, in an
  // Authorization header, and as a SQLite TEXT key with no escaping anywhere.
  const rawToken = randomBytes(32).toString('base64url');
  const expiresAt = now + config.sessionTtlSeconds;

  await insertSession(db, {
    sessionIdHash: sha256b64u(rawToken),
    athleteId,
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    userAgent: String(userAgent ?? '').slice(0, MAX_USER_AGENT),
  });

  return { rawToken, expiresAt };
}

/**
 * Resolve a raw token (from the `bc_sid` cookie or an `Authorization: Bearer`) to a session,
 * or null. Never throws for a bad credential -- an unknown token is simply "not logged in".
 *
 * `config` is accepted but not read today. It is in the signature so that adding sliding
 * expiry (extend `expires_at` on use, capped at an absolute maximum) later is a change to
 * this function alone, not to every call site in routes and guards.
 *
 * @param {object} db
 * @param {object} config
 * @param {string} rawToken
 * @param {{nowMs?:number}} opts
 * @returns {Promise<{athleteId:number, expiresAt:number}|null>}
 */
// eslint-disable-next-line no-unused-vars -- see the note above about `config`.
export async function resolveSession(db, config, rawToken, { nowMs = Date.now() } = {}) {
  if (typeof rawToken !== 'string' || rawToken === '') return null;

  const hash = sha256b64u(rawToken);
  const row = await findSessionByHash(db, hash);
  if (!row) return null;

  const now = epochSeconds(nowMs);

  // Expiry is enforced HERE, server-side, against our own clock -- never by trusting the
  // cookie's Max-Age. Max-Age is a client-side hint the client controls: anyone can keep
  // sending a cookie forever after it "expired", and a bearer token has no Max-Age at all.
  if (!Number.isFinite(row.expires_at) || row.expires_at <= now) {
    // Opportunistic cleanup so a dead row cannot be probed repeatedly. The startup sweep
    // (purgeExpiredSessions) catches sessions nobody ever comes back for.
    await deleteSession(db, hash);
    return null;
  }

  const lastSeen = row.last_seen_at;
  // The isFinite guard is the actual bug fix, not defensive noise. findSessionByHash must
  // SELECT last_seen_at; if a future edit drops it from the column list, `now - undefined`
  // is NaN, `NaN > 300` is false, and the column freezes forever with no error anywhere.
  // Failing toward "touch on every request" makes that regression visible instead of silent.
  if (!Number.isFinite(lastSeen) || now - lastSeen > TOUCH_AFTER_SECONDS) {
    await touchSession(db, hash, now);
  }

  return { athleteId: row.athlete_id, expiresAt: row.expires_at };
}

/**
 * Delete the session behind a raw token. Idempotent: logout is a 204 whether or not the
 * credential matched anything.
 *
 * Logout MUST delete the row, not just clear the cookie. Clearing only the cookie leaves the
 * bearer path alive, so "log out" visibly fails for anyone holding a token.
 */
export async function revokeSession(db, rawToken) {
  if (typeof rawToken !== 'string' || rawToken === '') return;
  await deleteSession(db, sha256b64u(rawToken));
}

/**
 * Drop every session for an athlete.
 *
 * Called whenever their privileges change (admin granted/revoked, team reassigned by an
 * admin) and on revocation, so a stale session cannot keep acting with the old authority.
 */
export async function revokeAllForAthlete(db, athleteId) {
  await deleteSessionsForAthlete(db, athleteId);
}

export { TOUCH_AFTER_SECONDS };
