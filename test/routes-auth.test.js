import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../server/app.js';
import { buildRoutes } from '../server/routes/index.js';
import { createStravaClient } from '../server/strava/client.js';
import { countStates } from '../server/db/oauthStates.js';
import { getAthlete } from '../server/db/athletes.js';
import { listSessionsForAthlete } from '../server/db/sessions.js';
import { loadTokens } from '../server/db/tokens.js';
import { setLogSink } from '../server/lib/log.js';
import { _resetSingleFlightForTests } from '../server/strava/tokenService.js';

import { attrOf, injectRequest } from './helpers/inject.js';
import { createFakeStrava } from './helpers/fakeStrava.js';
import { freshDb, seedAthlete, seedSession, testConfig, SENTINEL_SECRET } from './helpers/testDb.js';

/**
 * The OAuth surface, driven entirely through injectRequest and the in-process Strava double.
 *
 * No sockets anywhere: `listen(0,'127.0.0.1')` is EPERM in this sandbox, so the browser leg is
 * simulated by calling the fake's `fetchImpl` on the authorize URL we were redirected to and
 * following the Location it hands back -- which is exactly what a browser does.
 */

/**
 * A fixed clock, inside the competition window and late enough that the whole activity
 * fixture is in the past.
 *
 * This is why buildRoutes takes `now`. `computeSyncMonths` clamps the fetch to
 * `min(now, COMPETITION_END)`, so with the real clock the fixture's August rides are in the
 * future and every mileage assertion in this suite would depend on the day it was run.
 */
const NOW_MS = Date.parse('2026-08-31T12:00:00Z');

/** Must be in config.corsAllowedOrigins or every mutating request is a 403 by design. */
const ORIGIN = 'http://localhost:3000';

/** Every log record produced by this file, for the "no secret is ever logged" assertion. */
const LOG_RECORDS = [];
/** Every response body, for the same assertion on the wire side. */
const RESPONSE_BODIES = [];

setLogSink((record) => LOG_RECORDS.push(record));
test.after(() => setLogSink(null));

async function harness({ configOverrides = {}, nowMs = NOW_MS, db = null } = {}) {
  // The token refresh single-flight map is module-global by design (it is an in-process
  // mutex). Left over from a previous test it would make the second harness reuse the first
  // one's in-flight promise.
  _resetSingleFlightForTests();

  const database = db ?? (await freshDb());
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
    // The spacer and the backoff exist to be gentle to Strava; against a fake they are only
    // wall-clock time.
    minRequestSpacingMs: 0,
    retryBaseMs: 1,
  });
  const routes = buildRoutes({ config, db: database, strava, now: () => nowMs });
  const app = buildApp({ config, db: database, routes });
  return { db: database, config, fake, strava, app };
}

/** injectRequest, recording the body so the secret-leak assertion sees every response. */
async function call(app, opts) {
  const res = await injectRequest(app, opts);
  RESPONSE_BODIES.push(res.body);
  return res;
}

/**
 * Walk the whole OAuth flow: /login -> Strava's authorize -> our callback.
 *
 * @param {{grant?:string, deny?:boolean, cookies?:object, returnTo?:string}} opts
 *   `grant` is the fake's consent knob: 'read' means the rider unchecked private activities,
 *   '' means they unchecked every optional scope.
 */
async function connect(app, fake, { grant, deny = false, cookies = {}, returnTo } = {}) {
  const url = returnTo === undefined
    ? '/api/auth/strava/login'
    : `/api/auth/strava/login?return_to=${encodeURIComponent(returnTo)}`;

  const login = await call(app, { method: 'GET', url });
  const authorize = new URL(login.headers.location);
  if (grant !== undefined) authorize.searchParams.set('grant', grant);
  if (deny) authorize.searchParams.set('deny', '1');

  // The browser's leg. The fake answers authorize with a 302 back to our redirect_uri.
  const consent = await fake.fetchImpl(authorize.toString());
  const back = new URL(consent.headers.get('location'));
  const target = `${back.pathname}${back.search}`;

  const callback = await call(app, {
    method: 'GET',
    url: target,
    cookies: { bc_oauth: login.cookies.bc_oauth, ...cookies },
  });

  return { login, callback, target, nonce: login.cookies.bc_oauth };
}

