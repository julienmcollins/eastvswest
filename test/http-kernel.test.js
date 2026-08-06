import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../server/app.js';
import { createRouter } from '../server/http/router.js';
import { HttpError, sendJson, sendError, sendRedirect, sendNoContent } from '../server/http/respond.js';
import { readJsonBody } from '../server/http/body.js';
import { parseCookies, serializeCookie, clearCookie } from '../server/http/cookies.js';
import { corsHeaders } from '../server/http/cors.js';
import { API_SCHEMA } from '../server/contracts.js';
import { redact, SENSITIVE_KEYS } from '../server/security/redact.js';
import { log, setLogSink } from '../server/lib/log.js';
import { injectRequest, attrOf } from './helpers/inject.js';
import { testConfig } from './helpers/testDb.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(HERE, 'fixtures', 'static');

/**
 * The access log would otherwise interleave a JSON line per injected request with the test
 * reporter's output. The captured records are also what the redaction assertions inspect,
 * rather than re-implementing the formatter.
 */
const records = [];
setLogSink((record) => records.push(record));
test.after(() => setLogSink(null));

const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** An app with a handful of routes covering every shape a real route can take. */
function makeApp({ config = testConfig(), publicDir = null } = {}) {
  const router = createRouter();

  router.add('GET', '/api/echo/:id', (req, res, ctx) => {
    sendJson(res, 200, { id: ctx.params.id });
  });
  router.add('POST', '/api/echo', async (req, res) => {
    sendJson(res, 200, { received: await readJsonBody(req) });
  });
  router.add('GET', '/api/boom', () => {
    throw new Error('kaboom: leaks a filesystem path and a stack');
  });
  router.add('GET', '/api/teapot', () => {
    throw new HttpError(418, 'i_am_a_teapot', 'Short and stout.', { hint: 'tea' });
  });
  router.add('GET', '/api/hop', (req, res) => sendRedirect(res, 'http://localhost:3000/#done'));
  router.add('POST', '/api/quiet', (req, res) => sendNoContent(res));
  router.add('GET', '/api/guarded', (req, res) => sendJson(res, 200, { reached: true }));
  router.add('POST', '/api/guarded', (req, res) => sendJson(res, 200, { reached: true }));
  router.add('GET', '/api/ctx', (req, res, ctx) => {
    sendJson(res, 200, {
      is_map: ctx.cookies instanceof Map,
      sid: ctx.cookies.get('bc_sid') ?? null,
      start: ctx.query.get('start'),
      session: ctx.session,
    });
  });

  // The guard-in-one-call requirement: registered once, covers every route under the prefix
  // for every mutating method.
  router.use(
    (ctx) => ctx.pathname.startsWith('/api/guarded') && ctx.method === 'POST',
    () => {
      throw new HttpError(403, 'csrf_failed', 'Missing CSRF token.');
    },
  );

  return buildApp({ config, db: null, routes: router, publicDir });
}

// --------------------------------------------------------------------------- router

test('404 and 405 are distinguished, and 405 carries an accurate Allow header', async () => {
  const app = makeApp();

  const missing = await injectRequest(app, { method: 'GET', url: '/api/does-not-exist' });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'not_found');

  // Same path, wrong method. A 404 here would send you hunting for a typo that is not there.
  const wrongMethod = await injectRequest(app, { method: 'DELETE', url: '/api/echo/7' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error, 'method_not_allowed');
  assert.match(wrongMethod.headers.allow, /GET/);
  assert.match(wrongMethod.headers.allow, /HEAD/);
  assert.deepEqual([...wrongMethod.json.allow].sort(), ['GET', 'HEAD', 'OPTIONS']);

  const wrongMethodOnPost = await injectRequest(app, { method: 'GET', url: '/api/echo' });
  assert.equal(wrongMethodOnPost.status, 405);
  assert.match(wrongMethodOnPost.headers.allow, /POST/);
});

test('a GET route also answers HEAD, with headers but no body', async () => {
  const app = makeApp();

  const get = await injectRequest(app, { method: 'GET', url: '/api/echo/42' });
  assert.equal(get.status, 200);
  assert.deepEqual(get.json, { id: '42' });

  const head = await injectRequest(app, { method: 'HEAD', url: '/api/echo/42' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], get.headers['content-length']);
});

