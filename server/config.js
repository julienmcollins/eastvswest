import { existsSync } from 'node:fs';
import { isCalendarDate } from './lib/dates.js';

/**
 * The ONLY module in the tree that reads the environment. Everything else takes a frozen
 * config object. That is what makes the later Cloudflare Worker port a one-line change:
 * `loadConfig(env)` accepts the Worker's env binding instead of process.env.
 */

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Load `.env` into process.env if present. Never overwrites an already-set variable. */
export function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return false;
  // Node >=20.12 built-in. No dotenv dependency.
  process.loadEnvFile(path);
  return true;
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
    competitionTz: timeZone(env, 'COMPETITION_TZ', 'UTC'),
    allowedSportTypes: Object.freeze(allowedSportTypes),
    countManualActivities: bool(env, 'COUNT_MANUAL_ACTIVITIES', false),

    adminBootstrapAthleteIds: Object.freeze(adminBootstrapAthleteIds),

    sessionTtlSeconds: int(env, 'SESSION_TTL_SECONDS', 2592000, { min: 60 }),
    syncCooldownSeconds: int(env, 'SYNC_COOLDOWN_SECONDS', 60, { min: 0 }),
  };

  return Object.freeze(config);
}

export { ConfigError };
