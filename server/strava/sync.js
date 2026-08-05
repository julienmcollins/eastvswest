import { ERROR_CODES } from '../contracts.js';
import { HttpError } from '../http/respond.js';
import { log } from '../lib/log.js';
import { isoUtcNow, resolveWindow } from '../lib/dates.js';
import { getAthlete as getAthleteRow, upsertAthleteFromStrava } from '../db/athletes.js';
import { reconcileDeletions, upsertActivities } from '../db/activities.js';
import {
  acquireLock,
  advanceWatermark,
  getSyncState,
  recordError,
  recordOk,
  releaseLock,
  sweepStaleLocks,
} from '../db/syncState.js';
import { computeSyncWindow, isCountedSportType, localDateOf, normalizeActivity } from './map.js';
import { StravaRateLimitError } from './client.js';
import { assertScope } from './authUrl.js';
import { withAuth } from './tokenService.js';

/**
 * The one module that knows about BOTH the database and Strava.
 *
 * Everything below it is deliberately half-blind: `strava/client.js` cannot see a database,
 * `db/*` cannot see the network. That means every decision that needs both -- what window to
 * ask for, what may be written, and above all what may be DELETED -- is made here and only
 * here, and can be reviewed by reading one file.
 *
 * Five rules, each of which prevents a silent, competition-losing failure:
 *
 *  1. STORE EVERYTHING; FILTER AT QUERY TIME. Non-bike rides, out-of-window rides and manual
 *     rides are all persisted. Dropping them at fetch time would make any future edit to
 *     ALLOWED_SPORT_TYPES require a full re-sync of every athlete against a rate-limited API
 *     -- and mid-competition, that is not a migration anyone can run.
 *
 *  2. FULL MODE IS NOT OPTIONAL, because a watermark is provably wrong for a competition. A
 *     bikepacking trip uploaded a week late, a Garmin sync that failed on Sunday, a rider
 *     flipping a three-week-old ride from "Only You" to "Everyone", a corrected distance --
 *     every one of these carries a `start_date` OLDER than the watermark, and
 *     /athlete/activities has no `modified_after` to find them with. They would be missed
 *     forever. A full rescan of a 90-day season is 2-4 requests.
 *
 *  3. RECONCILIATION IS STRICTLY GATED on `mode === 'full' && no error && !truncated`. Run
 *     against a partial fetch it soft-deletes every ride the missing pages did not return,
 *     i.e. it silently zeroes a rider in the middle of the competition on a transient
 *     upstream 500. The same gate gates the watermark and `last_full_sync_at`: recording
 *     progress we did not make is how a gap becomes permanent.
 *
 *  4. NEVER SLEEP. A rate limit surfaces as a 429 carrying a time, because a handler that
 *     sleeps out a 15-minute Strava block is an outage, and one that retries inside the block
 *     turns one 429 into fifteen minutes of them.
 *
 *  5. THE LOCK IS RELEASED IN A `finally`. A crash mid-sync otherwise leaves the athlete
 *     locked until the stale sweep runs, and their Refresh button answering 409 with nothing
 *     to point at is indistinguishable from a hung sync.
 */

/**
 * How stale `last_full_sync_at` may be before auto mode picks 'full'.
 *
 * A day. Deletions and late uploads are reconciled at least daily, while the intervening
 * Refresh clicks stay cheap (one or two pages from the watermark).
 */
const FULL_SYNC_INTERVAL_SECONDS = 86400;

/**
 * Rows this athlete has stored, INCLUDING soft-deleted ones.
 *
 * Used only to derive `activities_added` from the difference across the upsert. The obvious
 * alternative -- a `WHERE strava_activity_id IN (...)` probe -- needs one placeholder per
 * fetched ride, and this is exact for the same reason `upsertActivities` is idempotent:
 * reconciliation soft-deletes rows, it never removes them, so the count only ever grows.
 */
async function countStoredActivities(db, athleteId) {
  const row = await db.get(`SELECT COUNT(*) AS n FROM activities WHERE athlete_id = ?`, [athleteId]);
  return Number(row?.n ?? 0);
}

