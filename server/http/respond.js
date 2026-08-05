import { ERROR_CODES } from '../contracts.js';
import { log as defaultLog, errorFields } from '../lib/log.js';

/**
 * The only place an HTTP response is written for the JSON API.
 *
 * Centralising it is what makes the security headers unforgettable: `Cache-Control:
 * no-store` on a credentialed leaderboard and `nosniff` on every JSON body are properties
 * of the transport, not decisions for each of two dozen handlers.
 */

/**
 * An error whose status, machine-readable code, and message are all safe to send.
 *
 * Anything that is NOT an HttpError becomes `{"error":"internal"}` with the stack going
 * only to the server log -- that asymmetry is the whole point of the class.
 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code one of ERROR_CODES -- the client switches on this, never on the message
   * @param {string} message safe to show a user
   * @param {object} extra merged into the JSON body (e.g. retry_after_seconds, allow)
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = Number.isInteger(status) ? status : 500;
    this.code = code ?? ERROR_CODES.INTERNAL;
    this.extra = extra ?? {};
    /** Marks the message as caller-safe. Non-HttpError throws have no such flag. */
    this.expose = true;
    /** Response headers this error needs, e.g. `Retry-After` on a 429. */
    this.headers = {};
  }
}

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

/**
 * Merge header objects with later ones winning, comparing names case-insensitively.
 *
 * Without the case-insensitive compare, a caller passing `content-type` alongside the base
 * `Content-Type` sends the header twice and the browser picks whichever it likes.
 */
function mergeHeaders(...objects) {
  const out = {};
  const byLower = new Map();
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj ?? {})) {
      if (value === undefined || value === null) continue;
      const lower = key.toLowerCase();
      const previous = byLower.get(lower);
      if (previous !== undefined) delete out[previous];
      byLower.set(lower, key);
      out[key] = value;
    }
  }
  return out;
}

/** Node suppresses a body on HEAD itself, but computing Content-Length still needs the check. */
function isHead(res) {
  return res.req?.method === 'HEAD';
}

/** Send a JSON body with the standard no-store/nosniff/no-referrer header set. */
export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload === undefined ? null : payload), 'utf8');
  // Content-Length goes last so a caller cannot accidentally describe a different body.
  res.writeHead(status, mergeHeaders(JSON_HEADERS, headers, { 'Content-Length': String(body.length) }));
  res.end(isHead(res) ? undefined : body);
}

/**
 * Translate a thrown error into a response.
 *
 * The headersSent/writableEnded guard is the FIRST thing that happens and is load-bearing:
 * a client aborting a large static download makes `pipeline` reject *after* the headers
 * went out, and calling writeHead() then throws ERR_HTTP_HEADERS_SENT from a catch block,
 * i.e. an unhandled rejection that takes the whole process down. A half-sent response
 * cannot be repaired, so the only correct move is to log it and kill the socket.
 */
export function sendError(res, err, { log = defaultLog } = {}) {
  if (res.headersSent || res.writableEnded) {
    log.error('response already sent', { ...errorFields(err), status: res.statusCode });
    res.destroy();
    return;
  }

  const exposed = err instanceof HttpError || (err?.expose === true && Number.isInteger(err?.status));
  const status = exposed ? err.status : 500;
  const code = exposed ? err.code : ERROR_CODES.INTERNAL;
  const message = exposed ? err.message : 'Internal server error.';

  if (status >= 500) log.error('request failed', errorFields(err));
  else if (status === 401 || status === 403 || status === 409 || status === 413 || status === 429) {
    log.warn('request rejected', { status, error_code: code });
  } else log.info('request rejected', { status, error_code: code });

  // `error` is assigned after the spread so a stray `error` key in extra cannot rewrite the
  // machine-readable code the client switches on.
  const body = { ...(exposed ? err.extra : null), error: code, message };
  sendJson(res, status, body, exposed ? err.headers : undefined);
}

/**
 * 302 with a Location. Used only for OAuth, where the user is in a browser and a JSON
 * error body would be an unreadable page rather than a message.
 */
export function sendRedirect(res, location, headers = {}) {
  // Node would throw on this anyway, but failing here names the actual bug: an unvalidated
  // return_to reaching a header is response splitting.
  if (/[\r\n\0]/.test(location)) throw new TypeError('Refusing to redirect to a location containing CR, LF, or NUL.');
  res.writeHead(
    302,
    mergeHeaders(
      {
        Location: location,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
      headers,
      { 'Content-Length': '0' },
    ),
  );
  res.end();
}

/** 204 for idempotent mutations (logout) and CORS preflights. Never carries a body. */
export function sendNoContent(res, headers = {}) {
  res.writeHead(
    204,
    mergeHeaders(
      {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
      headers,
    ),
  );
  res.end();
}
