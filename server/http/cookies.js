/**
 * Cookie parsing and serialization. No dependency, and no framework defaults to inherit.
 *
 * The defaults here are the secure ones (`HttpOnly`, `SameSite=Lax`, `Path=/`) so that
 * forgetting an option produces a safe cookie rather than an exposed one; `bc_csrf` has to
 * opt *out* of HttpOnly, which is the direction that gets reviewed.
 */

/** RFC 6265 cookie-name token characters. Anything else can forge a second cookie. */
const NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);

/**
 * Parse a Cookie header into a Map.
 *
 * A Map rather than an object because cookie names come from the client: an attacker
 * sending `__proto__=x` against a plain object literal is a prototype-pollution primitive,
 * and `Object.create(null)` still loses to code that later does `cookies.hasOwnProperty`.
 *
 * @param {string|string[]|undefined} cookieHeader
 * @returns {Map<string,string>}
 */
export function parseCookies(cookieHeader) {
  const out = new Map();
  if (!cookieHeader) return out;

  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : String(cookieHeader);
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    let value = part.slice(eq + 1).trim();
    // A quoted cookie-value is legal and the quotes are not part of the value.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // First occurrence wins: a client that sends bc_sid twice (a stale Domain cookie plus
    // a current host cookie) must not be able to pick the second one by ordering.
    if (out.has(name)) continue;
    try {
      out.set(name, decodeURIComponent(value));
    } catch {
      // A malformed escape is not a reason to drop every other cookie on the request.
      out.set(name, value);
    }
  }
  return out;
}

/**
 * Build one Set-Cookie header value.
 *
 * @param {string} name
 * @param {string} value
 * @param {{maxAge?:number|null, path?:string, httpOnly?:boolean, secure?:boolean,
 *          sameSite?:'Strict'|'Lax'|'None', expires?:Date|null}} opts
 */
export function serializeCookie(name, value, opts = {}) {
  if (!NAME_RE.test(name)) throw new TypeError(`Invalid cookie name: ${JSON.stringify(name)}`);

  const {
    maxAge = null,
    path = '/',
    httpOnly = true,
    // Gated on config.isProduction by every caller -- never on X-Forwarded-Proto, which the
    // client controls and which would let a spoofed header downgrade the session cookie.
    secure = false,
    sameSite = 'Lax',
    expires = null,
  } = opts;

  if (!SAME_SITE.has(sameSite)) throw new TypeError(`Invalid SameSite: ${JSON.stringify(sameSite)}`);
  // Browsers silently DROP a SameSite=None cookie that is not Secure, so the session would
  // simply never arrive and there would be nothing in any log to explain it.
  if (sameSite === 'None' && !secure) throw new TypeError('SameSite=None requires Secure.');
  if (/[\r\n\0]/.test(path)) throw new TypeError('Cookie Path may not contain CR, LF, or NUL.');

  // encodeURIComponent is symmetric with parseCookies' decode and is a no-op on the
  // base64url tokens this app actually stores.
  const parts = [`${name}=${encodeURIComponent(String(value))}`];

  if (maxAge !== null) {
    if (!Number.isInteger(maxAge)) throw new TypeError(`Cookie Max-Age must be an integer, got ${maxAge}.`);
    parts.push(`Max-Age=${maxAge}`);
  }
  if (expires !== null) {
    const d = expires instanceof Date ? expires : new Date(expires);
    if (Number.isNaN(d.getTime())) throw new TypeError('Cookie Expires must be a valid Date.');
    parts.push(`Expires=${d.toUTCString()}`);
  }
  if (path) parts.push(`Path=${path}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  parts.push(`SameSite=${sameSite}`);

  return parts.join('; ');
}

/**
 * Expire a cookie now.
 *
 * `path` (and any Domain) must match what was set or the browser keeps the original cookie
 * alongside the empty one and logout appears to succeed while the session still resolves.
 */
export function clearCookie(name, opts = {}) {
  return serializeCookie(name, '', { ...opts, maxAge: 0, expires: new Date(0) });
}
