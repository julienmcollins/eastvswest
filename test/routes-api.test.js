import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildApp } from '../server/app.js';
import { buildRoutes } from '../server/routes/index.js';
import { createStravaClient } from '../server/strava/client.js';
import { listSessionsForAthlete } from '../server/db/sessions.js';
import { getAthlete } from '../server/db/athletes.js';
import { getSyncState } from '../server/db/syncState.js';
import { API_SCHEMA } from '../server/contracts.js';
import { setLogSink } from '../server/lib/log.js';
import { _resetSingleFlightForTests } from '../server/strava/tokenService.js';

import { injectRequest } from './helpers/inject.js';
import { createFakeStrava } from './helpers/fakeStrava.js';
import { freshDb, seedAthlete, testConfig, SENTINEL_SECRET } from './helpers/testDb.js';

/**
 * The JSON API: /api/me, /api/me/team, /api/me/sync, /api/leaderboard, /api/admin/*.
 *
 * Everything runs against a :memory: database and the in-process Strava double, through
 * injectRequest -- no sockets, because listen() is EPERM in this sandbox.
 */

/** See the note in routes-auth.test.js: the whole activity fixture must be in the past. */
const NOW_MS = Date.parse('2026-08-31T12:00:00Z');
const ORIGIN = 'http://localhost:3000';

/** The fake's default athlete, i.e. whoever completes the OAuth flow in these tests. */
const RIDER_ID = 12345678;

/** Hand-computed in the fixture generator: 210 counted records, 360493.056 m. */
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/activities.json', import.meta.url), 'utf8'));

const LOG_RECORDS = [];
const RESPONSE_BODIES = [];

setLogSink((record) => LOG_RECORDS.push(record));
test.after(() => setLogSink(null));

async function harness({ configOverrides = {}, nowMs = NOW_MS } = {}) {
  _resetSingleFlightForTests();

  const db = await freshDb();
  const config = testConfig(configOverrides);
  const fake = createFakeStrava({ clientSecret: SENTINEL_SECRET, now: () => nowMs });
  const strava = createStravaClient({
    apiBase: config.stravaApiBase,
    oauthBase: config.stravaOauthBase,
    clientId: config.stravaClientId,
    clientSecret: config.stravaClientSecret,
    redirectUri: config.redirectUri,
    fetchImpl: fake.fetchImpl,
    now: () => nowMs,
    minRequestSpacingMs: 0,
    retryBaseMs: 1,
  });
  const routes = buildRoutes({ config, db, strava, now: () => nowMs });
  const app = buildApp({ config, db, routes });
  return { db, config, fake, strava, app };
}

async function call(app, opts) {
  const res = await injectRequest(app, opts);
  RESPONSE_BODIES.push(res.body);
  return res;
}

/** Complete the OAuth flow and return the credentials a browser would then hold. */
async function signIn(app, fake) {
  const login = await call(app, { method: 'GET', url: '/api/auth/strava/login' });
  const consent = await fake.fetchImpl(new URL(login.headers.location).toString());
  const back = new URL(consent.headers.get('location'));
  const callback = await call(app, {
    method: 'GET',
    url: `${back.pathname}${back.search}`,
    cookies: { bc_oauth: login.cookies.bc_oauth },
  });
  assert.equal(callback.status, 302, 'sign-in must succeed for the rest of the test to mean anything');
  return { sid: callback.cookies.bc_sid, csrf: callback.cookies.bc_csrf };
}

/** A correctly-formed mutating request: JSON body, allowlisted Origin, double-submit token. */
function post(app, url, body, auth, { headers = {}, cookies = {} } = {}) {
  return call(app, {
    method: 'POST',
    url,
    body,
    headers: { origin: ORIGIN, 'x-csrf-token': auth.csrf, ...headers },
    cookies: { bc_sid: auth.sid, bc_csrf: auth.csrf, ...cookies },
  });
}

