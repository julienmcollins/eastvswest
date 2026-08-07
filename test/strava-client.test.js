import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createStravaClient,
  StravaAuthError,
  StravaError,
  StravaGrantRevokedError,
  StravaNetworkError,
  StravaRateLimitError,
} from '../server/strava/client.js';
import { assertScope } from '../server/strava/authUrl.js';
import { computeSyncWindow, nextQuarterHourMs, nextUtcMidnightMs } from '../server/strava/map.js';
import { createFakeStrava, ACTIVITY_FIXTURE } from './helpers/fakeStrava.js';
import { testConfig } from './helpers/testDb.js';

const API_BASE = 'https://fake.strava.test/api/v3';
const OAUTH_BASE = 'https://fake.strava.test/oauth';
const REDIRECT_URI = 'http://localhost:3000/api/auth/strava/callback';

/** A recognizable client secret: every leak assertion in this file greps for it. */
const SENTINEL = 'SENTINEL_SECRET';

const TOTAL_RECORDS = ACTIVITY_FIXTURE.expected.total_records;
const MAX_START_EPOCH = Math.max(
  ...ACTIVITY_FIXTURE.activities.map((a) => Math.floor(Date.parse(a.start_date) / 1000)),
);

/**
 * A client wired to a fake, with a capturing logger.
 *
 * `minRequestSpacingMs: 0` and `retryBaseMs: 1` only shorten the real sleeps; both
 * defaults (100 ms spacer, 250 ms backoff) are exercised by their own assertions below.
 */
function makeClient(fake, over = {}) {
  const logCalls = [];
  const record = (entry) => logCalls.push(entry);
  const client = createStravaClient({
    apiBase: API_BASE,
    oauthBase: OAUTH_BASE,
    clientId: '12345',
    clientSecret: SENTINEL,
    redirectUri: REDIRECT_URI,
    fetchImpl: fake.fetchImpl,
    logger: { debug: record, info: record, warn: record, error: record },
    minRequestSpacingMs: 0,
    retryBaseMs: 1,
    ...over,
  });
  return { client, logCalls };
}

/** A fake that never prints its "unexpected call" warning during a deliberate 404 test. */
function quietFake(opts = {}) {
  return createFakeStrava({ logger: { error() {} }, ...opts });
}

// ------------------------------------------------------------- structural guarantees

test('client.js imports no node: builtin, reads no process.env, and knows nothing of sqlite', () => {
  const src = readFileSync(new URL('../server/strava/client.js', import.meta.url), 'utf8');
  // Strip comments first: this file talks ABOUT process.env and node:sqlite at length.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/process\s*\./.test(code), false, 'client.js must not touch process');
  assert.equal(/node:/.test(code), false, 'client.js must not import a node: builtin');
  assert.equal(/sqlite/i.test(code), false);
  // Same rule for the pure mapper it depends on.
  const mapSrc = readFileSync(new URL('../server/strava/map.js', import.meta.url), 'utf8');
  const mapCode = mapSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/node:/.test(mapCode), false);
  assert.equal(/process\s*\./.test(mapCode), false);
});

test('rate limits default conservatively before any response has been seen', () => {
  const { client } = makeClient(quietFake());
  const rl = client.rateLimit;
  assert.equal(rl.shortLimit, 100);
  assert.equal(rl.dailyLimit, 1000);
  assert.equal(rl.shortUsage, 0);
  assert.equal(rl.headersSeen, false);
  assert.equal(rl.blocked, false);
  assert.equal(rl.reserve, 5);
  assert.equal(client.redirectUri, REDIRECT_URI);
});

// ------------------------------------------------------------- pagination

test('full pagination over the 216-record fixture terminates on the short page', async () => {
  const fake = quietFake();
  const { client } = makeClient(fake);

  const res = await client.fetchAllActivities({ accessToken: fake.tokens.accessToken, perPage: 200 });

  assert.equal(res.activities.length, TOTAL_RECORDS);
  assert.equal(TOTAL_RECORDS, 216);
  assert.equal(res.pages, 2, '200 + a short page of 16');
  assert.equal(res.perPage, 200);
  assert.equal(res.truncated, false);
  assert.equal(fake.requests.length, 2, 'a third request would mean the short page was not recognized');
  assert.equal(fake.unexpected.length, 0);
  // Rate-limit headers were absorbed from the responses.
  assert.equal(client.rateLimit.headersSeen, true);
  assert.equal(client.rateLimit.shortUsage, 2);
});

