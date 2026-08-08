import { ERROR_CODES } from '../contracts.js';
import { HttpError } from '../http/respond.js';
import { log } from '../lib/log.js';
import { isoUtcNow, startOfMonth, endOfMonth } from '../lib/dates.js';
import { getAthlete as getAthleteRow, listAthletes, upsertAthleteFromStrava } from '../db/athletes.js';
import { activityMonthExtent, reconcileDeletions, upsertActivities } from '../db/activities.js';
import { hasTokens } from '../db/tokens.js';
import {
  acquireLock,
  advanceWatermark,
  getSyncState,
  recordError,
  recordOk,
  releaseLock,
  sweepStaleLocks,
} from '../db/syncState.js';
import { computeSyncMonths, isCountedSportType, localDateOf, normalizeActivity } from './map.js';
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
 *     forever.
 *
 *  3. EVERY MONTH IS FETCHED BY NAME, one request each, oldest first (`computeSyncMonths`).
 *     Not one wide range: a single range needs a FLOOR, the floor was partly derived from the
 *     rows the fetch itself wrote, and a month that had been missed once was therefore
 *     unreachable forever -- re-syncing recomputed the identical range and recovered nothing.
 *     Asking per month means a month is either in the list or it is not, with no arithmetic in
 *     between. RECONCILIATION IS PER MONTH TOO, gated on that month's own fetch being complete
 *     and untruncated with every record understood, so one month coming back short can neither
 *     suppress nor wrongly authorize deletions in another. A month never reached is never
 *     reconciled. The same gate still gates `last_full_sync_at`: recording progress we did not
 *     make is how a gap becomes permanent.
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

  // One entry per month, oldest first -- see computeSyncMonths. `activityMonthExtent` widens the
  // list to cover any month that already HOLDS rides, which is what keeps "the picker offers this
  // month" and "sync rescans this month" one predicate instead of two that can drift: it is the
  // same query `selectableMonthBounds` feeds to `monthBounds`. Reading it here rather than in
  // map.js is the usual split -- map.js has no database, and sync.js is the one module that may
  // see both.
  const plan = computeSyncMonths(config, {
    mode,
    watermarkEpoch: Number(state?.watermark_epoch ?? 0),
    nowMs,
    dataMonths: await activityMonthExtent(db, config),
  });

  // Logged, never silent: a list clipped by SYNC_MAX_MONTHS still reports `ok`, so without this
  // line a rider whose history exceeds the cap looks fully synced.
  if (plan.trimmedFrom) {
    log.warn('sync month list trimmed to SYNC_MAX_MONTHS', { athlete_id: athleteId, mode, ...plan.trimmedFrom });
  }

  /**
   * ---- fetch, ONE MONTH AT A TIME.
   *
   * `byId` rather than an array because adjacent months overlap by the ±86400 s pad, so a ride
   * near a boundary comes back in two months' fetches. Keyed on activity id, the same key the
   * upsert conflicts on.
   *
   * A failure is NOT fatal: whatever was fetched is worth persisting (the upsert is idempotent),
   * and the error's non-enumerable `partial` is how the client hands over the pages already in
   * hand without putting 200 rides into a log line. But it DOES stop the loop -- every remaining
   * month would hit the same rate limit or the same upstream outage, so continuing turns one error
   * into one per month. Months never reached are simply absent from `results`, and therefore never
   * reconciled.
   */
  const byId = new Map();
  const results = [];
  let fetchError = null;
  let pagesFetched = 0;
  /**
   * DISTINCT ids, not a running total of `activities.length`.
   *
   * The ±86400 s pad makes adjacent months overlap by two days, so a boundary ride is genuinely
   * returned twice. Summing the raw lengths would report 217 scanned for a 216-ride history and
   * make the number drift further the more months are synced -- a diagnostic that inflates with
   * the size of the fetch is worse than none. Unkeyable records are counted individually because
   * there is nothing to dedupe them on; `normalizeActivity` rejects them a few lines below anyway.
   */
  const scannedIds = new Set();
  let unkeyableScanned = 0;

  for (const win of plan.months) {
    let fetched = { activities: [], pages: 0, truncated: true };
    let monthError = null;
    try {
      fetched = await withAuth(
        db,
        config,
        strava,
        athleteId,
        (token) => strava.fetchAllActivities({ accessToken: token, after: win.afterEpoch, before: win.beforeEpoch }),
        { nowMs },
      );
    } catch (err) {
      monthError = err;
      fetchError = err;
      if (err?.partial) {
        fetched = { activities: err.partial.activities, pages: err.partial.pages, truncated: true };
      }
      log.warn('activity fetch failed; persisting what was already fetched', {
        athlete_id: athleteId,
        mode,
        month: win.month,
        pages_fetched: fetched.pages,
        activities_in_hand: fetched.activities.length,
        error_name: err?.name,
        error_message: err?.message,
      });
    }

    pagesFetched += fetched.pages;

    // ---- normalize EVERYTHING. No sport filter, no window filter: see rule 1 at the top.
    const seenIds = [];
    let malformed = 0;
    for (const raw of fetched.activities) {
      const key = raw?.id;
      if (typeof key === 'number' || typeof key === 'string') scannedIds.add(String(key));
      else unkeyableScanned += 1;

      let row;
      try {
        row = normalizeActivity(raw, { athleteId });
      } catch (err) {
        // One unusable record must not fail the whole sync -- that would block a rider
        // indefinitely on data we cannot fix. It DOES suppress reconciliation for THIS MONTH,
        // because a record we could not read is a record whose id is missing from `seenIds`, and
        // reconciliation would read that absence as "the rider deleted it". Scoping that
        // suppression to one month is a gain from doing this per month: before, a single
        // unreadable January record blocked August's deletions too.
        malformed += 1;
        log.warn('skipping an unusable Strava activity', {
          athlete_id: athleteId,
          month: win.month,
          activity_id: raw?.id ?? null,
          error_message: err?.message,
        });
        continue;
      }
      byId.set(row.strava_activity_id, row);
      seenIds.push(row.strava_activity_id);
    }

    results.push({
      ...win,
      seenIds,
      /** The page cap was hit for this month -- reported on the wire as `truncated`. */
      truncated: fetched.truncated === true,
      /**
       * The gate, now per month. All three conditions, and nothing else, permit a destructive
       * write for this month: a complete fetch of it, with every record understood.
       */
      complete: monthError === null && fetched.truncated !== true && malformed === 0,
    });

    if (monthError !== null) break;
  }

  const rows = [...byId.values()];
  // Max over every row of every month, never a positional element: Strava's ordering flips
  // depending on whether `after` was sent.
  let watermarkEpoch = 0;
  for (const row of rows) {
    if (row.start_epoch > watermarkEpoch) watermarkEpoch = row.start_epoch;
  }

  const storedBefore = await countStoredActivities(db, athleteId);
  await upsertActivities(db, athleteId, rows, { syncedAt });
  const activitiesAdded = Math.max(0, (await countStoredActivities(db, athleteId)) - storedBefore);

  /** Every month in the plan was reached. A break above leaves the rest unfetched. */
  const allMonthsReached = results.length === plan.months.length;
  /** Every month was reached AND came back reconcilable. Gates `last_full_sync_at`. */
  const complete = fetchError === null && allMonthsReached && results.every((r) => r.complete);
  /**
   * Kept meaning exactly what it meant before -- "we did not get everything we asked for" -- and
   * NOT widened to "something was unreadable". It is stored in `sync_state.truncated` and shown to
   * admins, so folding a malformed record into it would report a data-quality problem as a
   * pagination problem.
   */
  const truncated = !allMonthsReached || results.some((r) => r.truncated);

  let activitiesRemoved = 0;
  if (mode === 'full') {
    // Reconciled MONTH BY MONTH, against that month's own fetch. A month that came back short
    // reconciles nothing while its neighbours still do -- which is the substantive gain over one
    // wide window, where a single truncated page suppressed deletions for the entire season (or,
    // worse, would have authorized them across months that were never asked for).
    //
    // `startEpoch`/`endEpoch` are the UNPADDED half-open month, always strictly inside the
    // ±86400 s window that was actually sent. Strava's `after`/`before` inclusivity is
    // [UNVERIFIED], so under either reading a ride Strava might not have returned is outside this
    // range and cannot be soft-deleted. Being conservative costs nothing; being greedy deletes a
    // real ride.
    for (const r of results) {
      if (!r.complete) continue;
      activitiesRemoved += await reconcileDeletions(
        db,
        athleteId,
        { startEpoch: r.startEpoch, endEpoch: r.endEpoch },
        r.seenIds,
        nowEpoch,
      );
    }
  }

  if (fetchError === null) {
    // `last_full_sync_at` is only stamped when every month reconciled, so a run that skipped one
    // comes back as 'full' on the next attempt instead of being suppressed for a day.
    // advanceWatermark itself is max(), so it can never move backwards.
    await advanceWatermark(db, athleteId, watermarkEpoch, {
      fullSyncAt: complete && mode === 'full' ? nowEpoch : null,
    });
  }

  if (fetchError !== null) throw fetchError;

  return {
    ok: true,
    mode,
    syncedAt,
    /** The months actually asked for, oldest first. The evidence that each one was requested. */
    monthsSynced: results.map((r) => r.month),
    activitiesScanned: scannedIds.size + unkeyableScanned,
    activitiesCounted: countCountable(config, rows),
    activitiesAdded,
    activitiesRemoved,
    pagesFetched,
    truncated,
  };
}

