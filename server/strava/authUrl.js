import { REQUESTED_SCOPE, REQUIRED_SCOPE_ANY, SCOPE_READ, SCOPE_READ_ALL } from '../contracts.js';
import { StravaScopeError } from './client.js';

/**
 * Everything about the /oauth/authorize leg. Pure string building plus one guard.
 *
 * Kept out of client.js because none of it is an HTTP call: the authorize step is a
 * top-level browser NAVIGATION, never a fetch (a fetch to a cross-origin 302 CORS-fails
 * and looks like a network outage).
 */

/**
 * The redirect_uri we send and Strava echoes back.
 *
 * Always derived server-side from API_BASE_URL, never from a request parameter: without
 * PKCE, refusing to echo a client-supplied redirect target is the only thing standing
 * between this app and redirect injection.
 */
export function redirectUri(config) {
  if (config?.redirectUri) return config.redirectUri;
  if (!config?.apiBaseUrl) throw new TypeError('redirectUri: config.apiBaseUrl is required.');
  return `${config.apiBaseUrl}/api/auth/strava/callback`;
}

/**
 * Build the Strava consent URL.
 *
 * `approval_prompt=force` is used by the reconnect route: with `auto`, an athlete who
 * already granted (and then revoked in Strava's settings, or who needs to add a scope) is
 * bounced straight back with the old grant and never sees the consent screen, so
 * "Reconnect" appears to do nothing.
 */
export function buildAuthorizeUrl(config, { state, approvalPrompt = 'auto' } = {}) {
  if (typeof state !== 'string' || state === '') {
    throw new TypeError('buildAuthorizeUrl: a non-empty state is required (see security/oauthState.js).');
  }
  if (approvalPrompt !== 'auto' && approvalPrompt !== 'force') {
    throw new TypeError(`buildAuthorizeUrl: approvalPrompt must be 'auto' or 'force', got ${JSON.stringify(approvalPrompt)}.`);
  }
  if (!config?.stravaOauthBase) throw new TypeError('buildAuthorizeUrl: config.stravaOauthBase is required.');
  if (!config?.stravaClientId) throw new TypeError('buildAuthorizeUrl: config.stravaClientId is required.');

  const url = new URL(`${config.stravaOauthBase.replace(/\/+$/, '')}/authorize`);
  url.searchParams.set('client_id', String(config.stravaClientId));
  url.searchParams.set('redirect_uri', redirectUri(config));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('approval_prompt', approvalPrompt);
  // We ASK for activity:read_all; the rider may uncheck it. What we asked for is never
  // treated as what we got -- see assertScope.
  url.searchParams.set('scope', REQUESTED_SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Accept the granted scope, returning which activity read level we actually have.
 *
 * Two things this must not do:
 *
 *  - It must not require `activity:read_all`. Strava's consent screen lets the rider
 *    uncheck individual boxes; a rider who declines private-activity access still has
 *    perfectly countable public rides, and hard-requiring read_all turns a privacy
 *    preference into a permanent lockout.
 *  - It must not be called on REQUESTED_SCOPE. The `scope` query parameter on the OAuth
 *    callback is the only authoritative statement of what was granted.
 *
 * @param {string} scopeCsv the callback's ?scope= value
 * @returns {'read_all'|'read'}
 */
export function assertScope(scopeCsv) {
  const granted = typeof scopeCsv === 'string' ? scopeCsv : '';
  // Strava returns comma-separated on the callback; OAuth2 itself specifies
  // space-separated, and the token response has been observed both ways. Split on either
  // rather than betting on one. [UNVERIFIED] which the token endpoint uses today.
  const scopes = new Set(granted.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));

  if (scopes.has(SCOPE_READ_ALL)) return 'read_all';
  if (scopes.has(SCOPE_READ)) return 'read';

  throw new StravaScopeError('Strava granted neither activity:read_all nor activity:read; no rides can be read.', {
    granted,
    required: [...REQUIRED_SCOPE_ANY],
    code: 'insufficient_scope',
    path: '/oauth/authorize',
  });
}