// ---------------------------------------------------------------- /api/me

test('GET /api/me is 200 with rider:null when logged out -- never 401', async () => {
  const { app } = await harness();

  const res = await call(app, { method: 'GET', url: '/api/me' });

  // A 401 here would make the ordinary anonymous visit look like an error to every caller.
  assert.equal(res.status, 200);
  assert.equal(res.json.authenticated, false);
  assert.equal(res.json.rider, null);
  assert.equal(res.json.schema, API_SCHEMA);
  // The competition block is a season-level fact and is present for anonymous callers too.
  assert.equal(res.json.competition.start, '2026-06-01');
  assert.equal(res.json.competition.end, '2026-08-31');
  assert.equal(res.json.competition.state, 'open');
  assert.equal(res.json.competition.timezone, 'UTC');
  assert.equal(typeof res.json.server_time, 'string');
  // Credential-dependent, so it must never be cached or shared.
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.vary, 'Origin, Authorization, Cookie');
});

test('GET /api/me for a freshly connected rider reports needs_team', async () => {
  const { app, fake } = await harness();
  const auth = await signIn(app, fake);

  const res = await call(app, { method: 'GET', url: '/api/me', cookies: { bc_sid: auth.sid } });

  assert.equal(res.status, 200);
  assert.equal(res.json.authenticated, true);
  assert.equal(res.json.rider.athlete_id, RIDER_ID);
  assert.equal(res.json.rider.team, null);
  // The ONE authoritative trigger for the mandatory picker.
  assert.equal(res.json.rider.needs_team, true);
  assert.equal(res.json.rider.is_admin, false);
  assert.equal(res.json.rider.scope, 'read_all');
  assert.equal(res.json.rider.private_rides_counted, true);
  assert.equal(res.json.rider.revoked, false);
  assert.equal(res.json.rider.last_synced_at, null);
  assert.equal(res.json.rider.profile_url, `https://www.strava.com/athletes/${RIDER_ID}`);
  // Absolute https: or null, never Strava's bare relative string.
  assert.match(res.json.rider.avatar_url, /^https:\/\//);
});

test('a Bearer token resolves the same session as the cookie', async () => {
  const { app, fake } = await harness();
  const auth = await signIn(app, fake);

  const res = await call(app, {
    method: 'GET',
    url: '/api/me',
    headers: { authorization: `Bearer ${auth.sid}` },
  });

  assert.equal(res.json.authenticated, true);
  assert.equal(res.json.rider.athlete_id, RIDER_ID);
});

// ---------------------------------------------------------------- team claim

test('POST /api/me/team claims once, is idempotent for the same team, and 409s for another', async () => {
  const { app, fake, db } = await harness();
  const auth = await signIn(app, fake);

  const first = await post(app, '/api/me/team', { team: 'EAST' }, auth);
  assert.equal(first.status, 200);
  assert.equal(first.json.team, 'EAST');
  assert.equal(first.json.rider.needs_team, false);

  // The double-click. Must NOT be an error: the rider did exactly what they were asked to.
  const again = await post(app, '/api/me/team', { team: 'EAST' }, auth);
  assert.equal(again.status, 200);
  assert.equal(again.json.team, 'EAST');

  const switched = await post(app, '/api/me/team', { team: 'WEST' }, auth);
  assert.equal(switched.status, 409);
  assert.equal(switched.json.error, 'team_already_set');
  // The CURRENT team comes back so the client can correct itself rather than guess.
  assert.equal(switched.json.team, 'EAST');

  assert.equal((await getAthlete(db, RIDER_ID)).team, 'EAST');
});

test('two concurrent POSTs for different teams produce exactly one 200 and one 409', async () => {
  const { app, fake } = await harness();
  const auth = await signIn(app, fake);

  const [a, b] = await Promise.all([
    post(app, '/api/me/team', { team: 'EAST' }, auth),
    post(app, '/api/me/team', { team: 'WEST' }, auth),
  ]);

  // The atomic `UPDATE ... WHERE team IS NULL RETURNING team` is what makes this deterministic;
  // a read-then-write lets both callers win and the second write silently reassigns the rider.
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test('POST /api/me/team rejects a bogus team and requires a session', async () => {
  const { app, fake } = await harness();
  const auth = await signIn(app, fake);

  const bad = await post(app, '/api/me/team', { team: 'NORTH' }, auth);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_team');

  const anon = await call(app, {
    method: 'POST',
    url: '/api/me/team',
    body: { team: 'EAST' },
    headers: { origin: ORIGIN, 'x-csrf-token': auth.csrf },
    cookies: { bc_csrf: auth.csrf },
  });
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error, 'unauthenticated');
});

// ---------------------------------------------------------------- CSRF

test('a mutating request without X-CSRF-Token, from a foreign Origin, or as text/plain is refused', async () => {
  const { app, fake, db } = await harness();
  const auth = await signIn(app, fake);

  const noToken = await call(app, {
    method: 'POST',
    url: '/api/me/team',
    body: { team: 'EAST' },
    headers: { origin: ORIGIN },
    cookies: { bc_sid: auth.sid, bc_csrf: auth.csrf },
  });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.json.error, 'csrf_failed');

  const foreignOrigin = await post(app, '/api/me/team', { team: 'EAST' }, auth, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.json.error, 'csrf_failed');

  // A cross-site <form> can only produce urlencoded/multipart/text-plain, so requiring JSON
  // kills the entire no-script CSRF class on its own.
  const wrongType = await post(app, '/api/me/team', JSON.stringify({ team: 'EAST' }), auth, {
    headers: { 'content-type': 'text/plain' },
  });
  assert.ok(wrongType.status === 403 || wrongType.status === 415, `got ${wrongType.status}`);

  // A mismatched double-submit token is refused even with a valid session and Origin.
  const mismatch = await post(app, '/api/me/team', { team: 'EAST' }, auth, {
    headers: { 'x-csrf-token': 'not-the-cookie-value' },
  });
  assert.equal(mismatch.status, 403);

  // None of the four got through.
  assert.equal((await getAthlete(db, RIDER_ID)).team, null);
});

// ---------------------------------------------------------------- sync

test('POST /api/me/sync stores the fixture and embeds the whole leaderboard', async () => {
  const { app, fake, db } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);
  // A teamed rider with no rides at all: the zero-mile case that must survive to the wire.
  await seedAthlete(db, { id: 44444444, name: 'Priya R', team: 'WEST' });

  const res = await post(app, '/api/me/sync', {}, auth);

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  // No prior sync state, so the auto mode resolves to a full rescan.
  assert.equal(res.json.mode, 'full');
  assert.equal(res.json.activities_scanned, FIXTURE.expected.total_records);
  assert.equal(res.json.activities_counted, FIXTURE.expected.counted_records);
  assert.equal(res.json.activities_added, FIXTURE.expected.total_records);
  assert.equal(res.json.activities_removed, 0);
  // 216 records at per_page=200: one full page plus a short one, which is the only
  // termination signal Strava gives.
  assert.equal(res.json.pages_fetched, 2);
  assert.equal(res.json.truncated, false);

  // The embedded leaderboard is what makes Refresh one round trip.
  const lb = res.json.leaderboard;
  assert.equal(lb.schema, API_SCHEMA);
  assert.equal(res.json.miles, FIXTURE.expected.counted_miles);

  const east = lb.teams.find((t) => t.team === 'EAST');
  assert.equal(east.miles, FIXTURE.expected.counted_miles, 'EAST must total the fixture constant');
  assert.equal(east.ride_count, FIXTURE.expected.counted_records);

  // Every excluded fixture id must be absent from the totals but PRESENT in the table -- we
  // store everything and filter at query time.
  const stored = await db.get('SELECT COUNT(*) AS n FROM activities WHERE athlete_id = ?', [RIDER_ID]);
  assert.equal(Number(stored.n), FIXTURE.expected.total_records);
  for (const id of FIXTURE.expected.excluded_ids) {
    const row = await db.get('SELECT strava_activity_id FROM activities WHERE strava_activity_id = ?', [id]);
    assert.ok(row, `excluded fixture ${id} must still be stored`);
  }

  // The UTC+13 edge ride scores on its LOCAL date, which is inside the window even though its
  // UTC date is not.
  const auckland = await db.get('SELECT local_date FROM activities WHERE strava_activity_id = ?', [15000000012]);
  assert.equal(auckland.local_date, '2026-06-01');

  // `timezone`/`type` absent in the fixture must land as SQL NULLs, not as `undefined`.
  const nulls = await db.get('SELECT timezone, legacy_type FROM activities WHERE strava_activity_id = ?', [15000000015]);
  assert.equal(nulls.timezone, null);
  assert.equal(nulls.legacy_type, null);

  assert.equal(fake.unexpected.length, 0, 'the fake must have received no unexpected calls');

  const state = await getSyncState(db, RIDER_ID);
  assert.equal(state.last_status, 'ok');
  assert.equal(state.truncated, 0);
});