test('iterateActivities yields each page and reports the summary as its return value', async () => {
  const fake = quietFake();
  const { client } = makeClient(fake);
  const iterator = client.iterateActivities({ accessToken: fake.tokens.accessToken, perPage: 100 });

  const sizes = [];
  let summary = null;
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      summary = step.value;
      break;
    }
    sizes.push(step.value.activities.length);
  }
  assert.deepEqual(sizes, [100, 100, 16]);
  assert.equal(summary.pages, 3);
  assert.equal(summary.truncated, false);
  assert.equal(summary.total, TOTAL_RECORDS);
  assert.equal(summary.maxStartEpoch, MAX_START_EPOCH);
});

test('the STRAVA_MAX_PAGES backstop sets truncated instead of paging forever', async () => {
  const fake = quietFake();
  const { client } = makeClient(fake);

  const res = await client.fetchAllActivities({ accessToken: fake.tokens.accessToken, perPage: 100, maxPages: 2 });
  assert.equal(res.pages, 2);
  assert.equal(res.activities.length, 200);
  // The caller must not advance the watermark or reconcile deletions on this run.
  assert.equal(res.truncated, true);
});

test('per_page=200 rejected with a 400 falls back to 100 and restarts from page 1', async () => {
  const fake = quietFake({ rejectLargePerPage: true });
  const { client } = makeClient(fake);

  const res = await client.fetchAllActivities({ accessToken: fake.tokens.accessToken, perPage: 200 });
  assert.equal(res.perPage, 100);
  assert.equal(res.activities.length, TOTAL_RECORDS, 'restarting at page 1 is what avoids skipping records');
  assert.equal(res.truncated, false);
  assert.equal(fake.requests.length, 4, '1 rejected + 3 pages');
  assert.equal(new URL(fake.requests[0].url).searchParams.get('per_page'), '200');
  assert.equal(new URL(fake.requests[1].url).searchParams.get('per_page'), '100');
  assert.equal(new URL(fake.requests[1].url).searchParams.get('page'), '1');
  // The cap is remembered, so it costs one 400 for the whole process, not one per page.
  assert.equal(client.rateLimit.pageSizeCap, 100);

  const again = await client.fetchAllActivities({ accessToken: fake.tokens.accessToken, perPage: 200 });
  assert.equal(again.perPage, 100);
  assert.equal(fake.requests.length, 7, 'no second 400 -- the cap was remembered');
});

// ------------------------------------------------------------- the watermark trap

test('the watermark is Math.max over all pages and is identical ascending or descending', async () => {
  const fake = quietFake();
  const { client } = makeClient(fake);
  const accessToken = fake.tokens.accessToken;

  // No `after` -> the fake answers newest-first, like Strava's documented default.
  const descending = await client.fetchAllActivities({ accessToken, perPage: 200 });
  // `after` present -> the fake flips to ascending, which is the behaviour that makes a
  // positional watermark read silently wrong.
  const ascending = await client.fetchAllActivities({ accessToken, after: 0, perPage: 200 });

  assert.notEqual(
    descending.activities[0].id,
    ascending.activities[0].id,
    'the fake must actually flip order, or this test proves nothing',
  );
  assert.equal(descending.activities.length, ascending.activities.length);
  assert.equal(descending.maxStartEpoch, MAX_START_EPOCH);
  assert.equal(ascending.maxStartEpoch, MAX_START_EPOCH);
  assert.equal(descending.maxStartEpoch, ascending.maxStartEpoch);

  // A positional read is wrong in the ascending case -- the exact bug being guarded.
  const positional = Math.floor(Date.parse(ascending.activities[0].start_date) / 1000);
  assert.notEqual(positional, MAX_START_EPOCH);
});

