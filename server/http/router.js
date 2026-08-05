import { ERROR_CODES } from '../contracts.js';
import { HttpError, sendNoContent } from './respond.js';

/**
 * A segment router with `:param` capture.
 *
 * Two behaviours here are worth the code they cost:
 *
 *  - A path that exists under another method answers **405 with an accurate Allow header**,
 *    not 404. `POST /api/me/teams` (plural) and `PUT /api/me/team` are different mistakes
 *    and a 404 for both sends you looking at the wrong half of the stack.
 *  - `use(matcherOrPredicate, middleware)` applies one guard to a whole set of routes in a
 *    single call. requireCsrf on every mutating route and requireAdmin on `/api/admin/*`
 *    are registered once each; a per-handler check is how exactly one endpoint ends up
 *    missing it.
 */

/** Middleware only ever runs for a matched route, so a 404 cannot trip a CSRF check. */
export function createRouter() {
  const routes = [];
  const middleware = [];

  /** '/api/me/team' -> ['api','me','team'], '/' -> []. Trailing slashes are insignificant. */
  function segmentsOf(pathname) {
    const out = [];
    for (const part of pathname.split('/')) {
      if (part !== '') out.push(part);
    }
    return out;
  }

  function compile(pattern) {
    if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
      throw new TypeError(`Route pattern must start with "/", got ${JSON.stringify(pattern)}`);
    }
    return segmentsOf(pattern).map((part) => {
      if (part === '*') return { kind: 'wildcard' };
      if (part.startsWith(':')) {
        const name = part.slice(1);
        if (name === '') throw new TypeError(`Route pattern has an unnamed parameter: ${pattern}`);
        return { kind: 'param', name };
      }
      return { kind: 'literal', value: part };
    });
  }

  function add(method, pattern, handler, opts = {}) {
    if (typeof handler !== 'function') throw new TypeError(`Handler for ${method} ${pattern} is not a function.`);
    const upper = String(method).toUpperCase();
    routes.push({ method: upper, pattern, segments: compile(pattern), handler, opts });
  }

  /**
   * @param {string|((ctx:object)=>boolean)} matcherOrPredicate a path prefix, or a predicate
   *   over the resolved ctx (which carries `method`, `pathname`, and the matched `route`, so
   *   `(c) => c.route.opts.csrf` and `(c) => MUTATING.has(c.method)` both work).
   * @param {(req:object,res:object,ctx:object)=>any} fn throws an HttpError to reject, or
   *   writes the response itself to short-circuit.
   */
  function use(matcherOrPredicate, fn) {
    // One-argument form: applies to every matched route.
    if (fn === undefined && typeof matcherOrPredicate === 'function') {
      middleware.push({ test: () => true, fn: matcherOrPredicate });
      return;
    }
    if (typeof fn !== 'function') throw new TypeError('use() needs a middleware function.');

    if (typeof matcherOrPredicate === 'function') {
      middleware.push({ test: matcherOrPredicate, fn });
      return;
    }

    const prefix = String(matcherOrPredicate);
    const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
    // `pathname === prefix` is checked separately so `use('/api/admin', ...)` also covers a
    // route registered at exactly '/api/admin'.
    middleware.push({ test: (ctx) => ctx.pathname === prefix || ctx.pathname.startsWith(withSlash), fn });
  }

  function decodeSegment(raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      // '%zz' in a path parameter. 400 rather than 404: the path exists, the escape does not.
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'Request path contains an invalid percent-escape.');
    }
  }

  function matches(route, parts) {
    const params = Object.create(null);
    for (let i = 0; i < route.segments.length; i += 1) {
      const seg = route.segments[i];
      if (seg.kind === 'wildcard') {
        params['*'] = parts.slice(i).map(decodeSegment).join('/');
        return params;
      }
      if (i >= parts.length) return null;
      if (seg.kind === 'literal') {
        if (seg.value !== parts[i]) return null;
      } else {
        const value = decodeSegment(parts[i]);
        // A path parameter is always part of an identity or a lookup key; an empty one is a
        // malformed URL, never a legitimate id.
        if (value === '') return null;
        params[seg.name] = value;
      }
    }
    return route.segments.length === parts.length ? params : null;
  }

  /**
   * @returns {Promise<boolean>} true if the request was answered (or a handler ran), false
   *   if no route pattern matched the path at all -- the caller then decides between a JSON
   *   404 for `/api/*` and the static handler for everything else.
   */
  async function handle(req, res, ctx = {}) {
    const method = String(req.method ?? 'GET').toUpperCase();
    const url = ctx.url ?? new URL(req.url ?? '/', 'http://localhost');
    const pathname = ctx.pathname ?? url.pathname;
    const parts = segmentsOf(pathname);

    let matched = null;
    let params = null;
    const allow = new Set();

    for (const route of routes) {
      const captured = matches(route, parts);
      if (captured === null) continue;

      allow.add(route.method);
      // A GET route answers HEAD: a monitor or a link checker issuing HEAD /api/health must
      // not get a 405, and Node drops the body for us.
      if (route.method === 'GET') allow.add('HEAD');

      if (matched === null && (route.method === method || (method === 'HEAD' && route.method === 'GET'))) {
        matched = route;
        params = captured;
      }
    }

    if (matched === null) {
      if (allow.size === 0) return false;

      allow.add('OPTIONS');
      const allowHeader = [...allow].join(', ');

      // A non-preflight OPTIONS is answered here rather than 405'd; cors.handlePreflight has
      // already taken the requests that are actually preflights.
      if (method === 'OPTIONS') {
        sendNoContent(res, { Allow: allowHeader });
        return true;
      }

      const err = new HttpError(
        405,
        ERROR_CODES.METHOD_NOT_ALLOWED,
        `${method} is not allowed on ${pathname}.`,
        { allow: [...allow] },
      );
      // A 405 without Allow is non-conforming and tells the client nothing.
      err.headers = { Allow: allowHeader };
      throw err;
    }

    ctx.url = url;
    ctx.pathname = pathname;
    ctx.method = method;
    ctx.params = params;
    ctx.route = matched;
    ctx.query = ctx.query ?? url.searchParams;

    for (const { test, fn } of middleware) {
      if (!test(ctx)) continue;
      await fn(req, res, ctx);
      // A middleware that answered the request itself (a redirect, a 304) stops the chain.
      if (res.headersSent || res.writableEnded) return true;
    }

    await matched.handler(req, res, ctx);
    return true;
  }

  return {
    add,
    use,
    handle,
    /** Read-only view, for a startup log line or a route-coverage test. */
    list() {
      return routes.map((r) => ({ method: r.method, pattern: r.pattern, opts: r.opts }));
    },
  };
}
