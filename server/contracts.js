/**
 * Frozen constants shared by every module. Nothing here reads the environment.
 *
 * This file is the contract between the five parallel implementation groups: if a value
 * lives here, it must not be redefined anywhere else in the tree.
 */

/** Wire and DB literals for the two teams, in contractual display order. */
export const TEAMS = Object.freeze(['EAST', 'WEST']);

/** Display labels. The wire always carries the uppercase literal; this is presentation. */
export const TEAM_LABELS = Object.freeze({ EAST: 'East', WEST: 'West' });

/**
 * Exact meters in a statute mile. Conversion happens in exactly one place
 * (server/db/leaderboard.js); this constant exists so nobody re-types 1609.34.
 */
export const METERS_PER_MILE = 1609.344;

/**
 * Bumped whenever the /api shape changes in a way the frontend must notice. The client
 * compares it and shows a "reload to update" banner on mismatch.
 *
 * MUST be bumped in the SAME CHANGE as `API_SCHEMA` in public/config.js -- they are two
 * halves of one constant, and a bump on only one side is indistinguishable from a stale
 * cached module: every visitor gets the banner and nothing renders.
 *
 * 2: the month picker. `competition` describes ONE SELECTED MONTH (`month`, `first_month`,
 *    `last_month`, `prev_month`, `next_month`, `current_month`) instead of one configured
 *    season, and `state`/`days_remaining` are per-month. /api/leaderboard, /api/me and
 *    /api/riders/:id/activities take `?month=YYYY-MM`.
 */
export const API_SCHEMA = 2;

/**
 * Either of these Strava scopes lets us read the rides we need. `activity:read_all`
 * additionally covers rides the athlete marked "Only You".
 *
 * Requiring read_all would turn a privacy preference into a permanent lockout for a
 * rider whose public rides are perfectly countable, so we accept either and badge the
 * difference in the UI.
 */
export const SCOPE_READ_ALL = 'activity:read_all';
export const SCOPE_READ = 'activity:read';
export const REQUIRED_SCOPE_ANY = Object.freeze([SCOPE_READ_ALL, SCOPE_READ]);

/** Scopes we ask for. Strava's consent screen lets the rider uncheck them individually. */
export const REQUESTED_SCOPE = 'read,activity:read_all';

/** Machine-readable `error` values. The client switches on these, never on `message`. */
export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad_request',
  INVALID_JSON: 'invalid_json',
  INVALID_TEAM: 'invalid_team',
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  CSRF_FAILED: 'csrf_failed',
  NOT_FOUND: 'not_found',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
  TEAM_ALREADY_SET: 'team_already_set',
  /** Logged in but no team picked yet. Distinct from TEAM_ALREADY_SET, which is the
   *  opposite failure: a second attempt to claim an already-claimed team. */
  TEAM_REQUIRED: 'team_required',
  SYNC_IN_PROGRESS: 'sync_in_progress',
  RATE_LIMITED: 'rate_limited',
  INSUFFICIENT_SCOPE: 'insufficient_scope',
  STRAVA_REVOKED: 'strava_revoked',
  STRAVA_UNAVAILABLE: 'strava_unavailable',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  UNSUPPORTED_MEDIA_TYPE: 'unsupported_media_type',
  INTERNAL: 'internal',
});

/** Fragment codes the OAuth callback redirects with. The user is in a browser, not a fetch. */
export const OAUTH_FRAGMENT_ERRORS = Object.freeze({
  DENIED: 'denied',
  STATE_EXPIRED: 'state_expired',
  SCOPE: 'scope',
  OAUTH_FAILED: 'oauth_failed',
});

/** Cookie names. `bc_csrf` is deliberately readable by JS; the other two are HttpOnly. */
export const COOKIES = Object.freeze({
  SESSION: 'bc_sid',
  CSRF: 'bc_csrf',
  OAUTH_NONCE: 'bc_oauth',
});

/** Max JSON request body. A lying Content-Length is the attack, so this is enforced on
 *  the byte stream, not on the header. */