test('the embedded leaderboard is byte-identical to a fresh GET /api/leaderboard', async () => {
  const { app, fake } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);

  const sync = await post(app, '/api/me/sync', {}, auth);
  const fresh = await call(app, { method: 'GET', url: '/api/leaderboard', cookies: { bc_sid: auth.sid } });

  // Embedding it is only worth doing if it is genuinely the same object: any drift and the
  // board flickers between the sync response and the next poll.
  assert.deepEqual(sync.json.leaderboard, fresh.json);
});

test('an immediate second sync is 429 with retry_after_seconds and a Retry-After header', async () => {
  const { app, fake } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);

  assert.equal((await post(app, '/api/me/sync', {}, auth)).status, 200);

  const second = await post(app, '/api/me/sync', {}, auth);

  assert.equal(second.status, 429);
  assert.equal(second.json.error, 'rate_limited');
  // 'local' is our own 60 s per-athlete cooldown, not something Strava said.
  assert.equal(second.json.scope, 'local');
  assert.equal(Number.isInteger(second.json.retry_after_seconds), true);
  assert.ok(second.json.retry_after_seconds > 0);
  assert.equal(second.headers['retry-after'], String(second.json.retry_after_seconds));
  // Retry-After is not CORS-safelisted, so cross-origin JS cannot read it without this.
  assert.match(String(second.headers['access-control-expose-headers']), /Retry-After/);
});

