import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openD1 } from './db/d1.js';
import { buildRoutes } from './routes/index.js';
import { createStravaClient } from './strava/client.js';
import { log } from './lib/log.js';

/**
 * The Cloudflare Worker entry point. The counterpart to server/index.js, which owns the
 * socket, the filesystem and the process on a Mac.
 *
 * WHY THIS IS A SEPARATE FILE and index.js was not adapted: index.js runs `await main()` at
 * module scope. Point wrangler at it and the Worker would try to open a TCP socket, read
 * `public/` off a filesystem that does not exist, and install SIGTERM handlers, all during
 * module evaluation -- before the first request. Keeping them separate is also what leaves
 * `npm start` working unchanged for local development.
 *
 * The interesting work is the adapter at the bottom: `server/app.js` speaks Node's
 * `(req, res)`, and a Worker speaks `Request -> Response`. Rather than rewrite the HTTP kernel
 * (two dozen call sites of `writeHead`/`end`, all of them security-relevant), this file
 * presents the small slice of that interface the kernel actually touches.
 */

/**
 * Per-isolate cache.
 *
 * A Worker isolate serves many requests, so config validation, the D1 wrapper, the Strava
 * client and the route table are built once and reused. Keyed on the `env` object identity: it
 * is stable for the life of an isolate, and re-deriving on a miss is what keeps this correct if
 * that ever stops being true.
 */
let cached = null;

function getDeps(env) {
  if (cached?.env === env) return cached;

  // Config is validated and frozen before anything else exists, exactly as on the Node path.
  // A bad SESSION_SECRET or a WEB_BASE_PATH with an origin in it must fail here, loudly, and
  // not at some rider's first login. `loadEnvFile` stays false: there is no filesystem.
  const config = loadConfig(env);
  const db = openD1(env.DB);

  const strava = createStravaClient({
    apiBase: config.stravaApiBase,
    oauthBase: config.stravaOauthBase,
    clientId: config.stravaClientId,
    // The secret's ONLY consumer. It reaches no other module, no response, and no log line.
    clientSecret: config.stravaClientSecret,
    redirectUri: config.redirectUri,
    logger: stravaLogger,
  });

  const routes = buildRoutes({ config, db, strava });
  // publicDir stays null: GitHub Pages serves public/, and http/static.js is the one module
  // that needs node:fs. app.js only imports it lazily, so a Worker never loads it at all.
  const app = buildApp({ config, db, routes, publicDir: null });

  cached = { env, config, db, app };
  return cached;
}

/**
 * Adapt server/lib/log.js to the shape strava/client.js expects. Identical to the adapter in
 * index.js, and duplicated rather than shared because it is four lines and lives next to the
 * client construction it serves.
 */
const stravaLogger = {
  debug: ({ event, ...fields }) => log.info(event ?? 'strava', fields),
  info: ({ event, ...fields }) => log.info(event ?? 'strava', fields),
  warn: ({ event, ...fields }) => log.warn(event ?? 'strava', fields),
  error: ({ event, ...fields }) => log.error(event ?? 'strava', fields),
};

export default {
  /**
   * @param {Request} request
   * @param {{DB: D1Database}} env wrangler.toml `[vars]`, `wrangler secret put` values, and
   *        the D1 binding, all on one object -- which is exactly what loadConfig() takes.
   * @param {{waitUntil: (p: Promise<any>) => void}} ctx
   */
  async fetch(request, env, ctx) {
    let app;
    try {
      app = getDeps(env).app;
    } catch (err) {
      // A configuration or binding failure. There is no rider action that fixes this, and a
      // stack trace in the body would leak internals, so the detail goes to `wrangler tail`.
      log.error('worker startup failed', {
        error_name: err?.name,
        error_message: err?.message,
        stack: err?.stack,
      });
      return jsonResponse(500, { error: 'internal', message: 'Internal server error.' });
    }

    return handleWithNodeApi(app, request, ctx);
  },
};

/* ================================ the (req,res) adapter ================================ */

const NO_BODY_STATUSES = new Set([204, 205, 304]);

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/**
 * Run a Node-style `(req, res)` handler against a fetch `Request` and return its `Response`.
 *
 * The surface below is not a general shim -- it is precisely what server/http/* touches, and
 * nothing more. Every member is here because a specific call site needs it:
 *
 *   req.method/url/headers  routing, CORS, CSRF, cookies
 *   req[Symbol.asyncIterator] body.js counts bytes as they arrive rather than trusting
 *                           Content-Length, so it consumes the request as a stream
 *   req.destroy()           body.js stops reading after a 413 instead of buffering the rest
 *   req.res                 app.js links them so body.js can write its 413
 *   res.setHeader           app.js sets Vary/CORS before any handler runs
 *   res.writeHead(s, h)     respond.js, merging over whatever setHeader already set
 *   res.end(body)           every response
 *   res.statusCode          the request log line
 *   res.headersSent/        respond.js#sendError refuses to write a second response
 *     writableEnded
 *   res.destroy()           the same path, when one is already half-sent
 *   res.on('finish')        app.js logs the request there
 *   res.req                 respond.js checks it for HEAD, to suppress the body
 */
