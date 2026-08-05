import { TOKEN_REFRESH_SKEW_SECONDS } from '../contracts.js';
import { loadTokens, saveTokens } from '../db/tokens.js';
import { markRevoked } from '../db/athletes.js';
import { StravaError, StravaGrantRevokedError } from './client.js';
import { log } from '../lib/log.js';

/**
 * The only module allowed to refresh a Strava access token.
 *
 * It sits exactly between `db/tokens.js` (which owns the encryption envelope and the
 * `token_version` compare-and-swap) and `strava/client.js` (which owns the HTTP call and
 * knows nothing about a database). Nothing else in the tree may call
 * `client.refreshTokens()`: a second refresh path is a second chance to lose a rotation
 * race, and a lost rotation race is an unrecoverable, cause-less lockout.
 *
 * Four rules hold this file together. Each one prevents a failure that leaves NO trace:
 *
 *  1. PROACTIVE refresh at `expires_at - 300 <= now`. Waiting for a 401 means every
 *     token expiry costs a wasted request pair, and a token that expires mid-pagination
 *     turns a good sync into a partial one.
 *
 *  2. ONE refresh in flight per athlete, enforced by an in-process Map. Strava ROTATES
 *     the refresh token, so two callers presenting the same one means the loser's token is
 *     already dead. If the loser then writes it, the database holds a superseded refresh
 *     token, every later refresh 400s, and that athlete is locked out permanently with no
 *     error anywhere explaining why. The mutex is process-local and therefore evaporates on
 *     a serverless isolate -- which is exactly why rule 3 is not optional.
 *
 *  3. The write is a `token_version` CAS. `{ok:false}` means somebody else rotated while we
 *     were on the network: re-read and use THEIR token. Never retry the exchange, because
 *     the refresh token we hold was consumed by the exchange that just succeeded.
 *
 *  4. NO transaction is ever held across the fetch. Read, release, fetch, then write. A
 *     `BEGIN IMMEDIATE` spanning a 15-second HTTP timeout serializes every other writer in
 *     the process behind Strava's latency, and on SQLite that surfaces as unrelated
 *     `SQLITE_BUSY` errors on completely different requests.
 */

/**
 * athleteId -> the in-flight refresh promise.
 *
 * Module-level, so every import shares it. Entries are deleted in a `finally`; without
 * that, one network failure would leave a rejected promise parked under that athlete's id
 * and every later call would re-throw the same stale error forever.
 *
 * @type {Map<number, Promise<string>>}
 */
const inFlight = new Map();

/**
 * Drop any parked refresh promises.
 *
 * Test-only. Each test builds a fresh `:memory:` database but shares this module instance,
 * so without a reset a promise resolved against a closed database could be handed to the
 * next test.
 */
export function _resetSingleFlightForTests() {
  inFlight.clear();
}

/** Refresh this many seconds early. See TOKEN_REFRESH_SKEW_SECONDS in contracts.js. */
function isExpiring(tokens, nowMs) {
  const nowSeconds = Math.floor(nowMs / 1000);
  // A non-finite expires_at means we cannot reason about the token at all; refreshing is
  // the safe answer, since the alternative is using a token that may already be dead.
  if (!Number.isFinite(tokens.expiresAt)) return true;
  return tokens.expiresAt - TOKEN_REFRESH_SKEW_SECONDS <= nowSeconds;
}

/**
 * No token row at all: never connected, or disconnected.
 *
 * Reported as a revoked grant rather than a generic error because that is what the rider
 * has to do about it -- the routes map this to 403 `strava_revoked` with a reconnect URL.
 */
function noGrant(athleteId) {
  return new StravaGrantRevokedError(`Athlete ${athleteId} has no stored Strava tokens; a reconnect is required.`, {
    status: 401,
    path: '/oauth/token',
  });
}

/** A 401 from the API. Distinct from a dead grant, which is a 400 on the token endpoint. */
function isUnauthorized(err) {
  return err instanceof StravaError && !(err instanceof StravaGrantRevokedError) && err.status === 401;
}