test('POST /api/me/sync rejects a bogus mode and requires a session', async () => {
  const { app, fake } = await harness();
  const auth = await signIn(app, fake);

  const bad = await post(app, '/api/me/sync', { mode: 'sideways' }, auth);
  assert.equal(bad.status, 400);

  const anon = await call(app, {
    method: 'POST',
    url: '/api/me/sync',
    body: {},
    headers: { origin: ORIGIN, 'x-csrf-token': auth.csrf },
    cookies: { bc_csrf: auth.csrf },
  });
  assert.equal(anon.status, 401);
});

test('a downgraded scope makes sync 403 insufficient_scope with a reauth_url', async () => {
  const { app, fake, db } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);

  // Only reachable for a rider whose grant was recorded and later narrowed at Strava, which
  // is exactly why the check lives in sync rather than only in the callback.
  await db.run('UPDATE athletes SET granted_scope = ? WHERE strava_athlete_id = ?', ['read', RIDER_ID]);

  const res = await post(app, '/api/me/sync', {}, auth);
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'insufficient_scope');
  assert.match(res.json.reauth_url, /\/api\/auth\/strava\/reconnect$/);
  // Refused before a single request was spent on an account whose rides cannot be read.
  assert.equal(fake.requests.some((r) => r.pathname.endsWith('/athlete')), false);
});

