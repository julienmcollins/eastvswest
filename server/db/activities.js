import { placeholders } from './bind.js';
import { isoUtcNow, monthBounds } from '../lib/dates.js';

/**
 * The activities table: writes from sync, reads for the per-rider ride list.
 *
 * Design rule inherited from the spec: EVERYTHING Strava returns is stored and the filtering
 * happens at query time. Dropping non-bike rides at fetch time would make any future change
 * to ALLOWED_SPORT_TYPES require a full re-sync of every athlete against a rate-limited API.
 */

/**
 * The counted-activity predicate, in ONE place.
 *
 * Every aggregate and the per-ride `counted` flag are built from this, so the itemized list
 * can never claim a ride counts while the totals disagree. The activities table must be
 * aliased `ac` by every caller.
 *
 * The `?` for the sport list is generated from `allowedSportTypes.length` -- never a
 * hardcoded `IN (?,?,?,?)`. A hardcoded arity does not fail loudly when someone configures
 * three or five sport types; the query keeps running and quietly stops matching.
 */
export function countedPredicate(config, window) {
  const sports = config.allowedSportTypes;
  return {
    sql: `ac.deleted_at IS NULL
          AND ac.local_date >= ? AND ac.local_date <= ?
          AND ac.sport_type IN (${placeholders(sports.length)})
          AND (ac.is_manual = 0 OR ? = 1 OR ac.manual_approved = 1)`,
    params: [window.start, window.end, ...sports, config.countManualActivities ? 1 : 0],
  };
}

/**
 * The upsert. Keyed on Strava's own activity id, so re-syncing is naturally idempotent and
 * can never double-count a ride.
 *
 * Two details in the SET clause are load-bearing:
 *  - `athlete_id` is included, so a row whose ownership was mis-recorded self-heals.
 *  - `deleted_at = NULL`, so a ride that reappears (a rider un-hid it, or a reconciliation
 *    ran against a partial fetch) is un-deleted rather than staying invisible forever.
 * And one omission is: `local_date` is GENERATED ALWAYS -- assigning to it is an error, and
 * it recomputes itself from `start_date_local` on every write.
 */
const UPSERT_SQL = `
INSERT INTO activities (
  strava_activity_id, athlete_id, name, sport_type, legacy_type, sport_type_source,
  distance_meters, moving_time_seconds, elapsed_time_seconds, total_elevation_gain_meters,
  start_date_utc, start_epoch, start_date_local, timezone,
  is_private, is_manual, is_trainer, deleted_at, synced_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)
ON CONFLICT(strava_activity_id) DO UPDATE SET
  athlete_id=excluded.athlete_id,
  name=excluded.name, sport_type=excluded.sport_type, legacy_type=excluded.legacy_type,
  sport_type_source=excluded.sport_type_source, distance_meters=excluded.distance_meters,
  moving_time_seconds=excluded.moving_time_seconds, elapsed_time_seconds=excluded.elapsed_time_seconds,
  total_elevation_gain_meters=excluded.total_elevation_gain_meters,
  start_date_utc=excluded.start_date_utc, start_epoch=excluded.start_epoch,
  start_date_local=excluded.start_date_local, timezone=excluded.timezone,
  is_private=excluded.is_private, is_manual=excluded.is_manual, is_trainer=excluded.is_trainer,
  deleted_at=NULL, synced_at=excluded.synced_at`;

/** Read a field under either the column name or its camelCase twin. */
function pick(row, snake, camel) {
  const a = row[snake];
  if (a !== undefined) return a;
  return row[camel];
}

function requireInt(value, what, id) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new TypeError(`activity ${id}: ${what} must be an integer, got ${JSON.stringify(value)}`);
  return n;
}