test('the padded window captures the UTC+13 edge ride under BOTH before/after semantics', async () => {
  const config = testConfig();
  const auckland = ACTIVITY_FIXTURE.activities.find((a) => a._why.includes('UTC+13 edge'));
  const { afterEpoch, beforeEpoch } = computeSyncWindow(config, {
    mode: 'full',
    nowMs: Date.parse('2026-09-15T00:00:00Z'),
  });

  for (const field of ['start_date', 'start_date_local']) {
    const fake = quietFake();
    fake.setWindowField(field);
    const { client } = makeClient(fake);
    const res = await client.fetchAllActivities({
      accessToken: fake.tokens.accessToken,
      after: afterEpoch,
      before: beforeEpoch,
      perPage: 200,
    });
    assert.ok(
      res.activities.some((a) => a.id === auckland.id),
      `the +/-86400 s padding must cover the ${field} interpretation`,
    );
  }
});

// ------------------------------------------------------------- 5xx retry

test('a mid-pagination 500 retries twice, then throws WITHOUT dropping the pages already fetched', async () => {
  const fake = quietFake();
  const { client, logCalls } = makeClient(fake);
  // Page 1 succeeds; every attempt at page 2 fails.
  fake.queue500(3, { afterCalls: 1 });

  const err = await client
    .fetchAllActivities({ accessToken: fake.tokens.accessToken, perPage: 100 })
    .then(() => null, (e) => e);

  assert.ok(err instanceof StravaError, `expected a StravaError, got ${err}`);
  assert.equal(err.status, 500);
  assert.equal(err.code, 'strava_unavailable');
  assert.equal(err.retryable, true);
  assert.equal(fake.requests.length, 4, '1 good page + 3 attempts at page 2');

  // The already-fetched page must reach the caller: upserts are idempotent, so throwing
  // it away just re-spends rate limit on the next sync.
  assert.ok(err.partial, 'the error must carry the partial result');
  assert.equal(err.partial.activities.length, 100);
  assert.equal(err.partial.pages, 1);
  assert.equal(err.partial.truncated, true, 'a partial run must never advance the watermark');
  // ...but must not be dumped into a log line.
  assert.equal(Object.keys(err).includes('partial'), false, 'partial must be non-enumerable');
  assert.equal(JSON.stringify(err).includes('start_date'), false);

  const warns = logCalls.filter((c) => c.event === 'strava.error');
  assert.equal(warns.length, 3);
  assert.deepEqual(warns.map((c) => c.attempt), [1, 2, 3]);
});

test('a single transient 500 is retried and the pagination completes', async () => {
  const fake = quietFake();
  const { client } = makeClient(fake);
  fake.queue500(1, { afterCalls: 1 });

  const res = await client.fetchAllActivities({ accessToken: fake.tokens.accessToken, perPage: 100 });
  assert.equal(res.activities.length, TOTAL_RECORDS);
  assert.equal(res.truncated, false);
  assert.equal(fake.requests.length, 4, '3 pages + 1 retried failure');
});

test('a transport failure becomes StravaNetworkError after the retry budget', async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    return Promise.reject(new TypeError('fetch failed'));
  };
  const { client } = makeClient({ fetchImpl, tokens: { accessToken: 'x' } }, { fetchImpl });

  await assert.rejects(() => client.getAthlete('x'), StravaNetworkError);
  assert.equal(calls, 3, 'one attempt plus two retries');
});

test('POST /oauth/token is NEVER retried, however transient the failure looks', async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    return Promise.resolve(new Response('{"message":"Internal Server Error"}', { status: 500 }));
  };
  const { client } = makeClient({ fetchImpl }, { fetchImpl });

  // A retried code exchange burns the single-use code, turning a blip into a login the
  // rider cannot repeat.
  await assert.rejects(() => client.exchangeCode('one-shot-code'), StravaError);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(() => client.refreshTokens('some-refresh'), StravaError);
  assert.equal(calls, 1);
});

/**
 * THE WORKERD RECEIVER BUG. This is the test that was missing when every sign-in on the
 * deployed Worker died at `exchange_failed:strava_unavailable`.
 *
 * The default `fetchImpl` is `globalThis.fetch`, and the call site is `this.#fetch(url, init)`
 * -- so the receiver is the StravaClient instance. undici does not care, which is why all 411
 * tests passed on Node. workerd's `fetch` is a method of the global scope and validates its
 * `this`, throwing `TypeError: Illegal invocation` synchronously: no packet leaves the isolate,
 * `status` is null, and POST /oauth/token gets no retry by design, so the whole OAuth callback
 * failed 42 ms in while every D1-only route stayed green.
 *
 * The fake below is receiver-sensitive in exactly the way workerd is, so it reproduces that
 * failure here. It has to install itself on `globalThis` because the DEFAULT argument is what
 * is under test -- an injected `fetchImpl` never had this problem.
 */
