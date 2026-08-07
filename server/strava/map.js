import { SYNC_MAX_MONTHS, SYNC_WINDOW_PAD_SECONDS } from '../contracts.js';
import { addMonths, epochAtStartOfDate, isCalendarMonth, startOfMonth, monthOf, todayInTz } from '../lib/dates.js';

/**
 * Pure translation layer between Strava's JSON and this app's own shapes.
 *
 * Everything here is a total function of its arguments: no clock, no environment, no
 * network, no database. That is what lets `server/strava/client.js` import it and still
 * run unchanged on a Cloudflare Worker, and it is why every one of these can be tested
 * without a fake server.
 *
 * NOTE: `toBindable` deliberately does NOT live here even though docs/SPEC.md's
 * architecture list mentions it. It already exists in `server/db/db.js` (the module that
 * actually binds parameters), and re-exporting it from here would drag `node:sqlite` into
 * `client.js`'s import graph -- the one thing client.js is forbidden to depend on.
 * `normalizeActivity` instead asserts its own output is bindable, which is the property
 * that actually matters.
 */

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A boundary block is padded by one second past the bucket edge.
 *
 * Without the +1000, a caller that computes "now is >= blockedUntil, so I may send" on
 * the exact millisecond of the boundary immediately re-sends into a bucket that has not
 * actually rolled over yet on Strava's side.
 */
const BOUNDARY_SLACK_MS = 1000;

/** Strava's local timestamps are `YYYY-MM-DDTHH:MM:SSZ` with a LYING Z. Shape only. */
const LOCAL_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

class StravaMapError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'StravaMapError';
  }
}

/**
 * Does this activity's sport_type count toward the competition?
 *
 * Keyed on `sport_type`, NEVER on the legacy `type` field. Strava reports
 * `EMountainBikeRide` with `type: "Ride"`, so a `type`-based filter silently credits
 * e-bike miles to a team -- the single most consequential scoring bug available here.
 * Matching is exact and case-sensitive because Strava's sport types are a closed
 * CamelCase enum, and a case-insensitive match would let a future `EBikeRide` typo in
 * ALLOWED_SPORT_TYPES pass unnoticed.
 */
export function isCountedSportType(sportType, allowedSportTypes) {
  if (!Array.isArray(allowedSportTypes)) {
    throw new StravaMapError('isCountedSportType: allowedSportTypes must be an array (from config.allowedSportTypes).');
  }
  if (typeof sportType !== 'string' || sportType === '') return false;
  return allowedSportTypes.includes(sportType);
}

/** The calendar date a ride is judged on: the first 10 chars of start_date_local. */
export function localDateOf(startDateLocal) {
  if (typeof startDateLocal !== 'string' || !LOCAL_TS_RE.test(startDateLocal)) {
    throw new StravaMapError(`localDateOf: expected a YYYY-MM-DDTHH:MM:SS string, got ${JSON.stringify(startDateLocal)}.`);
  }
  // substr, never Date parsing. `start_date_local` carries a bogus `Z`, so parsing it as
  // an instant and re-formatting shifts the date by the athlete's UTC offset -- exactly
  // the bug that would drop the Auckland 00:30-local ride out of the window.
  return startDateLocal.slice(0, 10);
}

/** Truthy-ish JSON flag -> the 0/1 integer a STRICT SQLite column will actually accept. */
function flag(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  return 0;
}

/**
 * Read a numeric field, or throw.
 *
 * `required` fields (distance) throw when absent. Optional ones default, but a present
 * non-numeric value still throws: `Number('twelve')` is NaN, and a NaN that reaches
 * SUM() turns the entire leaderboard total into NaN with no error and no bad row to find.
 */
function numberField(raw, key, { required = false, fallback = 0, min = null, integer = false } = {}) {
  const v = raw[key];
  if (v === undefined || v === null) {
    if (required) throw new StravaMapError(`normalizeActivity: activity ${raw.id} has no "${key}".`);
    return fallback;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new StravaMapError(
      `normalizeActivity: activity ${raw.id} has non-numeric "${key}" (${typeof v} ${JSON.stringify(v)}).`,
    );
  }
  if (min !== null && v < min) {
    throw new StravaMapError(`normalizeActivity: activity ${raw.id} has "${key}"=${v}, below the allowed minimum ${min}.`);
  }
  return integer ? Math.round(v) : v;
}

/** Strava activity ids are 64-bit-ish integers. Accept a number or a digit string. */
function activityId(raw) {
  const v = raw?.id;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return Number(v);
  throw new StravaMapError(`normalizeActivity: activity has no usable numeric id (got ${JSON.stringify(v)}).`);
}

