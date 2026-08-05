import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encryptSecret, decryptSecret } from '../server/security/crypto.js';
import {
  createOAuthState,
  persistOAuthState,
  verifyAndConsumeOAuthState,
  safeReturnTo,
} from '../server/security/oauthState.js';
import {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllForAthlete,
} from '../server/security/sessionStore.js';
import { issueCsrfToken, csrfCookieOptions, requireCsrf } from '../server/security/csrf.js';
import { requireSession, requireTeamChosen, requireAdmin, requireNotRevoked } from '../server/security/guards.js';
import { epochSeconds } from '../server/lib/dates.js';
import { COOKIES } from '../server/contracts.js';
import { freshDb, testConfig, seedAthlete } from './helpers/testDb.js';

/* ============================== helpers ============================== */

const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const TOKEN = 'a1b2c3d4e5f6-strava-refresh-token';

/** Flip one bit inside one base64url part of an envelope, keeping the part well-formed. */
function flipPart(envelope, index) {
  const parts = envelope.split('.');
  const buf = Buffer.from(parts[index], 'base64url');
  buf[0] ^= 0x01;
  parts[index] = buf.toString('base64url');
  return parts.join('.');
}

/** A minimal IncomingMessage stand-in: requireCsrf only reads headers. */
function fakeReq(headers = {}) {
  return { method: 'POST', headers };
}

/* =============================== crypto =============================== */

test('crypto: two seals of the same plaintext differ, and both decrypt', () => {
  const a = encryptSecret(KEY_A, TOKEN);
  const b = encryptSecret(KEY_A, TOKEN);

  // IV freshness. This is also exactly why oauth_tokens uses an INTEGER token_version for
  // its CAS instead of comparing ciphertext: a `WHERE refresh_token_enc = ?` predicate would
  // match zero rows on every single refresh and lock out every athlete.
  assert.notEqual(a, b, 'two seals must not be byte-identical');
  assert.notEqual(a.split('.')[1], b.split('.')[1], 'the IV must be fresh per seal');

  assert.equal(decryptSecret(KEY_A, a), TOKEN);
  assert.equal(decryptSecret(KEY_A, b), TOKEN);
  assert.match(a, /^v1\./);
  assert.equal(a.split('.').length, 4);
  // The tag is stored, at full length.
  assert.equal(Buffer.from(a.split('.')[3], 'base64url').length, 16);
  assert.equal(Buffer.from(a.split('.')[1], 'base64url').length, 12);
});

test('crypto: any tampering throws', () => {
  const sealed = encryptSecret(KEY_A, TOKEN);

  assert.throws(() => decryptSecret(KEY_A, flipPart(sealed, 2)), /authenticate|state/i, 'flipped ciphertext byte');
  assert.throws(() => decryptSecret(KEY_A, flipPart(sealed, 3)), /authenticate|state/i, 'flipped auth-tag byte');
  assert.throws(() => decryptSecret(KEY_A, sealed.split('.').slice(0, 3).join('.')), /4 dot-separated/, 'truncated');
  assert.throws(() => decryptSecret(KEY_A, sealed.slice(0, sealed.length - 4)), /./, 'chopped tail');
  assert.throws(() => decryptSecret(KEY_A, `v2.${sealed.slice(3)}`), /version/, 'v2 prefix');
  assert.throws(() => decryptSecret(KEY_B, sealed), /authenticate|state/i, 'wrong 32-byte key');
  assert.throws(() => decryptSecret(KEY_A, ''), /non-empty/);
});

test('crypto: a 31-byte key is rejected on both sides', () => {
  const short = Buffer.alloc(31, 7);
  assert.throws(() => encryptSecret(short, TOKEN), /32-byte Buffer.*31 bytes/s);
  assert.throws(() => decryptSecret(short, encryptSecret(KEY_A, TOKEN)), /32-byte Buffer/);
  assert.throws(() => encryptSecret('not a buffer', TOKEN), /32-byte Buffer/);
});