test('path params are decoded, and a bad escape is a 400 rather than a 404', async () => {
  const app = makeApp();

  const decoded = await injectRequest(app, { method: 'GET', url: '/api/echo/hello%20world' });
  assert.deepEqual(decoded.json, { id: 'hello world' });

  const bad = await injectRequest(app, { method: 'GET', url: '/api/echo/%zz' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_request');
});

test('a trailing slash matches, and an empty path segment does not', async () => {
  const app = makeApp();
  assert.equal((await injectRequest(app, { url: '/api/echo/42/' })).status, 200);
  assert.equal((await injectRequest(app, { url: '/api/echo//' })).status, 405);
});

test('one use() call guards a whole set of routes', async () => {
  const app = makeApp();

  assert.equal((await injectRequest(app, { method: 'GET', url: '/api/guarded' })).status, 200);

  const blocked = await injectRequest(app, { method: 'POST', url: '/api/guarded', body: {} });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error, 'csrf_failed');
});

test('a bare OPTIONS is answered with an Allow list, not a 405', async () => {
  const app = makeApp();
  const res = await injectRequest(app, { method: 'OPTIONS', url: '/api/echo/1' });
  assert.equal(res.status, 204);
  assert.match(res.headers.allow, /GET, HEAD, OPTIONS/);
});

test('routes: null still serves GET /api/health', async () => {
  const app = buildApp({ config: testConfig(), db: null });
  const res = await injectRequest(app, { url: '/api/health' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  // API_SCHEMA, not a literal: /api/health reports the wire version, so a hardcoded 1 here
  // fails every time the contract legitimately bumps.
  assert.equal(res.json.schema, API_SCHEMA);
  assert.match(res.json.time, /Z$/);
});

test('ctx carries parsed cookies, the query, and an empty session', async () => {
  // csrf.js and guards.js both read ctx.cookies; parsing it in one place is what stops a
  // route from silently skipping the CSRF check because nobody parsed the header.
  const app = makeApp();
  const res = await injectRequest(app, {
    url: '/api/ctx?start=2026-06-01',
    cookies: { bc_sid: 'raw-token', bc_csrf: 'csrf-token' },
  });
  assert.deepEqual(res.json, { is_map: true, sid: 'raw-token', start: '2026-06-01', session: null });
});

// --------------------------------------------------------------------------- respond

test('every JSON response carries the standard security headers', async () => {
  const app = makeApp();
  const res = await injectRequest(app, { url: '/api/echo/1' });
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

test('an unknown /api/* path returns JSON, never HTML', async () => {
  // The bug this prevents: an HTML 404 makes a frontend fetch typo surface as
  // "Unexpected token '<'", which points at JSON.parse instead of at the URL.
  const app = makeApp({ publicDir: STATIC_DIR });
  const res = await injectRequest(app, { url: '/api/whatever' });
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.equal(res.json.error, 'not_found');
});

test('HttpError exposes its message and extra; a plain throw exposes nothing', async () => {
  const app = makeApp();

  const teapot = await injectRequest(app, { url: '/api/teapot' });
  assert.equal(teapot.status, 418);
  assert.deepEqual(teapot.json, { hint: 'tea', error: 'i_am_a_teapot', message: 'Short and stout.' });

  const boom = await injectRequest(app, { url: '/api/boom' });
  assert.equal(boom.status, 500);
  assert.deepEqual(boom.json, { error: 'internal', message: 'Internal server error.' });
  assert.ok(!boom.body.includes('kaboom'), 'the thrown message must not reach the client');
  assert.ok(records.some((r) => r.stack?.includes('kaboom')), 'but it must reach the log');
});

test("extra cannot overwrite the machine-readable error code", () => {
  const err = new HttpError(400, 'invalid_team', 'Nope.', { error: 'pretend_success' });
  const res = fakeRes();
  sendError(res, err, { log });
  assert.equal(JSON.parse(res.bodyText).error, 'invalid_team');
});

test('sendError on an already-sent response destroys instead of throwing', () => {
  // The real path: a client aborts a large download, pipeline rejects AFTER the headers went
  // out, and writeHead() then throws ERR_HTTP_HEADERS_SENT from inside a catch block -- an
  // unhandled rejection that takes the process down. Asserted against a response stub
  // because injectRequest cannot observe a destroyed socket.
  const before = records.length;
  const res = fakeRes();
  res.writeHead(200, { 'content-type': 'text/plain' });

  assert.doesNotThrow(() => sendError(res, Object.assign(new Error('aborted'), { code: 'ECONNRESET' }), { log }));
  assert.equal(res.destroyed, true, 'a half-sent response cannot be repaired, only killed');
  assert.equal(res.statusCode, 200, 'the status already on the wire is left alone');

  const logged = records.slice(before);
  assert.ok(logged.some((r) => r.msg === 'response already sent' && r.error_code === 'ECONNRESET'));
});

test('sendRedirect refuses a location containing CRLF', () => {
  assert.throws(() => sendRedirect(fakeRes(), 'http://x/\r\nSet-Cookie: bc_sid=evil'), /CR, LF/);
});

test('sendRedirect and sendNoContent are no-store with no body', async () => {
  const app = makeApp();

  const hop = await injectRequest(app, { url: '/api/hop' });
  assert.equal(hop.status, 302);
  assert.equal(hop.headers.location, 'http://localhost:3000/#done');
  assert.equal(hop.headers['cache-control'], 'no-store');
  assert.equal(hop.body, '');

  const quiet = await injectRequest(app, { method: 'POST', url: '/api/quiet', body: {} });
  assert.equal(quiet.status, 204);
  assert.equal(quiet.body, '');
});

// --------------------------------------------------------------------------- body

test('a 100 KB body with Content-Length: 10 gets a READABLE JSON 413', async () => {
  // The lying Content-Length is the actual attack, so the cap is enforced on the byte
  // stream. And the 413 is written BEFORE req.destroy(): destroying first would leave the
  // client with a bare ECONNRESET and nothing to display.
  const app = makeApp();
  const payload = 'x'.repeat(100 * 1024);

  const res = await injectRequest(app, {
    method: 'POST',
    url: '/api/echo',
    headers: { 'content-type': 'application/json', 'content-length': '10' },
    body: payload,
  });

  assert.equal(res.status, 413);
  const parsed = JSON.parse(res.body); // parseable, not a truncated socket
  assert.equal(parsed.error, 'payload_too_large');
  assert.equal(parsed.limit_bytes, 65536);
  assert.match(res.headers['content-type'], /^application\/json/);
});

test('an honest oversized Content-Length is also a 413', async () => {
  const app = makeApp();
  const res = await injectRequest(app, {
    method: 'POST',
    url: '/api/echo',
    headers: { 'content-type': 'application/json', 'content-length': String(70 * 1024) },
    body: 'x'.repeat(70 * 1024),
  });
  assert.equal(res.status, 413);
  assert.equal(res.json.error, 'payload_too_large');
});

test('a body at exactly the limit is accepted', async () => {
  const app = makeApp();
  const filler = 'y'.repeat(65536 - '{"a":""}'.length);
  const res = await injectRequest(app, { method: 'POST', url: '/api/echo', body: { a: filler } });
  assert.equal(res.status, 200);
  assert.equal(res.json.received.a.length, filler.length);
});

test('415 on a non-JSON Content-Type, 400 on malformed JSON, 400 on a top-level array', async () => {
  const app = makeApp();

  const plain = await injectRequest(app, {
    method: 'POST',
    url: '/api/echo',
    headers: { 'content-type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(plain.status, 415);
  assert.equal(plain.json.error, 'unsupported_media_type');

  const gzipped = await injectRequest(app, {
    method: 'POST',
    url: '/api/echo',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: '{}',
  });
  assert.equal(gzipped.status, 415, 'a compressed body would make the byte cap meaningless');

  const malformed = await injectRequest(app, { method: 'POST', url: '/api/echo', body: '{"team":' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.error, 'invalid_json');
  assert.ok(!malformed.body.includes('"team"'), 'the offending input must not be echoed back');

  const array = await injectRequest(app, { method: 'POST', url: '/api/echo', body: '[1,2,3]' });
  assert.equal(array.status, 400);
  assert.equal(array.json.error, 'bad_request');

  const bareString = await injectRequest(app, { method: 'POST', url: '/api/echo', body: '"EAST"' });
  assert.equal(bareString.status, 400);

  const bareNull = await injectRequest(app, { method: 'POST', url: '/api/echo', body: 'null' });
  assert.equal(bareNull.status, 400);
});

test('an empty body is an empty object, and application/*+json is accepted', async () => {
  const app = makeApp();

  const empty = await injectRequest(app, {
    method: 'POST',
    url: '/api/echo',
    headers: { 'content-type': 'application/json', 'content-length': '0' },
    body: '',
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.received, {});

  const suffixed = await injectRequest(app, {
    method: 'POST',
    url: '/api/echo',
    headers: { 'content-type': 'application/merge-patch+json; charset=utf-8' },
    body: '{"ok":1}',
  });
  assert.equal(suffixed.status, 200);
});

// --------------------------------------------------------------------------- static

test('static HTML carries the CSP and X-Frame-Options', async () => {
  const app = makeApp({ publicDir: STATIC_DIR });
  const res = await injectRequest(app, { url: '/index.html' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.equal(res.headers['content-security-policy'], EXPECTED_CSP);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.body, /FIXTURE_INDEX_SHELL/);
});

test('an extension-less path gets the shell; an extensioned miss gets 404', async () => {
  const app = makeApp({ publicDir: STATIC_DIR });

  const route = await injectRequest(app, { url: '/leaderboard' });
  assert.equal(route.status, 200);
  assert.match(route.body, /FIXTURE_INDEX_SHELL/);

  // Falling back to the shell here is what produces "Unexpected token '<'" for a mistyped
  // module path, so a path with an extension must 404.
  const asset = await injectRequest(app, { url: '/missing.js' });
  assert.equal(asset.status, 404);
  assert.match(asset.headers['content-type'], /^application\/json/);
});

test('a non-allowlisted extension is never served even when the file exists', async () => {
  // The file being asked for here is real; only the allowlist stops it.
  const app = makeApp({ publicDir: path.join(HERE, '..') });
  for (const url of ['/.env', '/package.json.bak', '/server/config.js.map', '/data/bike-comp.db']) {
    const res = await injectRequest(app, { url });
    assert.equal(res.status, 404, `${url} must not be served`);
  }
});

test('static sends an ETag and honours If-None-Match', async () => {
  const app = makeApp({ publicDir: STATIC_DIR });
  const first = await injectRequest(app, { url: '/styles.css' });
  assert.equal(first.status, 200);
  assert.match(first.headers['content-type'], /^text\/css/);
  assert.ok(first.headers.etag);
  // Non-HTML assets are cacheable; the shell that references them is not.
  assert.match(first.headers['cache-control'], /max-age/);

  const second = await injectRequest(app, {
    url: '/styles.css',
    headers: { 'if-none-match': first.headers.etag },
  });
  assert.equal(second.status, 304);
  assert.equal(second.body, '');
});

test('HEAD on a static file sends headers only', async () => {
  const app = makeApp({ publicDir: STATIC_DIR });
  const res = await injectRequest(app, { method: 'HEAD', url: '/styles.css' });
  assert.equal(res.status, 200);
  assert.equal(res.body, '');
  assert.ok(Number(res.headers['content-length']) > 0);
});

test('traversal battery: nothing outside publicDir is ever served', async () => {
  const app = makeApp({ publicDir: STATIC_DIR });

  const mustBe404 = [
    '/../server/config.js',
    '/%2e%2e%2fserver%2fconfig.js',
    '/..%252f..%252f.env',
    '/%00',
    '/../.env',
    '/%2e%2e/.env',
    // The sibling-directory escape. Without the `root + path.sep` suffix on the containment
    // check, `<root>-secrets/leak.txt` passes a bare startsWith(root) and is served. Note the
    // encoded SLASH: WHATWG URL parsing already collapses a bare `%2e%2e` segment, so an
    // encoded separator is the only way an escape survives to reach path.resolve.
    '/%2e%2e%2fstatic-secrets%2fleak.txt',
    // Containment is checked before the extension-less shell fallback, so this escapes too.
    '/%2e%2e%2fstatic-secrets%2fleak',
    '/public-secrets/x.txt',
    '/%2e%2e%2f%2e%2e%2f.npmrc',
  ];

  for (const url of mustBe404) {
    const res = await injectRequest(app, { url });
    assert.equal(res.status, 404, `${url} must be 404`);
    assert.ok(!res.body.includes('TOP_SECRET'), `${url} leaked the sibling directory`);
  }

  // These two normalize to extension-less in-root paths (`/\evil.com` parses as a
  // network-path reference whose pathname is just "/"), so the correct answer is the shell.
  // What matters is that neither reaches outside the root.
  for (const url of ['/\\evil.com', '/public-secrets/x']) {
    const res = await injectRequest(app, { url });
    assert.ok(res.status === 404 || res.status === 200, `${url} unexpected status ${res.status}`);
    if (res.status === 200) assert.match(res.body, /FIXTURE_INDEX_SHELL/);
    assert.ok(!res.body.includes('TOP_SECRET'), `${url} leaked the sibling directory`);
  }
});

test('static declines a non-GET/HEAD method so the router can 405 it', async () => {
  const app = makeApp({ publicDir: STATIC_DIR });
  const res = await injectRequest(app, { method: 'POST', url: '/index.html', body: {} });
  assert.equal(res.status, 404, 'no route matches, and static will not answer a POST');
  assert.match(res.headers['content-type'], /^application\/json/);
});

// --------------------------------------------------------------------------- cookies

test('serializeCookie defaults to HttpOnly; SameSite=Lax and adds Secure only in production', () => {
  const dev = testConfig();
  const prod = testConfig({ NODE_ENV: 'production' });

  const devCookie = serializeCookie('bc_sid', 'raw-token', { maxAge: 2592000, secure: dev.isProduction });
  assert.match(devCookie, /^bc_sid=raw-token;/);
  assert.match(devCookie, /HttpOnly/);
  assert.match(devCookie, /SameSite=Lax/);
  assert.match(devCookie, /Path=\//);
  assert.equal(attrOf(devCookie, 'Max-Age'), '2592000');
  assert.equal(attrOf(devCookie, 'Secure'), null, 'Secure on http://localhost would drop the cookie');

  const prodCookie = serializeCookie('bc_sid', 'raw-token', { secure: prod.isProduction });
  assert.equal(attrOf(prodCookie, 'Secure'), true);

  // SameSite=Strict would withhold the cookie on the OAuth callback navigation, so Lax is
  // the required default, not a relaxation.
  assert.equal(attrOf(prodCookie, 'SameSite'), 'Lax');
});

test('bc_csrf opts out of HttpOnly by design, and SameSite=None demands Secure', () => {
  const csrf = serializeCookie('bc_csrf', 'abc', { httpOnly: false });
  assert.equal(attrOf(csrf, 'HttpOnly'), null);
  assert.throws(() => serializeCookie('x', 'y', { sameSite: 'None' }), /requires Secure/);
  assert.throws(() => serializeCookie('bad name', 'y'), /Invalid cookie name/);
});

test('clearCookie empties the value and expires it immediately', () => {
  const cleared = clearCookie('bc_oauth', { path: '/api/auth' });
  assert.match(cleared, /^bc_oauth=;/);
  assert.equal(attrOf(cleared, 'Max-Age'), '0');
  // Path must match what was set or the browser keeps the original alongside the empty one.
  assert.equal(attrOf(cleared, 'Path'), '/api/auth');
});

test('parseCookies returns a Map, decodes values, and takes the first duplicate', () => {
  const jar = parseCookies('bc_sid=a%20b; bc_csrf="quoted"; bc_sid=second; junk; =empty');
  assert.ok(jar instanceof Map);
  assert.equal(jar.get('bc_sid'), 'a b');
  assert.equal(jar.get('bc_csrf'), 'quoted');
  assert.equal(jar.size, 2);
  assert.equal(parseCookies(undefined).size, 0);

  const roundTrip = serializeCookie('bc_sid', 'a b;c', {});
  assert.equal(parseCookies(roundTrip.split(';')[0]).get('bc_sid'), 'a b;c');
});

// --------------------------------------------------------------------------- cors

test('CORS is inert on a single origin but always sets Vary', async () => {
  const app = makeApp();

  const foreign = await injectRequest(app, { url: '/api/echo/1', headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);
  assert.match(foreign.headers.vary, /Origin/);

  const same = await injectRequest(app, { url: '/api/echo/1', headers: { origin: 'http://localhost:3000' } });
  assert.equal(same.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.equal(same.headers['access-control-allow-credentials'], 'true');

  for (const res of [foreign, same]) {
    assert.notEqual(res.headers['access-control-allow-origin'], '*', 'never * with credentials');
  }
});

test('corsHeaders never echoes a configured wildcard', () => {
  const config = { corsAllowedOrigins: ['*'] };
  const headers = corsHeaders({ headers: { origin: '*' } }, config);
  assert.deepEqual(Object.keys(headers), ['Vary']);
  assert.deepEqual(corsHeaders({ headers: {} }, config), { Vary: 'Origin, Authorization, Cookie' });
});

test('a preflight is answered 204 with the credentialed header set', async () => {
  const app = makeApp();
  const res = await injectRequest(app, {
    method: 'OPTIONS',
    url: '/api/echo',
    headers: {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-csrf-token',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
  assert.match(res.headers['access-control-allow-headers'], /X-CSRF-Token/);
  assert.match(res.headers['access-control-allow-methods'], /POST/);
  assert.equal(res.headers['access-control-max-age'], '86400');
  assert.match(res.headers.vary, /Access-Control-Request-Headers/);
});

test('a preflight from an unlisted origin gets 204 without the Allow-* headers', async () => {
  const app = makeApp();
  const res = await injectRequest(app, {
    method: 'OPTIONS',
    url: '/api/echo',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

// --------------------------------------------------------------------------- redact + log

test('redact replaces nested secrets and header values but leaves ordinary fields alone', () => {
  const input = {
    athlete_id: 12345678,
    display_name: 'Julien C.',
    miles: 412.8,
    token_version: 3,
    tokens: { access_token: 'a1b2c3', refresh_token: 'r9', expires_at: 1780000000 },
    headers: { cookie: 'bc_sid=raw', authorization: 'Bearer raw', 'set-cookie': ['bc_sid=raw'], 'x-csrf-token': 'c' },
    query: { code: 'oauth-code', state: 'signed-state' },
    missing_token: null,
  };

  const safe = redact(input);

  assert.equal(safe.tokens.access_token, '[redacted]');
  assert.equal(safe.tokens.refresh_token, '[redacted]');
  assert.equal(safe.headers.cookie, '[redacted]');
  assert.equal(safe.headers.authorization, '[redacted]');
  assert.equal(safe.headers['set-cookie'], '[redacted]');
  assert.equal(safe.headers['x-csrf-token'], '[redacted]');
  assert.equal(safe.query.code, '[redacted]');
  assert.equal(safe.query.state, '[redacted]');

  assert.equal(safe.athlete_id, 12345678);
  assert.equal(safe.display_name, 'Julien C.');
  assert.equal(safe.miles, 412.8);
  assert.equal(safe.tokens.expires_at, 1780000000);
  // Anchored suffix matching: token_version explains a CAS failure and must survive.
  assert.equal(safe.token_version, 3);
  // A null secret reports as null: "no token was set" is the useful half of a 401 log line.
  assert.equal(safe.missing_token, null);

  // A deep clone, so the caller's object is never mutated out from under it.
  assert.equal(input.tokens.access_token, 'a1b2c3');
  assert.ok(SENSITIVE_KEYS.includes('access_token'));
});

test('redact survives a circular reference without hanging', () => {
  const node = { name: 'a', secret: 's' };
  node.self = node;
  node.children = [{ parent: node }];

  const safe = redact(node);
  assert.equal(safe.self, '[circular]');
  assert.equal(safe.children[0].parent, '[circular]');
  assert.equal(safe.secret, '[redacted]');
  // Must remain JSON-serializable, since that is the next thing the logger does with it.
  assert.ok(JSON.stringify(safe).length > 0);
});

test('redact makes bigints, URLs, buffers, and errors JSON-safe', () => {
  const safe = redact({
    id: 15000000001n,
    url: new URL('https://www.strava.com/oauth/token?code=leaky&state=leaky'),
    blob: Buffer.from('binary'),
    err: Object.assign(new Error('nope'), { status: 502 }),
    nan: Number.NaN,
    when: new Date(0),
  });

  assert.equal(safe.id, '15000000001');
  assert.equal(safe.url, 'https://www.strava.com/oauth/token', 'the query string is dropped whole');
  assert.match(safe.blob, /^\[Buffer 6 bytes\]$/);
  assert.equal(safe.err.message, 'nope');
  assert.equal(safe.err.status, 502);
  assert.equal(safe.nan, 'NaN');
  assert.equal(safe.when, '1970-01-01T00:00:00.000Z');
  assert.doesNotThrow(() => JSON.stringify(safe));
});

test('every log field passes through redact, including bound child fields', () => {
  const captured = [];
  setLogSink((r) => captured.push(r));
  try {
    log.child({ access_token: 'bound-secret', athlete_id: 7 }).warn('sync failed', { refresh_token: 'per-call' });
  } finally {
    setLogSink((r) => records.push(r));
  }

  assert.equal(captured.length, 1);
  assert.equal(captured[0].msg, 'sync failed');
  assert.equal(captured[0].level, 'warn');
  assert.equal(captured[0].access_token, '[redacted]');
  assert.equal(captured[0].refresh_token, '[redacted]');
  assert.equal(captured[0].athlete_id, 7);
  assert.match(captured[0].ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('no request in this run logged the sentinel client secret', () => {
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes('SENTINEL_CLIENT_SECRET'), 'the sentinel secret reached a log line');
});

/** A minimal ServerResponse stand-in for the direct-call assertions above. */
function fakeRes() {
  return {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    bodyText: '',
    req: { method: 'GET' },
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk) this.bodyText = String(chunk);
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}
