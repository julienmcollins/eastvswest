import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, testConfig, seedAthlete } from './helpers/testDb.js';
import { createFakeStrava } from './helpers/fakeStrava.js';
import { createStravaClient, StravaAuthError, StravaGrantRevokedError } from '../server/strava/client.js';
import { getValidAccessToken, withAuth, _resetSingleFlightForTests } from '../server/strava/tokenService.js';
import { loadTokens, saveTokens } from '../server/db/tokens.js';
import { getAthlete } from '../server/db/athletes.js';
import { decryptSecret } from '../server/security/crypto.js';
import { setLogSink } from '../server/lib/log.js';

/**
 * Token service tests.
 *
 * The interesting assertions here are all about COUNTS -- how many token POSTs a scenario
 * produces -- because every failure this module exists to prevent is invisible in the return
 * value. Two concurrent refreshes both "work"; the damage is that the database ends up
 * holding a refresh token Strava has already rotated away, and the athlete discovers it
 * hours later as a permanent lockout with nothing in the logs.
 */

const ATHLETE_ID = 12345678;
/** Frozen clock. On a quarter-hour boundary, which is the nastiest case for the gate math. */
const NOW = Date.parse('2026-08-04T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW / 1000);

/** Silence the module logger for the whole file; one test installs its own sink instead. */
setLogSink(() => {});

async function setup({ expiresAt = NOW_SECONDS + 3600, fakeOpts = {} } = {}) {
  // The single-flight Map is module state shared by every test in the process. Without this
  // reset, a promise resolved against a closed database could be handed to the next test.
  _resetSingleFlightForTests();

  const db = await freshDb();
  const config = testConfig();
  const fake = createFakeStrava({ now: () => NOW, logger: { error() {} }, ...fakeOpts });
  const strava = createStravaClient({
    apiBase: config.stravaApiBase,
    oauthBase: config.stravaOauthBase,
    clientId: config.stravaClientId,
    clientSecret: config.stravaClientSecret,
    redirectUri: config.redirectUri,
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
    // Both only shorten real sleeps; strava-client.test.js owns the defaults.
    minRequestSpacingMs: 0,
    retryBaseMs: 1,
  });

  await seedAthlete(db, { id: ATHLETE_ID, name: 'Julien Collins', team: 'EAST' });
  await saveTokens(
    db,
    config,
    ATHLETE_ID,
    {
      accessToken: fake.tokens.accessToken,
      refreshToken: fake.tokens.refreshToken,
      expiresAt,
      scope: 'read,activity:read_all',
      tokenType: 'Bearer',
    },
    // null => the unconditional first write, as the OAuth callback does. Version starts at 0.
    null,
  );

  return { db, config, fake, strava };
}

/** Token-endpoint POSTs only. The whole file's core measurement. */
function tokenPosts(fake) {
  return fake.requests.filter((r) => r.method === 'POST' && r.pathname.endsWith('/oauth/token'));
}

// --------------------------------------------------------------- the happy, silent path

test('a token that is not near expiry issues ZERO requests', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS + 3600 });

  const token = await getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW });

  assert.equal(token, 'fake-access-1');
  assert.equal(fake.requests.length, 0, 'a live token must not touch the network at all');
});

test('the 300 s skew refreshes BEFORE expiry, not after it', async () => {
  // 299 s of life left: inside TOKEN_REFRESH_SKEW_SECONDS, so it must refresh now rather than
  // let a sync start with a token that dies mid-pagination.
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS + 299 });

  const token = await getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW });

  assert.equal(token, 'fake-access-2', 'a rotated token');
  assert.equal(tokenPosts(fake).length, 1);

  const { db: db2, config: c2, fake: f2, strava: s2 } = await setup({ expiresAt: NOW_SECONDS + 301 });
  await getValidAccessToken(db2, c2, s2, ATHLETE_ID, { nowMs: NOW });
  assert.equal(f2.requests.length, 0, '301 s of life is outside the skew');
});

// --------------------------------------------------------------- the single-flight mutex

test('two concurrent getValidAccessToken calls produce exactly ONE token POST', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS - 10 });

  const [a, b] = await Promise.all([
    getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW }),
    getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW }),
  ]);

  // The load-bearing assertion. Two POSTs would mean both callers presented the SAME refresh
  // token; Strava rotates, so the loser's exchange either 400s or -- worse -- succeeds against
  // a stale token and overwrites the winner's fresh one.
  assert.equal(tokenPosts(fake).length, 1, 'the refresh must be single-flighted per athlete');
  assert.equal(a, b, 'both callers must see the same access token');
  assert.equal(a, fake.tokens.accessToken);
});

test('five concurrent callers still produce one POST, and the map is left empty', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS - 10 });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW })),
  );

  assert.equal(tokenPosts(fake).length, 1);
  assert.equal(new Set(results).size, 1);

  // Proof the `finally` deleted the slot: a later call with a now-expired token refreshes
  // again instead of re-resolving the parked promise.
  await saveTokens(
    db,
    config,
    ATHLETE_ID,
    { accessToken: 'stale', refreshToken: fake.tokens.refreshToken, expiresAt: NOW_SECONDS - 1, scope: '', tokenType: 'Bearer' },
    null,
  );
  const again = await getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW });
  assert.equal(tokenPosts(fake).length, 2);
  assert.equal(again, fake.tokens.accessToken);
});