test('crypto: round-trips empty, unicode, and long plaintexts', () => {
  for (const value of ['', 'ünïcøde ✅ 🚲', 'x'.repeat(4096)]) {
    assert.equal(decryptSecret(KEY_A, encryptSecret(KEY_A, value)), value);
  }
});

/* ============================= oauth state ============================= */

async function stateFixture(nowMs = Date.UTC(2026, 6, 1, 12, 0, 0)) {
  const db = await freshDb();
  const config = testConfig();
  const created = createOAuthState(config, { returnTo: '/leaderboard?team=EAST', nowMs });
  await persistOAuthState(db, { ...created, nowEpoch: epochSeconds(nowMs) });
  return { db, config, created, nowMs };
}

test('oauthState: a state round-trips with its own browser nonce', async () => {
  const { db, config, created, nowMs } = await stateFixture();

  assert.equal(created.returnTo, '/leaderboard?team=EAST');
  assert.equal(created.expiresAt, epochSeconds(nowMs) + 600);
  // Only digests are persisted.
  const row = await db.get('SELECT * FROM oauth_states');
  assert.equal(row.state_hash, created.stateHash);
  assert.notEqual(row.state_hash, created.state);
  assert.notEqual(row.nonce_hash, created.nonce);

  const out = await verifyAndConsumeOAuthState(db, config, {
    state: created.state,
    nonce: created.nonce,
    nowMs: nowMs + 5000,
  });
  assert.deepEqual(out, { returnTo: '/leaderboard?team=EAST' });
  await db.close();
});

test('oauthState: a tampered state is rejected before any DB work', async () => {
  const { db, config, created, nowMs } = await stateFixture();

  const flipped = `${created.state.slice(0, -2)}XY`;
  await assert.rejects(
    () => verifyAndConsumeOAuthState(db, config, { state: flipped, nonce: created.nonce, nowMs }),
    (err) => err.status === 400 && err.extra.fragment === 'state_expired',
  );
  // Signature failure must not consume the genuine row.
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM oauth_states')).n, 1);

  await assert.rejects(() => verifyAndConsumeOAuthState(db, config, { state: 'garbage', nonce: created.nonce, nowMs }));
  await assert.rejects(() => verifyAndConsumeOAuthState(db, config, { state: created.state, nonce: '', nowMs }));
  await db.close();
});

test('oauthState: an expired state is rejected server-side', async () => {
  const { db, config, created, nowMs } = await stateFixture();

  await assert.rejects(
    () => verifyAndConsumeOAuthState(db, config, { state: created.state, nonce: created.nonce, nowMs: nowMs + 601_000 }),
    (err) => err.status === 400,
  );
  await db.close();
});

test('oauthState: a state is single-use', async () => {
  const { db, config, created, nowMs } = await stateFixture();

  await verifyAndConsumeOAuthState(db, config, { state: created.state, nonce: created.nonce, nowMs });
  await assert.rejects(
    () => verifyAndConsumeOAuthState(db, config, { state: created.state, nonce: created.nonce, nowMs }),
    (err) => err.status === 400,
  );
  await db.close();
});

test('oauthState: a valid state with ANOTHER browser\'s nonce is rejected (login CSRF)', async () => {
  // THE test for the control that HMAC + single-use does not provide. The attacker holds a
  // genuine, unexpired, never-used state and mails it to the victim; the victim's browser has
  // its own bc_oauth cookie (or none), so the nonce cannot match.
  const { db, config, created: attacker, nowMs } = await stateFixture();
  const victim = createOAuthState(config, { returnTo: '/', nowMs });
  await persistOAuthState(db, { ...victim, nowEpoch: epochSeconds(nowMs) });

  await assert.rejects(
    () => verifyAndConsumeOAuthState(db, config, { state: attacker.state, nonce: victim.nonce, nowMs }),
    (err) => err.status === 400 && err.reason === 'nonce_mismatch',
  );
  // The failed attempt burned the attacker's state, so the link cannot be retried.
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM oauth_states')).n, 1);
  await db.close();
});

