import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Authenticated encryption for the Strava tokens at rest. Called ONLY from db/tokens.js.
 *
 * Honest threat model: this defends a leaked or accidentally committed database file
 * (.env holds the key and is gitignored). It does nothing against a live-server
 * compromise, where the key is in memory next to the plaintext.
 *
 * Envelope format: "v1.<iv>.<ciphertext>.<tag>", each part base64url.
 *
 * The `v1.` prefix is the key-rotation seam: a future v2 (different KDF, different
 * cipher, a key id) can be decrypted alongside v1 rows without a migration. Anything
 * that is not a recognized version is rejected rather than guessed at -- silently
 * treating an unknown envelope as v1 would feed attacker-chosen bytes to a v1 decipher.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // The GCM-native nonce size; anything else invokes GHASH-based derivation.
const TAG_BYTES = 16; // Full-length tag. A truncated tag weakens forgery resistance.
const VERSION = 'v1';

/** base64url alphabet, unpadded. Buffer.from() silently DROPS characters outside it, so a
 *  mangled envelope would otherwise decode to a short buffer instead of failing. */
const B64U = /^[A-Za-z0-9_-]*$/;

/**
 * A wrong-sized key is a configuration bug, not a runtime condition.
 *
 * config.js already asserts TOKEN_ENCRYPTION_KEY decodes to exactly 32 bytes at boot, so
 * this is the second line of defense -- it catches a key handed in from a test or a
 * future rotation path that never went through loadConfig.
 */
function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    const got = Buffer.isBuffer(key) ? `${key.length} bytes` : typeof key;
    throw new TypeError(`Encryption key must be a ${KEY_BYTES}-byte Buffer, got ${got}.`);
  }
}

/**
 * Seal a secret. Returns "v1.<iv>.<ct>.<tag>".
 *
 * THERE IS DELIBERATELY NO PARAMETER TO SUPPLY THE IV. An API that accepts one invites
 * reuse (a caller "helpfully" deriving it from the athlete id, or a test fixture pinning
 * it), and IV reuse under GCM is catastrophic rather than merely weak: two ciphertexts
 * under the same key+IV leak the XOR of their plaintexts, and the reuse also exposes the
 * GHASH authentication subkey, which turns tag forgery from infeasible into arithmetic.
 * randomBytes(12) per call, always, is the only safe contract.
 *
 * @param {Buffer} key 32 bytes
 * @param {string} plaintext
 * @returns {string} envelope
 */
export function encryptSecret(key, plaintext) {
  assertKey(key);
  if (typeof plaintext !== 'string') {
    throw new TypeError(`encryptSecret expects a string plaintext, got ${typeof plaintext}.`);
  }

  const iv = randomBytes(IV_BYTES);
  // authTagLength is passed explicitly on BOTH sides. Node's default happens to be 16 for
  // GCM, but stating it means a future default change cannot silently shorten the tag.
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // getAuthTag is only valid AFTER final(); the tag is stored because without it GCM
  // degrades to unauthenticated CTR mode and any ciphertext bit flip becomes a plaintext
  // bit flip that decrypts "successfully".
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

/**
 * Open a sealed envelope. Throws on ANY tampering, truncation, wrong key, or unknown
 * version -- there is no "best effort" path, because a caller that got a partially
 * corrupt token would present it to Strava and burn a refresh token.
 *
 * @param {Buffer} key 32 bytes
 * @param {string} envelope
 * @returns {string} plaintext
 */
export function decryptSecret(key, envelope) {
  assertKey(key);
  if (typeof envelope !== 'string' || envelope === '') {
    throw new TypeError(`decryptSecret expects a non-empty envelope string, got ${typeof envelope}.`);
  }

  const parts = envelope.split('.');
  if (parts.length !== 4) {
    throw new Error(`Malformed secret envelope: expected 4 dot-separated parts, got ${parts.length}.`);
  }
  const [version, ivPart, ctPart, tagPart] = parts;

  if (version !== VERSION) {
    throw new Error(`Unsupported secret envelope version "${version}"; this build only reads "${VERSION}".`);
  }
  for (const part of [ivPart, ctPart, tagPart]) {
    if (!B64U.test(part)) throw new Error('Malformed secret envelope: non-base64url characters.');
  }

  const iv = Buffer.from(ivPart, 'base64url');
  const ciphertext = Buffer.from(ctPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');

  if (iv.length !== IV_BYTES) throw new Error(`Malformed secret envelope: IV is ${iv.length} bytes, expected ${IV_BYTES}.`);
  if (tag.length !== TAG_BYTES) throw new Error(`Malformed secret envelope: tag is ${tag.length} bytes, expected ${TAG_BYTES}.`);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  // setAuthTag MUST happen before final(): final() is where the computed tag is compared,
  // and Node throws "Unsupported state" if the expected tag was never supplied. Forgetting
  // it does not "skip" the check -- but a version that caught and ignored that error would
  // effectively skip it, which is why the ordering is called out here.
  decipher.setAuthTag(tag);
  // final() throws "Unsupported state or unable to authenticate data" on any tamper.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
