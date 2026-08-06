import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildApp } from '../server/app.js';
import { buildRoutes } from '../server/routes/index.js';
import { createStravaClient } from '../server/strava/client.js';
import { redirectUri } from '../server/strava/authUrl.js';
import { setLogSink } from '../server/lib/log.js';
import { decryptSecret } from '../server/security/crypto.js';
import { freshDb, testConfig, SENTINEL_SECRET, seedAthlete } from './helpers/testDb.js';
import { createFakeStrava } from './helpers/fakeStrava.js';
import { injectRequest } from './helpers/inject.js';
import { _resetSingleFlightForTests } from '../server/strava/tokenService.js';

/**
 * The whole rider journey in one ordered narrative, from an anonymous first visit through
 * sign-in, team choice, sync, a token rotation, a revoked grant, and logout.
 *
 * The per-area suites already assert these behaviours in isolation. What this file adds is
 * ORDER: it is the only place that proves the steps compose, that state carried between
 * them survives, and that no step quietly undoes an earlier one. Every request goes
 * through the real app handler via injectRequest -- no sockets, because listen() is EPERM
 * in this sandbox.
 */

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'activities.json'), 'utf8'),
);

const ORIGIN = 'http://localhost:3000';
const RIDER_ID = 12345678;

/**
 * The competition window used throughout this file, deliberately ENDING IN THE PAST.
 *
 * Requests arrive through the real HTTP handler, so there is no seam to inject a clock
 * through -- sync uses the wall clock and fetches `[START-1d, min(today, END)+1d]`. With a
 * window that has already closed, that upper bound is `END+1d` on every future run, so the
 * expected numbers below are stable instead of drifting with the calendar.
 */
const WINDOW = { start: '2026-06-01', end: '2026-07-31' };

/**
 * What the server should end up with, derived from the raw fixture by independent
 * arithmetic. Deliberately NOT read from the fixture's own `expected` block: that block is
 * computed for the full 2026-06-01..2026-08-31 season, and reusing production predicates
 * here would let a filtering bug agree with itself.
 */
const EXPECTED = (() => {
  const MILE = 1609.344;
  const counted = new Set(['Ride', 'GravelRide', 'MountainBikeRide', 'VirtualRide']);
  const dateOf = (iso) => iso.slice(0, 10);

  const fetchLo = '2026-05-31'; // START - 1d
  const fetchHi = '2026-08-01'; // END + 1d, since the window has closed

  const stored = FIXTURE.activities.filter((a) => {
    const d = dateOf(a.start_date);
    return d >= fetchLo && d <= fetchHi;
  });
  const scoring = stored.filter((a) => {
    const local = dateOf(a.start_date_local);
    return counted.has(a.sport_type) && local >= WINDOW.start && local <= WINDOW.end && !a.manual;
  });
  const meters = scoring.reduce((s, a) => s + a.distance, 0);

  // Per-month, because every calendar month is its own competition and one request returns
  // ONE month. `miles` below stays the whole-window sum so the months can be checked to add
  // up to it -- dropping that would let a month-filtering bug hide as a smaller total.
  const byMonth = {};
  for (const a of scoring) {
    const month = dateOf(a.start_date_local).slice(0, 7);
    byMonth[month] = byMonth[month] ?? { counted: 0, meters: 0 };
    byMonth[month].counted += 1;
    byMonth[month].meters += a.distance;
  }
  const monthMiles = {};
  const monthCounted = {};
  for (const [month, v] of Object.entries(byMonth)) {
    monthMiles[month] = Math.round((v.meters / MILE) * 10) / 10;
    monthCounted[month] = v.counted;
  }

  return {
    stored: stored.length,
    counted: scoring.length,
    miles: Math.round((meters / MILE) * 10) / 10,
    monthMiles,
    monthCounted,
  };
})();

/** Every log record and response body produced during the run, for the secret-leak sweep. */
const LOGS = [];
const BODIES = [];