test('an upstream Strava outage is 502 strava_unavailable, not 500', async () => {
  const { app, fake } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);

  // Enough 500s to exhaust the client's two GET retries.
  fake.queue500(4);

  const res = await post(app, '/api/me/sync', {}, auth);
  // 502, because the failure is upstream: the distinction is what tells whoever reads the log
  // whether to look at this codebase or at Strava's status page.
  assert.equal(res.status, 502);
  assert.equal(res.json.error, 'strava_unavailable');
});

test('a revoked grant makes sync 403 strava_revoked with a reauth_url', async () => {
  const { app, fake, db } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);

  fake.revokeAthlete();

  const res = await post(app, '/api/me/sync', {}, auth);
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'strava_revoked');
  assert.match(res.json.reauth_url, /\/api\/auth\/strava\/reconnect$/);

  // The row, the team, and the history all survive: the rider's total freezes rather than
  // vanishing mid-competition and taking their team's miles with it.
  const athlete = await getAthlete(db, RIDER_ID);
  assert.ok(athlete);
  assert.equal(athlete.team, 'EAST');
  assert.notEqual(athlete.strava_revoked_at, null);
});

// ---------------------------------------------------------------- leaderboard

test('GET /api/leaderboard keeps a zero-mile team and zero-mile riders on the board', async () => {
  const { app, fake, db } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);
  await seedAthlete(db, { id: 44444444, name: 'Priya R', team: 'WEST' });
  // A rider who never picked a team is excluded entirely -- their miles belong to no column.
  await seedAthlete(db, { id: 55555555, name: 'No Team', team: null });
  await post(app, '/api/me/sync', {}, auth);

  const res = await call(app, { method: 'GET', url: '/api/leaderboard', cookies: { bc_sid: auth.sid } });

  assert.equal(res.status, 200);
  const lb = res.json;

  // Exactly two teams, in fixed EAST-then-WEST order regardless of who is winning.
  assert.equal(lb.teams.length, 2);
  assert.equal(lb.teams[0].team, 'EAST');
  assert.equal(lb.teams[1].team, 'WEST');
  assert.equal(lb.teams[0].miles, FIXTURE.expected.counted_miles);
  // WEST has a member and no rides. A WHERE on the joined table would have deleted this row.
  assert.equal(lb.teams[1].miles, 0);
  assert.equal(lb.teams[1].rider_count, 1);
  // share is precomputed so the client never divides.
  assert.equal(lb.teams[0].share + lb.teams[1].share, 1);

  assert.equal(lb.leader.team, 'EAST');
  assert.ok(lb.leader.margin_miles >= 0);

  const me = lb.riders.find((r) => r.athlete_id === RIDER_ID);
  assert.equal(me.rank, 1);
  assert.equal(me.is_you, true);
  assert.equal(me.miles, FIXTURE.expected.counted_miles);

  const zero = lb.riders.find((r) => r.athlete_id === 44444444);
  assert.equal(zero.miles, 0);
  // rank null, rendered as an em-dash. A number here would be signup order dressed up as a
  // ranking, and zero-mile ties are the common case on day one.
  assert.equal(zero.rank, null);
  assert.equal(zero.last_synced_at, null);

  assert.equal(lb.riders.some((r) => r.athlete_id === 55555555), false);

  // Logged out: same board, nobody is `is_you`.
  const anon = await call(app, { method: 'GET', url: '/api/leaderboard' });
  assert.equal(anon.status, 200);
  assert.equal(anon.json.riders.every((r) => r.is_you === false), true);
});