/**
 * How many of the rides we just stored can show on SOME month's leaderboard.
 *
 * Not "on the board", because there is no single board any more: every calendar month is its own
 * competition, and this one number is reported for a sync that serves all of them. So the date
 * test is against the whole CONFIGURED range (first configured month .. last configured month)
 * rather than one month -- a June ride the rider will see when they pick June is genuinely
 * countable, and reporting 0 for it because the reader happens to be looking at August would make
 * the post-sync line read as a failed sync.
 *
 * The other two tests are the same ones the SQL predicate applies -- sport type and the
 * manual policy -- so a ride this counts is a ride the board will count. `local_date` comes
 * from `start_date_local` (a wall clock with a bogus Z), never from the UTC instant, which is
 * what keeps the Auckland 00:30-local ride on the right day and therefore in the right month.
 *
 * Two known, deliberate discrepancies, both affecting this per-run diagnostic number only and
 * never a total. An admin-APPROVED manual ride counts on the board but not here, because
 * `manual_approved` is admin state this run never read. And a ride landing just outside the
 * configured months -- the fetch window is padded a day on each end -- is not counted here even
 * though the picker DOES now offer its month; counting it would mean re-querying the widened
 * bounds from the database to move one log field.
 */
function countCountable(config, rows) {
  const lo = startOfMonth(config.competitionFirstMonth);
  const hi = endOfMonth(config.competitionLastMonth);
  let counted = 0;
  for (const row of rows) {
    if (!isCountedSportType(row.sport_type, config.allowedSportTypes)) continue;
    const localDate = localDateOf(row.start_date_local);
    if (localDate < lo || localDate > hi) continue;
    if (row.is_manual === 1 && !config.countManualActivities) continue;
    counted += 1;
  }
  return counted;
}

