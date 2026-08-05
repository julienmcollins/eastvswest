import { createHash, createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

/**
 * The only node:crypto hashing surface in the tree. Confining it to one file is what keeps
 * a future WebCrypto port (Cloudflare Workers) to a single file rather than a sweep.
 *
 * Note `globalThis.crypto.timingSafeEqual` does not exist in Node 26 (verified
 * `undefined`), which is why node:crypto is used rather than WebCrypto throughout.
 */

/** base64url with no padding -- safe in cookies, URLs, and as a SQLite TEXT primary key. */
function b64u(buf) {
  return buf.toString('base64url');
}

/** sha256 of a UTF-8 string, base64url. Used for session ids, state, and nonces. */
export function sha256b64u(input) {
  return b64u(createHash('sha256').update(String(input), 'utf8').digest());
}

/** HMAC-SHA256, base64url. `key` is a Buffer from config. */
export function hmacB64u(key, input) {
  return b64u(createHmac('sha256', key).update(String(input), 'utf8').digest());
}

/**
 * Constant-time string comparison that is safe to call with attacker-controlled lengths.
 *
 * node's timingSafeEqual THROWS ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH when the two buffers
 * differ in length, so the length check has to come first. Comparing lengths leaks
 * nothing an attacker cannot already measure from the input they sent.
 *
 * Do not "simplify" this to `===`.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return nodeTimingSafeEqual(ba, bb);
}