test('oauthState: persistOAuthState purges expired rows and caps the table', async () => {
  const db = await freshDb();
  const config = testConfig();
  const t0 = Date.UTC(2026, 6, 1, 12, 0, 0);

  const stale = createOAuthState(config, { returnTo: '/', nowMs: t0 });
  await persistOAuthState(db, { ...stale, nowEpoch: epochSeconds(t0) });

  // 20 minutes later the first row is long expired; writing a new one sweeps it.
  const later = t0 + 20 * 60_000;
  const fresh = createOAuthState(config, { returnTo: '/', nowMs: later });
  await persistOAuthState(db, { ...fresh, nowEpoch: epochSeconds(later) });

  const rows = await db.all('SELECT state_hash FROM oauth_states');
  assert.deepEqual(rows.map((r) => r.state_hash), [fresh.stateHash]);
  await db.close();
});

/* ============================= safeReturnTo ============================= */

test('safeReturnTo: every open-redirect payload normalizes to /', () => {
  const config = testConfig();
  const hostile = [
    '//evil.com',
    'https://evil.com',
    'http://evil.com/path',
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/\\evil.com',
    '/\\\\evil.com',
    '/%09/evil.com',
    '/%5cevil.com',
    '/..//evil.com',
    '/../..//evil.com',
    '/leaderboard\r\nSet-Cookie: bc_sid=stolen',
    '/leaderboard%0d%0aSet-Cookie:%20bc_sid=stolen',
    '/%00/evil.com',
    '/%zz',
    '',
    null,
    undefined,
    42,
    { pathname: '/evil' },
  ];
  for (const value of hostile) {
    assert.equal(safeReturnTo(config, value), '/', `expected / for ${JSON.stringify(value)}`);
  }
});

test('safeReturnTo: legitimate same-origin paths are preserved', () => {
  const config = testConfig();
  assert.equal(safeReturnTo(config, '/leaderboard?team=EAST'), '/leaderboard?team=EAST');
  assert.equal(safeReturnTo(config, '/'), '/');
  assert.equal(safeReturnTo(config, '/riders/12345678/activities'), '/riders/12345678/activities');
  // An absolute URL on our OWN origin is fine, and is reduced to a path.
  assert.equal(safeReturnTo(config, 'http://localhost:3000/leaderboard'), '/leaderboard');
  // The fragment is dropped: it never reaches the server anyway, and the callback owns it.
  assert.equal(safeReturnTo(config, '/leaderboard#error=denied'), '/leaderboard');
  // A different PORT on the same host is a different origin.
  assert.equal(safeReturnTo(config, 'http://localhost:4000/leaderboard'), '/');
});

/* ============================== sessions ============================== */

async function sessionFixture(overrides = {}) {
  const db = await freshDb();
  const config = testConfig(overrides);
  await seedAthlete(db, { id: 12345678, name: 'Julien C', team: 'EAST' });
  return { db, config };
}

test('session: create -> resolve -> revoke', async () => {
  const { db, config } = await sessionFixture();
  const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);

  const { rawToken, expiresAt } = await createSession(db, config, 12345678, { userAgent: 'curl/8', nowMs });
  assert.equal(typeof rawToken, 'string');
  assert.match(rawToken, /^[A-Za-z0-9_-]{43}$/, '32 random bytes as unpadded base64url');
  assert.equal(expiresAt, epochSeconds(nowMs) + config.sessionTtlSeconds);

  // The raw token is nowhere in the database -- only its digest.
  const row = await db.get('SELECT * FROM sessions');
  assert.notEqual(row.session_id_hash, rawToken);
  assert.equal((await db.all('SELECT * FROM sessions WHERE session_id_hash = ?', [rawToken])).length, 0);

  assert.deepEqual(await resolveSession(db, config, rawToken, { nowMs }), {
    athleteId: 12345678,
    expiresAt,
  });

  assert.equal(await resolveSession(db, config, 'never-issued', { nowMs }), null);
  assert.equal(await resolveSession(db, config, '', { nowMs }), null);
  assert.equal(await resolveSession(db, config, undefined, { nowMs }), null);

  await revokeSession(db, rawToken);
  assert.equal(await resolveSession(db, config, rawToken, { nowMs }), null);
  // Idempotent: logout is a 204 whether or not anything matched.
  await revokeSession(db, rawToken);
  await db.close();
});