/**
 * Sync EVERY rider on the board, not just the one who pressed Refresh.
 *
 * The board is shared, so a rider looking at it wants everyone's current miles, not their own
 * against a roster that last updated whenever each teammate happened to open the page. But
 * fanning out multiplies the one genuinely scarce resource in this app -- Strava's 100 reads per
 * 15 minutes -- by the size of the roster, so every rule below exists to keep one button press
 * from consuming the quota that the next one needs.
 *
 *  1. THE PRESSING RIDER GOES FIRST, with whatever mode they asked for. Their own data is the
 *     thing they are waiting on, and doing it first means a rate limit hit halfway down the
 *     roster still leaves their press having worked.
 *
 *  2. EVERYONE ELSE GETS AUTO MODE, NEVER `force`. Auto is 'incremental' for the 24 hours after
 *     each rider's own full sync, which is one request each; `FULL_SYNC_INTERVAL_SECONDS` still
 *     gets them a full rescan daily, just not on someone else's button press. Declining to force
 *     means each teammate's own 60-second cooldown throttles the fan-out for free: five people
 *     pressing Refresh in the same minute produce one sweep, not five.
 *
 *  3. ANOTHER RIDER'S FAILURE IS NEVER THE CALLER'S FAILURE. A teammate with a revoked grant, an
 *     expired refresh token or a sync already running must not turn the caller's successful
 *     refresh into an error page. Outcomes are counted and returned; only the caller's own sync
 *     is allowed to throw, and it throws from the caller, not here.
 *
 *  4. A RATE LIMIT STOPS THE SWEEP IMMEDIATELY. Every later rider would hit the same block, so
 *     continuing turns one 429 into one per teammate -- and Strava's block is global to the app,
 *     so it would be spending the caller's next refresh too.
 *
 *  5. RIDERS WHO CANNOT BE SYNCED ARE SKIPPED WITHOUT A REQUEST: no team (absent from the board
 *     by contract, so nothing to show), revoked, disconnected, or no stored tokens.
 *
 * Sequential, never `Promise.all`. The rate-limit gate, the observed-429 block and the
 * single-flight spacer in strava/client.js are all per-INSTANCE state on one shared client, and
 * concurrent calls race all three -- the reserve could never engage and the sweep would walk
 * straight into a block having already reported success for the riders it got to.
 *
 * @param {number} selfAthleteId the rider who pressed Refresh; synced first
 * @param {{selfMode?: 'full'|'incremental'|null, nowMs?: number}} [opts]
 * @returns {Promise<{attempted:number, synced:number, skipped:number, failed:number,
 *   rateLimited:boolean}>} counts for the OTHER riders only; the caller's own outcome is its
 *   own return value from `syncAthlete`.
 */