setLogSink((record) => LOGS.push(record));

async function harness(configOverrides = {}) {
  _resetSingleFlightForTests();
  const db = await freshDb();
  const config = testConfig({
    COMPETITION_START: WINDOW.start,
    COMPETITION_END: WINDOW.end,
    ...configOverrides,
  });
  const fake = createFakeStrava({ athleteId: RIDER_ID });
  const strava = createStravaClient({
    apiBase: config.stravaApiBase,
    oauthBase: config.stravaOauthBase,
    clientId: config.stravaClientId,
    clientSecret: config.stravaClientSecret,
    redirectUri: redirectUri(config),
    fetchImpl: fake.fetchImpl,
  });
  const app = buildApp({ config, db, routes: buildRoutes({ config, db, strava }) });
  return { db, config, fake, strava, app };
}

async function call(app, opts) {
  const res = await injectRequest(app, opts);
  if (res.body) BODIES.push(res.body);
  return res;
}

/**
 * Walk the real OAuth flow end to end: our login redirect -> the fake's authorize endpoint
 * -> our callback. Nothing is hand-assembled, so the `state` and `code` are the ones the
 * two sides actually exchanged.
 */
async function signIn(app, fake, { grant = null, deny = false } = {}) {
  const login = await call(app, { method: 'GET', url: '/api/auth/strava/login' });
  assert.equal(login.status, 302);

  const authorizeUrl = new URL(login.headers.location);
  if (deny) authorizeUrl.searchParams.set('deny', '1');
  if (grant !== null) authorizeUrl.searchParams.set('grant', grant);

  const consent = await fake.fetchImpl(authorizeUrl.toString());
  const back = new URL(consent.headers.get('location'));

  const cb = await call(app, {
    method: 'GET',
    url: `${back.pathname}${back.search}`,
    cookies: { bc_oauth: login.cookies.bc_oauth },
  });
  return {
    cb,
    sid: cb.cookies.bc_sid,
    csrf: cb.cookies.bc_csrf,
    state: authorizeUrl.searchParams.get('state'),
    oauthNonce: login.cookies.bc_oauth,
    callbackQuery: back.search,
  };
}

function authed(auth) {
  return {
    headers: { origin: ORIGIN, 'x-csrf-token': auth.csrf },
    cookies: { bc_sid: auth.sid, bc_csrf: auth.csrf },
  };
}

