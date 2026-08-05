import { MAX_BODY_BYTES, ERROR_CODES } from '../contracts.js';
import { HttpError, sendJson } from './respond.js';

/**
 * Read and validate a JSON request body.
 *
 * The cap is enforced by counting bytes as they arrive, NOT by reading Content-Length: a
 * lying Content-Length is the actual attack, and a header check alone is a 64 KiB limit
 * that accepts unbounded bodies from anyone willing to type `Content-Length: 10`.
 */

/** `application/json` plus the `+json` suffix family. Parameters (charset) are ignored. */
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json$/;

/** A truncated upload is a normal network event, not a server fault. */
const ABORTED = new Set(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ECANCELED', 'ABORT_ERR']);

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit?:number, res?:import('node:http').ServerResponse|null}} opts
 *   `res` defaults to `req.res`, which server/app.js assigns on every request. It is needed
 *   only for the 413 path, where the response has to be written before the socket dies.
 * @returns {Promise<object>} the parsed body, `{}` for an empty one
 */
export async function readJsonBody(req, { limit = MAX_BODY_BYTES, res = req.res ?? null } = {}) {
  const declaredType = req.headers['content-type'];

  if (declaredType !== undefined) {
    const type = String(declaredType).split(';')[0].trim().toLowerCase();
    if (!JSON_TYPE.test(type)) {
      throw new HttpError(
        415,
        ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
        'Request body must be application/json.',
        { received: type },
      );
    }
  }

  // We never decompress a request body: doing so would make the byte cap meaningless,
  // since a few KiB of gzip expands to gigabytes.
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity') {
    throw new HttpError(415, ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, 'Compressed request bodies are not accepted.');
  }

  // An honest oversized Content-Length is rejected without reading a byte. This is an
  // optimization only -- the stream check below is what actually enforces the limit.
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw respondTooLarge(req, res, limit);

  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of req) {
      received += chunk.length;
      if (received > limit) throw respondTooLarge(req, res, limit);
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (ABORTED.has(err?.code) || err?.name === 'AbortError') {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'Request body was interrupted before it completed.');
    }
    throw err;
  }

  // No body at all is a valid `{}` for routes whose payload is optional (POST /api/me/sync).
  if (received === 0) return {};

  if (declaredType === undefined) {
    throw new HttpError(415, ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, 'Request body must be application/json.');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // The parser's own message quotes the offending input, which would echo attacker bytes
    // back in a response body.
    throw new HttpError(400, ERROR_CODES.INVALID_JSON, 'Request body is not valid JSON.');
  }

  // A bare array or string parses fine and then destructures to undefined everywhere,
  // turning a client bug into a confusing 500 three layers down.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'Request body must be a JSON object.');
  }

  // JSON.parse defines `__proto__` as an own property rather than invoking the setter, so
  // this is hygiene for whatever the body is later spread into, not a live exploit here.
  if (Object.hasOwn(parsed, '__proto__')) delete parsed['__proto__'];

  return parsed;
}

/**
 * Write the 413 and only THEN destroy the request.
 *
 * Order matters and is the reason this helper exists: destroying first makes the client see
 * a bare ECONNRESET with no status and no body, which is indistinguishable from a crashed
 * server. Writing first means the fetch that sent 2 MB gets a JSON 413 it can display.
 */
function respondTooLarge(req, res, limit) {
  const err = new HttpError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, `Request body exceeds the ${limit} byte limit.`, {
    limit_bytes: limit,
  });

  if (res && !res.headersSent && !res.writableEnded) {
    sendJson(res, 413, { error: err.code, message: err.message, limit_bytes: limit }, { Connection: 'close' });
    // Tells server/app.js the response is already out, so it does not try to send a second.
    err.responded = true;
  }

  // Stop reading. The remaining megabytes are never buffered.
  req.destroy();
  return err;
}
