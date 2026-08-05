import { API_SCHEMA, ERROR_CODES } from './contracts.js';
import { createRouter } from './http/router.js';
import { HttpError, sendError, sendJson } from './http/respond.js';
import { corsHeaders, handlePreflight } from './http/cors.js';
import { parseCookies } from './http/cookies.js';
import { createStaticHandler } from './http/static.js';
import { isoUtcNow } from './lib/dates.js';
import { log } from './lib/log.js';

/**
 * Compose the whole request pipeline into a single `(req, res)` function.
 *
 * It deliberately does NOT call listen(). server/index.js owns the socket, process signal
 * handlers, and the filesystem; this file is reused verbatim by the test harness (which
 * injects requests directly, because listen() is EPERM in the dev sandbox) and later by the
 * serverless adapter. Anything that needs a port belongs in index.js, not here.
 *
 * @param {{config:object, db:object, routes?:object|null, publicDir?:string|null}} deps
 *   `routes` is a pre-built router from server/routes/index.js. When it is null the app
 *   serves only GET /api/health plus static files, which is enough for a smoke test.
 * @returns {(req:object,res:object)=>Promise<void>}
 */
export function buildApp({ config, db, routes = null, publicDir = null }) {
  if (!config) throw new TypeError('buildApp requires a config object.');

  const router = routes ?? healthOnlyRouter();
  const staticHandler = publicDir ? createStaticHandler(publicDir, config) : null;

  return async function app(req, res) {
    const startedAt = Date.now();

    // body.js writes its 413 before destroying the request, which means it needs the
    // response object; Node does not link them, so the link is made once, here.
    if (req.res === undefined) req.res = res;

    let url;
    try {
      // A fixed base, not the Host header: `Host: ]` is a 500 waiting to happen, and nothing
      // downstream may read url.host anyway (`/\evil.com` parses as a different host).
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendError(res, new HttpError(400, ERROR_CODES.BAD_REQUEST, 'Malformed request URL.'), { log });
      return;
    }

    const pathname = url.pathname;

    res.on('finish', () => {
      log.info('request', {
        method: req.method,
        path: pathname,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      });
    });

    try {
      // Set via setHeader rather than passed to each send*: writeHead merges what is already
      // set, so `Vary` cannot be forgotten by a handler that builds its own header object.
      for (const [name, value] of Object.entries(corsHeaders(req, config))) res.setHeader(name, value);

      if (handlePreflight(req, res, config)) return;

      const ctx = {
        config,
        db,
        req,
        res,
        url,
        pathname,
        query: url.searchParams,
        params: Object.create(null),
        /**
         * Parsed once, here, because security/csrf.js and security/guards.js both read
         * `ctx.cookies` and neither should have to remember to parse the header itself --
         * that is the sort of omission that turns a CSRF check into a no-op.
         */
        cookies: parseCookies(req.headers.cookie),
        /** Populated by security/guards.js. Handlers read identity from here and nowhere else. */
        session: null,
        log,
      };

      if (await router.handle(req, res, ctx)) return;

      // An unknown /api/* path is JSON, always. An HTML 404 here surfaces in the browser as
      // "Unexpected token '<' in JSON at position 0", which points at the parser instead of
      // at the typo in the URL.
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        throw new HttpError(404, ERROR_CODES.NOT_FOUND, `Unknown API endpoint: ${pathname}`);
      }

      if (staticHandler && (await staticHandler(req, res))) return;

      throw new HttpError(404, ERROR_CODES.NOT_FOUND, `Not found: ${pathname}`);
    } catch (err) {
      // readJsonBody's 413 is already on the wire by design (written before req.destroy()),
      // so a second response would only produce an ERR_HTTP_HEADERS_SENT crash.
      if (err?.responded === true) return;
      sendError(res, err, { log });
    }
  };
}

/** The fallback router for `routes: null`. Health is here so a deployment can be probed
 *  before any of the Strava wiring exists. */
function healthOnlyRouter() {
  const router = createRouter();
  router.add('GET', '/api/health', (req, res) => {
    sendJson(res, 200, { ok: true, schema: API_SCHEMA, time: isoUtcNow() });
  });
  return router;
}