/**
 * Every value bound to SQLite must be null | number | string.
 *
 * Verified on Node v26.3.0: both a JS boolean and `undefined` throw "Provided value
 * cannot be bound to SQLite parameter N". A pure mapper test asserting
 * `row.is_manual === true` passes happily while every real insert fails, so the mapper
 * asserts its own output here rather than trusting a later test to notice.
 */
function assertBindableRow(row) {
  for (const [key, value] of Object.entries(row)) {
    if (value === null) continue;
    const t = typeof value;
    if (t === 'string') continue;
    if (t === 'number') {
      if (Number.isFinite(value)) continue;
      throw new StravaMapError(`normalizeActivity: "${key}" is ${String(value)}; refusing to emit a non-finite number.`);
    }
    throw new StravaMapError(`normalizeActivity: "${key}" is a ${t} (${JSON.stringify(value)}); only null|number|string can be bound.`);
  }
  return row;
}

/**
 * Strava activity JSON -> exactly the columns the `activities` upsert binds.
 *
 * Deliberately absent from the output:
 *  - `local_date`   -- a GENERATED ALWAYS ... STORED column; binding it is an error.
 *  - `deleted_at`   -- the upsert writes a literal NULL and reconciliation owns it.
 *  - `synced_at`    -- the writer's clock, not the mapper's (this module has no clock).
 *  - `manual_approved` -- admin state; an upsert must never stomp it.
 *
 * @param {object} raw           a single element of GET /athlete/activities
 * @param {{athleteId?: number}} [opts]  owning athlete; defaults to raw.athlete.id
 */
export function normalizeActivity(raw, { athleteId = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StravaMapError(`normalizeActivity: expected an object, got ${JSON.stringify(raw)}.`);
  }

  const id = activityId(raw);

  // sport_type is the filter field and is NOT NULL. Older payloads (and manual uploads
  // from very old clients) can carry only the legacy `type`; we fall back to it but
  // record that we did, so a wrong total can be traced to a guess rather than to data.
  const sportType = typeof raw.sport_type === 'string' && raw.sport_type !== ''
    ? raw.sport_type
    : (typeof raw.type === 'string' && raw.type !== '' ? raw.type : null);
  if (sportType === null) {
    throw new StravaMapError(`normalizeActivity: activity ${id} has neither sport_type nor type.`);
  }
  const sportTypeSource = typeof raw.sport_type === 'string' && raw.sport_type !== '' ? 'sport_type' : 'type';

  const startDateLocal = raw.start_date_local;
  if (typeof startDateLocal !== 'string' || !LOCAL_TS_RE.test(startDateLocal)) {
    throw new StravaMapError(`normalizeActivity: activity ${id} has an unusable start_date_local (${JSON.stringify(startDateLocal)}).`);
  }

  const startMs = typeof raw.start_date === 'string' ? Date.parse(raw.start_date) : NaN;
  if (!Number.isFinite(startMs)) {
    throw new StravaMapError(`normalizeActivity: activity ${id} has an unparseable start_date (${JSON.stringify(raw.start_date)}).`);
  }

  const owner = athleteId ?? (typeof raw.athlete?.id === 'number' ? raw.athlete.id : null);

  const row = {
    strava_activity_id: id,
    athlete_id: owner,
    // `?? ''` because the column is NOT NULL DEFAULT '' and `undefined` cannot be bound.
    name: typeof raw.name === 'string' ? raw.name : '',
    sport_type: sportType,
    // Kept purely for forensics: it is what tells you later whether a miscount came from
    // a sport_type/type disagreement. `?? null`, never `undefined`.
    legacy_type: typeof raw.type === 'string' ? raw.type : null,
    sport_type_source: sportTypeSource,
    distance_meters: numberField(raw, 'distance', { required: true, min: 0 }),
    moving_time_seconds: numberField(raw, 'moving_time', { min: 0, integer: true }),
    elapsed_time_seconds: numberField(raw, 'elapsed_time', { integer: true }),
    total_elevation_gain_meters: numberField(raw, 'total_elevation_gain'),
    // Canonicalized so start_date_utc is lexicographically comparable across rows;
    // Strava has shipped both `...Z` and `...+00:00` renderings over the years.
    start_date_utc: new Date(startMs).toISOString(),
    start_epoch: Math.floor(startMs / 1000),
    // Stored VERBATIM. This is a wall-clock reading with a bogus Z; the generated
    // local_date column slices it, and nothing may ever re-interpret it as an instant.
    start_date_local: startDateLocal,
    timezone: typeof raw.timezone === 'string' ? raw.timezone : null,
    is_private: flag(raw.private),
    is_manual: flag(raw.manual),
    is_trainer: flag(raw.trainer),
  };

  return assertBindableRow(row);
}