test('?start/?end narrow the window but cannot widen it past the competition', async () => {
  const { app, fake } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);
  await post(app, '/api/me/sync', {}, auth);

  // A hand-edited all-time range must not turn the board into a lifetime ranking won by
  // whoever has the longest Strava history.
  const wide = await call(app, { method: 'GET', url: '/api/leaderboard?start=2000-01-01&end=2099-12-31' });
  assert.equal(wide.json.teams[0].miles, FIXTURE.expected.counted_miles);

  const narrow = await call(app, { method: 'GET', url: '/api/leaderboard?start=2026-07-01&end=2026-07-01' });
  assert.ok(narrow.json.teams[0].miles < FIXTURE.expected.counted_miles);
});

test('GET /api/riders/:id/activities requires a session and carries no location data', async () => {
  const { app, fake } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);
  await post(app, '/api/me/sync', {}, auth);

  const anon = await call(app, { method: 'GET', url: `/api/riders/${RIDER_ID}/activities` });
  assert.equal(anon.status, 401);

  const res = await call(app, {
    method: 'GET',
    url: `/api/riders/${RIDER_ID}/activities`,
    cookies: { bc_sid: auth.sid },
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.activities.length > 0);

  const row = res.json.activities[0];
  assert.equal(typeof row.miles, 'number');
  assert.match(row.strava_url, /^https:\/\/www\.strava\.com\/activities\/\d+$/);
  // We never store lat/lng or polylines, so there is nothing here to leak.
  for (const forbidden of ['start_latlng', 'end_latlng', 'map', 'polyline', 'summary_polyline']) {
    assert.equal(Object.hasOwn(row, forbidden), false, `${forbidden} must not be in the payload`);
  }
  assert.equal(res.body.includes('polyline'), false);

  // `counted` comes from the same SQL predicate as the totals, so the list agrees with them.
  const counted = res.json.activities.filter((a) => a.counted).length;
  assert.equal(counted, FIXTURE.expected.counted_records);

  const missing = await call(app, { method: 'GET', url: '/api/riders/98765/activities', cookies: { bc_sid: auth.sid } });
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------- disconnect

test('POST /api/me/disconnect drops the tokens and the session but keeps the rider', async () => {
  const { app, fake, db } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);
  await post(app, '/api/me/sync', {}, auth);

  const res = await post(app, '/api/me/disconnect', {}, auth);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);

  assert.equal(await db.get('SELECT 1 AS x FROM oauth_tokens WHERE athlete_id = ?', [RIDER_ID]), undefined);
  assert.equal((await listSessionsForAthlete(db, RIDER_ID)).length, 0);

  // Row, team, and every activity survive: deleting them would silently rewrite the standings.
  const athlete = await getAthlete(db, RIDER_ID);
  assert.equal(athlete.team, 'EAST');
  const rides = await db.get('SELECT COUNT(*) AS n FROM activities WHERE athlete_id = ?', [RIDER_ID]);
  assert.equal(Number(rides.n), FIXTURE.expected.total_records);

  // A second disconnect still succeeds -- Strava's 401 for an already-revoked grant is the
  // desired end state, not an error.
  const twice = await post(app, '/api/me/disconnect', {}, auth, { cookies: { bc_sid: auth.sid } });
  assert.ok(twice.status === 200 || twice.status === 401, `got ${twice.status}`);
});

test('DELETE /api/me?purge=1 removes the rider and everything cascaded from them', async () => {
  const { app, fake, db } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);
  await post(app, '/api/me/sync', {}, auth);

  const res = await call(app, {
    method: 'DELETE',
    url: '/api/me?purge=1',
    // Mutating, so the full CSRF triple is required -- including the JSON content type on a
    // request that has no body.
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-csrf-token': auth.csrf },
    cookies: { bc_sid: auth.sid, bc_csrf: auth.csrf },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.purged, true);
  assert.equal(res.json.activities_deleted, FIXTURE.expected.total_records);

  // The row is gone, and ON DELETE CASCADE took the tokens, sessions, and sync state with it
  // -- which only works because PRAGMA foreign_keys is asserted ON in openDatabase().
  assert.equal(await getAthlete(db, RIDER_ID), undefined);
  for (const table of ['activities', 'oauth_tokens', 'sessions', 'sync_state']) {
    const row = await db.get(`SELECT COUNT(*) AS n FROM ${table}`);
    assert.equal(Number(row.n), 0, `${table} must be empty`);
  }
});