test('the default fetchImpl is BOUND to the global, as workerd requires', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    // eslint-disable-next-line func-names -- needs a dynamic `this`, so not an arrow.
    globalThis.fetch = function (url, init) {
      if (this !== globalThis) {
        // Precisely workerd's behaviour, and the message it uses.
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      }
      seen.push({ url: String(url), method: init?.method });
      return Promise.resolve(new Response(
        JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          expires_at: 4000000000,
          athlete: { id: 7 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    };

    // No fetchImpl: the default is the whole point.
    const client = createStravaClient({
      apiBase: API_BASE,
      oauthBase: OAUTH_BASE,
      clientId: '12345',
      clientSecret: SENTINEL,
      redirectUri: REDIRECT_URI,
      minRequestSpacingMs: 0,
    });

    const tokens = await client.exchangeCode('a-code');
    assert.equal(tokens.accessToken, 'a');
    assert.deepEqual(seen, [{ url: `${OAUTH_BASE}/token`, method: 'POST' }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a transport failure logs the cause name and message, and still no secret', async () => {
  const fetchImpl = () => Promise.reject(
    new TypeError('Illegal invocation: function called with incorrect `this` reference.'),
  );
  const { client, logCalls } = makeClient({ fetchImpl }, { fetchImpl });

  await assert.rejects(() => client.exchangeCode('a-code'), StravaNetworkError);

  const line = logCalls.find((c) => c.event === 'strava.transport_error');
  assert.ok(line, 'the transport failure is logged');
  assert.equal(line.status, null);
  assert.equal(line.attempt, 1);
  // Without these two the line said only "something threw", and a runtime rejecting the call
  // outright was indistinguishable from Strava being down.
  assert.equal(line.errorName, 'TypeError');
  assert.match(line.errorMessage, /Illegal invocation/);
  // Rule 2 still holds: the strings come off the error, never off the body or the headers, and
  // the line is still an allowlist -- two keys wider than an ordinary one, and no wider.
  assert.deepEqual(
    Object.keys(line).sort(),
    ['attempt', 'errorMessage', 'errorName', 'event', 'host', 'method', 'pathname', 'rateLimitUsage', 'status'],
  );
  assert.ok(!JSON.stringify(logCalls).includes(SENTINEL), 'the client secret never reaches a log line');
  assert.ok(!JSON.stringify(logCalls).includes('a-code'), 'the authorization code never reaches a log line');
});

// ------------------------------------------------------------- rate limiting

test('a 429 blocks until the next quarter hour and the NEXT call throws without sending', async () => {
  const nowMs = Date.parse('2026-08-04T14:31:07.000Z');
  const fake = quietFake();
  const { client } = makeClient(fake, { now: () => nowMs });
  fake.queue429(1);

  const err = await client
    .fetchAllActivities({ accessToken: fake.tokens.accessToken, perPage: 200 })
    .then(() => null, (e) => e);

  assert.ok(err instanceof StravaRateLimitError);
  assert.equal(err.status, 429);
  assert.equal(err.bucket, 'short');
  assert.equal(err.resetAt, new Date(nextQuarterHourMs(nowMs)).toISOString());
  assert.equal(err.resetAt, '2026-08-04T14:45:01.000Z');
  assert.equal(err.retryAfterMs, nextQuarterHourMs(nowMs) - nowMs);
  assert.ok(err.retryAfterMs > 0, 'blockedUntil === now would be a tight 429 burn loop');

  assert.equal(client.rateLimit.blocked, true);
  assert.equal(client.rateLimit.bucket, 'short');
  assert.equal(client.rateLimit.blockedUntil, '2026-08-04T14:45:01.000Z');

  // The pre-emptive gate: no second request may leave the process.
  const sent = fake.requests.length;
  assert.equal(sent, 1);
  await assert.rejects(() => client.getAthlete(fake.tokens.accessToken), StravaRateLimitError);
  await assert.rejects(() => client.listActivities({ accessToken: fake.tokens.accessToken }), StravaRateLimitError);
  assert.equal(fake.requests.length, sent, 'a blocked client must not touch the network');
});

test('a 429 with the daily bucket exhausted blocks until the next UTC midnight', async () => {
  const nowMs = Date.parse('2026-08-04T14:31:07.000Z');
  const fake = quietFake();
  const { client } = makeClient(fake, { now: () => nowMs });
  fake.queue429(1, { bucket: 'daily' });

  const err = await client.getAthlete(fake.tokens.accessToken).then(() => null, (e) => e);
  assert.ok(err instanceof StravaRateLimitError);
  assert.equal(err.bucket, 'daily');
  assert.equal(err.resetAt, new Date(nextUtcMidnightMs(nowMs)).toISOString());
  assert.equal(err.resetAt, '2026-08-05T00:00:01.000Z');
});

test('a Retry-After further out than the bucket boundary wins', async () => {
  const nowMs = Date.parse('2026-08-04T14:31:07.000Z');
  const fake = quietFake();
  const { client } = makeClient(fake, { now: () => nowMs });
  fake.queue429(1, { retryAfter: 7200 });

  const err = await client.getAthlete(fake.tokens.accessToken).then(() => null, (e) => e);
  assert.equal(err.resetAt, new Date(nowMs + 7_200_000).toISOString());
});

test('the RESERVE gate refuses to send once usage is within 5 of the limit', async () => {
  const fake = quietFake();
  fake.setRateLimit({ shortUsage: 93, shortLimit: 100 });
  const { client } = makeClient(fake);

  // First call is allowed (no headers seen yet) and teaches the client usage=94.
  await client.getAthlete(fake.tokens.accessToken);
  assert.equal(client.rateLimit.shortUsage, 94);
  await client.getAthlete(fake.tokens.accessToken);
  assert.equal(client.rateLimit.shortUsage, 95);

  const sent = fake.requests.length;
  const err = await client.getAthlete(fake.tokens.accessToken).then(() => null, (e) => e);
  assert.ok(err instanceof StravaRateLimitError);
  assert.equal(err.bucket, 'local', 'our own reserve, not an observed 429');
  assert.equal(err.status, null);
  assert.equal(fake.requests.length, sent, 'the reserve gate must not send the request');
  // The reserve is NOT a persisted block: it is a guess about our own usage.
  assert.equal(client.rateLimit.blocked, false);
});

test('a full READ quota still leaves room for a token refresh', async () => {
  const fake = quietFake();
  fake.setRateLimit({ readShortUsage: 100, readShortLimit: 100 });
  const { client } = makeClient(fake);

  // Teach the client the read bucket is gone (this GET is the last one allowed through).
  await client.getAthlete(fake.tokens.accessToken).then(() => null, () => null);
  await assert.rejects(() => client.getAthlete(fake.tokens.accessToken), StravaRateLimitError);
  // The refresh is a POST to /oauth/token: the read bucket must not gate it, or a rider
  // whose read quota is spent can never log in again.
  const refreshed = await client.refreshTokens(fake.tokens.refreshToken);
  assert.ok(refreshed.accessToken);
});

// ------------------------------------------------------------- OAuth

test('the authorize knobs produce the three real consent outcomes', async () => {
  const fake = quietFake();
  const authorize = async (extra) => {
    const url = new URL(`${OAUTH_BASE}/authorize`);
    url.searchParams.set('client_id', '12345');
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('state', 'st-1');
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    const res = await fake.fetchImpl(url.toString(), { method: 'GET' });
    assert.equal(res.status, 302);
    return new URL(res.headers.get('location'));
  };

  const full = await authorize({});
  assert.equal(assertScope(full.searchParams.get('scope')), 'read_all');
  assert.ok(full.searchParams.get('code'));
  assert.equal(full.searchParams.get('state'), 'st-1');

  // The rider unchecked "private activities": countable, must NOT be a lockout.
  const readOnly = await authorize({ grant: 'read' });
  assert.equal(assertScope(readOnly.searchParams.get('scope')), 'read');

  // The rider unchecked everything optional: no activity scope at all.
  const noActivity = await authorize({ grant: '' });
  assert.throws(() => assertScope(noActivity.searchParams.get('scope')), { name: 'StravaScopeError' });

  const denied = await authorize({ deny: '1' });
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  assert.equal(denied.searchParams.get('code'), null);
});

test('exchangeCode works once; replaying the code is a hard 400 with no retry', async () => {
  const fake = quietFake({ clientSecret: SENTINEL });
  const { client } = makeClient(fake);

  const res = await fake.fetchImpl(
    `${OAUTH_BASE}/authorize?client_id=12345&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=s`,
    { method: 'GET' },
  );
  const code = new URL(res.headers.get('location')).searchParams.get('code');

  const tokens = await client.exchangeCode(code);
  assert.equal(tokens.accessToken, fake.tokens.accessToken);
  assert.equal(tokens.refreshToken, fake.tokens.refreshToken);
  assert.equal(tokens.tokenType, 'Bearer');
  assert.ok(tokens.expiresAt > Math.floor(Date.now() / 1000));
  assert.equal(tokens.athlete.id, fake.athlete.id);
  // The secret really was sent -- otherwise the leak assertions below prove nothing.
  const tokenPost = fake.requests.find((r) => r.pathname.endsWith('/oauth/token'));
  assert.equal(tokenPost.form.client_secret, SENTINEL);

  const before = fake.requests.length;
  await assert.rejects(() => client.exchangeCode(code), StravaAuthError);
  assert.equal(fake.requests.length, before + 1, 'exactly one attempt');
});

test('refresh_token rotates, and the superseded token is dead', async () => {
  const fake = quietFake();
  const { client } = makeClient(fake);

  const first = await client.refreshTokens('fake-refresh-1');
  assert.notEqual(first.refreshToken, 'fake-refresh-1', 'the fake rotates by default');
  const second = await client.refreshTokens(first.refreshToken);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.notEqual(second.accessToken, first.accessToken);

  // This is why a token must be persisted unconditionally, never "only if changed".
  await assert.rejects(() => client.refreshTokens('fake-refresh-1'), StravaGrantRevokedError);
});

test('a revoked grant surfaces as StravaGrantRevokedError, not a generic 400', async () => {
  const fake = quietFake();
  const { client } = makeClient(fake);
  const refreshToken = fake.tokens.refreshToken;
  fake.revokeAthlete();

  const err = await client.refreshTokens(refreshToken).then(() => null, (e) => e);
  assert.ok(err instanceof StravaGrantRevokedError);
  assert.equal(err.code, 'strava_revoked');
  assert.equal(err.status, 400);
  assert.equal(err.retryable, false);
});

test('an expired access token is a 401 StravaAuthError and is not retried', async () => {
  const fake = quietFake();
  const { client } = makeClient(fake);
  fake.expireAccessToken();

  const err = await client.getAthlete(fake.tokens.accessToken).then(() => null, (e) => e);
  assert.ok(err instanceof StravaAuthError);
  assert.equal(err.status, 401);
  assert.equal(err.retryable, false);
  assert.equal(fake.requests.length, 1, 'a 401 is not transient; retrying just spends quota');
});

test('deauthorize succeeds, and succeeds again on an already-revoked grant', async () => {
  const fake = quietFake();
  const { client } = makeClient(fake);

  const first = await client.deauthorize(fake.tokens.accessToken);
  assert.equal(first.ok, true);
  assert.equal(first.alreadyRevoked, false);
  assert.equal(fake.revoked, true);
  // Sent both ways because it is [UNVERIFIED] which one Strava reads.
  const post = fake.requests.at(-1);
  assert.equal(post.bearer, fake.tokens.accessToken);
  assert.equal(post.form.access_token, fake.tokens.accessToken);

  // A 401 here means the grant is already gone -- the state the caller asked for.
  const second = await client.deauthorize(fake.tokens.accessToken);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyRevoked, true);
});

test('a token response missing its tokens is an auth error, not a crash later', async () => {
  const fetchImpl = () => Promise.resolve(new Response('{"token_type":"Bearer"}', { status: 200 }));
  const { client } = makeClient({ fetchImpl }, { fetchImpl });
  await assert.rejects(() => client.exchangeCode('c'), StravaAuthError);
});

test('a non-array activity page is rejected instead of read as "no more pages"', async () => {
  const fetchImpl = () => Promise.resolve(new Response('{"message":"nope"}', { status: 200 }));
  const { client } = makeClient({ fetchImpl }, { fetchImpl });
  await assert.rejects(() => client.listActivities({ accessToken: 'x' }), { code: 'strava_bad_shape' });
});

test('an HTML 502 from a proxy does not turn into a body-quoting SyntaxError', async () => {
  const fetchImpl = () => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 }));
  const { client } = makeClient({ fetchImpl }, { fetchImpl, retryBaseMs: 1 });
  const err = await client.getAthlete('x').then(() => null, (e) => e);
  assert.ok(err instanceof StravaError);
  assert.equal(err.status, 502);
  assert.equal(err.message.includes('<html>'), false);
});