/** 409: somebody else holds the lock. `retry_after_seconds` is the remaining TTL. */
function syncInProgress(retryAfterSeconds) {
  const err = new HttpError(
    409,
    ERROR_CODES.SYNC_IN_PROGRESS,
    'A sync is already running for this athlete. Try again in a moment.',
    { retry_after_seconds: retryAfterSeconds },
  );
  err.headers = { 'Retry-After': String(retryAfterSeconds) };
  return err;
}

/**
 * 429 with a time in it, for either kind of block.
 *
 * `scope` tells the client WHOSE limit it hit, because the two need different words in the
 * UI: 'local' is our own 60-second per-athlete cooldown ("you just synced"), 'strava' is a
 * real quota that no amount of patience on our side shortens.
 */
function rateLimited(message, { retryAfterSeconds, scope }) {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const err = new HttpError(429, ERROR_CODES.RATE_LIMITED, message, {
    retry_after_seconds: seconds,
    scope,
  });
  // `Access-Control-Expose-Headers` because Retry-After is not a CORS-safelisted response
  // header: once the frontend is on its own origin, the value is invisible to JS without it.
  // The body carries `retry_after_seconds` too, so the client never depends on the header.
  err.headers = { 'Retry-After': String(seconds), 'Access-Control-Expose-Headers': 'Retry-After' };
  return err;
}

/**
 * Map a Strava failure onto the HTTP contract, passing through what the routes already map.
 *
 * Only the rate limit is translated here: `retryAfterMs` and `resetAt` live on the Strava
 * error and would be lost if a route had to reconstruct them. Scope errors, revoked grants
 * and plain StravaErrors travel untouched -- the routes turn them into 403
 * `insufficient_scope`, 403 `strava_revoked` and 502 `strava_unavailable`.
 */
function translateStravaError(err) {
  if (!(err instanceof StravaRateLimitError)) return err;

  const seconds = Math.max(1, Math.ceil((Number(err.retryAfterMs) || 0) / 1000));
  const when = err.resetAt ? ` Try again after ${err.resetAt}.` : '';
  // The client uses bucket 'local' for its own pre-emptive RESERVE gate -- it declined to
  // send rather than being refused by Strava. Reporting that as scope 'strava' sends the
  // rider to check Strava's status page over a limit we imposed ourselves, so honour the
  // bucket. This mirrors the mapping in routes/me.js; sync.js translates first and wins,
  // so the two must agree.
  const scope = err.bucket === 'local' ? 'local' : 'strava';
  const message =
    scope === 'local'
      ? `Approaching Strava's rate limit, so this sync was held back.${when}`
      : `Strava's rate limit is in effect.${when}`;
  return rateLimited(message, { retryAfterSeconds: seconds, scope });
}

/**
 * Put the outcome fields back exactly as they were before we took the lock.
 *
 * Needed because `acquireLock` stamps `last_status = 'running'` as part of the same atomic
 * upsert that takes the lock -- there is no way to test the cooldown first without either
 * racing or lying. When the cooldown then refuses the run, leaving 'running' behind on a row
 * with no lock would misreport a healthy athlete as perpetually syncing.
 *
 * `nowEpoch` is deliberately the PREVIOUS `last_sync_finished`: re-stamping it with now would
 * push the cooldown window forward on every refused attempt, so an impatient rider clicking
 * Refresh in a loop could never sync again.
 */
async function restorePreviousOutcome(db, athleteId, previous) {
  if (!previous) return false;
  const finished = previous.last_sync_finished;
  if (finished === null || finished === undefined) return false;

  if (previous.last_status === 'ok') {
    await recordOk(db, athleteId, {
      nowEpoch: Number(finished),
      activitiesUpserted: Number(previous.activities_upserted ?? 0),
      pagesFetched: Number(previous.pages_fetched ?? 0),
      truncated: Number(previous.truncated ?? 0) === 1,
    });
    return true;
  }
  if (previous.last_status === 'error') {
    await recordError(db, athleteId, {
      nowEpoch: Number(finished),
      message: previous.last_error ?? 'sync failed',
    });
    return true;
  }
  // 'never' or 'running': there is no earlier outcome to restore, so the lock release in the
  // caller's `finally` is the whole cleanup.
  return false;
}

