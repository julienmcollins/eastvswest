import test from 'node:test';
import assert from 'node:assert/strict';

import { openD1 } from '../server/db/d1.js';
import { handleWithNodeApi } from '../server/worker.js';
import { buildApp } from '../server/app.js';
import { buildRoutes } from '../server/routes/index.js';
import { createStravaClient } from '../server/strava/client.js';
import { seedAthlete, seedActivity, seedSession, testConfig, SENTINEL_SECRET } from './helpers/testDb.js';
import { createFakeStrava } from './helpers/fakeStrava.js';
import { freshD1, createFakeD1 } from './helpers/fakeD1.js';

/**
 * The Cloudflare port: the D1 adapter and the Request/Response adapter.
 *
 * Neither can be tested against the real thing here (no Workers runtime, no network), so both
 * are tested against doubles that reproduce the specific behaviours the adapters exist to
 * paper over -- `first()` returning null, `meta.last_row_id`, `{success:false}` instead of a
 * throw, BigInt rejection. Each of those is a way the adapter could be silently wrong and
 * still pass a looser test. See test/helpers/fakeD1.js.
 */

const NOW_MS = Date.parse('2026-08-31T12:00:00Z');

/* ================================== the D1 adapter ================================== */

test('d1: all/get/run map onto D1 shapes, including the field renames', async () => {
  const { db } = await freshD1();

  const insert = await db.run(
    'INSERT INTO athletes (strava_athlete_id, display_name, team, created_at, updated_at) VALUES (?,?,?,?,?)',
    [42, 'Rider 42', 'EAST', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
  );
  // D1 reports meta.changes / meta.last_row_id; call sites read changes / lastInsertRowid.
  assert.equal(insert.changes, 1);
  assert.equal(typeof insert.lastInsertRowid, 'number');
  assert.ok(insert.lastInsertRowid > 0);

  const row = await db.get('SELECT display_name FROM athletes WHERE strava_athlete_id = ?', [42]);
  assert.equal(row.display_name, 'Rider 42');

  // THE RENAME THAT MATTERS: D1's first() gives null for no row, node:sqlite gives undefined.
  // Anything doing `=== undefined` would silently change behaviour between the two drivers.
  const missing = await db.get('SELECT 1 AS x FROM athletes WHERE strava_athlete_id = ?', [999]);
  assert.equal(missing, undefined, 'a missing row must be undefined, not null');

  const all = await db.all('SELECT strava_athlete_id FROM athletes ORDER BY strava_athlete_id');
  assert.deepEqual(all, [{ strava_athlete_id: 42 }]);
  assert.deepEqual(await db.all('SELECT 1 AS x WHERE 0'), [], 'no rows is [], never undefined');
});

test('d1: a no-parameter statement is never .bind()ed', async () => {
  // D1 treats bind() with zero arguments as an arity mismatch on some versions, and the fake
  // rejects a double bind the way D1 does.
  const { db, fake } = await freshD1();
  await db.all('SELECT 1 AS x');
  await db.get('SELECT 2 AS x');
  assert.deepEqual(fake.calls.map((c) => c.params), [[], []]);
});

test('d1: booleans and undefined are coerced before they reach the driver', async () => {
  // The fake throws on a raw boolean exactly as D1 does. Strava's JSON is full of them
  // (`trainer`, `manual`, `private`) and this only ever fails at bind time, so a mapper unit
  // test cannot catch it.
  const { db } = await freshD1();
  await db.run(
    'INSERT INTO athletes (strava_athlete_id, display_name, team, is_admin, avatar_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    [7, 'Bool Rider', 'WEST', true, undefined, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
  );
  const row = await db.get('SELECT is_admin, avatar_url FROM athletes WHERE strava_athlete_id = ?', [7]);
  assert.equal(row.is_admin, 1, 'true became 1');
  assert.equal(row.avatar_url, null, 'undefined became NULL');
});

test('d1: a BigInt too large to narrow is refused rather than silently rounded', async () => {
  const { db } = await freshD1();
  // Inside Number.MAX_SAFE_INTEGER: narrowed losslessly, which is every real id in this schema.
  await db.run(
    'INSERT INTO athletes (strava_athlete_id, display_name, team, created_at, updated_at) VALUES (?,?,?,?,?)',
    [123n, 'Big', 'EAST', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
  );
  assert.ok(await db.get('SELECT 1 AS x FROM athletes WHERE strava_athlete_id = ?', [123]));

  await assert.rejects(
    () => db.get('SELECT 1 FROM athletes WHERE strava_athlete_id = ?', [2n ** 60n]),
    /BigInt too large/,
  );
});

test('d1: batch is one transaction, and a mid-batch failure rolls the whole thing back', async () => {
  const { db, fake } = await freshD1();
  const ts = '2026-08-01T00:00:00.000Z';
  const insert = 'INSERT INTO athletes (strava_athlete_id, display_name, team, created_at, updated_at) VALUES (?,?,?,?,?)';

  const results = await db.batch([
    [insert, [1, 'One', 'EAST', ts, ts]],
    [insert, [2, 'Two', 'WEST', ts, ts]],
  ]);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.changes), [1, 1]);
  assert.equal((await db.all('SELECT strava_athlete_id FROM athletes')).length, 2);

  assert.deepEqual(await db.batch([]), [], 'an empty batch does no work and is not an error');

  // All-or-nothing. Without the rollback a half-applied sync would leave the watermark and the
  // activity rows disagreeing, which is the corruption batch() exists to prevent.
  fake.failOn.add('Four');
  await assert.rejects(() => db.batch([
    [insert, [3, 'Three', 'EAST', ts, ts]],
    [insert, [4, 'Four', 'WEST', ts, ts]],
  ]));
  fake.failOn.clear();
  assert.equal((await db.all('SELECT strava_athlete_id FROM athletes')).length, 2, 'neither row survived');
});

