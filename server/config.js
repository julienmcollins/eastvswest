import { isCalendarDate, monthOf } from './lib/dates.js';

/**
 * The ONLY module in the tree that reads the environment. Everything else takes a frozen
 * config object. That is what makes the Cloudflare Worker port a one-line change:
 * `loadConfig(env)` accepts the Worker's env binding instead of process.env.
 *
 * Imports no Node builtin ON PURPOSE. This module is on the Worker's import path, and
 * `node:fs` is either absent or partial there depending on the compatibility date -- so
 * `loadDotEnv` probes for the file by catching ENOENT rather than by calling existsSync.
 */

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load `.env` into process.env if present. Never overwrites an already-set variable.
 *
 * Only ever called with `loadEnvFile: true`, which only server/index.js and the scripts pass.
 * A Worker gets its configuration from the `env` binding and must never reach this.
 */
export function loadDotEnv(path = '.env') {
  try {
    // Node >=20.12 built-in. No dotenv dependency, and no existsSync -- see the file header.
    process.loadEnvFile(path);
    return true;
  } catch (err) {
    // "No .env" is the normal case in production and is not an error.
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

function required(env, name) {
  const v = env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new ConfigError(`${name} is required but empty. Copy .env.example to .env and fill it in.`);
  }
  return String(v).trim();
}

function optional(env, name, fallback) {
  const v = env[name];
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  return String(v).trim();
}

function bool(env, name, fallback) {
  const raw = optional(env, name, null);
  if (raw === null) return fallback;
  const v = raw.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), got "${raw}".`);
}

function int(env, name, fallback, { min = 0 } = {}) {
  const raw = optional(env, name, null);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new ConfigError(`${name} must be an integer >= ${min}, got "${raw}".`);
  }
  return n;
}

/**
 * Decode a base64 secret and assert its byte length.
 *
 * Length is checked at BOOT, not at first use. A truncated copy-paste of
 * TOKEN_ENCRYPTION_KEY otherwise surfaces as a crypto error during a rider's first
 * login -- long after the person who mis-pasted it has stopped looking.
 */
function secretBytes(env, name, { exactly = null, atLeast = null }) {
  const raw = required(env, name);
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new ConfigError(`${name} is not valid base64. Regenerate with \`npm run keygen\`.`);
  }
  // Buffer.from is lenient: it silently drops invalid characters instead of throwing, so
  // the length check below is what actually catches a mangled value.
  if (exactly !== null && buf.length !== exactly) {
    throw new ConfigError(
      `${name} must decode to exactly ${exactly} bytes, got ${buf.length}. Regenerate with \`npm run keygen\`.`,
    );
  }
  if (atLeast !== null && buf.length < atLeast) {
    throw new ConfigError(
      `${name} must decode to at least ${atLeast} bytes, got ${buf.length}. Regenerate with \`npm run keygen\`.`,
    );
  }
  return buf;
}

/** Normalize an origin: scheme + host + port, no trailing slash, no path. */
function origin(env, name, raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL, got "${raw}".`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ConfigError(`${name} must be http: or https:, got "${u.protocol}".`);
  }
  return u.origin;
}

/**
 * Normalize a frontend sub-path: leading slash, no trailing slash, `''` for a domain root.
 *
 * Exists for GitHub Pages PROJECT sites, which serve `public/` from `user.github.io/<repo>/`
 * rather than from a domain root. WEB_ORIGIN cannot carry the path itself: an `Origin` header
 * is scheme + host + port with NO path component, so a path smuggled into WEB_ORIGIN would
 * never match a real browser Origin and would silently empty the CORS allowlist -- every
 * mutating request 403s on the Origin leg of requireCsrf with nothing to point at. Keeping the
 * two separate is what lets the post-OAuth redirect land on the app while CORS still compares
 * origins to origins.
 */
function basePath(env, name) {
  const raw = optional(env, name, '');
  if (raw === '' || raw === '/') return '';

  // Resolved rather than pattern-matched, for the same reason safeReturnTo resolves: `/a/../..`
  // and a stray backslash mean something different after normalization than they look like
  // here, and this value is concatenated into a Location header.
  const SENTINEL = 'https://base.invalid';
  let u;
  try {
    u = new URL(raw, SENTINEL);
  } catch {
    throw new ConfigError(`${name} must be a path like "/my-repo", got "${raw}".`);
  }
  // Catches an absolute URL, and `//host` -- which is protocol-relative, so it parses as a
  // different origin rather than as the path it looks like.
  if (u.origin !== SENTINEL || u.search !== '' || u.hash !== '') {
    throw new ConfigError(`${name} must be a bare path with no origin, query or fragment, got "${raw}".`);
  }
  const path = u.pathname.replace(/\/+$/, '');
  if (path === '') return '';
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new ConfigError(`${name} must start with a single "/", got "${raw}".`);
  }
  return path;
}

