import { sendNoContent } from './respond.js';

/**
 * CORS, written complete and shipped inert.
 *
 * Today the frontend and the API share an origin, so `corsHeaders()` contributes nothing
 * but `Vary`. It exists now anyway because the deploy split (Pages on www., API on api.)
 * must be a change to two environment variables, not a code change to a header layer
 * nobody has thought about in six months.
 *
 * `Vary` is emitted unconditionally, including on the no-match path. That is the part that
 * is easy to skip and expensive to debug: a cache that stores one athlete's `/api/me`
 * without varying on Origin/Cookie will serve it to the next person.
 */

/** Never `*` with credentials: browsers reject that combination outright. */
const WILDCARD = '*';

const ALLOW_METHODS = 'GET, HEAD, POST, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, X-CSRF-Token';
/** One day. Cuts the preflight on `/api/*` to once per browser session. */
const MAX_AGE = '86400';

/**
 * `Retry-After` is invisible to cross-origin JS unless it is explicitly exposed, which is
 * also why the 429 body carries retry_after_seconds as well.
 */
const EXPOSE_HEADERS = 'Retry-After';

function requestOrigin(req) {
  const value = req.headers?.origin;
  if (!value || Array.isArray(value)) return null;
  const origin = String(value).trim();
  // A file:// page or a privacy extension sends the literal string "null".
  if (origin === '' || origin === 'null') return null;
  return origin;
}

function isAllowed(origin, config) {
  const allowlist = config?.corsAllowedOrigins ?? [];
  // Refusing to echo a configured '*' is deliberate: with Allow-Credentials the browser
  // discards the response, so a wildcard here is never a working configuration, only a
  // silent one.
  if (origin === WILDCARD) return false;
  return allowlist.includes(origin);
}

/**
 * Headers to attach to every `/api/*` response.
 *
 * @returns {Record<string,string>} `{Vary}` alone when the Origin is absent or unlisted.
 */
export function corsHeaders(req, config) {
  // All three request attributes below change the body of /api/me and /api/leaderboard.
  const headers = { Vary: 'Origin, Authorization, Cookie' };

  const origin = requestOrigin(req);
  if (origin === null || !isAllowed(origin, config)) return headers;

  headers['Access-Control-Allow-Origin'] = origin;
  headers['Access-Control-Allow-Credentials'] = 'true';
  headers['Access-Control-Expose-Headers'] = EXPOSE_HEADERS;
  return headers;
}

/**
 * Answer a CORS preflight.
 *
 * @returns {boolean} true if a 204 was sent and routing should stop.
 */
export function handlePreflight(req, res, config) {
  if (req.method !== 'OPTIONS') return false;
  // A bare OPTIONS with no Access-Control-Request-Method is not a preflight -- it is a
  // capability query, and the router answers it with an accurate Allow list.
  if (!req.headers?.['access-control-request-method']) return false;

  const headers = corsHeaders(req, config);
  // Access-Control-Request-Headers is part of the cache key for the preflight itself.
  headers.Vary = 'Origin, Access-Control-Request-Headers';

  if (headers['Access-Control-Allow-Origin']) {
    headers['Access-Control-Allow-Methods'] = ALLOW_METHODS;
    headers['Access-Control-Allow-Headers'] = ALLOW_HEADERS;
    headers['Access-Control-Max-Age'] = MAX_AGE;
  }

  // An unlisted origin still gets a 204, just without the Allow-* headers: the browser then
  // fails the preflight itself, which is the error the developer needs to see. Returning a
  // 403 here shows up as an opaque network error instead.
  sendNoContent(res, headers);
  return true;
}