function requireText(value, what, id) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`activity ${id}: ${what} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Turn one normalized activity into the positional parameter list.
 *
 * The validation here is not belt-and-braces: `distance_meters` is NOT NULL with a
 * `>= 0` CHECK, and a missing `distance` upstream arrives as `undefined`, which the adapter
 * binds as NULL. That would surface as a constraint error naming a column rather than an
 * activity, so the id is put in the message here instead.
 */
function bindActivity(athleteId, row, syncedAt) {
  const id = requireInt(pick(row, 'strava_activity_id', 'id'), 'strava_activity_id', row?.id);

  const distance = Number(pick(row, 'distance_meters', 'distanceMeters'));
  if (!Number.isFinite(distance) || distance < 0) {
    throw new TypeError(`activity ${id}: distance_meters must be a finite number >= 0, got ${JSON.stringify(pick(row, 'distance_meters', 'distanceMeters'))}`);
  }

  const source = pick(row, 'sport_type_source', 'sportTypeSource') ?? 'sport_type';
  if (source !== 'sport_type' && source !== 'type') {
    throw new TypeError(`activity ${id}: sport_type_source must be 'sport_type' or 'type', got ${JSON.stringify(source)}`);
  }

  return [
    id,
    athleteId,
    pick(row, 'name', 'title') ?? '',
    requireText(pick(row, 'sport_type', 'sportType'), 'sport_type', id),
    pick(row, 'legacy_type', 'legacyType') ?? null,
    source,
    distance,
    Number(pick(row, 'moving_time_seconds', 'movingTimeSeconds') ?? 0),
    Number(pick(row, 'elapsed_time_seconds', 'elapsedTimeSeconds') ?? 0),
    Number(pick(row, 'total_elevation_gain_meters', 'totalElevationGainMeters') ?? 0),
    requireText(pick(row, 'start_date_utc', 'startDateUtc'), 'start_date_utc', id),
    requireInt(pick(row, 'start_epoch', 'startEpoch'), 'start_epoch', id),
    // The local wall clock with a misleading trailing Z. `local_date` is generated from its
    // first 10 characters, so this string -- not start_date_utc -- decides which calendar day
    // the ride scores on.
    requireText(pick(row, 'start_date_local', 'startDateLocal'), 'start_date_local', id),
    row.timezone ?? null,
    pick(row, 'is_private', 'isPrivate') ?? 0,
    pick(row, 'is_manual', 'isManual') ?? 0,
    pick(row, 'is_trainer', 'isTrainer') ?? 0,
    pick(row, 'synced_at', 'syncedAt') ?? syncedAt,
  ];
}

/**
 * Upsert a whole page-set of activities in ONE transaction.
 *
 * All-or-nothing via batch(): a partial write would leave the watermark and the stored rows
 * disagreeing, and the next incremental sync would skip the gap.
 *
 * `manual_approved` is deliberately not in the statement at all. It is admin state, not
 * Strava state -- carrying it through the upsert would silently un-approve every already
 * approved manual ride on the next sync.
 *
 * @returns {Promise<number>} number of activities written
 */
export async function upsertActivities(db, athleteId, rows, { syncedAt = isoUtcNow() } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('upsertActivities: rows must be an array.');
  if (rows.length === 0) return 0;

  // Validate every row BEFORE opening the transaction, so one malformed activity fails fast
  // instead of rolling back a good page of work.
  const statements = rows.map((row) => [UPSERT_SQL, bindActivity(athleteId, row, syncedAt)]);
  await db.batch(statements);
  return statements.length;
}

/**
 * Soft-delete in-window rides that Strava no longer reports.
 *
 * ONLY safe after a COMPLETE, UNTRUNCATED, full-mode fetch. The caller owns that decision.
 * Run against a partial fetch -- a 500 mid-pagination, a rate-limit cut-off, an incremental
 * window -- this soft-deletes every ride the missing pages would have returned, wiping a
 * rider's season on a transient upstream error.
 *
 * Without it, though, a rider's deleted 340-mile GPS-glitch ride counts for their team for
 * the rest of the competition, so it is not optional either.
 *
 * `seenIds` are coerced to Numbers first, and that is not cosmetic: SQLite compares across
 * storage classes, so a string '123' is NOT equal to the integer 123, and a set of string
 * ids would make `NOT IN` true for every row -- soft-deleting the entire window.
 *
 * @param {number[]} seenIds every activity id the fetch actually returned
 * @returns {Promise<number>} rows soft-deleted
 */
export async function reconcileDeletions(db, athleteId, { startEpoch, endEpoch }, seenIds, nowEpoch) {
  const window = [athleteId, requireInt(startEpoch, 'startEpoch', athleteId), requireInt(endEpoch, 'endEpoch', athleteId)];

  if (!Array.isArray(seenIds)) throw new TypeError('reconcileDeletions: seenIds must be an array.');

  if (seenIds.length === 0) {
    // A complete fetch that returned nothing genuinely means the rider has no rides in the
    // window. `NOT IN ()` is not valid SQL, so the clause is simply omitted.
    const res = await db.run(
      `UPDATE activities SET deleted_at = ?
        WHERE athlete_id = ? AND start_epoch >= ? AND start_epoch < ? AND deleted_at IS NULL`,
      [nowEpoch, ...window],
    );
    return res.changes;
  }

  const ids = seenIds.map((v, i) => requireInt(v, `seenIds[${i}]`, athleteId));
  // Placeholders from the actual length. SQLite's default parameter ceiling is 32766, which
  // a 90-day competition window cannot approach (a rider would need 32k rides in 3 months).
  const res = await db.run(
    `UPDATE activities SET deleted_at = ?
      WHERE athlete_id = ? AND start_epoch >= ? AND start_epoch < ?
        AND deleted_at IS NULL
        AND strava_activity_id NOT IN (${placeholders(ids.length)})`,
    [nowEpoch, ...window, ...ids],
  );
  return res.changes;
}

/**
 * The rider's itemized rides for `GET /api/riders/:athleteId/activities`.
 *
 * `counted` is computed in SQL from the shared predicate, so it always agrees with the
 * leaderboard totals. Soft-deleted rides are excluded outright -- an itemized list of rides
 * the rider already deleted on Strava is confusing, not informative.
 *
 * No lat/lng and no polylines appear here because they are never stored at all.
 */
export async function listAthleteActivities(db, config, athleteId, { start, end, limit = 500 } = {}) {
  const counted = countedPredicate(config, { start, end });
  return db.all(
    `SELECT ac.strava_activity_id, ac.name, ac.sport_type, ac.legacy_type,
            ac.distance_meters, ac.moving_time_seconds, ac.total_elevation_gain_meters,
            ac.local_date, ac.start_date_utc, ac.start_date_local,
            ac.is_private, ac.is_manual, ac.manual_approved, ac.is_trainer,
            CASE WHEN ${counted.sql} THEN 1 ELSE 0 END AS counted
       FROM activities ac
      WHERE ac.athlete_id = ?
        AND ac.deleted_at IS NULL
        AND ac.local_date >= ? AND ac.local_date <= ?
      ORDER BY ac.local_date DESC, ac.start_epoch DESC, ac.strava_activity_id DESC
      LIMIT ?`,
    [...counted.params, athleteId, start, end, limit],
  );
}

/** @returns {Promise<object|undefined>} */
export async function getActivity(db, activityId) {
  return db.get(
    `SELECT strava_activity_id, athlete_id, name, sport_type, legacy_type, distance_meters,
            moving_time_seconds, local_date, start_date_utc, start_date_local, timezone,
            is_private, is_manual, manual_approved, is_trainer, deleted_at, synced_at
       FROM activities
      WHERE strava_activity_id = ?`,
    [activityId],
  );
}

/**
 * Admin approval of a manual ride.
 *
 * Manual rides are excluded by default because a manual distance is free text with no device
 * and no upper bound: counting them automatically means the first person to notice wins.
 *
 * @returns {Promise<boolean>} false => no such activity (=> 404)
 */
export async function setManualApproved(db, activityId, approved) {
  const res = await db.run(
    `UPDATE activities SET manual_approved = ? WHERE strava_activity_id = ?`,
    [approved ? 1 : 0, activityId],
  );
  return res.changes > 0;
}

/**
 * Hard-delete every activity for an athlete (`DELETE /api/me?purge=1`).
 *
 * A real delete, not a soft one: this is the rider exercising a data-removal request, and a
 * soft delete would leave their rides in the file they asked to be removed from.
 *
 * @returns {Promise<number>} rows deleted
 */
export async function purgeAthleteActivities(db, athleteId) {
  const res = await db.run(`DELETE FROM activities WHERE athlete_id = ?`, [athleteId]);
  return res.changes;
}

/** Highest `start_epoch` we have stored for this athlete. The watermark's ground truth. */
export async function maxStartEpoch(db, athleteId) {
  const row = await db.get(
    `SELECT COALESCE(MAX(start_epoch), 0) AS max_epoch FROM activities WHERE athlete_id = ?`,
    [athleteId],
  );
  return Number(row.max_epoch);
}

/**
 * Lexical date bounds that match EVERY row, used to reuse `countedPredicate` with its date test
 * neutralized. `local_date` is TEXT in `YYYY-MM-DD` form, so these compare correctly as strings
 * -- which is the same property the whole month layer relies on. Not `'0000-00-00'`/`'9999-99-99'`
 * because those are not dates at all and would read as a typo the first time somebody greps them.
 */
const ALL_DATES = Object.freeze({ start: '0000-01-01', end: '9999-12-31' });

/**
 * The first and last month that actually HOLD a ride the board would count.
 *
 * This is what widens the month picker past the configured season. Sync stores every activity it
 * fetches regardless of the window (server/strava/sync.js rule 1) and the fetch window is padded
 * by a day on both ends, so rides genuinely do land outside `COMPETITION_START..END` -- and
 * before this query existed, those months were unreachable in the UI with no hint that they held
 * data.
 *
 * The predicate is the SHARED `countedPredicate` with only its date test opened up, so "a month
 * is offered" means exactly "a ride in it would appear on that month's board". A plain
 * `MIN/MAX(local_date)` instead would open months whose only rows are a Run, a soft-deleted ride
 * or an unapproved manual entry -- months guaranteed to render an empty board.
 *
 * `substr(local_date,1,7)` rather than any date function: `local_date` is generated from
 * `start_date_local`, a wall clock carrying a bogus trailing Z, so slicing it is the only reading
 * that keeps an Auckland 00:30-local ride in the month the rider rode it.
 *
 * @returns {Promise<{first: string|null, last: string|null}>} nulls when nothing is stored yet
 */
export async function activityMonthExtent(db, config) {
  const counted = countedPredicate(config, ALL_DATES);
  const row = await db.get(
    `SELECT MIN(substr(ac.local_date, 1, 7)) AS first_month,
            MAX(substr(ac.local_date, 1, 7)) AS last_month
       FROM activities ac
      WHERE ${counted.sql}`,
    counted.params,
  );
  return { first: row?.first_month ?? null, last: row?.last_month ?? null };
}

/**
 * The picker's month bounds for THIS request: the union of stored data, the current month, and
 * the configured season. One extra `MIN/MAX` per request, which the
 * `(local_date, sport_type, athlete_id)` index serves without touching the table.
 *
 * Every request-serving path must go through here rather than calling `monthBounds` directly:
 * `monthBounds` defaults to the config-plus-clock range when it is handed no data, and that
 * narrower range is exactly the bug -- it silently answers a request for a month that has rides
 * with a different month's board, and hides the picker outright on a one-month `.env`.
 */
export async function selectableMonthBounds(db, config, nowMs = Date.now()) {
  return monthBounds(config, nowMs, await activityMonthExtent(db, config));
}

/**
 * One row per month that holds a ride the board would count. THE EVIDENCE A BACKFILL WORKED.
 *
 * `activityMonthExtent` above answers "what is the earliest and latest month", which is all the
 * fetch floor and the month picker need -- and which is exactly the wrong shape for checking a
 * backfill. A run that recovered January and August but silently missed everything between them
 * reports the same `{first, last}` as a run that recovered all eight months. A month-by-month
 * count is the only output that distinguishes them, which is why this exists separately rather
 * than as an extra column on that query.
 *
 * The predicate is the SHARED `countedPredicate` with only its date test opened up -- the same
 * reuse, and for the same reason, as `activityMonthExtent`: "this month has 12 rides" then means
 * exactly "12 rides appear on that month's board", rather than counting Runs, soft-deleted rows
 * and unapproved manual entries that the reader will never see. A verification number that does
 * not agree with the thing it is verifying is worse than none.
 *
 * Meters, not miles. `server/db/leaderboard.js` is the only place in the app that converts, and
 * rounding here would let a per-month total disagree with the board's headline figure.
 *
 * @param {{athleteId?: number|null}} [opts] scope to one rider; null is every rider.
 * @returns {Promise<Array<{month: string, ride_count: number, meters: number}>>} ascending by
 *   month. Months with no counted rides are ABSENT, not zero -- the caller knows which months it
 *   asked about and a gap is the signal.
 */
export async function activityMonthlyTotals(db, config, { athleteId = null } = {}) {
  const counted = countedPredicate(config, ALL_DATES);
  const params = [...counted.params];
  let scope = '';
  if (athleteId !== null && athleteId !== undefined) {
    scope = ' AND ac.athlete_id = ?';
    params.push(requireInt(athleteId, 'athleteId', athleteId));
  }

  const rows = await db.all(
    `SELECT substr(ac.local_date, 1, 7)               AS month,
            COUNT(*)                                  AS ride_count,
            COALESCE(SUM(ac.distance_meters), 0)      AS meters
       FROM activities ac
      WHERE ${counted.sql}${scope}
      GROUP BY substr(ac.local_date, 1, 7)
      ORDER BY month ASC`,
    params,
  );

  // Numbers coerced here rather than at every call site: the two drivers do not agree on what a
  // SUM comes back as (node:sqlite can hand back a BigInt), and a BigInt reaching JSON.stringify
  // throws "Do not know how to serialize a BigInt" from inside the response writer.
  return rows.map((row) => ({
    month: String(row.month),
    ride_count: Number(row.ride_count),
    meters: Number(row.meters),
  }));
}