test('a caller that arrives after the row was already rotated does not refresh again', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS - 10 });

  await getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW });
  assert.equal(tokenPosts(fake).length, 1);

  // The re-read inside the single-flight slot is what makes this free: the row now holds a
  // token with 6 h of life, so there is nothing to exchange.
  await getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW });
  assert.equal(tokenPosts(fake).length, 1);
});

// --------------------------------------------------------------- persistence and the CAS

test('the persisted refresh_token_enc decrypts to the ROTATED value and token_version increments', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS - 10 });

  assert.equal(fake.tokens.refreshToken, 'fake-refresh-1', 'precondition');
  await getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW });
  assert.equal(fake.tokens.refreshToken, 'fake-refresh-2', 'the fake rotates by default');

  const stored = await loadTokens(db, config, ATHLETE_ID);
  // The single highest-consequence assertion in the file: "persist only if it changed" and
  // "compare the ciphertext" both fail exactly here, and nowhere else.
  assert.equal(stored.refreshToken, 'fake-refresh-2');
  assert.equal(stored.accessToken, 'fake-access-2');
  assert.equal(stored.tokenVersion, 1, 'the CAS bumped the version');
  assert.equal(stored.expiresAt, fake.tokens.expiresAt);

  // And the envelope really is an envelope: sealed, versioned, no plaintext.
  const row = await db.get('SELECT access_token_enc, refresh_token_enc FROM oauth_tokens WHERE athlete_id = ?', [ATHLETE_ID]);
  assert.match(row.refresh_token_enc, /^v1\./);
  assert.equal(row.refresh_token_enc.includes('fake-refresh-2'), false);
  assert.equal(decryptSecret(config.tokenEncryptionKey, row.refresh_token_enc), 'fake-refresh-2');
  assert.equal(decryptSecret(config.tokenEncryptionKey, row.access_token_enc), 'fake-access-2');
});

test('a token set is re-sealed every time, so two writes of the same value differ on disk', async () => {
  const { db, config } = await setup();
  const first = await db.get('SELECT refresh_token_enc FROM oauth_tokens WHERE athlete_id = ?', [ATHLETE_ID]);

  await saveTokens(
    db,
    config,
    ATHLETE_ID,
    { accessToken: 'fake-access-1', refreshToken: 'fake-refresh-1', expiresAt: NOW_SECONDS + 60, scope: '', tokenType: 'Bearer' },
    null,
  );
  const second = await db.get('SELECT refresh_token_enc FROM oauth_tokens WHERE athlete_id = ?', [ATHLETE_ID]);

  // Why the CAS is an integer column: a fresh IV per seal means a ciphertext predicate would
  // match zero rows on every refresh, silently discarding every rotated token.
  assert.notEqual(first.refresh_token_enc, second.refresh_token_enc);
});

test('losing the CAS adopts the winner\'s token instead of retrying the exchange', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS - 10 });

  // Simulate an OAuth callback landing while we are "on the network": it writes a brand-new
  // grant unconditionally, which bumps token_version past what our refresh will present.
  const original = strava.refreshTokens.bind(strava);
  strava.refreshTokens = async (rt) => {
    const issued = await original(rt);
    await saveTokens(
      db,
      config,
      ATHLETE_ID,
      { accessToken: 'callback-access', refreshToken: 'callback-refresh', expiresAt: NOW_SECONDS + 7200, scope: 'read,activity:read_all', tokenType: 'Bearer' },
      null,
    );
    return issued;
  };

  const token = await getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW });

  assert.equal(token, 'callback-access', 'the newer grant wins');
  assert.equal(tokenPosts(fake).length, 1, 'a lost CAS must NOT retry the exchange');
  const stored = await loadTokens(db, config, ATHLETE_ID);
  assert.equal(stored.refreshToken, 'callback-refresh', 'our superseded token was dropped, not written');
});

// --------------------------------------------------------------- a dead grant

test('a 400 "RefreshToken invalid" sets strava_revoked_at and throws StravaGrantRevokedError', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS - 10 });
  fake.revokeAthlete();

  await assert.rejects(
    () => getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW }),
    (err) => {
      assert.ok(err instanceof StravaGrantRevokedError, `expected StravaGrantRevokedError, got ${err?.name}`);
      assert.equal(err.code, 'strava_revoked');
      return true;
    },
  );

  const athlete = await getAthlete(db, ATHLETE_ID);
  assert.equal(typeof athlete.strava_revoked_at, 'number');
  assert.equal(athlete.strava_revoked_at, Math.floor(NOW / 1000));

  // The rider survives the revocation: their team and history are untouched, which is what
  // keeps a revoked athlete on the board with a frozen total instead of vanishing.
  assert.equal(athlete.team, 'EAST');

  // One POST, not two: the row had not moved, so retrying with the identical token would be a
  // guaranteed second 400 against the endpoint every other athlete needs.
  assert.equal(tokenPosts(fake).length, 1);
});