/**
 * Sync one athlete's activities from Strava.
 *
 * @param {object} db     async adapter (server/db/db.js)
 * @param {object} config frozen config (server/config.js)
 * @param {object} strava client (server/strava/client.js)
 * @param {number} athleteId
 * @param {{mode?: 'full'|'incremental'|null, force?: boolean, nowMs?: number}} [opts]
 *   `mode` null means auto: 'full' when `last_full_sync_at` is missing or older than a day.
 *   `force` skips the cooldown only -- never the lock, which exists to stop concurrent runs.
 * @returns {Promise<{ok:true, mode:string, syncedAt:string, activitiesScanned:number,
 *   activitiesCounted:number, activitiesAdded:number, activitiesRemoved:number,
 *   pagesFetched:number, truncated:boolean}>}
 */
export async function syncAthlete(db, config, strava, athleteId, { mode = null, force = false, nowMs = Date.now() } = {}) {
  const id = Number(athleteId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError(`syncAthlete: athleteId must be a positive integer, got ${JSON.stringify(athleteId)}.`);
  }
  if (mode !== null && mode !== 'full' && mode !== 'incremental') {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, `mode must be "full" or "incremental", got ${JSON.stringify(mode)}.`);
  }

  const nowEpoch = Math.floor(nowMs / 1000);
  const syncedAt = isoUtcNow(nowMs);

  // Before the lock, because `sync_state.athlete_id` REFERENCES athletes: taking the lock for
  // an athlete who does not exist would surface as an opaque foreign-key error instead of a
  // 404, and would do so AFTER writing a row we then have to clean up.
  const athlete = await getAthleteRow(db, id);
  if (!athlete) {
    throw new HttpError(404, ERROR_CODES.NOT_FOUND, `No athlete ${id}.`);
  }

  // Fail before spending a request when we already know no ride can be read. Only checked
  // when a scope was actually recorded: '' means "we never learned what was granted" (the
  // callback is what records it), and treating unknown as insufficient would lock out an
  // athlete over missing bookkeeping. Throws StravaScopeError -> 403 insufficient_scope.
  if (typeof athlete.granted_scope === 'string' && athlete.granted_scope !== '') {
    assertScope(athlete.granted_scope);
  }

  // Read purely so the cooldown path below can put `last_status` back. Not used for any
  // decision: between this read and the lock, another run can finish.
  const previous = await getSyncState(db, id);

  const lock = await acquireLock(db, id, { nowEpoch });
  if (!lock.acquired) {
    // The held lock may be stale-but-unexpired; `lock_expires_at` bounds the wait either way.
    throw syncInProgress(Math.max(1, lock.retryAfterSeconds));
  }

  // Whoever clears the lock must also be the last writer to touch it. recordOk/recordError
  // clear it themselves, so the `finally` must not release again -- a second release could
  // land after a different caller has acquired and would hand that caller's lock away.
  let ownsLock = true;

  try {
    // Authoritative state, read under the lock.
    const state = await getSyncState(db, id);

    const lastFinished = state?.last_sync_finished;
    if (!force && config.syncCooldownSeconds > 0 && lastFinished !== null && lastFinished !== undefined) {
      const elapsed = nowEpoch - Number(lastFinished);
      if (elapsed >= 0 && elapsed < config.syncCooldownSeconds) {
        if (await restorePreviousOutcome(db, id, previous)) ownsLock = false;
        throw rateLimited(
          `This athlete synced ${elapsed} s ago. Try again in ${config.syncCooldownSeconds - elapsed} s.`,
          { retryAfterSeconds: config.syncCooldownSeconds - elapsed, scope: 'local' },
        );
      }
    }

    const lastFull = state?.last_full_sync_at;
    const resolvedMode = mode
      ?? (lastFull === null || lastFull === undefined || nowEpoch - Number(lastFull) > FULL_SYNC_INTERVAL_SECONDS
        ? 'full'
        : 'incremental');

    try {
      const result = await runSync(db, config, strava, id, { mode: resolvedMode, nowMs, nowEpoch, syncedAt, state });

      await recordOk(db, id, {
        nowEpoch,
        activitiesUpserted: result.activitiesScanned,
        pagesFetched: result.pagesFetched,
        truncated: result.truncated,
      });
      ownsLock = false;
      return result;
    } catch (err) {
      // The message is stored verbatim and shown to admins. Strava's error classes are built
      // so their `message` can never contain a form field, a header, or a token -- which is
      // why the raw message is safe here and a response body would not be.
      await recordError(db, id, { nowEpoch, message: err?.message ?? 'sync failed' });
      ownsLock = false;
      throw translateStravaError(err);
    }
  } finally {
    // The safety net for anything that threw before recordOk/recordError ran -- including
    // the cooldown rejection and any bug in the block above.
    if (ownsLock) await releaseLock(db, id);
  }
}