test('d1: {success:false} becomes a throw, not an empty result set', async () => {
  // D1 reports some failures without rejecting. Read as an empty result set, a failed write
  // looks like a sync that stored nothing -- silently.
  const { db, fake } = await freshD1();
  fake.failOn.add('athletes');
  await assert.rejects(() => db.all('SELECT * FROM athletes'), /D1 reported failure/);
  await assert.rejects(
    () => db.run('DELETE FROM athletes WHERE strava_athlete_id = ?', [1]),
    /D1 reported failure/,
  );
});

test('d1: the shared statement guards still apply', async () => {
  const { db } = await freshD1();
  await assert.rejects(() => db.all('SELECT 1; SELECT 2'), /one statement per call/);
  await assert.rejects(() => db.get('SELECT * FROM athletes WHERE id = :id'), /positional \? placeholders only/);
  await assert.rejects(() => db.batch([['SELECT 1; DROP TABLE athletes', []]]), /one statement per call/);
});

test('d1: openD1 refuses a missing or malformed binding', () => {
  // The commonest real deploy mistake: wrangler.toml left with the placeholder database_id, or
  // the binding named something other than DB.
  for (const bad of [undefined, null, {}, { prepare: 'nope' }]) {
    assert.throws(() => openD1(bad), /openD1 requires a D1Database binding/);
  }
  assert.equal(openD1({ prepare: () => {} }, { name: 'DB' }).path, 'd1:DB');
});

test('d1: close() is a no-op and does not throw', async () => {
  const { db } = await freshD1();
  await db.close();
  assert.deepEqual(await db.all('SELECT 1 AS x'), [{ x: 1 }], 'the binding is still usable');
});

/* ============================ the real app, over D1 ============================ */

/**
 * The whole route tree, on the D1 adapter, driven through the Worker's Request/Response
 * adapter. This is the test that would have caught `placeholders` dragging node:sqlite into the
 * Worker, and every place a repository assumed a synchronous driver.
 */
async function workerHarness(configOverrides = {}) {
  const { sqlite, fake } = await freshD1();
  const db = openD1(fake, { name: 'DB' });
  const config = testConfig(configOverrides);
  const strava = createFakeStrava({ clientSecret: SENTINEL_SECRET, now: () => NOW_MS });
  const client = createStravaClient({
    apiBase: config.stravaApiBase,
    oauthBase: config.stravaOauthBase,
    clientId: config.stravaClientId,
    clientSecret: config.stravaClientSecret,
    redirectUri: config.redirectUri,
    fetchImpl: strava.fetchImpl,
    now: () => NOW_MS,
    minRequestSpacingMs: 0,
    retryBaseMs: 1,
  });
  const routes = buildRoutes({ config, db, strava: client, now: () => NOW_MS });
  const app = buildApp({ config, db, routes, publicDir: null });

  const call = (input, init) => handleWithNodeApi(app, new Request(input, init), { waitUntil: () => {} });
  return { sqlite, db, config, app, call };
}