/** unix seconds of a raw activity's true UTC start, or null when unparseable. */
export function startEpochOf(raw) {
  const ms = typeof raw?.start_date === 'string' ? Date.parse(raw.start_date) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * The sync watermark: Math.max over EVERY start_epoch seen, seeded with the previous one.
 *
 * Never `arr[0]` or `arr.at(-1)`. Strava's ordering is documented as newest-first but
 * flips to ascending when `after` is set, and that behaviour is unverified here (network
 * to developers.strava.com is blocked), so a positional read is a coin flip: pick the
 * wrong end and the watermark either barely advances (re-fetching the same rides every
 * sync forever) or jumps to the newest ride and permanently skips everything older.
 * A max over all pages is correct under either ordering. Unparseable dates are skipped
 * rather than folded in, because Math.max(x, NaN) is NaN and would wipe the watermark.
 */
export function maxStartEpoch(activities, seed = 0) {
  let max = Number.isFinite(seed) ? seed : 0;
  for (const raw of activities ?? []) {
    const epoch = startEpochOf(raw);
    if (epoch !== null && epoch > max) max = epoch;
  }
  return max;
}

/**
 * ONE FETCH WINDOW PER MONTH, oldest first. Every month is asked for by name.
 *
 * This used to be a single `[after, before]` spanning every month at once, with a floor that was
 * the earliest of {`competitionFirstMonth`, the current month, the earliest month already holding
 * rides}. That shape had one fatal property: the third source is derived from the rows the fetch
 * itself writes, so it could only ever widen the floor to a month that ALREADY had data. With
 * COMPETITION_START in the future -- which is what shipped -- the floor collapsed onto the first
 * of the CURRENT month, and a month that had been missed once was unreachable by every source
 * forever. Re-syncing computed the identical window and recovered nothing.
 *
 * Asking per month removes the whole class of problem instead of patching the floor:
 *
 *   - A month is either in the list or it is not. There is no arithmetic that can quietly
 *     exclude the middle of a range, and no need for a separate recovery tool -- an ordinary
 *     full sync fetches every month, every time.
 *   - Truncation stops being a dead end. `STRAVA_MAX_PAGES` x `STRAVA_PAGE_SIZE` is 8000 rides;
 *     one calendar month cannot approach it, so a truncated fetch is no longer a state a re-run
 *     reproduces identically.
 *   - Reconciliation gets tighter. The caller reconciles each month against that month's own
 *     fetch, so one month coming back short can no longer suppress -- or wrongly authorize --
 *     deletions in another.
 *
 * WHAT IT COSTS, stated rather than buried: a full sync is now one request per month instead of
 * one or two in total. Roughly 9 for a Jan-September season, per rider. Strava's read limit is
 * 100 per 15 minutes and 1000 per day, so a ten-rider roster is ~90 requests for a full pass --
 * inside the quota, but no longer negligible. Two existing mechanisms keep that safe and neither
 * is incidental: `FULL_SYNC_INTERVAL_SECONDS` means auto mode picks 'full' only once a day per
 * rider, and `mode:'incremental'` below asks only for the months since the watermark, which is
 * normally the current month alone.
 *
 * The month list is still the union of the same three sources -- config, the clock, and stored
 * data -- because each is a month a reader can legitimately select, and "the picker offers this
 * month" must imply "sync rescans this month" or a ride deleted at Strava in an old month can
 * never be reconciled away. Bounded by SYNC_MAX_MONTHS, and the trim is reported rather than
 * applied silently.
 *
 * Each month's window is padded by SYNC_WINDOW_PAD_SECONDS (86400) on BOTH ends. The
 * justification is that it is correct under BOTH possible readings of `before`/`after` --
 * whether Strava compares `start_date` (UTC) or `start_date_local` -- because no UTC offset
 * exceeds 14 hours, which is less than 24. It is explicitly NOT justified by the unverified
 * claim that Strava filters on UTC; if that claim turns out to be false, these windows are still
 * right. The pad makes adjacent months overlap by two days, so a boundary ride is fetched twice;
 * the caller dedupes on activity id, and the upsert is idempotent anyway.
 *
 * `mode:'incremental'` asks only for the months from the watermark onward; `mode:'full'` ignores
 * the watermark and rescans every month, because a watermark alone is provably wrong here: a trip
 * uploaded a week late, a Garmin backfill, or a ride flipped from "Only You" to "Everyone" all
 * have a start_date older than the watermark, and /athlete/activities has no `modified_after` to
 * find them with.
 *
 * @param {{first: string|null, last: string|null}|null} [opts.dataMonths] extent of STORED ride
 *   data, from `activityMonthExtent` in server/db/activities.js. Passed in rather than read here
 *   because this module must stay database-free; `monthBounds` takes it the same way and for the
 *   same reason.
 * @returns {{months: Array<{month:string, afterEpoch:number, beforeEpoch:number,
 *   startEpoch:number, endEpoch:number}>, trimmedFrom:object|null}}
 *   `afterEpoch`/`beforeEpoch` are the padded bounds to send Strava. `startEpoch`/`endEpoch` are
 *   the UNPADDED half-open month in UTC, which is what a caller may reconcile over -- always
 *   strictly inside the padded window, so `reconcile ⊆ fetch` holds by construction rather than
 *   by review. `trimmedFrom` is non-null only when SYNC_MAX_MONTHS clipped the list.
 */
export function computeSyncMonths(config, { mode = 'full', watermarkEpoch = 0, nowMs = Date.now(), dataMonths = null } = {}) {
  if (mode !== 'full' && mode !== 'incremental') {
    throw new StravaMapError(`computeSyncMonths: mode must be 'full' or 'incremental', got ${JSON.stringify(mode)}.`);
  }
  if (!Number.isFinite(nowMs)) throw new StravaMapError(`computeSyncMonths: nowMs must be finite, got ${nowMs}.`);

  const nowSeconds = Math.floor(nowMs / 1000);
  const currentMonth = monthOf(todayInTz(config.competitionTz, nowMs));

  // Plain `<` on `YYYY-MM` is a correct chronological compare (fixed-width and zero-padded),
  // which is why no Date is built to order these -- the same property the whole month layer
  // relies on. `isCalendarMonth` guards each candidate because `dataMonths.first` comes from a
  // `substr` over stored data: one corrupt `start_date_local` must be ignored here, not honoured.
  const candidates = [config.competitionFirstMonth, currentMonth, dataMonths?.first]
    .filter((m) => isCalendarMonth(m));
  let firstMonth = candidates.reduce((best, m) => (m < best ? m : best), currentMonth);

  // Bounded, and reported. See SYNC_MAX_MONTHS in contracts.js for why a data-derived floor
  // cannot be trusted unclamped -- and it now bounds the REQUEST COUNT too, not just the span.
  // Trimming the oldest keeps the current month, the only one that can still be ridden.
  const floorMonth = addMonths(currentMonth, -(SYNC_MAX_MONTHS - 1));
  let trimmedFrom = null;
  if (firstMonth < floorMonth) {
    trimmedFrom = { requested_first_month: firstMonth, first_month: floorMonth, max_months: SYNC_MAX_MONTHS };
    firstMonth = floorMonth;
  }

  // Never past the current month. Nothing can have been ridden in a month that has not begun, so
  // asking for one only spends quota -- and `config.competitionLastMonth` is routinely in the
  // future. This is also why the list can never be empty: `firstMonth` is at most `currentMonth`.
  const lastMonth = currentMonth;

  // Incremental starts at the watermark's month rather than the whole list, which is what keeps an
  // ordinary Refresh at one request. The watermark's own month is INCLUDED, not skipped: rides
  // later in that month than the watermark are exactly what an incremental sync is for.
  let from = firstMonth;
  if (mode === 'incremental' && Number.isFinite(watermarkEpoch) && watermarkEpoch > 0) {
    const watermarkMonth = monthOf(new Date(watermarkEpoch * 1000).toISOString());
    if (isCalendarMonth(watermarkMonth) && watermarkMonth > from) from = watermarkMonth;
    if (from > lastMonth) from = lastMonth;
  }

  const months = [];
  for (let month = from; month <= lastMonth; month = addMonths(month, 1)) {
    const startEpoch = epochAtStartOfDate(startOfMonth(month));
    // Half-open: the first second of the NEXT month. Half-open rather than inclusive because it
    // is what `reconcileDeletions` binds (`>= start AND < end`), and an inclusive end would need
    // every caller to remember the -1.
    const nextStart = epochAtStartOfDate(startOfMonth(addMonths(month, 1)));

    // `after` is the one bound Strava validates: a future value is rejected outright with
    // 400 {field:'after', code:'future'}, so it is clamped to now. For the current month before
    // the 2nd, `startEpoch - 86400` is last month -- fine, and covered by the previous entry too.
    const afterEpoch = Math.max(0, Math.min(startEpoch - SYNC_WINDOW_PAD_SECONDS, nowSeconds));
    // Never ask beyond now. A future `before` is fine and is the normal case every day of the
    // current month, but capping the month end at `now` first is what keeps the request honest.
    const beforeEpoch = Math.max(Math.min(nextStart - 1, nowSeconds) + SYNC_WINDOW_PAD_SECONDS, afterEpoch + 1);

    months.push({
      month,
      afterEpoch,
      beforeEpoch,
      startEpoch,
      // Clamped to what was actually ASKED for, never past it. Without this the current month's
      // reconcile range would run to the 1st of next month while the fetch stopped at
      // now + 1 day, and a ride dated later in the month than today -- which a rider can create
      // by uploading with a future date -- would be soft-deleted as "no longer reported".
      endEpoch: Math.min(nextStart, beforeEpoch),
    });
  }

  return { months, trimmedFrom };
}

/** Case-insensitive header read that works for Headers, a Map, or a plain object. */
function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name) ?? null;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      const v = headers[key];
      return v === undefined || v === null ? null : String(v);
    }
  }
  return null;
}