test('a 400 whose row HAS moved is retried once with the winner\'s token', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS - 10 });

  // The classic race, replayed deterministically: our exchange presents a token that lost, and
  // the row already holds the token that won. Declaring the grant dead here would badge a
  // perfectly healthy rider as disconnected.
  const original = strava.refreshTokens.bind(strava);
  let call = 0;
  strava.refreshTokens = async (rt) => {
    call += 1;
    if (call === 1) {
      await saveTokens(
        db,
        config,
        ATHLETE_ID,
        { accessToken: 'winner-access', refreshToken: fake.tokens.refreshToken, expiresAt: NOW_SECONDS - 5, scope: '', tokenType: 'Bearer' },
        null,
      );
      throw new StravaGrantRevokedError('Strava refused the refresh token (400) (refresh_token: invalid).', {
        status: 400,
        path: '/oauth/token',
      });
    }
    return original(rt);
  };

  const token = await getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW });

  assert.equal(token, fake.tokens.accessToken);
  assert.equal(call, 2, 'exactly one retry');
  const athlete = await getAthlete(db, ATHLETE_ID);
  assert.equal(athlete.strava_revoked_at, null, 'a race must never mark the grant revoked');
});

test('no token row at all reads as a revoked grant, not an internal error', async () => {
  const { db, config, strava } = await setup();
  await db.run('DELETE FROM oauth_tokens WHERE athlete_id = ?', [ATHLETE_ID]);

  await assert.rejects(
    () => getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW }),
    StravaGrantRevokedError,
  );
});

// --------------------------------------------------------------- withAuth

test('withAuth refreshes once and retries once on a 401', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS + 3600 });
  // The stored token looks fresh but Strava disagrees -- the case a proactive skew cannot
  // cover (a token revoked and reissued elsewhere, or a clock that drifted).
  fake.expireAccessToken();

  const athlete = await withAuth(db, config, strava, ATHLETE_ID, (token) => strava.getAthlete(token), { nowMs: NOW });

  assert.equal(athlete.id, ATHLETE_ID);
  assert.equal(tokenPosts(fake).length, 1, 'exactly one refresh');
  const athleteGets = fake.requests.filter((r) => r.pathname.endsWith('/api/v3/athlete'));
  assert.equal(athleteGets.length, 2, 'the original call plus exactly one retry');
  assert.equal(athleteGets[0].bearer, 'fake-access-1');
  assert.equal(athleteGets[1].bearer, 'fake-access-2', 'the retry carries the NEW token');
});

test('withAuth does not loop on a second 401', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS + 3600 });

  let calls = 0;
  const always401 = () => {
    calls += 1;
    throw new StravaAuthError('Strava API rejected the credentials (401).', { status: 401, path: '/athlete' });
  };

  await assert.rejects(
    () => withAuth(db, config, strava, ATHLETE_ID, always401, { nowMs: NOW }),
    StravaAuthError,
  );

  assert.equal(calls, 2, 'called once, retried once, then the 401 is information');
  assert.equal(tokenPosts(fake).length, 1, 'one refresh, not one per attempt');
});

test('withAuth passes a non-401 straight through without refreshing', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS + 3600 });

  await assert.rejects(
    () => withAuth(db, config, strava, ATHLETE_ID, () => {
      throw new StravaAuthError('Strava API forbade the request (403).', { status: 403, path: '/athlete' });
    }, { nowMs: NOW }),
    StravaAuthError,
  );

  assert.equal(tokenPosts(fake).length, 0, 'a 403 is not a stale token');
});

test('two concurrent withAuth calls that both 401 share ONE refresh', async () => {
  const { db, config, fake, strava } = await setup({ expiresAt: NOW_SECONDS + 3600 });
  fake.expireAccessToken();

  const run = () => withAuth(db, config, strava, ATHLETE_ID, (token) => strava.getAthlete(token), { nowMs: NOW });
  const [a, b] = await Promise.all([run(), run()]);

  assert.equal(a.id, ATHLETE_ID);
  assert.equal(b.id, ATHLETE_ID);
  assert.equal(tokenPosts(fake).length, 1, 'the 401 path is single-flighted too');
});

// --------------------------------------------------------------- logging

test('no token, refresh token, or client secret ever reaches a log line', async () => {
  const records = [];
  setLogSink((r) => records.push(r));
  try {
    const { db, config, strava } = await setup({ expiresAt: NOW_SECONDS - 10 });
    await getValidAccessToken(db, config, strava, ATHLETE_ID, { nowMs: NOW });
  } finally {
    setLogSink(() => {});
  }

  assert.ok(records.length > 0, 'the refresh should say something');
  const text = JSON.stringify(records);
  for (const secret of ['fake-access-1', 'fake-access-2', 'fake-refresh-1', 'fake-refresh-2', 'SENTINEL_CLIENT_SECRET_do_not_log']) {
    assert.equal(text.includes(secret), false, `"${secret}" leaked into a log record`);
  }
  // token_version is deliberately NOT redacted: it is the one field that explains a CAS loss.
  assert.ok(records.some((r) => typeof r.token_version === 'number'));
});