test('worker: GET /api/health over D1', async () => {
  const { call } = await workerHarness();
  const res = await call('https://api.test/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  // Transport-level headers are properties of respond.js, so they must survive the adapter.
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('worker: the leaderboard renders real rows read through D1', async () => {
  const { sqlite, call } = await workerHarness();
  await seedAthlete(sqlite, { id: 1, name: 'East One', team: 'EAST' });
  await seedAthlete(sqlite, { id: 2, name: 'West One', team: 'WEST' });
  await seedActivity(sqlite, { athleteId: 1, id: 100, localDate: '2026-08-10', meters: 16093.44 });
  await seedActivity(sqlite, { athleteId: 2, id: 200, localDate: '2026-08-11', meters: 32186.88 });

  const res = await call('https://api.test/api/leaderboard?month=2026-08');
  assert.equal(res.status, 200);
  const body = await res.json();
  // The IN-clause path: leaderboard.js builds it with placeholders(), which is the import that
  // used to reach node:sqlite and would make this whole module unloadable in a Worker.
  const west = body.teams.find((t) => t.team === 'WEST');
  const east = body.teams.find((t) => t.team === 'EAST');
  assert.equal(Math.round(west.miles), 20);
  assert.equal(Math.round(east.miles), 10);
  assert.equal(east.ride_count, 1);
});

test('worker: the per-month backfill table groups correctly over D1', async () => {
  // `activityMonthlyTotals` is the only query in the tree that GROUPs BY a `substr` expression, and
  // it is the one an operator reads to decide whether a backfill worked. A driver difference that
  // returned its counts as strings, or lost the ORDER BY, would be invisible on the Node path and
  // wrong in production -- where this endpoint is the only view of the data anyone has.
  const { sqlite, call } = await workerHarness({ ADMIN_BOOTSTRAP_ATHLETE_IDS: '1' });
  await seedAthlete(sqlite, { id: 1, name: 'East One', team: 'EAST', isAdmin: true });
  await seedActivity(sqlite, { athleteId: 1, id: 100, localDate: '2026-06-10', meters: 16093.44 });
  await seedActivity(sqlite, { athleteId: 1, id: 101, localDate: '2026-06-11', meters: 16093.44 });
  // Nothing in July: the gap has to survive the adapter, because the gap is the finding.
  await seedActivity(sqlite, { athleteId: 1, id: 200, localDate: '2026-08-11', meters: 32186.88 });
  await seedActivity(sqlite, { athleteId: 1, id: 201, localDate: '2026-08-12', sportType: 'Run' });

  const token = 'd1-admin-token';
  // The TTL has to cover the gap between the real clock (which stamps the row) and NOW_MS (which
  // the app reads it with). A default hour would leave the session already expired and the 401
  // would look like a broken admin guard.
  await seedSession(sqlite, 1, token, { ttlSeconds: 400 * 86400 });

  const res = await call('https://api.test/api/admin/months', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.current_month, '2026-08');
  assert.equal(body.competition_first_month, '2026-06');
  assert.deepEqual(body.months, [
    { month: '2026-06', ride_count: 2, meters: 32186.88 },
    { month: '2026-08', ride_count: 1, meters: 32186.88 },
  ]);
  // Numbers, not strings: a stringified count reaching the script's arithmetic would silently
  // concatenate rather than add when the per-athlete tables are merged.
  assert.equal(typeof body.months[0].ride_count, 'number');
  assert.equal(typeof body.months[0].meters, 'number');
});

test('worker: unknown /api paths are JSON 404s, and unknown non-api paths too', async () => {
  const { call } = await workerHarness();
  const api = await call('https://api.test/api/nope');
  assert.equal(api.status, 404);
  assert.equal((await api.json()).error, 'not_found');

  // publicDir is null in a Worker, so there is no static fallback to reach -- and reaching one
  // would mean app.js had loaded http/static.js and therefore node:fs.
  const page = await call('https://api.test/anything');
  assert.equal(page.status, 404);
  assert.equal((await page.json()).error, 'not_found');
});

/* ========================= the Request/Response adapter ========================= */

/** A bare app that lets each test assert one adapter behaviour without the route tree. */
function adapter(handler) {
  return (input, init) => handleWithNodeApi(handler, new Request(input, init), { waitUntil: () => {} });
}

test('adapter: writeHead merges over setHeader, later winning, case-insensitively', async () => {
  const call = adapter(async (req, res) => {
    res.setHeader('Vary', 'Origin, Authorization, Cookie');
    res.setHeader('X-Kept', 'yes');
    res.setHeader('Content-Type', 'text/plain');
    res.writeHead(201, { 'content-type': 'application/json', 'X-New': 'also' });
    res.end('{}');
  });
  const res = await call('https://api.test/');
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('vary'), 'Origin, Authorization, Cookie');
  assert.equal(res.headers.get('x-kept'), 'yes');
  assert.equal(res.headers.get('x-new'), 'also');
  // Not sent twice with the browser picking one: `Content-Type` and `content-type` are one
  // header, and writeHead's value wins.
  assert.equal(res.headers.get('content-type'), 'application/json');
});

test('adapter: multiple Set-Cookie lines survive as separate headers', async () => {
  // The OAuth callback sets three at once. Collapsed into one comma-joined value the browser
  // would store a single malformed cookie and every login would fail.
  const call = adapter(async (req, res) => {
    res.writeHead(302, {
      Location: 'https://web.test/',
      'Set-Cookie': ['bc_sid=a; Path=/; HttpOnly', 'bc_csrf=b; Path=/', 'bc_oauth=; Max-Age=0'],
    });
    res.end();
  });
  const res = await call('https://api.test/');
  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 3);
  assert.ok(cookies[0].startsWith('bc_sid=a'));
  assert.ok(cookies[1].startsWith('bc_csrf=b'));
  assert.equal(res.headers.get('location'), 'https://web.test/');
});

test('adapter: the request body streams, and byte counting sees real chunk lengths', async () => {
  const { readJsonBody } = await import('../server/http/body.js');
  const call = adapter(async (req, res) => {
    const body = await readJsonBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ echoed: body }));
  });

  const res = await call('https://api.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ team: 'WEST' }),
  });
  assert.deepEqual((await res.json()).echoed, { team: 'WEST' });
});

