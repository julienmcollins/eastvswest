import { redact } from '../security/redact.js';

/**
 * One JSON object per line, to stdout for info and stderr for warn/error.
 *
 * Structured lines are not a style preference here: this app's interesting failures are
 * rate-limit blocks and token races, which are only diagnosable by grepping fields across
 * many requests. Free-text lines make that a manual read.
 *
 * Nothing in this file reads the environment (server/config.js is the only env reader), so
 * the log level is not configurable. There is exactly one volume knob -- what callers
 * choose to log.
 */

let sink = null;

/**
 * Redirect log records to `fn` instead of stdout/stderr, or pass null to restore.
 *
 * Test-only seam. It exists so the required "no secret ever reaches a log line" assertions
 * can inspect real records rather than re-implementing the formatter, and so a test run
 * does not interleave thousands of access-log lines with the reporter output.
 */
export function setLogSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

function emit(level, msg, fields, bound) {
  // Both halves go through redact(): bound child fields are just as capable of carrying a
  // token as per-call ones.
  const safe = redact({ ...bound, ...fields });
  const record = { ts: new Date().toISOString(), level, msg: String(msg) };
  for (const [k, v] of Object.entries(safe)) {
    // A field named `ts`/`level`/`msg` must not shadow the record's own frame.
    if (k === 'ts' || k === 'level' || k === 'msg') record[`field_${k}`] = v;
    else record[k] = v;
  }

  if (sink) {
    sink(record);
    return;
  }

  let line;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch (err) {
    // redact() only ever returns JSON-safe values, so this is unreachable by design; if it
    // is ever reached, losing the log line must not take the request down with it.
    line = `${JSON.stringify({ ts: record.ts, level: 'error', msg: 'log serialization failed', reason: String(err) })}\n`;
  }
  // `process.stdout` is a Node concept. On Cloudflare Workers it is absent (or a stub with no
  // `write`) depending on the compatibility date, and an unguarded `.write` there throws
  // inside the logger -- which turns a log line into a 500 on a request that had already
  // succeeded. console.* is what the Workers runtime forwards to `wrangler tail`, so it is the
  // correct sink there, and the trailing newline is dropped because console adds one.
  const stream = level === 'info' ? process?.stdout : process?.stderr;
  if (typeof stream?.write === 'function') {
    stream.write(line);
  } else if (level === 'info') {
    console.log(line.trimEnd());
  } else {
    console.error(line.trimEnd());
  }
}

function createLogger(bound = {}) {
  return {
    info(msg, fields = {}) {
      emit('info', msg, fields, bound);
    },
    warn(msg, fields = {}) {
      emit('warn', msg, fields, bound);
    },
    error(msg, fields = {}) {
      emit('error', msg, fields, bound);
    },
    /** A logger that stamps `fields` onto every line -- one request id, set once. */
    child(fields = {}) {
      return createLogger({ ...bound, ...fields });
    },
  };
}

export const log = createLogger();

/**
 * Flatten an error into log fields whose names survive redaction.
 *
 * `code` is a redacted key (an OAuth authorization code must never be logged), so an
 * error's code is deliberately renamed: logging `{ code: err.code }` would print
 * `"[redacted]"` where 'ECONNRESET' belongs and make the line useless.
 */
export function errorFields(err) {
  if (!(err instanceof Error)) return { error_message: String(err) };
  const out = { error_name: err.name, error_message: err.message };
  if (err.code !== undefined) out.error_code = String(err.code);
  if (Number.isInteger(err.status)) out.status = err.status;
  if (typeof err.stack === 'string') out.stack = err.stack;
  return out;
}
