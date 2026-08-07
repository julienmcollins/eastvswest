import { SYNC_MAX_MONTHS, SYNC_WINDOW_PAD_SECONDS } from '../contracts.js';
import { addMonths, epochAtStartOfDate, epochAtEndOfDate, isCalendarMonth, startOfMonth, endOfMonth, monthOf, todayInTz } from '../lib/dates.js';

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
 * The [after, before] window to ask Strava for, in unix seconds.
 *
 * ONE fetch range covers EVERY month worth fetching. It is deliberately not per-month: sync
 * stores everything and the leaderboard filters at query time (sync.js rule 1), so a
 * per-month fetch would multiply requests against a rate-limited API to produce data we
 * already have.
 *
 * THE FLOOR IS A UNION OF THREE SOURCES -- unless `sinceMonth` names one outright, see below --
 * and it must stay a superset of what the month picker offers. Each source is a month a reader
 * can legitimately end up looking at:
 *
 *   1. the first day of `competitionFirstMonth` -- a superset of `COMPETITION_START` whenever
 *      that date falls mid-month, and the widening is required: a START of 2026-06-15 makes all
 *      of June selectable, so June 1-14 must be fetchable or that month's board is silently short;
 *   2. the CURRENT month, because leaving it out is a silent, total failure. With
 *      COMPETITION_START/END set to a month that has not begun (September, say, configured in
 *      August) the configured range is entirely in the future, `after` gets clamped to now by the
 *      rule below, and every sync then asks Strava for "rides between now and tomorrow" --
 *      succeeding, reporting `ok`, and storing NOTHING, for weeks;
 *   3. the earliest month that already HOLDS ride data (`dataMonths`, queried by the caller).
 *
 * Source 3 is the fix for a reported bug, and the reason is worth keeping: the range used to be
 * sources 1 and 2 only, which for a future one-month `.env` (START=2026-09-01 viewed in August)
 * collapses the floor onto the first of the CURRENT month, every month, forever. July's board
 * then holds only whatever happened to be fetched while July was current -- and since
 * /athlete/activities has no `modified_after`, the full rescan that exists to catch late uploads,
 * edits and privacy flips is the only thing that could find the rest, and it never reached July.
 * A rider who connected in August had no July history at all.
 *
 * That made the FETCH floor narrower than the BROWSE floor: `monthBounds` in
 * server/lib/dates.js already unions stored data into what a reader may select, so the picker
 * offered July while sync skipped it. Feeding both from the same `activityMonthExtent` query
 * makes "the picker offers this month" and "sync fetches this month" one predicate instead of
 * two that can drift.
 *
 * Still BOUNDED, not "all of history": this is the one decision in the app that spends Strava
 * rate limit, and source 3 is derived from stored data, so it is clamped to SYNC_MAX_MONTHS
 * back from the current month and the clamp is reported rather than applied silently. The clamp
 * applies to `sinceMonth` too -- `--since 1990-01` is a typo, not a request.
 *
 * Padded by SYNC_WINDOW_PAD_SECONDS (86400) on BOTH ends. The justification is that it
 * is correct under BOTH possible readings of `before`/`after` -- whether Strava compares
 * `start_date` (UTC) or `start_date_local` -- because no UTC offset exceeds 14 hours,
 * which is less than 24. It is explicitly NOT justified by the unverified claim that
 * Strava filters on UTC; if that claim turns out to be false, this window is still right.
 *
 * `mode:'incremental'` starts from the watermark; `mode:'full'` ignores it and rescans
 * the whole range, because a watermark alone is provably wrong here: a trip uploaded a
 * week late, a Garmin backfill, or a ride flipped from "Only You" to "Everyone" all have
 * a start_date older than the watermark, and /athlete/activities has no `modified_after`
 * to find them with.
 *
 * `sinceMonth` REPLACES the union outright, and that is the one escape hatch from the
 * circularity above: source 3 can only ever widen the floor to a month that ALREADY holds
 * rides, so a month that was never fetched in the first place is unreachable by every source
 * here -- re-running a backfill computes the identical window and recovers nothing. An
 * operator has to be able to name the month. It is deliberately unconditional in BOTH
 * directions rather than joining the `min`: widening is what recovers a skipped July, and
 * narrowing is what lets a rider whose history exceeds STRAVA_MAX_PAGES be backfilled in
 * chunks. Narrowing is safe because `reconcileDeletions`' range is derived from this same
 * window (server/strava/sync.js), so a narrow fetch can only ever reconcile the months it
 * actually fetched -- it cannot soft-delete a month it did not ask Strava about.
 *
 * NOTHING ON THE REQUEST PATH MAY SET IT. `POST /api/me/sync` deliberately does not forward
 * the rider's on-screen month here; a caller who picks their own fetch window picks their own
 * reconcile window with it. It is set by the admin backfill route and by nothing else.
 *
 * @param {{first: string|null, last: string|null}|null} [opts.dataMonths] extent of STORED ride
 *   data, from `activityMonthExtent` in server/db/activities.js. Passed in rather than read here
 *   because this module must stay database-free; `monthBounds` takes it the same way and for the
 *   same reason. Omitting it degrades to the config-plus-clock floor, which is the bug described
 *   above -- every request-serving caller must supply it.
 * @param {string|null} [opts.sinceMonth] `YYYY-MM`. An explicit floor that overrides the union.
 * @returns {{afterEpoch:number, beforeEpoch:number, trimmedFrom:object|null, firstMonth:string}}
 *   `trimmedFrom` is non-null only when SYNC_MAX_MONTHS clipped the floor, so the caller can log
 *   it. A silently capped window reads as "we fetched everything" when it did not. `firstMonth` is
 *   the floor ACTUALLY used, after every clamp -- so an operator reads what was fetched rather than
 *   what was asked for. The two differ whenever a `sinceMonth` was clamped to the current month or
 *   trimmed by the cap, and printing the request instead of the result is how a tool ends up
 *   claiming to have covered a month it never asked about.
 */