test('DELETE /api/me without purge behaves like disconnect and keeps the history', async () => {
  const { app, fake, db } = await harness();
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);
  await post(app, '/api/me/sync', {}, auth);

  const res = await call(app, {
    method: 'DELETE',
    url: '/api/me',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-csrf-token': auth.csrf },
    cookies: { bc_sid: auth.sid, bc_csrf: auth.csrf },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.purged, false);
  assert.equal(res.json.activities_deleted, 0);
  // A mis-typed fetch must not be able to erase a season.
  assert.ok(await getAthlete(db, RIDER_ID));
  const rides = await db.get('SELECT COUNT(*) AS n FROM activities');
  assert.equal(Number(rides.n), FIXTURE.expected.total_records);
});

// ---------------------------------------------------------------- admin

test('a non-admin is 403 on every /api/admin route and on /api/health/strava', async () => {
  const { app, fake } = await harness();
  const auth = await signIn(app, fake);

  const list = await call(app, { method: 'GET', url: '/api/admin/athletes', cookies: { bc_sid: auth.sid } });
  assert.equal(list.status, 403);
  assert.equal(list.json.error, 'forbidden');

  const team = await post(app, `/api/admin/athletes/${RIDER_ID}/team`, { team: 'WEST' }, auth);
  assert.equal(team.status, 403);

  const admin = await post(app, `/api/admin/athletes/${RIDER_ID}/admin`, { is_admin: true }, auth);
  assert.equal(admin.status, 403);

  const approve = await post(app, '/api/admin/activities/15000000014/approve', { approved: true }, auth);
  assert.equal(approve.status, 403);

  const health = await call(app, { method: 'GET', url: '/api/health/strava', cookies: { bc_sid: auth.sid } });
  assert.equal(health.status, 403);

  // Anonymous gets 401, not 403: the credential is missing rather than insufficient, and the
  // client opens the Connect flow for one and shows an error for the other.
  const anon = await call(app, { method: 'GET', url: '/api/admin/athletes' });
  assert.equal(anon.status, 401);
});

test('an admin can list athletes, move a rider, flip admin, and approve a manual ride', async () => {
  const { app, fake, db } = await harness({ configOverrides: { ADMIN_BOOTSTRAP_ATHLETE_IDS: String(RIDER_ID) } });
  const auth = await signIn(app, fake);
  await post(app, '/api/me/team', { team: 'EAST' }, auth);
  await post(app, '/api/me/sync', {}, auth);

  const list = await call(app, { method: 'GET', url: '/api/admin/athletes', cookies: { bc_sid: auth.sid } });
  assert.equal(list.status, 200);
  const row = list.json.athletes.find((a) => a.athlete_id === RIDER_ID);
  assert.equal(row.is_admin, true);
  assert.equal(row.team, 'EAST');
  // The manual fixture ride is waiting in the approval queue rather than silently counting.
  assert.equal(row.pending_manual, 1);
  assert.equal(typeof row.last_synced_at, 'string');

  // Approving it makes it count, which is the whole point of the queue.
  const before = (await call(app, { method: 'GET', url: '/api/leaderboard' })).json.teams[0].miles;
  const approve = await post(app, '/api/admin/activities/15000000014/approve', { approved: true }, auth);
  assert.equal(approve.status, 200);
  assert.equal(approve.json.is_manual, true);
  const after = (await call(app, { method: 'GET', url: '/api/leaderboard' })).json.teams[0].miles;
  assert.ok(after > before, 'an approved manual ride must start counting');

  // An admin team change drops that athlete's sessions so the privilege/state change cannot
  // linger in a live session.
  await seedAthlete(db, { id: 44444444, name: 'Priya R', team: 'WEST' });
  const moved = await post(app, '/api/admin/athletes/44444444/team', { team: 'EAST' }, auth);
  assert.equal(moved.status, 200);
  assert.equal((await getAthlete(db, 44444444)).team, 'EAST');

  const notFound = await post(app, '/api/admin/athletes/999/team', { team: 'EAST' }, auth);
  assert.equal(notFound.status, 404);

  const badTeam = await post(app, '/api/admin/athletes/44444444/team', { team: 'NORTH' }, auth);
  assert.equal(badTeam.status, 400);

  // Self-demotion drops our own sessions, which is exactly what "privilege changes must not
  // linger" means -- the next request with the old cookie is anonymous.
  const demote = await post(app, `/api/admin/athletes/${RIDER_ID}/admin`, { is_admin: false }, auth);
  assert.equal(demote.status, 200);
  assert.equal(Number((await getAthlete(db, RIDER_ID)).is_admin), 0);
  const afterDemote = await call(app, { method: 'GET', url: '/api/me', cookies: { bc_sid: auth.sid } });
  assert.equal(afterDemote.json.authenticated, false);
});