test('adapter: an oversized body still gets its 413 rather than a dead connection', async () => {
  // body.js writes the 413 and only THEN destroys the request. On this adapter "destroy" means
  // cancelling the stream, so the ordering has to hold or the client sees nothing at all.
  const { readJsonBody } = await import('../server/http/body.js');
  const call = adapter(async (req, res) => {
    try {
      await readJsonBody(req, { limit: 32 });
      res.writeHead(200, {});
      res.end('{}');
    } catch (err) {
      if (err?.responded !== true) {
        res.writeHead(500, {});
        res.end('{}');
      }
    }
  });

  const res = await call('https://api.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(200) }),
  });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'payload_too_large');
});

test('adapter: an empty body reads as {}, so an optional payload stays optional', async () => {
  const { readJsonBody } = await import('../server/http/body.js');
  const call = adapter(async (req, res) => {
    const body = await readJsonBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  // POST /api/me/sync sends no body at all.
  const res = await call('https://api.test/', { method: 'POST' });
  assert.deepEqual(await res.json(), {});
});

test('adapter: HEAD and 204 carry no body', async () => {
  // Constructing a Response with a body on either is a runtime TypeError, not something the
  // browser forgives -- so the suppression has to happen in the adapter.
  const head = await adapter(async (req, res) => {
    const { sendJson } = await import('../server/http/respond.js');
    sendJson(res, 200, { hello: 'world' });
  })('https://api.test/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  // Content-Length still describes the body that a GET would have returned.
  assert.equal(head.headers.get('content-length'), String(JSON.stringify({ hello: 'world' }).length));

  const noContent = await adapter(async (req, res) => {
    const { sendNoContent } = await import('../server/http/respond.js');
    sendNoContent(res, { 'Set-Cookie': 'bc_sid=; Max-Age=0' });
  })('https://api.test/', { method: 'POST' });
  assert.equal(noContent.status, 204);
  assert.equal(await noContent.text(), '');
});

test('adapter: query string and path reach the router, but the host never does', async () => {
  const call = adapter(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: req.url, method: req.method }));
  });
  const res = await call('https://api.test/api/leaderboard?month=2026-08&x=1');
  // Path + query only. app.js resolves this against a fixed base precisely so a hostile Host
  // header cannot become a 500 or change what the router matches.
  assert.deepEqual(await res.json(), { url: '/api/leaderboard?month=2026-08&x=1', method: 'GET' });
});

