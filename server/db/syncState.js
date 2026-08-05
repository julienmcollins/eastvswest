import { SYNC_LOCK_TTL_SECONDS } from '../contracts.js';

/**
 * Per-athlete sync bookkeeping: the advisory lock, the cooldown clock, the watermark, and
 * the last outcome.
 *
 * The lock lives in the database rather than in process memory on purpose. It has to
 * survive a serverless cold start, where every request may be a different isolate and an
 * in-process mutex protects nothing.
 */

/** Truncated so a pathological upstream error message cannot bloat the row. */
const MAX_ERROR_CHARS = 500;

/** @returns {Promise<object|undefined>} the row, or undefined if this athlete never synced */
export async function getSyncState(db, athleteId) {
  return db.get(
    `SELECT athlete_id, watermark_epoch, last_full_sync_at, last_sync_started, last_sync_finished,
            lock_expires_at, last_status, last_error, activities_upserted, pages_fetched, truncated
       FROM sync_state
      WHERE athlete_id = ?`,
    [athleteId],
  );
}

/** Create the row if it is missing, leaving an existing row untouched. */
export async function ensureSyncState(db, athleteId) {
  await db.run(
    `INSERT INTO sync_state (athlete_id) VALUES (?) ON CONFLICT(athlete_id) DO NOTHING`,
    [athleteId],
  );
}

/**
 * Take the sync lock, or report why not.
 *
 * ONE statement does the whole thing -- insert-or-conditionally-update with RETURNING.
 * A read-then-write ("is it locked? no? then lock it") lets two concurrent Refresh clicks
 * both observe an unlocked row and both start syncing, which is how an athlete burns
 * double the rate-limit budget and races themselves on the upsert.
 *
 * `lock_expires_at IS NULL OR lock_expires_at <= ?` is the self-heal: a process killed
 * mid-sync leaves a lock behind, and without the TTL that athlete could never sync again.
 *
 * @returns {Promise<{acquired:boolean, lockExpiresAt:number|null, retryAfterSeconds:number}>}
 */
export async function acquireLock(db, athleteId, { nowEpoch, ttlSeconds = SYNC_LOCK_TTL_SECONDS } = {}) {
  const expires = nowEpoch + ttlSeconds;
  const row = await db.get(
    `INSERT INTO sync_state (athlete_id, last_sync_started, lock_expires_at, last_status)
     VALUES (?,?,?,'running')
     ON CONFLICT(athlete_id) DO UPDATE SET
       last_sync_started = excluded.last_sync_started,
       lock_expires_at   = excluded.lock_expires_at,
       last_status       = 'running'
      WHERE sync_state.lock_expires_at IS NULL OR sync_state.lock_expires_at <= ?
     RETURNING lock_expires_at`,
    [athleteId, nowEpoch, expires, nowEpoch],
  );

  if (row) return { acquired: true, lockExpiresAt: Number(row.lock_expires_at), retryAfterSeconds: 0 };

  // The upsert's WHERE filtered the update out, so somebody else holds a live lock. Read it
  // back purely to tell the caller how long to wait; the decision is already made.
  const held = await getSyncState(db, athleteId);
  const lockExpiresAt = held?.lock_expires_at ?? null;
  return {
    acquired: false,
    lockExpiresAt,
    retryAfterSeconds: lockExpiresAt === null ? 1 : Math.max(1, lockExpiresAt - nowEpoch),
  };
}

/**
 * Drop the lock without touching the outcome fields.
 *
 * Deliberately separate from recordOk/recordError (which also clear the lock) so the
 * caller can release in a `finally` and still have the recorded status stand.
 */
export async function releaseLock(db, athleteId) {
  const res = await db.run(`UPDATE sync_state SET lock_expires_at = NULL WHERE athlete_id = ?`, [athleteId]);
  return res.changes > 0;
}

/** Record a successful run. Clears `last_error` so a stale message cannot outlive its cause. */
export async function recordOk(db, athleteId, { nowEpoch, activitiesUpserted = 0, pagesFetched = 0, truncated = false } = {}) {
  const res = await db.run(
    `UPDATE sync_state
        SET last_status = 'ok',
            last_error = NULL,
            last_sync_finished = ?,
            activities_upserted = ?,
            pages_fetched = ?,
            truncated = ?,
            lock_expires_at = NULL
      WHERE athlete_id = ?`,
    [nowEpoch, activitiesUpserted, pagesFetched, truncated ? 1 : 0, athleteId],
  );
  return res.changes > 0;
}

/**
 * Record a failed run.
 *
 * `last_sync_finished` is stamped on failure too, because the 60 s cooldown is derived from
 * it: without that, a failing sync is retryable in a tight loop and a rate-limit error
 * becomes a rate-limit storm.
 *
 * The message is stored verbatim and shown to admins, so the CALLER must pass an already
 * redacted string -- a raw Strava OAuth error body can contain a client secret or a live
 * refresh token, and this column ends up in an admin API response.
 */
export async function recordError(db, athleteId, { nowEpoch, message = 'sync failed' } = {}) {
  const res = await db.run(
    `UPDATE sync_state
        SET last_status = 'error',
            last_error = ?,
            last_sync_finished = ?,
            lock_expires_at = NULL
      WHERE athlete_id = ?`,
    [String(message).slice(0, MAX_ERROR_CHARS), nowEpoch, athleteId],
  );
  return res.changes > 0;
}

/**
 * Move the incremental-sync watermark forward, never backward.
 *
 * `max(watermark_epoch, ?)` rather than a plain assignment: a partial or out-of-order run
 * that computed a lower high-water mark would otherwise rewind the watermark and cause the
 * next incremental sync to re-fetch (harmless) -- but the inverse mistake, assigning a
 * *higher* value after a truncated fetch, permanently skips the pages that never arrived.
 * Callers must therefore only call this after a complete, untruncated fetch.
 *
 * `last_full_sync_at` is only written when supplied, so an incremental run cannot make the
 * athlete look fully reconciled and suppress the daily full sync.
 */
export async function advanceWatermark(db, athleteId, watermarkEpoch, { fullSyncAt = null } = {}) {
  const res = await db.run(
    `UPDATE sync_state
        SET watermark_epoch = max(watermark_epoch, ?),
            last_full_sync_at = COALESCE(?, last_full_sync_at)
      WHERE athlete_id = ?`,
    [Number(watermarkEpoch) || 0, fullSyncAt, athleteId],
  );
  return res.changes > 0;
}

/**
 * Startup sweep: any lock whose TTL has passed belonged to a process that died mid-sync.
 *
 * Flipping the row to 'error' rather than silently to 'ok' matters -- 'running' forever is
 * indistinguishable from "in progress", so the athlete's Refresh button would keep
 * returning 409 with nothing to point at.
 *
 * @returns {Promise<number>} rows healed
 */
export async function sweepStaleLocks(db, nowEpoch) {
  const res = await db.run(
    `UPDATE sync_state
        SET last_status = 'error',
            last_error = 'sync interrupted: lock expired without release',
            lock_expires_at = NULL
      WHERE lock_expires_at IS NOT NULL AND lock_expires_at <= ?`,
    [nowEpoch],
  );
  return res.changes;
}
