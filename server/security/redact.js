/**
 * Deep, cycle-safe redaction of log fields.
 *
 * Every field object handed to server/lib/log.js passes through here before it is
 * serialized, so the redaction is structural rather than a habit each call site has to
 * remember. The failure this prevents is not hypothetical: the obvious implementation of a
 * token-endpoint error log writes STRAVA_CLIENT_SECRET and a live refresh token to stdout,
 * and stdout is exactly what gets pasted into a bug report.
 */

/**
 * Keys whose values never reach a log line.
 *
 * `code` and `state` are here because of the OAuth callback query string -- an
 * authorization code in a log is a session for whoever reads the log. That does mean an
 * error's `code` field would be redacted too, which is why log.js serializes errors into
 * `error_code` instead of passing the raw error through.
 */
export const SENSITIVE_KEYS = Object.freeze([
  'access_token',
  'refresh_token',
  'client_secret',
  'code',
  'state',
  'cookie',
  'authorization',
  'set-cookie',
  'password',
  'token',
  'secret',
  'bc_sid',
  'bc_csrf',
  'bc_oauth',
]);

const REDACTED = '[redacted]';

/** `-` and `_` are the same word separator here, so `set-cookie` and `set_cookie` match. */
function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[-\s]+/g, '_');
}

const EXACT = new Set(SENSITIVE_KEYS.map(normalizeKey));

/**
 * Suffix rule on top of the exact list, so `x_csrf_token` and `session_secret` are caught
 * without a maintenance list. Anchored at the end on purpose: `token_version` is a plain
 * integer that is genuinely useful in a refresh-race log line, and over-redacting it would
 * hide the one field that explains a CAS failure.
 */
const SUFFIX = /(^|_)(token|secret|password)$/;

function isSensitiveKey(key) {
  const n = normalizeKey(key);
  return EXACT.has(n) || SUFFIX.test(n);
}

/** Depth and width caps: a log line is a line, and a deep object graph is a stall. */
const MAX_DEPTH = 8;
const MAX_ITEMS = 64;

/**
 * Clone `value` with every sensitive key replaced by '[redacted]', returning only values
 * JSON.stringify accepts (so the log writer can never throw on a bigint or a cycle).
 */
export function redact(value) {
  return walk(value, 0, new Set());
}

function walk(value, depth, stack) {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      // JSON.stringify turns NaN/Infinity into null, which reads as "no value" in a log.
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return `${value}`;
    case 'function':
      return '[function]';
    case 'symbol':
      return String(value);
    default:
      break;
  }

  if (stack.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (value instanceof Error) return fromError(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
  // A URL's query string is where `code` and `state` live, so the search is dropped whole
  // rather than key-filtered -- there is no legitimate reason to log a full callback URL.
  if (value instanceof URL) return `${value.origin}${value.pathname}`;

  stack.add(value);
  try {
    if (Array.isArray(value) || value instanceof Set) {
      const items = [];
      for (const item of value) {
        if (items.length >= MAX_ITEMS) {
          items.push('[…]');
          break;
        }
        items.push(walk(item, depth + 1, stack));
      }
      return items;
    }

    const entries = value instanceof Map ? value.entries() : Object.entries(value);
    const out = {};
    let n = 0;
    for (const [key, v] of entries) {
      if (n >= MAX_ITEMS) {
        out['…'] = '[truncated]';
        break;
      }
      n += 1;
      const k = String(key);
      if (isSensitiveKey(k)) {
        // A null-valued secret is reported as null rather than '[redacted]': knowing a
        // token was absent is the useful half of a "why is this 401" log line.
        out[k] = v === null || v === undefined ? null : REDACTED;
        continue;
      }
      out[k] = walk(v, depth + 1, stack);
    }
    return out;
  } finally {
    // Removed on the way back out, so the same object appearing twice in a tree is cloned
    // twice instead of being mislabelled '[circular]'.
    stack.delete(value);
  }
}

/**
 * Errors are reduced to three known-safe fields on purpose.
 *
 * Enumerating an error's own properties would drag along whatever the thrower attached --
 * `form`, `body`, `headers` on an HTTP client error -- which is the single most likely way
 * a secret reaches a log line.
 */
function fromError(err) {
  const out = { name: err.name, message: err.message };
  if (typeof err.stack === 'string') out.stack = err.stack;
  if (Number.isInteger(err.status)) out.status = err.status;
  return out;
}