function dateVar(env, name) {
  const v = required(env, name);
  if (!isCalendarDate(v)) throw new ConfigError(`${name} must be a real YYYY-MM-DD date, got "${v}".`);
  return v;
}

function timeZone(env, name, fallback) {
  const tz = optional(env, name, fallback);
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(0));
  } catch {
    throw new ConfigError(`${name} is not a valid IANA timezone, got "${tz}".`);
  }
  return tz;
}

/** Trim, drop empties, de-duplicate. */
function csv(raw) {
  return [...new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))];
}

/**
 * Validate, coerce, and freeze the whole configuration surface. Throws ConfigError on
 * anything malformed -- the process must refuse to start rather than run half-configured.
 *
 * @param {Record<string,string|undefined>} env
 * @param {{ loadEnvFile?: boolean }} opts
 */
export function loadConfig(env = process.env, { loadEnvFile = false } = {}) {
  if (loadEnvFile) loadDotEnv();

  const nodeEnv = optional(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';

  const appBaseUrl = origin(env, 'APP_BASE_URL', required(env, 'APP_BASE_URL'));
  // Both default to APP_BASE_URL so single-origin local dev needs no extra setup, and
  // the deploy split is two variables rather than a code change.
  const apiBaseUrl = origin(env, 'API_BASE_URL', optional(env, 'API_BASE_URL', appBaseUrl));
  const webOrigin = origin(env, 'WEB_ORIGIN', optional(env, 'WEB_ORIGIN', appBaseUrl));
  /** Sub-path the frontend is served under: `/eastvswest` on a Pages project site, `''` at a
   *  domain root. Only the OAuth redirect and safeReturnTo read it. */
  const webBasePath = basePath(env, 'WEB_BASE_PATH');

  /**
   * Hand the freshly minted session token to the frontend in the callback's URL FRAGMENT
   * instead of relying on the `bc_sid` cookie.
   *
   * Off by default, and it should stay off whenever the frontend and the API share one
   * registrable domain -- an HttpOnly cookie is strictly safer than a token any script on the
   * frontend's origin can read. Turn it on ONLY when you cannot get a shared domain
   * (`user.github.io` + `<worker>.<account>.workers.dev` is the case that forces it): there
   * both `bc_sid` and `bc_csrf` are third-party cookies, which Safari's ITP blocks outright
   * and Chrome partitions, so OAuth appears to succeed and every later `/api/*` is anonymous.
   * See docs/DEPLOY.md and docs/SPEC.md "Deferred to deploy time" item 5.
   */
  const authTokenInFragment = bool(env, 'AUTH_TOKEN_IN_FRAGMENT', false);
  const sessionTtlSeconds = int(env, 'SESSION_TTL_SECONDS', 2592000, { min: 60 });
  // A 30-day HttpOnly cookie and a 30-day token sitting in localStorage are not the same
  // risk: the token is readable by any script on the frontend's origin, and on a
  // `user.github.io` project site that origin is shared with every other project that
  // account has ever published. Refusing to boot is deliberate -- SPEC item 5 says "shorten
  // session TTL to hours", and a comment saying so is a thing people skip.
  const BEARER_TTL_CEILING = 86400;
  if (authTokenInFragment && sessionTtlSeconds > BEARER_TTL_CEILING) {
    throw new ConfigError(
      `AUTH_TOKEN_IN_FRAGMENT=true requires SESSION_TTL_SECONDS <= ${BEARER_TTL_CEILING} (24h), got ${sessionTtlSeconds}. `
      + 'The token is stored in localStorage, readable by any script on the frontend origin, so it must be short-lived.',
    );
  }

  /**
   * COMPETITION_START/END are still required and still validated exactly as before, so no
   * existing `.env` stops booting. What they MEAN has narrowed twice. First, every calendar
   * month became its own competition, so they stopped describing one race. Now they are only
   * the FLOOR of the month picker's range and no longer its ceiling: the selectable range is a
   * union of these months, the current month, and every month that holds ride data (see
   * `monthBounds` in server/lib/dates.js). Setting them can therefore only ADD months, never
   * remove one -- which is the fix for a one-month window hiding the picker entirely.
   *
   * They keep exactly two live jobs, which is why they are not deprecated: they are the fetch
   * months sync asks Strava for (`computeSyncMonths` in server/strava/map.js -- the one decision
   * here that spends rate limit), and they are the floor that keeps a deliberately configured
   * season browsable before anybody has ridden a metre of it. A START of 2026-06-15 makes the
   * whole of June selectable, not half of it. See docs/SPEC.md "The month picker".
   */
  const competitionStart = dateVar(env, 'COMPETITION_START');
  const competitionEnd = dateVar(env, 'COMPETITION_END');
  if (competitionEnd < competitionStart) {
    throw new ConfigError(
      `COMPETITION_END (${competitionEnd}) precedes COMPETITION_START (${competitionStart}).`,
    );
  }

  const allowedSportTypes = csv(
    optional(env, 'ALLOWED_SPORT_TYPES', 'Ride,GravelRide,MountainBikeRide,VirtualRide'),
  );
  if (allowedSportTypes.length === 0) {
    throw new ConfigError('ALLOWED_SPORT_TYPES must list at least one sport_type.');
  }

  const adminBootstrapAthleteIds = csv(optional(env, 'ADMIN_BOOTSTRAP_ATHLETE_IDS', '')).map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ConfigError(`ADMIN_BOOTSTRAP_ATHLETE_IDS must be numeric athlete IDs, got "${s}".`);
    }
    return n;
  });

  const config = {
    nodeEnv,
    isProduction,
    port: int(env, 'PORT', 3000, { min: 0 }),

    appBaseUrl,
    apiBaseUrl,
    webOrigin,
    webBasePath,
    /** Absolute URL of the frontend's app root, no trailing slash. Equals `webOrigin` at a
     *  domain root; `https://user.github.io/eastvswest` on a Pages project site. */
    webAppUrl: `${webOrigin}${webBasePath}`,
    /** See the comment on the local of the same name above. */
    authTokenInFragment,
    /** Sent as `redirect_uri` and echoed back by Strava. A server-side constant: never
     *  built from a request parameter, since without PKCE nothing else blunts redirect
     *  injection. */
    redirectUri: `${apiBaseUrl}/api/auth/strava/callback`,
    /** Origins allowed to make credentialed /api calls. Same-origin today. */
    corsAllowedOrigins: Object.freeze([...new Set([webOrigin, appBaseUrl])]),
    /** True once the frontend and API are on different origins. Flips CORS on. */
    isCrossOrigin: webOrigin !== apiBaseUrl,

    databasePath: optional(env, 'DATABASE_PATH', './data/bike-comp.db'),

    stravaClientId: required(env, 'STRAVA_CLIENT_ID'),
    stravaClientSecret: required(env, 'STRAVA_CLIENT_SECRET'),
    stravaApiBase: optional(env, 'STRAVA_API_BASE', 'https://www.strava.com/api/v3').replace(/\/+$/, ''),
    stravaOauthBase: optional(env, 'STRAVA_OAUTH_BASE', 'https://www.strava.com/oauth').replace(/\/+$/, ''),

    sessionSecret: secretBytes(env, 'SESSION_SECRET', { atLeast: 32 }),
    tokenEncryptionKey: secretBytes(env, 'TOKEN_ENCRYPTION_KEY', { exactly: 32 }),

    competitionStart,
    competitionEnd,
    /** The FLOOR of the month picker's range, derived here so nothing else re-slices the dates
     *  and no consumer has to remember that a mid-month START still opens the whole month. Also
     *  the sync fetch range. Derived from config ALONE -- never from the clock -- so a process
     *  that runs across a month boundary cannot end up with two different ideas of what it
     *  fetches. The full selectable range is computed per request, because it depends on the
     *  clock and on stored data: see `monthBounds` in server/lib/dates.js. */
    competitionFirstMonth: monthOf(competitionStart),
    competitionLastMonth: monthOf(competitionEnd),
    competitionTz: timeZone(env, 'COMPETITION_TZ', 'UTC'),
    allowedSportTypes: Object.freeze(allowedSportTypes),
    countManualActivities: bool(env, 'COUNT_MANUAL_ACTIVITIES', false),

    adminBootstrapAthleteIds: Object.freeze(adminBootstrapAthleteIds),

    sessionTtlSeconds,
    syncCooldownSeconds: int(env, 'SYNC_COOLDOWN_SECONDS', 60, { min: 0 }),
  };

  return Object.freeze(config);
}

export { ConfigError };