// ------------------------------------------------------------- the leak assertions

test('a token-endpoint 400 leaves the client secret in ZERO logger calls and nowhere in the error', async () => {
  // clientSecret: null on the fake so the request reaches the code-validation branch and
  // fails with Strava's real 400 envelope.
  const fake = quietFake({ clientSecret: null });
  const { client, logCalls } = makeClient(fake);

  const err = await client.exchangeCode('never-issued-code').then(() => null, (e) => e);
  assert.ok(err instanceof StravaAuthError);
  assert.equal(err.status, 400);

  // The secret WAS transmitted; it just must not be recorded anywhere.
  assert.equal(fake.requests.at(-1).form.client_secret, SENTINEL);

  assert.ok(logCalls.length > 0, 'the failure must still be logged, just not with the secret');
  const logged = JSON.stringify(logCalls);
  assert.equal(logged.includes(SENTINEL), false, 'client secret leaked into a log line');
  assert.equal(logged.includes('never-issued-code'), false, 'the authorization code leaked into a log line');
  assert.equal(logged.includes('client_secret'), false);

  // Log lines carry ONLY the allowlisted scalars.
  for (const call of logCalls) {
    assert.deepEqual(Object.keys(call).sort(), ['attempt', 'event', 'host', 'method', 'pathname', 'rateLimitUsage', 'status']);
  }

  const serialized = JSON.stringify(err);
  assert.equal(serialized.includes(SENTINEL), false, 'client secret leaked into JSON.stringify(err)');
  assert.equal(serialized.includes('never-issued-code'), false);
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), ['code', 'message', 'name', 'path', 'retryable', 'status']);
  assert.equal('body' in err, false, 'StravaError must never carry a response body');
  assert.equal(err.path, '/oauth/token', 'the query string is never part of the logged path');
});