/** The Set-Cookie line for one cookie name, or undefined. */
function cookieLine(res, name) {
  return res.setCookie.find((line) => line.startsWith(`${name}=`));
}

// ---------------------------------------------------------------- login

test('GET /api/auth/strava/login redirects to Strava, sets bc_oauth, and writes one state row', async () => {
  const { app, db, config } = await harness();

  const res = await call(app, { method: 'GET', url: '/api/auth/strava/login' });

  assert.equal(res.status, 302);
  const location = new URL(res.headers.location);
  assert.equal(location.origin + location.pathname, `${config.stravaOauthBase}/authorize`);
  // The state must be IN THE QUERY: it is the only thing Strava echoes back, and without it
  // the callback has nothing to verify.
  assert.match(location.searchParams.get('state') ?? '', /^[\w-]+\.[\w-]+$/);
  assert.equal(location.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(location.searchParams.get('approval_prompt'), 'auto');

  const oauth = cookieLine(res, 'bc_oauth');
  assert.ok(oauth, 'bc_oauth must be set');
  // HttpOnly: the nonce is the browser-binding secret and page script has no business
  // reading it. Path narrows it off every leaderboard poll.
  assert.match(oauth, /HttpOnly/);
  assert.match(oauth, /SameSite=Lax/);
  assert.equal(attrOf(oauth, 'Path'), '/api/auth');
  assert.equal(attrOf(oauth, 'Max-Age'), '600');

  // no-store so a link prefetcher cannot silently burn states.
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(await countStates(db), 1);
});

test('GET /api/auth/strava/reconnect asks for a fresh consent screen', async () => {
  const { app } = await harness();
  const res = await call(app, { method: 'GET', url: '/api/auth/strava/reconnect' });
  // approval_prompt=force, or an athlete who revoked us in Strava's settings is bounced
  // straight back with the dead grant and "Reconnect" appears to do nothing.
  assert.equal(new URL(res.headers.location).searchParams.get('approval_prompt'), 'force');
});

// ---------------------------------------------------------------- callback, happy path

test('the callback issues a session, sets both cookies, and clears bc_oauth', async () => {
  const { app, db, fake, config } = await harness();

  const { callback } = await connect(app, fake);

  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, `${config.webOrigin}/`);

  const sid = cookieLine(callback, 'bc_sid');
  assert.ok(sid, 'bc_sid must be set');
  assert.match(sid, /HttpOnly/);
  // Lax, never Strict: Strict withholds the cookie on the OAuth callback navigation itself.
  assert.match(sid, /SameSite=Lax/);
  assert.equal(attrOf(sid, 'Path'), '/');

  const csrf = cookieLine(callback, 'bc_csrf');
  assert.ok(csrf, 'bc_csrf must be set');
  // Readable by JS BY DESIGN -- the double-submit pattern needs page script to echo it.
  assert.equal(/HttpOnly/.test(csrf), false);

  // Cleared on the success path too, not just on failures.
  assert.equal(attrOf(cookieLine(callback, 'bc_oauth'), 'Max-Age'), '0');

  // The state was consumed, so nothing is left to replay.
  assert.equal(await countStates(db), 0);
  const sessions = await listSessionsForAthlete(db, fake.athlete.id);
  assert.equal(sessions.length, 1);

  // The tokens are sealed, and they decrypt to what the fake issued.
  const tokens = await loadTokens(db, config, fake.athlete.id);
  assert.equal(tokens.accessToken, fake.tokens.accessToken);
  assert.equal(tokens.refreshToken, fake.tokens.refreshToken);
  const raw = await db.get('SELECT access_token_enc FROM oauth_tokens WHERE athlete_id = ?', [fake.athlete.id]);
  assert.match(raw.access_token_enc, /^v1\./);
  assert.equal(raw.access_token_enc.includes(fake.tokens.accessToken), false);
});