/**
 * Return a usable access token, refreshing first if it is at or near expiry.
 *
 * @param {object} db      the async adapter from server/db/db.js
 * @param {object} config  frozen config (only `tokenEncryptionKey` is read, via db/tokens)
 * @param {object} strava  a client from createStravaClient()
 * @param {number} athleteId
 * @returns {Promise<string>} the access token
 * @throws {StravaGrantRevokedError} the grant is dead and only re-consent can fix it
 */
export async function getValidAccessToken(db, config, strava, athleteId, { nowMs = Date.now() } = {}) {
  const stored = await loadTokens(db, config, athleteId);
  if (!stored) throw noGrant(athleteId);

  // The overwhelmingly common path: a live token, ZERO requests, no lock, no write.
  if (!isExpiring(stored, nowMs)) return stored.accessToken;

  return refreshSingleFlight(db, config, strava, athleteId, { nowMs, staleAccessToken: null });
}

/**
 * Run `fn(accessToken)`, refreshing once and retrying once if it comes back 401.
 *
 * The retry is deliberately bounded at exactly one. A loop here is how a genuinely
 * rejected credential becomes an infinite request storm against a rate-limited API, and
 * the second 401 is information -- it means the problem is not token freshness.
 *
 * `fn` must be idempotent, because it can run twice. Every current caller is a GET.
 */
export async function withAuth(db, config, strava, athleteId, fn, { nowMs = Date.now() } = {}) {
  if (typeof fn !== 'function') throw new TypeError('withAuth: fn must be a function of (accessToken).');

  const accessToken = await getValidAccessToken(db, config, strava, athleteId, { nowMs });
  try {
    return await fn(accessToken);
  } catch (err) {
    if (!isUnauthorized(err)) throw err;

    log.warn('strava 401 with a token we believed was valid; refreshing once', {
      athlete_id: athleteId,
      path: err.path ?? null,
    });

    // `staleAccessToken` is what makes this safe under concurrency: the refresh below skips
    // the expiry test (the token is provably bad regardless of what expires_at claims) but
    // still returns early if the stored access token is no longer the one that just 401'd,
    // i.e. another caller already fixed it.
    const refreshed = await refreshSingleFlight(db, config, strava, athleteId, { nowMs, staleAccessToken: accessToken });
    return fn(refreshed);
  }
}

/**
 * Join the in-flight refresh for this athlete, or become it.
 *
 * The `get`/`set` pair has no `await` between them, so it is atomic against other
 * microtasks -- two callers that arrive in the same tick cannot both create a slot.
 */
async function refreshSingleFlight(db, config, strava, athleteId, { nowMs, staleAccessToken }) {
  const key = Number(athleteId);

  const joined = inFlight.get(key);
  if (joined) {
    // Deliberately does NOT pass its own `staleAccessToken` in: the winner is already doing
    // the exchange, and its result is by definition newer than anything this caller held.
    log.info('joining an in-flight token refresh', { athlete_id: key });
    return joined;
  }

  const promise = performRefresh(db, config, strava, key, { nowMs, staleAccessToken });
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    // In a `finally`, and only by the caller that created the slot. A rejected promise left
    // in the map poisons that athlete for the lifetime of the process.
    inFlight.delete(key);
  }
}

/** The actual refresh. Runs with the single-flight slot held. */
async function performRefresh(db, config, strava, athleteId, { nowMs, staleAccessToken }) {
  // RE-READ inside the slot. Between our first read and getting here, the winner of a race
  // may have already rotated -- or an OAuth callback may have stored a whole new grant.
  // Exchanging our (now superseded) refresh token at that point is guaranteed to 400 and
  // would then look exactly like a revoked grant.
  const stored = await loadTokens(db, config, athleteId);
  if (!stored) throw noGrant(athleteId);

  if (staleAccessToken === null) {
    if (!isExpiring(stored, nowMs)) {
      log.info('token already rotated by another caller; skipping refresh', { athlete_id: athleteId, token_version: stored.tokenVersion });
      return stored.accessToken;
    }
  } else if (stored.accessToken !== staleAccessToken) {
    // A 401 whose token has already been replaced needs no refresh, only a retry.
    log.info('token already replaced after a 401; skipping refresh', { athlete_id: athleteId, token_version: stored.tokenVersion });
    return stored.accessToken;
  }

  // ---- network. No transaction is open, and none may be opened until it returns.
  let issued;
  try {
    issued = await strava.refreshTokens(stored.refreshToken);
  } catch (err) {
    if (err instanceof StravaGrantRevokedError) {
      return retryOrDeclareDead(db, config, strava, athleteId, stored, err, nowMs);
    }
    throw err;
  }

  return persist(db, config, athleteId, issued, stored);
}