export function computeSyncWindow(config, { mode = 'full', watermarkEpoch = 0, nowMs = Date.now(), dataMonths = null, sinceMonth = null } = {}) {
  if (mode !== 'full' && mode !== 'incremental') {
    throw new StravaMapError(`computeSyncWindow: mode must be 'full' or 'incremental', got ${JSON.stringify(mode)}.`);
  }
  if (!Number.isFinite(nowMs)) throw new StravaMapError(`computeSyncWindow: nowMs must be finite, got ${nowMs}.`);
  // Thrown, never quietly ignored -- unlike `dataMonths.first`, which is derived from stored data
  // and so is tolerated when corrupt. This one is a human typing a month on a command line, and
  // silently falling back to the union would run a backfill that reports success while covering
  // exactly the range that was already broken.
  if (sinceMonth !== null && sinceMonth !== undefined && !isCalendarMonth(sinceMonth)) {
    throw new StravaMapError(`computeSyncWindow: sinceMonth must be a YYYY-MM calendar month, got ${JSON.stringify(sinceMonth)}.`);
  }

  const currentMonth = monthOf(todayInTz(config.competitionTz, nowMs));

  // The floor is the EARLIEST of the three, so the fetch range is a superset of every month the
  // picker offers. Plain `<` on `YYYY-MM` is a correct chronological compare (fixed-width and
  // zero-padded), which is why no Date is built to order them -- same property the whole month
  // layer relies on. `isCalendarMonth` guards each candidate because `dataMonths.first` comes
  // from a `substr` over stored data: one corrupt `start_date_local` must be ignored here, not
  // honoured as a floor.
  const candidates = [config.competitionFirstMonth, currentMonth, dataMonths?.first]
    .filter((m) => isCalendarMonth(m));
  // `min(sinceMonth, currentMonth)`, NOT sinceMonth alone. The current month is the one month that
  // is never negotiable -- see source 2 above -- and an override allowed past it walks straight
  // back into that failure: the default floor is `competitionFirstMonth`, which for a season that
  // has not begun (September, configured in August) is in the FUTURE, so a plain override would
  // ask Strava for "rides between now and tomorrow" and report `ok` having stored nothing. That is
  // the exact bug this parameter was added to fix, reintroduced through the fix. Clamping costs
  // nothing real either: a floor later than the current month can only select months nobody has
  // ridden yet, so no reachable ride is lost.
  let startMonth = isCalendarMonth(sinceMonth)
    ? (sinceMonth < currentMonth ? sinceMonth : currentMonth)
    : candidates.reduce((best, m) => (m < best ? m : best), currentMonth);

  // Bounded, and reported. See SYNC_MAX_MONTHS in contracts.js for why the data-derived floor
  // cannot be trusted unclamped. Trimming the OLDEST months keeps the current month reachable,
  // which is the one month that can still be ridden.
  const floorMonth = addMonths(currentMonth, -(SYNC_MAX_MONTHS - 1));
  let trimmedFrom = null;
  if (startMonth < floorMonth) {
    trimmedFrom = { requested_first_month: startMonth, first_month: floorMonth, max_months: SYNC_MAX_MONTHS };
    startMonth = floorMonth;
  }

  const rangeStart = epochAtStartOfDate(startOfMonth(startMonth));
  // Not widened by `dataMonths.last`: `upper` below is clamped to `now`, and the current month's
  // end is always >= now, so a later data month could not move this bound anyway.
  const rangeEnd = Math.max(
    epochAtEndOfDate(endOfMonth(config.competitionLastMonth)),
    epochAtEndOfDate(endOfMonth(currentMonth)),
  );
  const nowSeconds = Math.floor(nowMs / 1000);

  // Never ask for the future, and never past the end of the range: rides after it are
  // outside anything anyone can select, and asking for them only spends rate limit.
  const upper = Math.min(nowSeconds, rangeEnd);

  let lower = rangeStart;
  if (mode === 'incremental' && Number.isFinite(watermarkEpoch) && watermarkEpoch > rangeStart) {
    lower = watermarkEpoch;
  }

  // Clamped to `now` as well as to 0, because `after` is the one bound Strava validates:
  // a future value is rejected outright with 400 {field:'after', code:'future'}. Before the
  // first selectable month, RANGE_START - 86400 is still in the future, so an unclamped
  // `after` makes EVERY sync fail with a 502 instead of succeeding with nothing to show.
  // `upper` was already clamped to now on the line above; this is the same rule applied to
  // the lower bound. A future `before` is fine and is the normal case every day of a month.
  const afterEpoch = Math.max(0, Math.min(lower - SYNC_WINDOW_PAD_SECONDS, nowSeconds));
  // Math.max keeps the window non-empty before the first month opens, where
  // min(now, RANGE_END) is below RANGE_START and a naive subtraction would invert the range.
  const beforeEpoch = Math.max(upper + SYNC_WINDOW_PAD_SECONDS, afterEpoch + 1);

  return { afterEpoch, beforeEpoch, trimmedFrom, firstMonth: startMonth };
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
