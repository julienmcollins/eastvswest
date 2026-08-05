import { encryptSecret, decryptSecret } from '../security/crypto.js';
import { isoUtcNow } from '../lib/dates.js';

/**
 * Strava OAuth tokens, encrypted at rest.
 *
 * This is the ONLY module in the tree that calls encryptSecret/decryptSecret. Everything
 * above it deals in plaintext token strings and never sees an envelope, which is what keeps
 * a future key rotation to one file.
 *
 * Honest threat model: this protects a leaked or accidentally committed database file. It
 * does not protect against a compromised live server, which holds the key in memory.
 */

/**
 * Persist a token set, guarded by the `token_version` compare-and-swap.
 *
 * THE TRAP THIS AVOIDS: the intuitive CAS is `WHERE refresh_token_enc = ?` with the token
 * you started from. AES-GCM generates a fresh random IV on every seal, so re-encrypting the
 * very same refresh token produces different bytes each time. That predicate would match
 * ZERO rows on every single refresh, `changes` would always be 0, each freshly rotated
 * token would be discarded, and the next refresh would 400 -- locking out every athlete
 * permanently, with no error anywhere. An integer version column is comparable; a ciphertext
 * is not.
 *
 * @param {number|null} expectedVersion `null` for the first write after OAuth (insert or
 *   unconditional overwrite). A number for a refresh: the version the caller read.
 * @returns {Promise<{ok:boolean, version:number}>} `ok:false` means someone else rotated
 *   first; the caller must re-read the row and use THEIR token, not retry with its own.
 */
export async function saveTokens(
  db,
  config,
  athleteId,
  { accessToken, refreshToken, expiresAt, scope, tokenType },
  expectedVersion = null,
) {
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new TypeError('saveTokens: accessToken must be a non-empty string.');
  }
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    // Strava returns the refresh token on every grant; an empty one means we are about to
    // persist a token set we can never refresh, i.e. a lockout in six hours.
    throw new TypeError('saveTokens: refreshToken must be a non-empty string.');
  }

  const key = config.tokenEncryptionKey;
  const accessEnc = encryptSecret(key, accessToken);
  const refreshEnc = encryptSecret(key, refreshToken);
  const nowIso = isoUtcNow();
  const exp = Number(expiresAt);
  if (!Number.isInteger(exp)) throw new TypeError(`saveTokens: expiresAt must be unix seconds, got ${expiresAt}`);
  const scopeText = scope ?? '';
  const typeText = tokenType ?? 'Bearer';

  if (expectedVersion === null || expectedVersion === undefined) {
    // First write, or a deliberate unconditional overwrite (a fresh OAuth grant supersedes
    // whatever was stored, so there is nothing to lose a race against).
    await db.run(
      `INSERT INTO oauth_tokens (athlete_id, access_token_enc, refresh_token_enc, token_version,
         expires_at, scope, token_type, updated_at)
       VALUES (?,?,?,0,?,?,?,?)
       ON CONFLICT(athlete_id) DO UPDATE SET
         access_token_enc  = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         token_version     = oauth_tokens.token_version + 1,
         expires_at        = excluded.expires_at,
         scope             = excluded.scope,
         token_type        = excluded.token_type,
         updated_at        = excluded.updated_at`,
      [athleteId, accessEnc, refreshEnc, exp, scopeText, typeText, nowIso],
    );
    return { ok: true, version: await currentVersion(db, athleteId) };
  }

  const res = await db.run(
    `UPDATE oauth_tokens
        SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, scope = ?,
            token_type = ?, token_version = token_version + 1, updated_at = ?
      WHERE athlete_id = ? AND token_version = ?`,
    [accessEnc, refreshEnc, exp, scopeText, typeText, nowIso, athleteId, expectedVersion],
  );

  if (res.changes === 0) {
    // Lost the CAS (or the row is gone). Report the version that actually won so the caller
    // can see it moved rather than guessing.
    return { ok: false, version: await currentVersion(db, athleteId) };
  }
  return { ok: true, version: expectedVersion + 1 };
}

async function currentVersion(db, athleteId) {
  const row = await db.get(`SELECT token_version FROM oauth_tokens WHERE athlete_id = ?`, [athleteId]);
  return row ? Number(row.token_version) : -1;
}

/**
 * Decrypt and return the stored token set.
 *
 * `tokenVersion` comes back with it and must be threaded into the matching `saveTokens`
 * call: the read and the write together are the compare-and-swap.
 *
 * @returns {Promise<{accessToken:string,refreshToken:string,expiresAt:number,scope:string,
 *   tokenType:string,tokenVersion:number}|null>} null when this athlete has no tokens
 *   (never connected, or disconnected).
 */
export async function loadTokens(db, config, athleteId) {
  const row = await db.get(
    `SELECT access_token_enc, refresh_token_enc, token_version, expires_at, scope, token_type
       FROM oauth_tokens
      WHERE athlete_id = ?`,
    [athleteId],
  );
  if (!row) return null;

  const key = config.tokenEncryptionKey;
  return {
    accessToken: decryptSecret(key, row.access_token_enc),
    refreshToken: decryptSecret(key, row.refresh_token_enc),
    expiresAt: Number(row.expires_at),
    scope: row.scope,
    tokenType: row.token_type,
    tokenVersion: Number(row.token_version),
  };
}

/**
 * Drop the token row (disconnect).
 *
 * Deleting rather than blanking: a NOT NULL envelope column has no "empty" value, and a
 * row of garbage would make `loadTokens` throw a decrypt error where the honest answer is
 * "this athlete is not connected".
 */
export async function deleteTokens(db, athleteId) {
  const res = await db.run(`DELETE FROM oauth_tokens WHERE athlete_id = ?`, [athleteId]);
  return res.changes > 0;
}

/** Does this athlete have a usable grant? Avoids decrypting just to answer yes/no. */
export async function hasTokens(db, athleteId) {
  const row = await db.get(`SELECT 1 AS present FROM oauth_tokens WHERE athlete_id = ?`, [athleteId]);
  return Boolean(row);
}