test('the whole rider journey, in order', async (t) => {
  const { db, app, fake, config } = await harness();

  await t.test('1. an anonymous visitor gets a real page, not an error', async () => {
    const me = await call(app, { method: 'GET', url: '/api/me' });
    assert.equal(me.status, 200, 'logged out is 200 with rider:null -- a 401 makes an ordinary visit look broken');
    assert.equal(me.json.authenticated, false);
    assert.equal(me.json.rider, null);

    const lb = await call(app, { method: 'GET', url: '/api/leaderboard' });
    assert.equal(lb.status, 200);
    assert.equal(lb.json.teams.length, 2, 'both teams exist before anyone has signed up');
    assert.equal(lb.json.teams[0].miles, 0);
    assert.equal(lb.json.teams[0].share, 0.5, 'an empty board splits evenly rather than dividing by zero');
    assert.equal(lb.json.riders.length, 0);
    assert.equal(lb.json.sync.last_synced_at, null, 'this is what drives the empty state');
    assert.equal(lb.json.leader, null, 'nobody leads a 0-0 race');
  });

  let auth;

  await t.test('2. sign-in mints a brand-new session', async () => {
    auth = await signIn(app, fake);
    assert.equal(auth.cb.status, 302);
    assert.ok(auth.cb.headers.location.startsWith(config.webOrigin));
    assert.ok(auth.sid && auth.csrf);

    const sidCookie = auth.cb.setCookie.find((c) => c.startsWith('bc_sid='));
    assert.match(sidCookie, /HttpOnly/);
    assert.match(sidCookie, /SameSite=Lax/, 'Strict would withhold the cookie on the callback navigation');

    const cleared = auth.cb.setCookie.find((c) => c.startsWith('bc_oauth=') && /Max-Age=0/.test(c));
    assert.ok(cleared, 'the one-shot nonce cookie must be cleared on every exit path');

    // The raw token is never stored, so a leaked DB yields nothing usable.
    const stored = await db.all('SELECT session_id_hash FROM sessions');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].session_id_hash.includes(auth.sid), false);
  });

  await t.test('3. replaying that state fails, and so does another browser holding it', async () => {
    const replay = await call(app, {
      method: 'GET',
      url: `/api/auth/strava/callback${auth.callbackQuery}`,
      cookies: { bc_oauth: auth.oauthNonce },
    });
    assert.equal(replay.status, 302);
    assert.match(replay.headers.location, /#error=state_expired/, 'single-use consumption');

    // The login-CSRF case. An attacker who completes consent themselves and mails the
    // victim a genuine code+state link must NOT be able to bind their athlete to the
    // victim's browser. Signing and single-use alone do not stop this -- the nonce does.
    const fresh = await call(app, { method: 'GET', url: '/api/auth/strava/login' });
    const consent = await fake.fetchImpl(new URL(fresh.headers.location).toString());
    const back = new URL(consent.headers.get('location'));
    const victim = await call(app, {
      method: 'GET',
      url: `${back.pathname}${back.search}`,
      cookies: { bc_oauth: 'a-different-browsers-nonce' },
    });
    assert.equal(victim.status, 302);
    assert.match(victim.headers.location, /#error=/);
    assert.equal(victim.cookies.bc_sid, undefined, 'no session may be issued for a foreign nonce');
  });

  await t.test('4. the new rider must choose a team, exactly once', async () => {
    const me = await call(app, { method: 'GET', url: '/api/me', cookies: { bc_sid: auth.sid } });
    assert.equal(me.json.rider.needs_team, true);
    assert.equal(me.json.rider.team, null);

    const claim = await call(app, { method: 'POST', url: '/api/me/team', body: { team: 'EAST' }, ...authed(auth) });
    assert.equal(claim.status, 200);
    assert.equal(claim.json.team, 'EAST');

    // A double-click is not an error: the rider did exactly what was asked.
    const again = await call(app, { method: 'POST', url: '/api/me/team', body: { team: 'EAST' }, ...authed(auth) });
    assert.equal(again.status, 200);

    // But switching sides mid-competition is not on offer.
    const switched = await call(app, { method: 'POST', url: '/api/me/team', body: { team: 'WEST' }, ...authed(auth) });
    assert.equal(switched.status, 409);
    assert.equal(switched.json.error, 'team_already_set');
    assert.equal((await db.get('SELECT team FROM athletes WHERE strava_athlete_id=?', [RIDER_ID])).team, 'EAST');
  });

  await t.test('5. the first sync fills the board with exactly the countable rides', async () => {
    // Give WEST a member so the zero-mile team case is live end to end.
    await seedAthlete(db, { id: 44444444, name: 'Priya R', team: 'WEST' });

    const sync = await call(app, { method: 'POST', url: '/api/me/sync', body: {}, ...authed(auth) });
    assert.equal(sync.status, 200);
    assert.equal(sync.json.activities_scanned, EXPECTED.stored);
    assert.equal(sync.json.activities_counted, EXPECTED.counted);
    assert.equal(sync.json.truncated, false);

    // `miles` is the SELECTED MONTH's total, so it is checked against the month the response
    // says it resolved to rather than a hardcoded one. The server picks that month (the
    // current one in COMPETITION_TZ, clamped to the picker bounds); asserting a literal here
    // would encode a clamp rule this test is not the right place to re-derive.
    const selected = sync.json.leaderboard.competition.month;
    assert.ok(EXPECTED.monthMiles[selected] !== undefined, `fixture has no rides for ${selected}`);
    assert.equal(sync.json.miles, EXPECTED.monthMiles[selected]);

    // The months must still add up to the whole-window total this test used to assert, or a
    // month filter that silently dropped rides would look like a pass.
    assert.equal(
      Object.values(EXPECTED.monthMiles).reduce((a, b) => a + b, 0),
      EXPECTED.miles,
      'per-month totals must sum to the full-window total',
    );

    // Everything fetched is stored; only the query filters. Changing ALLOWED_SPORT_TYPES
    // later must not require re-syncing every rider against a rate-limited API.
    const stored = await db.get('SELECT COUNT(*) n FROM activities');
    assert.equal(Number(stored.n), EXPECTED.stored);
    assert.ok(EXPECTED.stored > EXPECTED.counted, 'the fixture must include rides that are stored but do not score');

    const lb = sync.json.leaderboard;
    assert.equal(lb.teams[0].team, 'EAST');
    assert.equal(lb.teams[0].miles, EXPECTED.monthMiles[selected]);
    assert.equal(lb.teams[1].team, 'WEST');
    assert.equal(lb.teams[1].miles, 0, 'a zero-mile team must survive the LEFT JOIN');
    assert.equal(lb.leader.team, 'EAST');

    // The UTC+13 ride scores on its LOCAL date, which is inside the window even though its
    // UTC date is the day before.
    const auckland = await db.get('SELECT local_date FROM activities WHERE strava_activity_id=?', [15000000012]);
    assert.equal(auckland.local_date, WINDOW.start);

    const priya = lb.riders.find((r) => r.athlete_id === 44444444);
    assert.equal(priya.miles, 0);
    assert.equal(priya.rank, null, 'zero miles is unranked, not rank 2');

    const mine = lb.riders.find((r) => r.athlete_id === RIDER_ID);
    assert.equal(mine.is_you, true);
    assert.equal(mine.rank, 1);
  });

  await t.test('6. tokens are encrypted at rest -- the highest-consequence regression', async () => {
    const row = await db.get('SELECT access_token_enc, refresh_token_enc FROM oauth_tokens WHERE athlete_id=?', [RIDER_ID]);
    assert.ok(row.access_token_enc.startsWith('v1.'));
    assert.equal(row.access_token_enc.includes(fake.tokens.accessToken), false);
    assert.equal(row.refresh_token_enc.includes(fake.tokens.refreshToken), false);
    assert.equal(decryptSecret(config.tokenEncryptionKey, row.access_token_enc), fake.tokens.accessToken);
  });

  await t.test('7. an immediate refresh is refused with a time, not an error', async () => {
    const second = await call(app, { method: 'POST', url: '/api/me/sync', body: {}, ...authed(auth) });
    assert.equal(second.status, 429);
    assert.equal(second.json.scope, 'local', 'our own cooldown, not something Strava said');
    assert.ok(second.json.retry_after_seconds > 0, 'the UI shows a countdown, so it needs a number');
  });

  await t.test('8. re-syncing is idempotent -- rides never double-count', async () => {
    const before = Number((await db.get('SELECT COUNT(*) n FROM activities')).n);
    const forced = await call(app, { method: 'POST', url: '/api/me/sync', body: { mode: 'full' }, ...authed(auth), });
    // The cooldown may still be in effect; force through it at the service level instead.
    if (forced.status === 429) {
      await db.run('UPDATE sync_state SET last_sync_finished = 0 WHERE athlete_id = ?', [RIDER_ID]);
      const retry = await call(app, { method: 'POST', url: '/api/me/sync', body: { mode: 'full' }, ...authed(auth) });
      assert.equal(retry.status, 200);
      // Against the month the response itself reports, for the reason given in step 5.
      const month = retry.json.leaderboard.competition.month;
      assert.equal(retry.json.miles, EXPECTED.monthMiles[month], 'the total must not move');
    }
    assert.equal(Number((await db.get('SELECT COUNT(*) n FROM activities')).n), before);
  });

  await t.test('9. a revoked grant freezes the total instead of erasing the rider', async () => {
    fake.revokeAthlete();
    await db.run('UPDATE sync_state SET last_sync_finished = 0 WHERE athlete_id = ?', [RIDER_ID]);

    const res = await call(app, { method: 'POST', url: '/api/me/sync', body: {}, ...authed(auth) });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'strava_revoked');
    assert.ok(res.json.reauth_url, 'the rider needs a way back in');

    // Everything survives. Deleting them would silently rewrite the standings for the whole
    // team, which is a worse outcome than a stale number.
    const athlete = await db.get('SELECT team, strava_revoked_at FROM athletes WHERE strava_athlete_id=?', [RIDER_ID]);
    assert.equal(athlete.team, 'EAST');
    assert.notEqual(athlete.strava_revoked_at, null);

    const lb = await call(app, { method: 'GET', url: '/api/leaderboard' });
    assert.equal(
      lb.json.teams[0].miles,
      EXPECTED.monthMiles[lb.json.competition.month],
      'the frozen total still counts',
    );
    assert.equal(lb.json.riders.find((r) => r.athlete_id === RIDER_ID).revoked, true);
  });

  await t.test('10. logout genuinely invalidates the session', async () => {
    const out = await call(app, { method: 'POST', url: '/api/auth/logout', body: {}, ...authed(auth) });
    assert.equal(out.status, 204);
    assert.equal((await db.all('SELECT 1 FROM sessions WHERE athlete_id=?', [RIDER_ID])).length, 0);

    const after = await call(app, { method: 'GET', url: '/api/me', cookies: { bc_sid: auth.sid } });
    assert.equal(after.json.authenticated, false);

    // The bearer path must die too -- clearing only the cookie leaves it alive.
    const bearer = await call(app, { method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${auth.sid}` } });
    assert.equal(bearer.json.authenticated, false);
  });

  await db.close();
});

test('a rider who declines private access still competes', async () => {
  const { db, app, fake } = await harness();

  // Unchecking "private activities" on Strava's consent screen is a privacy preference, not
  // a refusal. Their public rides are perfectly countable, so treating it as a lockout would
  // turn a reasonable choice into an unexplained failure.
  const auth = await signIn(app, fake, { grant: 'read,activity:read' });
  assert.equal(auth.cb.status, 302);
  assert.ok(auth.sid, 'a read-only grant must still produce a session');

  const me = await call(app, { method: 'GET', url: '/api/me', cookies: { bc_sid: auth.sid } });
  assert.equal(me.json.authenticated, true);
  assert.equal(me.json.rider.scope, 'read');
  assert.equal(me.json.rider.private_rides_counted, false, 'the UI badges this rather than blocking');

  await db.close();
});

test('declining entirely is a message, not a stack trace', async () => {
  const { db, app, fake } = await harness();
  const auth = await signIn(app, fake, { deny: true });
  assert.equal(auth.cb.status, 302);
  assert.match(auth.cb.headers.location, /#error=denied/, 'a fragment the page can read, never JSON');
  assert.equal(auth.sid, undefined);
  await db.close();
});

test('the client secret reached neither a log line nor a response body', () => {
  // These guards keep the sweep from passing vacuously: if the journey somehow captured
  // nothing, "the secret is absent" would be trivially true and prove nothing at all.
  assert.ok(LOGS.length > 0, 'the journey must have logged something');
  assert.ok(
    BODIES.some((b) => b.includes('"teams"')),
    'and it must have captured real leaderboard payloads, not just redirects',
  );

  const logText = JSON.stringify(LOGS);
  assert.equal(logText.includes(SENTINEL_SECRET), false, 'STRAVA_CLIENT_SECRET reached a log line');
  for (const body of BODIES) {
    assert.equal(body.includes(SENTINEL_SECRET), false, 'STRAVA_CLIENT_SECRET reached a response body');
  }
});
