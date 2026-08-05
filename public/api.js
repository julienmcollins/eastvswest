/**
 * The ONLY module in public/ that calls fetch(). Nothing else may.
 *
 * That is what makes the deploy split a one-file change: every credential concern
 * (cookies, CSRF double-submit, the bearer fallback) and every origin concern lives here
 * and in config.js. It also means there is exactly one place to audit for "does this
 * request carry credentials it shouldn't".
 *
 * No DOM access at import time — `document` and `localStorage` are touched only inside
 * functions, behind typeof guards, so this file can be imported in Node by
 * test/frontend-contract.test.js (and so Safari private mode's throwing localStorage does
 * not take the page down at parse time).
 */

import { API_BASE, CSRF_COOKIE, TOKEN_STORAGE_KEY } from './config.js?v=1';

/**
 * Every non-2xx response and every network failure surfaces as this. Callers switch on
 * `.code` (the server's snake_case `error` field), never on `.message`.
 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status, or 0 for a transport failure
   * @param {string} code machine-readable error code
   * @param {unknown} body the parsed response body, if any
   * @param {string} [message] human-readable text
   */
  constructor(status, code, body, message) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body ?? null;
  }

  /** Seconds the server asked us to wait, when it said so. */
  get retryAfterSeconds() {
    const n = Number(this.body?.retry_after_seconds);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /** Where to send the rider to re-grant access, when the server offers it. */
  get reauthUrl() {
    return typeof this.body?.reauth_url === 'string' ? this.body.reauth_url : null;
  }
}

/**
 * Read a cookie value. `bc_csrf` is deliberately NOT HttpOnly so this can see it; the
 * session cookie is HttpOnly and is never visible here.
 *
 * @param {string} name
 * @returns {string|null}
 */
function readCookie(name) {
  if (typeof document === 'undefined' || typeof document.cookie !== 'string') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/** @returns {string|null} the stored bearer token, or null. Never throws. */
export function storedToken() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(TOKEN_STORAGE_KEY);
    return typeof v === 'string' && v !== '' ? v : null;
  } catch {
    return null; // private-mode / disabled storage
  }
}

/** Persist a bearer token adopted from the URL fragment. Never throws. */
export function storeToken(token) {
  try {
    if (typeof localStorage === 'undefined' || typeof token !== 'string' || token === '') return;
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    /* storage unavailable: the cookie path still works */
  }
}

/** Drop every locally held credential. Never throws. */
export function clearStoredToken() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* nothing we can do, and nothing we should throw over */
  }
}

/**
 * @param {string} path a `/api/...` path
 * @returns {string} absolute URL, or the same path when API_BASE is same-origin
 */
export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

/**
 * The single fetch call site.
 *
 * @param {string} path
 * @param {{method?: string, body?: unknown, signal?: AbortSignal}} [options]
 * @returns {Promise<any>} parsed JSON, or null for 204
 * @throws {ApiError}
 */
async function request(path, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase();
  const mutating = method !== 'GET' && method !== 'HEAD';

  const headers = { Accept: 'application/json' };
  const init = {
    method,
    headers,
    // Sends bc_sid today; still required after the deploy split, alongside
    // Access-Control-Allow-Credentials on the API side.
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    signal: options.signal,
  };

  if (mutating) {
    // The server requires all three of: application/json, an allow-listed Origin, and
    // X-CSRF-Token matching the bc_csrf cookie. Two of the three are ours to send.
    headers['Content-Type'] = 'application/json';
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf !== null) headers['X-CSRF-Token'] = csrf;
    init.body = JSON.stringify(options.body ?? {});
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  // Bearer only when one exists. On the shared-domain deploy it never does, so no
  // preflight is provoked; on the cross-site path every request preflights because
  // Authorization is not a safelisted header (see docs/SPEC.md deploy note 3).
  const token = storedToken();
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(apiUrl(path), init);
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new ApiError(0, 'network_error', null, 'Could not reach the server.');
  }

  const payload = await parseBody(response);

  if (!response.ok) {
    const code = typeof payload?.error === 'string' ? payload.error : `http_${response.status}`;
    const message = typeof payload?.message === 'string' ? payload.message : undefined;
    const error = new ApiError(response.status, code, payload, message);
    // Retry-After needs Access-Control-Expose-Headers cross-origin, which is exactly why
    // the body also carries retry_after_seconds. Prefer the body, fall back to the header.
    if (error.retryAfterSeconds === null) {
      const header = Number(response.headers.get('Retry-After'));
      if (Number.isFinite(header) && header >= 0) error.body = { ...(payload ?? {}), retry_after_seconds: header };
    }
    throw error;
  }
  return payload;
}