test('session: expiry is enforced server-side, not by the cookie Max-Age', async () => {
  const { db, config } = await sessionFixture({ SESSION_TTL_SECONDS: '60' });
  const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
  const { rawToken } = await createSession(db, config, 12345678, { nowMs });

  assert.notEqual(await resolveSession(db, config, rawToken, { nowMs: nowMs + 59_000 }), null);
  // The client can keep presenting the cookie forever; the server still refuses.
  assert.equal(await resolveSession(db, config, rawToken, { nowMs: nowMs + 61_000 }), null);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM sessions')).n, 0, 'expired row cleaned up');
  await db.close();
});

test('session: a last_seen_at backdated 400 s is advanced; a fresh one is not written', async () => {
  const { db, config } = await sessionFixture();
  const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
  const now = epochSeconds(nowMs);
  const { rawToken } = await createSession(db, config, 12345678, { nowMs });

  // A read 100 s later must NOT take the write lock.
  await resolveSession(db, config, rawToken, { nowMs: nowMs + 100_000 });
  assert.equal((await db.get('SELECT last_seen_at FROM sessions')).last_seen_at, now);

  await db.run('UPDATE sessions SET last_seen_at = ?', [now - 400]);
  await resolveSession(db, config, rawToken, { nowMs });
  assert.equal(
    (await db.get('SELECT last_seen_at FROM sessions')).last_seen_at,
    now,
    'stale last_seen_at must advance -- if it silently froze, `now - undefined > 300` is NaN > 300 === false',
  );
  await db.close();
});

test('session: revokeAllForAthlete drops every session for that athlete only', async () => {
  const { db, config } = await sessionFixture();
  await seedAthlete(db, { id: 99, name: 'Other Rider', team: 'WEST' });
  const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);

  const a = await createSession(db, config, 12345678, { nowMs });
  const b = await createSession(db, config, 12345678, { nowMs });
  const other = await createSession(db, config, 99, { nowMs });

  await revokeAllForAthlete(db, 12345678);
  assert.equal(await resolveSession(db, config, a.rawToken, { nowMs }), null);
  assert.equal(await resolveSession(db, config, b.rawToken, { nowMs }), null);
  assert.notEqual(await resolveSession(db, config, other.rawToken, { nowMs }), null);
  await db.close();
});

test('session: tokens are unique across mints', async () => {
  const { db, config } = await sessionFixture();
  const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
  const seen = new Set();
  for (let i = 0; i < 25; i += 1) {
    const { rawToken } = await createSession(db, config, 12345678, { nowMs });
    assert.equal(seen.has(rawToken), false);
    seen.add(rawToken);
  }
  await db.close();
});

/* ================================ csrf ================================ */