export async function syncOtherAthletes(db, config, strava, selfAthleteId, { nowMs = Date.now() } = {}) {
  const summary = { attempted: 0, synced: 0, skipped: 0, failed: 0, rateLimited: false };

  const roster = await listAthletes(db);
  for (const row of roster) {
    const id = Number(row.athlete_id);
    if (id === Number(selfAthleteId)) continue;

    // Rule 5. Each of these would cost a request (or a token decrypt) to discover the hard way.
    if (row.team === null || row.team === undefined) { summary.skipped += 1; continue; }
    if (row.strava_revoked_at !== null && row.strava_revoked_at !== undefined) { summary.skipped += 1; continue; }
    if (row.disconnected_at !== null && row.disconnected_at !== undefined) { summary.skipped += 1; continue; }
    if (!(await hasTokens(db, id))) { summary.skipped += 1; continue; }

    summary.attempted += 1;
    try {
      // Rule 2: auto mode, and no `force`. A rider inside their own cooldown throws 429
      // scope:'local', which the catch below counts as a skip -- that IS the throttle.
      await syncAthlete(db, config, strava, id, { mode: null, nowMs });
      summary.synced += 1;
    } catch (err) {
      // Rule 4. `translateStravaError` has already turned a Strava 429 into an HttpError with
      // this code, and our own cooldown raises the same code with scope 'local' -- so the scope
      // is what distinguishes "Strava is blocking us, stop" from "this teammate synced a moment
      // ago, move on".
      if (err?.code === ERROR_CODES.RATE_LIMITED) {
        if (err?.extra?.scope === 'local') {
          summary.attempted -= 1;
          summary.skipped += 1;
          continue;
        }
        summary.rateLimited = true;
        log.warn('roster sync stopped by a Strava rate limit', {
          athlete_id: id,
          synced_so_far: summary.synced,
          error_message: err?.message,
        });
        break;
      }
      // Rule 3. Logged at warn, counted, and swallowed: a teammate needing to reconnect is not
      // the caller's problem to see as an error.
      summary.failed += 1;
      log.warn('roster sync skipped a rider', {
        athlete_id: id,
        error_name: err?.name,
        error_code: err?.code ?? null,
        error_message: err?.message,
      });
    }
  }

  return summary;
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