/**
 * Strava called our refresh token invalid. Confirm it before condemning the grant.
 *
 * "Invalid" is ambiguous: it is what a revoked grant looks like, and ALSO what the losing
 * side of a rotation race looks like. Marking the athlete revoked on the first 400 means a
 * double-clicked Refresh can badge a perfectly healthy rider as disconnected and hide their
 * miles behind a reconnect prompt.
 *
 * So we re-read once. The exchange is retried ONLY if the row actually moved -- retrying
 * with the identical token is provably another 400 and spends a request on the token
 * endpoint, which is the one endpoint that must stay available for every other athlete.
 */
async function retryOrDeclareDead(db, config, strava, athleteId, previous, revokedError, nowMs) {
  const current = await loadTokens(db, config, athleteId);

  const rowMoved = current !== null
    && (current.tokenVersion !== previous.tokenVersion || current.refreshToken !== previous.refreshToken);

  if (rowMoved) {
    log.warn('refresh rejected, but the stored token had moved; retrying once with the winner\'s token', {
      athlete_id: athleteId,
      token_version: current.tokenVersion,
      previous_version: previous.tokenVersion,
    });

    // The winner may have stored a token that is still perfectly fresh, in which case there
    // is nothing to exchange at all.
    if (!isExpiring(current, nowMs)) return current.accessToken;

    try {
      const issued = await strava.refreshTokens(current.refreshToken);
      return persist(db, config, athleteId, issued, current);
    } catch (err) {
      if (!(err instanceof StravaGrantRevokedError)) throw err;
      // Fall through: two different refresh tokens both rejected means the grant, not the
      // race, is the problem.
    }
  }

  // Only now. The athlete row, their team, and all their activities survive this: the flag
  // drives a reconnect badge and a frozen total, never a deletion.
  await markRevoked(db, athleteId, Math.floor(nowMs / 1000));
  log.warn('strava grant is dead; marked revoked', { athlete_id: athleteId, token_version: previous.tokenVersion });
  throw revokedError;
}

/**
 * Write the rotated token set under the CAS, resolving a lost CAS by adopting the winner's.
 *
 * BOTH tokens are written every time, never "only the ones that changed". Strava rotates
 * the refresh token, and a conditional write is how the database ends up one rotation
 * behind Strava with no error to point at.
 */
async function persist(db, config, athleteId, issued, previous) {
  const expectedVersion = previous.tokenVersion;
  const result = await saveTokens(
    db,
    config,
    athleteId,
    {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt: issued.expiresAt,
      // [UNVERIFIED] whether Strava's token response carries `scope` at all, so the stored
      // value is carried forward when it does not. Letting it fall through to '' would
      // discard the record of an `activity:read_all` grant on every refresh.
      scope: issued.scope ?? previous.scope,
      tokenType: issued.tokenType,
    },
    expectedVersion,
  );

  if (result.ok) {
    log.info('strava token refreshed', {
      athlete_id: athleteId,
      token_version: result.version,
      expires_at: issued.expiresAt,
    });
    return issued.accessToken;
  }

  // Lost the CAS. In practice this means an OAuth callback wrote a brand-new grant while we
  // were on the network (a competing REFRESH could not have succeeded -- it would have had
  // to present the same token we just consumed). The callback's grant is strictly newer, so
  // theirs wins and ours is dropped on the floor. Retrying the exchange here would present a
  // refresh token that no longer exists at Strava and would read as a revoked grant.
  log.warn('token CAS lost; adopting the stored token', {
    athlete_id: athleteId,
    expected_version: expectedVersion,
    actual_version: result.version,
  });

  const winner = await loadTokens(db, config, athleteId);
  if (!winner) throw noGrant(athleteId);
  return winner.accessToken;
}