function handleWithNodeApi(app, request, ctx) {
  return new Promise((resolve) => {
    const url = new URL(request.url);

    /**
     * The reader for the request body, created on first read.
     *
     * Held here rather than locally in the iterator because `req.destroy()` has to cancel
     * through the SAME reader: `ReadableStream.cancel()` on a stream that a reader has locked
     * throws ERR_INVALID_STATE, and it throws asynchronously, so the 413 path would surface as
     * an unhandled rejection *after* the response had already gone out.
     */
    let bodyReader = null;

    const req = {
      method: request.method,
      // Path + query only. app.js resolves this against a fixed base and never reads the host
      // (`Host: ]` would otherwise be a 500, and `/\evil.com` parses as a different host).
      url: `${url.pathname}${url.search}`,
      headers: headersToObject(request.headers),
      res: undefined,
      destroy() {
        // Stop reading; the remaining megabytes are never buffered. Best-effort, because the
        // body may be absent, already drained, or cancelled by an earlier call.
        try {
          if (bodyReader !== null) void bodyReader.cancel().catch(() => {});
          else void request.body?.cancel().catch(() => {});
        } catch {
          /* nothing left to cancel */
        }
      },
      /** Yields Uint8Array chunks. `.length` is the byte count, which is what body.js sums. */
      async *[Symbol.asyncIterator]() {
        const body = request.body;
        if (!body) return;
        bodyReader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await bodyReader.read();
            if (done) return;
            if (value) yield value;
          }
        } catch {
          // A cancel() from destroy() surfaces here as a read rejection. body.js has already
          // written its 413 by then, so there is nothing left to report.
          return;
        }
      },
    };

    /** Header names are case-insensitive; `Headers` handles that, including multi Set-Cookie. */
    const headers = new Headers();
    const finishListeners = [];
    let settled = false;

    const res = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      writableFinished: false,
      req,

      setHeader(name, value) {
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
          headers.delete(name);
          for (const v of value) headers.append(name, String(v));
        } else {
          headers.set(name, String(value));
        }
      },

      getHeader(name) {
        return headers.get(name) ?? undefined;
      },

      removeHeader(name) {
        headers.delete(name);
      },

      /** writeHead MERGES over setHeader, later winning -- the Node behaviour app.js relies on
       *  when it sets Vary once and lets each handler build its own header object. */
      writeHead(status, headerObject = {}) {
        res.statusCode = status;
        for (const [name, value] of Object.entries(headerObject ?? {})) res.setHeader(name, value);
        res.headersSent = true;
        return res;
      },

      end(body) {
        if (settled) return res;
        settled = true;
        res.headersSent = true;
        res.writableEnded = true;
        res.writableFinished = true;

        // A 204/304 with a body, or any body on a HEAD, is a runtime error in the Response
        // constructor rather than something the browser forgives.
        const suppress = NO_BODY_STATUSES.has(res.statusCode) || req.method === 'HEAD';
        resolve(new Response(suppress || body === undefined ? null : body, {
          status: res.statusCode,
          headers,
        }));

        // After the Response is handed back, so a throwing listener cannot lose the response.
        for (const fn of finishListeners) {
          try {
            fn();
          } catch (err) {
            log.error('finish listener threw', { error_message: err?.message });
          }
        }
        return res;
      },

      /** No socket to kill, so this is the only honest translation: a bare 500. sendError
       *  reaches here only when a response is already half-written, which cannot happen on
       *  this adapter (nothing is sent until `end`), so it is a belt-and-braces path. */
      destroy() {
        if (settled) return;
        settled = true;
        resolve(new Response(null, { status: 500 }));
      },

      on(event, listener) {
        if (event === 'finish') finishListeners.push(listener);
        return res;
      },
      once(event, listener) {
        return res.on(event, listener);
      },
      removeListener() {
        return res;
      },
      emit() {
        return false;
      },
    };

    // Mirrors what app.js does for the Node path; set here too so body.js has it even on the
    // paths that reach it before app.js runs.
    req.res = res;

    void ctx; // waitUntil is unused: nothing in this app depends on post-response work.

    Promise.resolve()
      .then(() => app(req, res))
      .catch((err) => {
        // app.js catches everything it can and turns it into a response. Reaching here means
        // the kernel itself threw, so there is no safe body to send.
        log.error('unhandled worker error', {
          error_name: err?.name,
          error_message: err?.message,
          stack: err?.stack,
        });
        if (!settled) {
          settled = true;
          resolve(jsonResponse(500, { error: 'internal', message: 'Internal server error.' }));
        }
      });
  });
}

/**
 * `Headers` -> a lowercase plain object, the shape `req.headers` has in Node.
 *
 * `cookie` is the one header that can legitimately arrive more than once, and a runtime that
 * joins those repeats with ', ' produces a header parseCookies would read as one mangled name,
 * making every session look absent. It has to be undone on the joined string: `getAll` is not
 * an option, because both workerd and undici restrict it to 'Set-Cookie' -- workerd throws
 * `TypeError: getAll() can only be used with the header name "Set-Cookie"` for any other name,
 * and undici does not define the method at all.
 */
function headersToObject(headers) {
  const out = Object.create(null);
  for (const [name, value] of headers) out[name.toLowerCase()] = value;
  if (out.cookie) out.cookie = out.cookie.replace(COOKIE_HEADER_JOIN, '; ');
  return out;
}

/**
 * A ', ' that joined two Cookie headers, as opposed to a comma inside a cookie value.
 *
 * RFC 6265 cookie-octet excludes both comma and semicolon, so an unquoted comma in a Cookie
 * header is always a join; requiring a `name=` after it keeps a quoted value that does contain
 * one intact. Undici already joins cookies with '; ', which this leaves untouched.
 */
const COOKIE_HEADER_JOIN = /,\s*(?=[^\s=;,]+=)/g;

/** Exported for the test suite, which drives the adapter without a Workers runtime. */
export { handleWithNodeApi };