/** "30,300" -> [30, 300]; anything unparseable becomes null so a default can win. */
function pair(value) {
  if (typeof value !== 'string' || value.trim() === '') return [null, null];
  const parts = value.split(',').map((s) => {
    const n = Number(s.trim());
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  });
  return [parts[0] ?? null, parts[1] ?? null];
}

/**
 * Read both rate-limit header pairs, tolerating the absence of either.
 *
 * Strava sends `X-RateLimit-Limit: <15min>,<daily>` plus the matching `-Usage`, and (on
 * read endpoints) a second `X-ReadRateLimit-*` pair. [UNVERIFIED] whether both pairs are
 * present on every response and whether `Retry-After` is sent at all -- so every field
 * here is independently nullable and the caller keeps its conservative defaults for
 * whatever is missing, rather than treating a missing header as usage 0 (which would
 * hand back the full quota on the very response that says we are out of it).
 */
export function parseRateLimitHeaders(headers) {
  const [shortLimit, dailyLimit] = pair(headerValue(headers, 'x-ratelimit-limit'));
  const [shortUsage, dailyUsage] = pair(headerValue(headers, 'x-ratelimit-usage'));
  const [readShortLimit, readDailyLimit] = pair(headerValue(headers, 'x-readratelimit-limit'));
  const [readShortUsage, readDailyUsage] = pair(headerValue(headers, 'x-readratelimit-usage'));

  const retryAfterRaw = headerValue(headers, 'retry-after');
  const retryAfterSeconds = retryAfterRaw !== null && /^\d+$/.test(retryAfterRaw.trim())
    ? Number(retryAfterRaw.trim())
    : null;

  return {
    shortUsage,
    shortLimit,
    dailyUsage,
    dailyLimit,
    readShortUsage,
    readShortLimit,
    readDailyUsage,
    readDailyLimit,
    retryAfterSeconds,
    /** False means "no rate-limit information at all" -- keep the conservative defaults. */
    headersSeen: [shortUsage, shortLimit, readShortUsage, readShortLimit].some((v) => v !== null),
  };
}

/**
 * Start of the NEXT 15-minute bucket, plus a second of slack.
 *
 * `Math.floor(...)+QUARTER` and not `Math.ceil(...)`: on an exact boundary `ceil` is the
 * identity, so blockedUntil === now, the gate opens immediately, and the retry burns the
 * very rate limit the block exists to protect -- a tight loop against a 429.
 */
export function nextQuarterHourMs(nowMs) {
  if (!Number.isFinite(nowMs)) throw new StravaMapError(`nextQuarterHourMs: nowMs must be finite, got ${nowMs}.`);
  return Math.floor(nowMs / QUARTER_HOUR_MS) * QUARTER_HOUR_MS + QUARTER_HOUR_MS + BOUNDARY_SLACK_MS;
}

/** Next 00:00 UTC plus a second of slack. Same floor-not-ceil reasoning as above. */
export function nextUtcMidnightMs(nowMs) {
  if (!Number.isFinite(nowMs)) throw new StravaMapError(`nextUtcMidnightMs: nowMs must be finite, got ${nowMs}.`);
  return Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS + BOUNDARY_SLACK_MS;
}

export { StravaMapError };
