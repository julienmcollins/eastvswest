import { createReadStream, realpathSync } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { ERROR_CODES } from '../contracts.js';
import { sendJson, sendError } from './respond.js';
import { log } from '../lib/log.js';

/**
 * Local static file serving for `public/`.
 *
 * This is the one file the deploy plan deletes: GitHub Pages serves `public/` directly. It
 * still gets the full traversal treatment, because "temporary" and "internet-facing" have
 * never once been mutually exclusive.
 */

/**
 * Extension allowlist. An allowlist rather than a denylist because the set of things you do
 * NOT want to hand out (`.env`, `.db`, `.db-wal`, `.pem`, `.sqlite`, a stray `.bak`) is
 * open-ended, and every new entry in a denylist is discovered the hard way.
 */
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
});

const ALLOWED_EXTENSIONS = new Set(Object.keys(CONTENT_TYPES));

/**
 * A client that navigates away mid-download makes `pipeline` reject. These three codes are
 * normal browser behaviour, not errors, and treating them as errors floods the log and
 * (before the sendError guard existed) killed the process.
 */
const BENIGN_STREAM_ERRORS = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'EPIPE', 'ECONNRESET']);

/**
 * Real CSP header for local dev; `public/index.html` carries a matching <meta> for the
 * Pages deploy, where nothing sets response headers.
 *
 * `frame-ancestors 'none'` and `X-Frame-Options: DENY` overlap deliberately -- the meta tag
 * cannot express frame-ancestors at all, so the header is the only place it can live.
 */
function buildCsp(config) {
  const connect = ["'self'"];
  // Once the API moves to its own origin, `connect-src 'self'` blocks every fetch the app
  // makes. Deriving it from config keeps that a config flip rather than a code change.
  if (config?.isCrossOrigin && config?.apiBaseUrl) connect.push(config.apiBaseUrl);
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: https:",
    `connect-src ${connect.join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * @param {string} publicDir
 * @param {object} config
 * @returns {(req:object,res:object)=>Promise<boolean>} true if a response was written
 *   (including its own 404s), false if the handler declined the request entirely.
 */
export function createStaticHandler(publicDir, config = {}) {
  const resolved = path.resolve(publicDir);
  // realpath the root ONCE, so the containment check below compares like with like on a
  // machine where the project sits under a symlink (/tmp -> /private/tmp on macOS is the
  // one that bites): otherwise every request looks like an escape attempt.
  let root;
  try {
    root = realpathSync(resolved);
  } catch {
    root = resolved;
  }
  const csp = buildCsp(config);

  /** `abs === root || abs.startsWith(root + sep)`. The separator is the whole point: without
   *  it, a sibling directory named `public-secrets` passes a bare startsWith(root). */
  function contained(abs) {
    return abs === root || abs.startsWith(root + path.sep);
  }

  function notFound(res, pathname) {
    // JSON, not HTML: this handler also answers `/missing.png`, and an HTML error page for a
    // fetch is how you get "Unexpected token '<'".
    sendJson(res, 404, { error: ERROR_CODES.NOT_FOUND, message: `Not found: ${pathname}` });
  }

  return async function serveStatic(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase();
    // A POST to a static path is the router's business (405), not ours.
    if (method !== 'GET' && method !== 'HEAD') return false;

    const rawUrl = String(req.url ?? '/');
    // A NUL truncates the path inside some C-level syscalls, so `/x.html\0.png` can pass an
    // extension check and open a different file. Rejected before anything else looks at it.
    if (rawUrl.includes('\0')) {
      notFound(res, '/');
      return true;
    }

    let pathname;
    try {
      // WHATWG parsing normalizes `..` segments and converts backslashes, so `/\evil.com`
      // never reaches the filesystem as a path. url.host is deliberately ignored: that same
      // input parses as a different HOST, and trusting it would be an open redirect.
      pathname = new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      notFound(res, '/');
      return true;
    }

    // Decode percent-escapes BEFORE resolving: `%2e%2e%2f` is `../` and resolving first
    // would leave it as an innocent-looking single segment. Decoded exactly once -- a value
    // that still contains an escape after one pass (`..%252f`) is not decoded again, it is
    // simply treated as the literal filename it now is.
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      notFound(res, pathname);
      return true;
    }
    if (decoded.includes('\0')) {
      notFound(res, pathname);
      return true;
    }

    let abs = path.resolve(root, decoded.replace(/^\/+/, ''));
    if (!contained(abs)) {
      log.warn('static path traversal rejected', { path: pathname });
      notFound(res, pathname);
      return true;
    }

    // Dotfiles are refused outright, before the extension logic, because
    // path.extname('/.env') is the empty string -- a dotfile would otherwise be treated as an
    // extension-less app route and answered with the shell. Only the final name is tested:
    // `..` segments are traversal and belong to the containment check above, and letting this
    // rule swallow them too would hide a regression in it.
    if (path.basename(abs).startsWith('.')) {
      notFound(res, pathname);
      return true;
    }

    let ext = path.extname(abs).toLowerCase();
    if (ext !== '' && !ALLOWED_EXTENSIONS.has(ext)) {
      notFound(res, pathname);
      return true;
    }

    // Extension-less paths are app routes, so they get the shell. Anything WITH an extension
    // is an asset request: falling back to index.html there would answer `/api.js` (a typo
    // for `/api/js`) with HTML and produce "Unexpected token '<'" instead of a 404.
    if (ext === '') {
      abs = path.join(root, 'index.html');
      ext = '.html';
    }

    let stats;
    try {
      stats = await stat(abs);
    } catch {
      notFound(res, pathname);
      return true;
    }
    if (!stats.isFile()) {
      notFound(res, pathname);
      return true;
    }

    // The containment check above ran on the resolved path; a symlink inside the root can
    // still point outside it, and only realpath sees that.
    try {
      if (!contained(await realpath(abs))) {
        log.warn('static symlink escape rejected', { path: pathname });
        notFound(res, pathname);
        return true;
      }
    } catch {
      notFound(res, pathname);
      return true;
    }

    const isHtml = ext === '.html';
    const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600' });
      res.end();
      return true;
    }

    const headers = {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': String(stats.size),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ETag: etag,
      // The shell must revalidate or a deploy leaves people on last week's JS; the assets it
      // references are versioned with ?v=N, so they can be cached.
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600',
    };
    if (isHtml) {
      headers['Content-Security-Policy'] = csp;
      headers['X-Frame-Options'] = 'DENY';
    }

    res.writeHead(200, headers);
    if (method === 'HEAD') {
      res.end();
      return true;
    }

    try {
      await pipeline(createReadStream(abs), res);
    } catch (err) {
      // The headers are already out at this point, so there is no status left to send. This
      // catch is what keeps a cancelled image download from becoming an unhandled rejection.
      if (BENIGN_STREAM_ERRORS.has(err?.code)) return true;
      sendError(res, err, { log });
    }
    return true;
  };
}