test('a refresh failure never records the refresh token', async () => {
  const fake = quietFake();
  const { client, logCalls } = makeClient(fake);
  const doomed = 'refresh-token-that-should-never-be-logged';

  const err = await client.refreshTokens(doomed).then(() => null, (e) => e);
  assert.ok(err instanceof StravaGrantRevokedError);
  const blob = JSON.stringify({ err, logCalls });
  assert.equal(blob.includes(doomed), false);
  assert.equal(blob.includes(SENTINEL), false);
});

test('an access token never reaches the logger on an API failure', async () => {
  const fake = quietFake();
  const { client, logCalls } = makeClient(fake);
  const token = fake.tokens.accessToken;
  fake.expireAccessToken();

  const err = await client.getAthlete(token).then(() => null, (e) => e);
  const blob = JSON.stringify({ err, logCalls });
  assert.equal(blob.includes(token), false);
  assert.equal(blob.includes('Bearer'), false);
});

test('an unexpected path 404s loudly rather than returning an empty page', async () => {
  const shouted = [];
  const fake = createFakeStrava({ logger: { error: (m) => shouted.push(m) } });
  const res = await fake.fetchImpl(`${API_BASE}/segments/123`, {
    method: 'GET',
    // Authenticated, so the 404 is unambiguously about the unexpected PATH.
    headers: { Authorization: `Bearer ${fake.tokens.accessToken}` },
  });
  assert.equal(res.status, 404);
  assert.equal(fake.unexpected.length, 1);
  assert.equal(shouted.length, 1);
  assert.match(shouted[0], /UNEXPECTED GET/);
});
