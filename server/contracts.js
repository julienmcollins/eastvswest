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
 */
export const API_SCHEMA = 1;

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

/** Competition state values in /api/me and /api/leaderboard. */
export const COMPETITION_STATES = Object.freeze({
  UPCOMING: 'upcoming',
  OPEN: 'open',
  CLOSED: 'closed',
});