/**
 * The work itself, with the lock held and the mode decided.
 *
 * Split out so the lock/cooldown/bookkeeping shell above reads as a single sequence and this
 * function can be read as "what we do to the data".
 */
async function runSync(db, config, strava, athleteId, { mode, nowMs, nowEpoch, syncedAt, state }) {
  // ---- identity refresh. Its own withAuth call, so a 401 here retries ONE request rather
  // than re-fetching every activity page.
  const athleteRaw = await withAuth(db, config, strava, athleteId, (token) => strava.getAthlete(token), { nowMs });
  // upsertAthleteFromStrava normalizes a non-https: avatar to NULL (Strava sends the bare
  // relative string `avatar/athlete/large.png` for photo-less athletes) and leaves team,
  // is_admin, granted_scope and the revoked flags alone.
  await upsertAthleteFromStrava(db, athleteRaw, { nowIso: syncedAt });

  const window = computeSyncWindow(config, {
    mode,
    watermarkEpoch: Number(state?.watermark_epoch ?? 0),
    nowMs,
  });

  // ---- fetch. A failure mid-pagination is NOT fatal: the pages already in hand are worth
  // persisting (the upsert is idempotent), and the error's non-enumerable `partial` is how
  // the client hands them over without putting 200 rides into a log line.
  let fetched = { activities: [], pages: 0, truncated: true };
  let fetchError = null;
  try {
    fetched = await withAuth(
      db,
      config,
      strava,
      athleteId,
      (token) => strava.fetchAllActivities({ accessToken: token, after: window.afterEpoch, before: window.beforeEpoch }),
      { nowMs },
    );
  } catch (err) {
    fetchError = err;
    if (err?.partial) {
      fetched = { activities: err.partial.activities, pages: err.partial.pages, truncated: true };
    }
    log.warn('activity fetch failed; persisting the pages already fetched', {
      athlete_id: athleteId,
      mode,
      pages_fetched: fetched.pages,
      activities_in_hand: fetched.activities.length,
      error_name: err?.name,
      error_message: err?.message,
    });
  }

  // ---- normalize EVERYTHING. No sport filter, no window filter: see rule 1 at the top.
  const rows = [];
  const seenIds = [];
  let watermarkEpoch = 0;
  let malformed = 0;

  for (const raw of fetched.activities) {
    let row;
    try {
      row = normalizeActivity(raw, { athleteId });
    } catch (err) {
      // One unusable record must not fail the whole sync -- that would block a rider
      // indefinitely on data we cannot fix. It DOES suppress reconciliation below, because a
      // record we could not read is a record whose id is missing from `seenIds`, and
      // reconciliation would read that absence as "the rider deleted it".
      malformed += 1;
      log.warn('skipping an unusable Strava activity', {
        athlete_id: athleteId,
        activity_id: raw?.id ?? null,
        error_message: err?.message,
      });
      continue;
    }
    rows.push(row);
    seenIds.push(row.strava_activity_id);
    // Max over every page, never a positional element: Strava's ordering flips depending on
    // whether `after` was sent.
    if (row.start_epoch > watermarkEpoch) watermarkEpoch = row.start_epoch;
  }

  const storedBefore = await countStoredActivities(db, athleteId);
  await upsertActivities(db, athleteId, rows, { syncedAt });
  const activitiesAdded = Math.max(0, (await countStoredActivities(db, athleteId)) - storedBefore);

  /**
   * The gate. All three conditions, and nothing else, permit a destructive write or a
   * recorded advance: a complete fetch, in the mode that actually rescanned the whole
   * competition, with every record understood.
   */
  const complete = fetchError === null && fetched.truncated !== true && malformed === 0;

  let activitiesRemoved = 0;
  if (complete && mode === 'full') {
    // The reconcile range is deliberately NARROWER than the fetch window: the fetch uses
    // Strava's `after`/`before`, whose inclusivity is [UNVERIFIED]. `afterEpoch + 1` and a
    // half-open upper bound mean that under either reading, a ride Strava might not have
    // returned is outside the range and cannot be soft-deleted. Being one second too
    // conservative costs nothing; being one second too greedy deletes a real ride.
    activitiesRemoved = await reconcileDeletions(
      db,
      athleteId,
      { startEpoch: window.afterEpoch + 1, endEpoch: window.beforeEpoch },
      seenIds,
      nowEpoch,
    );
  }

  if (fetchError === null && fetched.truncated !== true) {
    // `last_full_sync_at` is only stamped when reconciliation actually ran, so a run that
    // skipped it comes back as 'full' on the next attempt instead of being suppressed for a
    // day. advanceWatermark itself is max(), so it can never move backwards.
    await advanceWatermark(db, athleteId, watermarkEpoch, {
      fullSyncAt: complete && mode === 'full' ? nowEpoch : null,
    });
  }

  if (fetchError !== null) throw fetchError;

  return {
    ok: true,
    mode,
    syncedAt,
    activitiesScanned: fetched.activities.length,
    activitiesCounted: countCountable(config, rows),
    activitiesAdded,
    activitiesRemoved,
    pagesFetched: fetched.pages,
    truncated: fetched.truncated === true,
  };
}