/**
 * @param {Response} response
 * @returns {Promise<any>} parsed JSON, or null when there is no JSON body. Never throws.
 */
async function parseBody(response) {
  if (response.status === 204) return null;
  let text;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    // Unknown /api/* paths return JSON 404s by contract, so HTML here means something is
    // seriously misrouted. Report it as data rather than letting SyntaxError escape.
    return { error: 'non_json_response', message: 'The server returned a non-JSON response.' };
  }
}

/** GET /api/me — 200 with `rider: null` when logged out, never 401. */
export function getMe(signal) {
  return request('/api/me', { signal });
}

/** GET /api/leaderboard — 200 always; the empty state is zeroed teams and `riders: []`. */
export function getLeaderboard(signal) {
  return request('/api/leaderboard', { signal });
}

/** POST /api/me/team — one-time claim. 409 `team_already_set` if it is already locked. */
export function setTeam(team) {
  return request('/api/me/team', { method: 'POST', body: { team } });
}

/**
 * POST /api/me/sync — the response embeds an entire /api/leaderboard payload, so Refresh
 * is one round trip.
 * @param {'incremental'|'full'} [mode] omit to let the server choose
 */
export function syncNow(mode) {
  return request('/api/me/sync', { method: 'POST', body: mode ? { mode } : {} });
}

/** POST /api/me/disconnect — deauthorises at Strava, keeps the team and history. */
export function disconnect() {
  return request('/api/me/disconnect', { method: 'POST' });
}

/** GET /api/riders/:id/activities */
export function riderActivities(athleteId, query = '') {
  return request(`/api/riders/${encodeURIComponent(athleteId)}/activities${query}`);
}

/**
 * POST /api/auth/logout, then clear local credentials in a `finally`.
 *
 * The `finally` is the whole point: if the server 502s, "log out" must still log you out
 * of this browser rather than leaving a zombie bearer token that keeps working. Resolves
 * rather than throwing so the caller always reaches its reload.
 *
 * @returns {Promise<{ok: boolean, error: ApiError|null}>}
 */
export async function logout() {
  let error = null;
  try {
    await request('/api/auth/logout', { method: 'POST' });
  } catch (cause) {
    error = cause instanceof ApiError ? cause : new ApiError(0, 'logout_failed', null, String(cause));
  } finally {
    clearStoredToken();
  }
  return { ok: error === null, error };
}

/**
 * Start the OAuth dance as a TOP-LEVEL NAVIGATION.
 *
 * Never a fetch: /api/auth/strava/login answers 302 to strava.com, and a cross-origin
 * redirect chain fails CORS — the user would see nothing at all.
 *
 * @param {{reconnect?: boolean}} [options] reconnect forces Strava's consent screen again
 */
export function startLogin(options = {}) {
  const path = options.reconnect ? '/api/auth/strava/reconnect' : '/api/auth/strava/login';
  const url = apiUrl(path);
  if (typeof location === 'undefined') return url; // importable in Node
  location.assign(url);
  return url;
}

/** The href to put on the "Connect with Strava" anchor, so it works before JS binds. */
export function loginHref(options = {}) {
  return apiUrl(options.reconnect ? '/api/auth/strava/reconnect' : '/api/auth/strava/login');
}