export const MAX_BODY_BYTES = 65536;

/** OAuth `state` lifetime. Long enough for a slow consent screen, short enough to bound
 *  the oauth_states table. */
export const OAUTH_STATE_TTL_SECONDS = 600;

/** Hard cap on stored pending OAuth states, since GET /login writes a row unauthenticated. */
export const OAUTH_STATE_MAX_ROWS = 5000;

/** Refresh an access token this many seconds before it actually expires. */
export const TOKEN_REFRESH_SKEW_SECONDS = 300;

/** How long a sync may hold its lock before a later caller treats it as crashed. */
export const SYNC_LOCK_TTL_SECONDS = 300;

/**
 * Padding applied to both ends of the activity fetch window, in seconds.
 *
 * 86400 covers BOTH possible readings of Strava's `before`/`after` params (whether they
 * compare start_date UTC or start_date_local), because no UTC offset exceeds 14 hours.
 * This is deliberately not a consequence of the unverified "filters on UTC" claim.
 */
export const SYNC_WINDOW_PAD_SECONDS = 86400;

/** Strava page size. 200 is the documented max; the client falls back to 100 on a 400. */
export const STRAVA_PAGE_SIZE = 200;

/** Refuse to page forever if something goes wrong with termination detection. */
export const STRAVA_MAX_PAGES = 40;

/**
 * Hard ceiling on how many months `[first_month, last_month]` may span.
 *
 * The range is a UNION of the configured window, the current month, and every month that has
 * ride data (see `monthBounds` in server/lib/dates.js), so a single fat-fingered
 * `COMPETITION_START=1026-06-01` -- or one activity row with a corrupt `start_date_local` --
 * would otherwise ask the browser to build twelve thousand `<option>` elements on first paint.
 *
 * The cap consumes the OLDEST months first, because the current month must stay reachable: it
 * is the only one with a live `open` state, and a picker that cannot offer "now" is the bug
 * this whole range rule exists to fix.
 *
 * MIRRORED by `MAX_PICKER_MONTHS` in public/config.js, which caps the option list it builds.
 * The client's copy is defence in depth against a server that ignores this one; keep the two
 * numbers equal or the `<select>` silently offers fewer months than `prev_month` will step to.
 */
export const MAX_PICKER_MONTHS = 120;

/**
 * Hard ceiling on how many months ONE SYNC may fetch, counting back from the current month.
 *
 * Not the same number as `MAX_PICKER_MONTHS`, and deliberately much smaller. The picker's cap
 * bounds how many `<option>` elements a browser builds, which is cheap; this one bounds the only
 * decision in the app that spends Strava rate limit, which is not. `computeSyncWindow` now widens
 * its floor using the extent of STORED ride data, and that extent is derived from `local_date`
 * values -- so a single row with a corrupt `start_date_local` (a year of `1026`) would otherwise
 * make every sync, for every rider, forever, ask Strava for a millennium of pages.
 *
 * The OLDEST months are dropped first, for the same reason `monthBounds` trims that way: the
 * current month is the only one that can still be ridden, so it must never be the one trimmed out.
 *
 * 24 months at a prolific ~40 rides/month is ~5 pages at `per_page=200` -- comfortably inside
 * `STRAVA_MAX_PAGES`, which is what keeps a widened window from coming back `truncated` and
 * therefore suppressing reconciliation on every run.
 */
export const SYNC_MAX_MONTHS = 24;

/**
 * `competition.state` values in /api/me and /api/leaderboard.
 *
 * These describe the SELECTED MONTH, not a season: `closed` is a month that has already
 * ended, `open` is the current month, `upcoming` is a month that has not begun. The wire
 * literals are unchanged from the single-season model on purpose -- the client already
 * switches on them, and renaming them would have been a second breaking change for nothing.
 */
export const COMPETITION_STATES = Object.freeze({
  UPCOMING: 'upcoming',
  OPEN: 'open',
  CLOSED: 'closed',
});