/**
 * How many of the rides we just stored will actually show on the leaderboard.
 *
 * The same three tests the SQL predicate applies -- sport type, local date inside the
 * competition, and the manual policy -- so the number the rider sees after a sync agrees with
 * the number on the board. `local_date` comes from `start_date_local` (a wall clock with a
 * bogus Z), never from the UTC instant, which is what keeps the Auckland 00:30-local ride on
 * the right day.
 *
 * One known, deliberate discrepancy: an admin-APPROVED manual ride counts on the board but
 * not here, because `manual_approved` is admin state that this run never read. It affects a
 * per-run diagnostic number only, never a total.
 */
function countCountable(config, rows) {
  const window = resolveWindow(config, {});
  let counted = 0;
  for (const row of rows) {
    if (!isCountedSportType(row.sport_type, config.allowedSportTypes)) continue;
    const localDate = localDateOf(row.start_date_local);
    if (localDate < window.start || localDate > window.end) continue;
    if (row.is_manual === 1 && !config.countManualActivities) continue;
    counted += 1;
  }
  return counted;
}

/**
 * Startup sweep: heal locks left behind by a process that died mid-sync.
 *
 * Called from server/index.js at boot. Without it, an athlete whose sync was killed by a
 * deploy keeps getting 409 until the TTL passes, and their row reads 'running' forever --
 * indistinguishable from a sync that is genuinely in progress.
 *
 * @returns {Promise<number>} rows healed
 */
export async function sweepStaleSyncLocks(db, { nowMs = Date.now() } = {}) {
  const healed = await sweepStaleLocks(db, Math.floor(nowMs / 1000));
  if (healed > 0) log.warn('healed stale sync locks', { rows: healed });
  return healed;
}