test('csrf: issueCsrfToken is random base64url', () => {
  const a = issueCsrfToken();
  const b = issueCsrfToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test('csrf: cookie options are readable by JS and Secure only in production', () => {
  assert.equal(csrfCookieOptions(testConfig()).httpOnly, false);
  assert.equal(csrfCookieOptions(testConfig()).secure, false);
  assert.equal(csrfCookieOptions(testConfig({ NODE_ENV: 'production' })).secure, true);
  assert.equal(csrfCookieOptions(testConfig()).sameSite, 'Lax');
});

test('csrf: the correct triple is accepted', () => {
  const config = testConfig();
  const token = issueCsrfToken();
  const cookies = new Map([[COOKIES.CSRF, token]]);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    origin: 'http://localhost:3000',
    'x-csrf-token': token,
  };
  assert.doesNotThrow(() => requireCsrf(fakeReq(headers), config, { cookies }));
  // A plain object of cookies works too, for callers that do not use parseCookies' Map.
  assert.doesNotThrow(() => requireCsrf(fakeReq(headers), config, { cookies: { [COOKIES.CSRF]: token } }));
});

test('csrf: each leg fails closed with 403', () => {
  const config = testConfig();
  const token = issueCsrfToken();
  const cookies = new Map([[COOKIES.CSRF, token]]);
  const base = {
    'content-type': 'application/json',
    origin: 'http://localhost:3000',
    'x-csrf-token': token,
  };
  const is403 = (err) => err.status === 403 && err.code === 'csrf_failed';

  // Missing header token.
  assert.throws(() => requireCsrf(fakeReq({ ...base, 'x-csrf-token': undefined }), config, { cookies }), is403);
  // Mismatched token (an attacker can guess a value but cannot read our cookie).
  assert.throws(() => requireCsrf(fakeReq({ ...base, 'x-csrf-token': issueCsrfToken() }), config, { cookies }), is403);
  // A wrong-LENGTH token must be a clean 403, not a timingSafeEqual crash.
  assert.throws(() => requireCsrf(fakeReq({ ...base, 'x-csrf-token': 'short' }), config, { cookies }), is403);
  // No cookie at all.
  assert.throws(() => requireCsrf(fakeReq(base), config, { cookies: new Map() }), is403);
  assert.throws(() => requireCsrf(fakeReq(base), config, {}), is403);
  // Foreign / absent Origin.
  assert.throws(() => requireCsrf(fakeReq({ ...base, origin: 'https://evil.com' }), config, { cookies }), is403);
  assert.throws(() => requireCsrf(fakeReq({ ...base, origin: undefined }), config, { cookies }), is403);
  // Content types an HTML form can actually produce.
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', undefined]) {
    assert.throws(() => requireCsrf(fakeReq({ ...base, 'content-type': ct }), config, { cookies }), is403);
  }
});

/* =============================== guards =============================== */

test('guards: requireSession / requireTeamChosen / requireAdmin / requireNotRevoked', () => {
  const config = testConfig();
  const loggedOut = { session: null, athlete: null, config };
  const noTeam = { session: { athleteId: 1 }, athlete: { team: null, is_admin: 0 }, config };
  const rider = { session: { athleteId: 1 }, athlete: { team: 'EAST', is_admin: 0 }, config };
  const admin = { session: { athleteId: 1 }, athlete: { team: 'WEST', is_admin: 1 }, config };
  const revoked = { session: { athleteId: 1 }, athlete: { team: 'EAST', is_admin: 0, strava_revoked_at: 1_780_000_000 }, config };

  assert.throws(() => requireSession(loggedOut), (e) => e.status === 401 && e.code === 'unauthenticated');
  assert.throws(() => requireSession({}), (e) => e.status === 401);
  assert.throws(() => requireSession(undefined), (e) => e.status === 401);
  assert.deepEqual(requireSession(rider), { athleteId: 1 });

  assert.throws(() => requireTeamChosen(noTeam), (e) => e.status === 409 && e.extra.needs_team === true);
  assert.equal(requireTeamChosen(rider), 'EAST');

  assert.throws(() => requireAdmin(rider), (e) => e.status === 403 && e.code === 'forbidden');
  // A JSON round-trip can turn 0 into the truthy string "0"; the guard compares to 1.
  assert.throws(() => requireAdmin({ ...rider, athlete: { ...rider.athlete, is_admin: '0' } }), (e) => e.status === 403);
  assert.equal(requireAdmin(admin).is_admin, 1);
  assert.throws(() => requireAdmin(loggedOut), (e) => e.status === 401);

  assert.doesNotThrow(() => requireNotRevoked(rider));
  assert.throws(
    () => requireNotRevoked(revoked),
    (e) => e.status === 403 && e.code === 'strava_revoked' && e.extra.reauth_url.endsWith('/api/auth/strava/reconnect'),
  );
});