test('the callback mints a NEW session id and destroys any inbound one (fixation defense)', async () => {
  const { app, db, fake } = await harness();

  // A session an attacker could have planted in the victim's browser before the login.
  const planted = 'planted-session-token-aaaaaaaaaaaaaaaaaaaa';
  await seedAthlete(db, { id: 777, name: 'Other Rider' });
  await seedSession(db, 777, planted, { ttlSeconds: 86_400 * 90 });

  const { callback } = await connect(app, fake, { cookies: { bc_sid: planted } });

  assert.equal(callback.status, 302);
  // The new credential must not be the one that came in, or the planted cookie is now a live
  // session for the victim's account.
  assert.notEqual(callback.cookies.bc_sid, planted);
  assert.equal(callback.cookies.bc_sid.length > 0, true);
  // And the inbound row is gone, so the planted value is dead rather than merely unused.
  assert.equal((await listSessionsForAthlete(db, 777)).length, 0);
});

test('return_to is honoured, and an off-origin return_to collapses to /', async () => {
  const { app, fake, config } = await harness();

  const ok = await connect(app, fake, { returnTo: '/rules' });
  assert.equal(ok.callback.headers.location, `${config.webOrigin}/rules`);

  const hostile = await connect(app, fake, { returnTo: 'https://evil.example/steal' });
  assert.equal(hostile.callback.headers.location, `${config.webOrigin}/`);

  const backslash = await connect(app, fake, { returnTo: '/\\evil.example' });
  // Browsers normalize the backslash into a protocol-relative //evil.example, which is why
  // safeReturnTo resolves rather than pattern-matches.
  assert.equal(backslash.callback.headers.location, `${config.webOrigin}/`);
});

/* ---------------------------------------------- the default-domain (cross-site) deploy ---- */

/**
 * `user.github.io` + `<worker>.<account>.workers.dev`: two registrable domains, so `bc_sid`
 * and `bc_csrf` are both third-party cookies. AUTH_TOKEN_IN_FRAGMENT hands the session token
 * to the frontend in the URL fragment instead, and WEB_BASE_PATH aims the redirect at the
 * Pages PROJECT sub-path rather than the origin root, which is GitHub's own 404 page.
 *
 * The TTL is inside config.js's 24 h ceiling for this mode on purpose: the default 30 days
 * would refuse to boot, which is the point of that check.
 */
const CROSS_SITE = Object.freeze({
  APP_BASE_URL: 'https://julienmcollins.github.io',
  WEB_ORIGIN: 'https://julienmcollins.github.io',
  API_BASE_URL: 'https://eastvswest.julienmcollins.workers.dev',
  WEB_BASE_PATH: '/eastvswest',
  AUTH_TOKEN_IN_FRAGMENT: 'true',
  SESSION_TTL_SECONDS: '43200',
});

test('cross-site deploy: the callback lands on the project sub-path with #token=', async () => {
  const { app, fake, config, db } = await harness({ configOverrides: CROSS_SITE });

  const { callback } = await connect(app, fake);
  assert.equal(callback.status, 302);

  const location = new URL(callback.headers.location);
  assert.equal(location.origin, 'https://julienmcollins.github.io');
  assert.equal(location.pathname, '/eastvswest/', 'the origin root is GitHub 404, not the app');

  // A FRAGMENT, never a query parameter: this is a live session credential and fragments are
  // never sent to a server, a proxy, or a CDN log.
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  assert.ok(token, 'no #token= in the callback redirect');
  assert.equal(location.search, '', 'the token must never appear in the query string');

  // The token IS the session credential -- the same value the cookie carries, so one code
  // path serves both deploys.
  assert.equal(token, callback.cookies.bc_sid);
  const me = await call(app, {
    method: 'GET',
    url: '/api/me',
    headers: { origin: 'https://julienmcollins.github.io', authorization: `Bearer ${token}` },
  });
  assert.equal(me.json.authenticated, true);
  assert.equal((await listSessionsForAthlete(db, me.json.rider.athlete_id)).length, 1);
  assert.equal(config.authTokenInFragment, true);
});