test('GET /api/health/strava is admin-only and carries no token', async () => {
  const { app, fake } = await harness({ configOverrides: { ADMIN_BOOTSTRAP_ATHLETE_IDS: String(RIDER_ID) } });
  const auth = await signIn(app, fake);

  const res = await call(app, { method: 'GET', url: '/api/health/strava', cookies: { bc_sid: auth.sid } });

  assert.equal(res.status, 200);
  assert.equal(typeof res.json.rateLimit.shortLimit, 'number');
  assert.deepEqual(res.json.scope, ['read', 'activity:read_all']);
  // Not a single credential anywhere in the body -- not the client secret, not the access
  // token, not the refresh token, not the session id.
  for (const secret of [SENTINEL_SECRET, fake.tokens.accessToken, fake.tokens.refreshToken, auth.sid, auth.csrf]) {
    assert.equal(res.body.includes(secret), false, `health/strava leaked ${secret}`);
  }
  assert.equal(/token/i.test(res.body), false);
});

// ---------------------------------------------------------------- plumbing

test('GET /api/health needs no credential', async () => {
  const { app } = await harness();
  const res = await call(app, { method: 'GET', url: '/api/health' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.schema, API_SCHEMA);
});

test('an unknown /api/* path is a JSON 404, never HTML', async () => {
  const { app } = await harness();

  const res = await call(app, { method: 'GET', url: '/api/nonexistent' });

  assert.equal(res.status, 404);
  // An HTML 404 here surfaces in the browser as "Unexpected token '<'", which points at the
  // JSON parser instead of at the typo in the URL.
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.json.error, 'not_found');
});

test('a known path under the wrong method is 405 with an accurate Allow header', async () => {
  const { app } = await harness();
  const res = await call(app, { method: 'PUT', url: '/api/me/team' });
  assert.equal(res.status, 405);
  assert.match(String(res.headers.allow), /POST/);
});

// ---------------------------------------------------------------- the secret

test('the sentinel client secret appears in no log record and no response body', () => {
  assert.ok(LOG_RECORDS.length > 0, 'the run must have produced log records for this to prove anything');
  assert.ok(RESPONSE_BODIES.length > 0);

  const logs = JSON.stringify(LOG_RECORDS);
  assert.equal(logs.includes(SENTINEL_SECRET), false, 'STRAVA_CLIENT_SECRET reached a log line');
  for (const body of RESPONSE_BODIES) {
    assert.equal(body.includes(SENTINEL_SECRET), false, 'STRAVA_CLIENT_SECRET reached a response body');
  }
});