test('adapter: headers arrive lowercased, and a thrown handler is a JSON 500', async () => {
  const seen = {};
  const call = adapter(async (req, res) => {
    Object.assign(seen, req.headers);
    throw new Error('boom: this message must not reach the client');
  });
  const res = await call('https://api.test/', { headers: { 'X-Mixed-Case': 'v', Cookie: 'bc_sid=abc' } });
  assert.equal(seen['x-mixed-case'], 'v');
  assert.equal(seen.cookie, 'bc_sid=abc');
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'internal');
  assert.equal(body.message, 'Internal server error.');
  assert.equal(JSON.stringify(body).includes('boom'), false, 'the internal message must not leak');
});

test('adapter: the finish listener runs, and a throwing one cannot lose the response', async () => {
  let fired = 0;
  const call = adapter(async (req, res) => {
    // app.js logs the request from a finish listener; if that threw and took the response with
    // it, every request would 500 after having already succeeded.
    res.on('finish', () => { fired += 1; throw new Error('listener boom'); });
    res.on('finish', () => { fired += 1; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  const res = await call('https://api.test/');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(fired, 2, 'both listeners ran despite the first throwing');
});

test('adapter: a second end() is ignored rather than throwing', async () => {
  // respond.js guards this with headersSent/writableEnded, and those flags have to be real on
  // the adapter or the guard silently stops working.
  const call = adapter(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    assert.equal(res.headersSent, true);
    res.end('{"first":true}');
    assert.equal(res.writableEnded, true);
    res.end('{"second":true}');
  });
  const res = await call('https://api.test/');
  assert.deepEqual(await res.json(), { first: true });
});

test('adapter: CORS preflight and a credentialed cross-origin GET both work end to end', async () => {
  // The cross-site deploy depends entirely on this pair, and CORS never runs on the Node path
  // in development, so the adapter is where it first gets exercised.
  const { call } = await workerHarness({
    APP_BASE_URL: 'https://julienmcollins.github.io',
    WEB_ORIGIN: 'https://julienmcollins.github.io',
    API_BASE_URL: 'https://eastvswest.acct.workers.dev',
    WEB_BASE_PATH: '/eastvswest',
    AUTH_TOKEN_IN_FRAGMENT: 'true',
    SESSION_TTL_SECONDS: '43200',
  });

  const preflight = await call('https://eastvswest.acct.workers.dev/api/me/sync', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://julienmcollins.github.io',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization',
    },
  });
  assert.equal(preflight.status, 204);
  // Never `*`: with credentials the browser discards the response outright.
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://julienmcollins.github.io');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);

  const me = await call('https://eastvswest.acct.workers.dev/api/me', {
    headers: { Origin: 'https://julienmcollins.github.io' },
  });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).authenticated, false);
  assert.equal(me.headers.get('access-control-allow-origin'), 'https://julienmcollins.github.io');
  assert.equal(me.headers.get('vary'), 'Origin, Authorization, Cookie');
});

test('adapter: a repeated Cookie header joins with "; " rather than ", "', async () => {
  // A runtime that joins Cookie repeats with ', ' (workerd does; undici already uses '; ')
  // would leave parseCookies reading one mangled name, so every session would look absent.
  // getAll cannot be used to rebuild it: workerd throws a TypeError for any name other than
  // Set-Cookie, and undici has no such method -- hence the string-level fix under test.
  const call = adapter(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cookie: req.headers.cookie }));
  });

  const headers = new Headers();
  headers.append('cookie', 'bc_sid=a');
  headers.append('cookie', 'bc_csrf=b');
  const res = await call('https://api.test/', { headers });
  assert.equal((await res.json()).cookie, 'bc_sid=a; bc_csrf=b');

  // The workerd shape, stated literally: whatever the host runtime hands over, the header that
  // reaches parseCookies is '; '-delimited.
  const joined = await call('https://api.test/', { headers: { cookie: 'bc_sid=a, bc_csrf=b' } });
  assert.equal((await joined.json()).cookie, 'bc_sid=a; bc_csrf=b');

  // A comma inside a (quoted) cookie value is not a join and stays put.
  const quoted = await call('https://api.test/', { headers: { cookie: 'bc_sid="a,b"' } });
  assert.equal((await quoted.json()).cookie, 'bc_sid="a,b"');
});

test('adapter: every request survives header conversion, cookie or not', async () => {
  // The regression this guards: headersToObject threw a TypeError for EVERY request, so even
  // GET /api/health -- no cookie, no auth -- came back as a worker error rather than a 200.
  const call = adapter(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cookie: req.headers.cookie ?? null, accept: req.headers.accept }));
  });
  const res = await call('https://api.test/api/health', { headers: { Accept: 'application/json' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cookie: null, accept: 'application/json' });
});