test('cross-site deploy: a bearer POST succeeds with NO CSRF cookie at all', async () => {
  // The regression this guards: cross-site the browser never returns bc_csrf, so public/api.js
  // sends no X-CSRF-Token and every mutating route would 403 with `token_absent` on a deploy
  // that otherwise looks completely healthy -- OAuth works, /api/me works, nothing 4xxs until
  // the rider picks a team.
  const { app, fake } = await harness({ configOverrides: CROSS_SITE });

  const { callback } = await connect(app, fake);
  const token = new URLSearchParams(new URL(callback.headers.location).hash.slice(1)).get('token');

  const pick = await call(app, {
    method: 'POST',
    url: '/api/me/team',
    headers: {
      origin: 'https://julienmcollins.github.io',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: { team: 'WEST' },
  });
  assert.equal(pick.status, 200, `expected 200, got ${pick.status}: ${pick.body}`);
  assert.equal(pick.json.team, 'WEST');
  assert.equal(pick.json.rider.team, 'WEST');

  // Same request WITHOUT the bearer header is still refused. The exemption is tied to the
  // credential, not to the deployment mode.
  const forged = await call(app, {
    method: 'POST',
    url: '/api/me/team',
    headers: { origin: 'https://julienmcollins.github.io', 'content-type': 'application/json' },
    cookies: { bc_sid: token },
    body: { team: 'EAST' },
  });
  assert.equal(forged.status, 403);
  assert.equal(forged.json.error, 'csrf_failed');
});

test('cross-site deploy: a bearer header cannot be used to spend a cookie session', async () => {
  // The obvious attack on the CSRF exemption: attach any Authorization header to skip leg 3
  // and let the victim's ambient cookies do the authenticating. credentialFrom PREFERS the
  // bearer value, so the request resolves to no session rather than falling back.
  const { app, fake } = await harness({ configOverrides: CROSS_SITE });

  const { callback } = await connect(app, fake);
  const real = new URLSearchParams(new URL(callback.headers.location).hash.slice(1)).get('token');

  const res = await call(app, {
    method: 'POST',
    url: '/api/me/team',
    headers: {
      origin: 'https://julienmcollins.github.io',
      'content-type': 'application/json',
      authorization: 'Bearer not-a-real-session-token',
    },
    // The victim's real credential, riding along exactly as a browser would send it.
    cookies: { bc_sid: real },
    body: { team: 'EAST' },
  });
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${res.body}`);
  assert.equal(res.json.error, 'unauthenticated');
});

test('cross-site deploy: callback FAILURES also land on the project sub-path', async () => {
  const { app, fake } = await harness({ configOverrides: CROSS_SITE });

  const { callback } = await connect(app, fake, { deny: true });
  assert.equal(
    callback.headers.location,
    'https://julienmcollins.github.io/eastvswest/#error=denied',
    'an error fragment dropped at the origin root is an error the rider never sees',
  );
});

test('AUTH_TOKEN_IN_FRAGMENT off means no token in the URL, even cross-site', async () => {
  // The flag is the whole switch. Nothing about a cross-origin WEB_ORIGIN should start
  // exporting session tokens into URLs on its own.
  const { app, fake } = await harness({
    configOverrides: { ...CROSS_SITE, AUTH_TOKEN_IN_FRAGMENT: 'false' },
  });

  const { callback } = await connect(app, fake);
  assert.equal(callback.headers.location, 'https://julienmcollins.github.io/eastvswest/');
  assert.equal(callback.headers.location.includes('#'), false);
});

// ---------------------------------------------------------------- callback, rejections

test('replaying the same state is rejected with #error=state_expired', async () => {
  const { app, fake } = await harness();

  const first = await connect(app, fake);
  assert.equal(first.callback.status, 302);

  const replay = await call(app, {
    method: 'GET',
    url: first.target,
    cookies: { bc_oauth: first.nonce },
  });

  assert.equal(replay.status, 302);
  assert.equal(replay.headers.location, 'http://localhost:3000/#error=state_expired');
  // Cleared on the failure path as well.
  assert.equal(attrOf(cookieLine(replay, 'bc_oauth'), 'Max-Age'), '0');
  // And no session was minted.
  assert.equal(replay.cookies.bc_sid, undefined);
});

test('a genuine state presented with a DIFFERENT browser\'s bc_oauth is rejected', async () => {
  const { app, fake, db } = await harness();

  // The attacker's flow: they hit /login and complete consent themselves, capturing a
  // genuine, unused code+state pair.
  const attacker = await connect(app, fake);
  assert.equal(attacker.callback.status, 302);

  // A second, unrelated flow -- the victim's browser, which holds ITS OWN bc_oauth nonce.
  const victimLogin = await call(app, { method: 'GET', url: '/api/auth/strava/login' });

  // Now the attack: a fresh genuine state, mailed to the victim, whose browser presents its
  // own cookie. HMAC passes (the state is real) and single-use passes (it is unused), so the
  // nonce binding is the ONLY thing standing between this and a session bound to the
  // attacker's athlete id.
  const fresh = await call(app, { method: 'GET', url: '/api/auth/strava/login' });
  const authorize = new URL(fresh.headers.location);
  const consent = await fake.fetchImpl(authorize.toString());
  const back = new URL(consent.headers.get('location'));

  const crossed = await call(app, {
    method: 'GET',
    url: `${back.pathname}${back.search}`,
    // The victim's nonce, not the one minted alongside this state.
    cookies: { bc_oauth: victimLogin.cookies.bc_oauth },
  });

  assert.equal(crossed.status, 302);
  assert.equal(crossed.headers.location, 'http://localhost:3000/#error=state_expired');
  assert.equal(crossed.cookies.bc_sid, undefined);
  // The state was still burned, so the attacker cannot keep re-sending it until one lands.
  assert.equal(await countStates(db), 1); // only victimLogin's row remains
});

test('a callback with no bc_oauth cookie at all fails closed', async () => {
  const { app, fake } = await harness();
  const login = await call(app, { method: 'GET', url: '/api/auth/strava/login' });
  const consent = await fake.fetchImpl(new URL(login.headers.location).toString());
  const back = new URL(consent.headers.get('location'));

  const res = await call(app, { method: 'GET', url: `${back.pathname}${back.search}` });
  assert.equal(res.headers.location, 'http://localhost:3000/#error=state_expired');
});

test('?error=access_denied redirects with #error=denied and mints nothing', async () => {
  const { app, fake, db } = await harness();

  const { callback } = await connect(app, fake, { deny: true });

  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, 'http://localhost:3000/#error=denied');
  assert.equal(attrOf(cookieLine(callback, 'bc_oauth'), 'Max-Age'), '0');
  assert.equal(callback.cookies.bc_sid, undefined);
  // A denial is not an attack, so the state row survives for the rider's retry.
  assert.equal(await countStates(db), 1);
  assert.equal(await getAthlete(db, fake.athlete.id), undefined);
});

// ---------------------------------------------------------------- scope

test('a rider who granted only activity:read signs in successfully with scope "read"', async () => {
  const { app, fake, db } = await harness();

  const { callback } = await connect(app, fake, { grant: 'read' });

  // NOT an error. Their public rides are perfectly countable; hard-requiring read_all turns a
  // privacy preference into a permanent lockout.
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, 'http://localhost:3000/');
  assert.ok(callback.cookies.bc_sid);

  const me = await call(app, { method: 'GET', url: '/api/me', cookies: { bc_sid: callback.cookies.bc_sid } });
  assert.equal(me.status, 200);
  assert.equal(me.json.rider.scope, 'read');
  assert.equal(me.json.rider.private_rides_counted, false);

  const athlete = await getAthlete(db, fake.athlete.id);
  assert.equal(athlete.granted_scope, 'read,activity:read');
});

test('a rider who granted NEITHER activity scope gets #error=scope', async () => {
  const { app, fake, db } = await harness();

  // The fake's `?grant=` knob: only the base `read` scope, no activity access at all.
  const { callback } = await connect(app, fake, { grant: '' });

  assert.equal(callback.headers.location, 'http://localhost:3000/#error=scope');
  assert.equal(callback.cookies.bc_sid, undefined);
  assert.equal(attrOf(cookieLine(callback, 'bc_oauth'), 'Max-Age'), '0');
  // Nothing was written: the scope check runs BEFORE the code exchange, so no token was even
  // requested for an account that cannot be read.
  assert.equal(await getAthlete(db, fake.athlete.id), undefined);
  assert.equal(fake.requests.filter((r) => r.pathname.endsWith('/token')).length, 0);
});

// ---------------------------------------------------------------- admin bootstrap

test('ADMIN_BOOTSTRAP_ATHLETE_IDS grants admin, and a later login without it does not revoke', async () => {
  const first = await harness({ configOverrides: { ADMIN_BOOTSTRAP_ATHLETE_IDS: '12345678' } });

  await connect(first.app, first.fake);
  assert.equal(Number((await getAthlete(first.db, 12345678)).is_admin), 1);

  // The same database, a config that has FORGOTTEN the bootstrap list -- which is the normal
  // state after the first admin exists. A second login must not silently demote them.
  const config = testConfig();
  const routes = buildRoutes({ config, db: first.db, strava: first.strava, now: () => NOW_MS });
  const app = buildApp({ config, db: first.db, routes });

  const again = await connect(app, first.fake);
  assert.equal(again.callback.status, 302);
  assert.equal(Number((await getAthlete(first.db, 12345678)).is_admin), 1);
});

// ---------------------------------------------------------------- logout

test('POST /api/auth/logout is 204, deletes the row, and clears both cookies', async () => {
  const { app, db, fake } = await harness();
  const { callback } = await connect(app, fake);
  const { bc_sid: sid, bc_csrf: csrf } = callback.cookies;

  const res = await call(app, {
    method: 'POST',
    url: '/api/auth/logout',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-csrf-token': csrf },
    cookies: { bc_sid: sid, bc_csrf: csrf },
    body: {},
  });

  assert.equal(res.status, 204);
  assert.equal(attrOf(cookieLine(res, 'bc_sid'), 'Max-Age'), '0');
  assert.equal(attrOf(cookieLine(res, 'bc_csrf'), 'Max-Age'), '0');
  // The ROW is gone, not just the cookie: clearing only the cookie leaves the bearer path
  // alive and logout visibly fails for anyone holding a token.
  assert.equal((await listSessionsForAthlete(db, fake.athlete.id)).length, 0);

  const after = await call(app, { method: 'GET', url: '/api/me', cookies: { bc_sid: sid } });
  assert.equal(after.status, 200);
  assert.equal(after.json.authenticated, false);
});

test('logout is idempotent and needs no session', async () => {
  const { app } = await harness();
  const res = await call(app, {
    method: 'POST',
    url: '/api/auth/logout',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-csrf-token': 'abc' },
    cookies: { bc_csrf: 'abc' },
    body: {},
  });
  assert.equal(res.status, 204);
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
