import { HttpError } from '../http/respond.js';
import { ERROR_CODES } from '../contracts.js';

/**
 * Route guards. Each one either returns quietly or throws an HttpError, so a handler reads
 * as a straight line and can never "forget the else".
 *
 * The request context these read is built once, before dispatch:
 *
 *   ctx = {
 *     session: { athleteId, expiresAt } | null,   // from security/sessionStore#resolveSession
 *     athlete: <athletes row> | null,             // snake_case, straight from the DB
 *     config,                                     // frozen config, for building reauth URLs
 *   }
 *
 * The single most important property of this file: IDENTITY IS ONLY EVER `ctx.session.athleteId`.
 * No guard, and no handler outside the requireAdmin-gated /api/admin/* prefix, may take an
 * athlete id from a body, a query string, or a path parameter. That is the invariant that
 * makes "act as another rider" structurally impossible rather than merely unimplemented.
 */

/**
 * 409 code for "you are logged in but have not picked a team yet".
 *
 * Not in contracts.ERROR_CODES: that frozen list was written against the documented API
 * table, which has no route returning this yet (the picker is driven by `needs_team` on
 * /api/me). Add it there if a route ever surfaces this to the client.
 */
const TEAM_REQUIRED = 'team_required';

/**
 * Require an authenticated session.
 *
 * 401 (not 403): the credential is missing or expired, so retrying after logging in is the
 * correct advice, and the client distinguishes the two -- 401 opens the Connect flow while
 * 403 shows an error.
 *
 * @returns {{athleteId:number}} the session, so callers can chain
 */
export function requireSession(ctx) {
  const athleteId = ctx?.session?.athleteId;
  if (!Number.isInteger(athleteId) || athleteId <= 0) {
    throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, 'Sign in with Strava to do that.');
  }
  return ctx.session;
}

/**
 * Require that the rider has claimed a team.
 *
 * 409 rather than 403: nothing is forbidden, the account is simply in a state where the
 * request makes no sense, and the fix is a one-click action the client already knows how to
 * offer. Scoring anything for a teamless rider is the actual hazard -- their miles would
 * belong to no column and silently vanish from both team totals.
 *
 * @returns {'EAST'|'WEST'} the claimed team
 */
export function requireTeamChosen(ctx) {
  requireSession(ctx);
  const team = ctx?.athlete?.team;
  if (team !== 'EAST' && team !== 'WEST') {
    throw new HttpError(409, TEAM_REQUIRED, 'Pick your team first.', { needs_team: true });
  }
  return team;
}

/**
 * Require admin.
 *
 * Read from the freshly loaded athlete row, never from anything carried in the session or the
 * token: an admin flag copied into a session at login stays true after the flag is revoked,
 * for as long as that session lives. (Revocation also calls deleteSessionsForAthlete, but
 * this guard must not depend on that having happened.)
 *
 * `is_admin` is a SQLite INTEGER 0/1, so it is compared to 1 rather than trusted as truthy --
 * the string "0" that a JSON round-trip could produce is truthy in JS.
 */
export function requireAdmin(ctx) {
  requireSession(ctx);
  const athlete = ctx?.athlete;
  const isAdmin = Number(athlete?.is_admin ?? athlete?.isAdmin ?? 0) === 1;
  if (!isAdmin) {
    // Deliberately the same generic message a non-admin would get for any forbidden action:
    // confirming that an endpoint exists and is admin-only is free reconnaissance.
    throw new HttpError(403, ERROR_CODES.FORBIDDEN, 'You do not have access to that.');
  }
  return athlete;
}

/**
 * Require that the rider's Strava grant is still live.
 *
 * Applied to routes that will actually call Strava (sync, health), not to reads. A revoked
 * rider must keep their row, their team, their history, and their place on the board with a
 * frozen total -- deleting them mid-competition would silently rewrite the standings -- so
 * this guard blocks the API call, not the account.
 *
 * `reauth_url` is included so the client can render a working "Reconnect" button without
 * hardcoding a server path.
 */
export function requireNotRevoked(ctx) {
  requireSession(ctx);
  const athlete = ctx?.athlete;
  const revokedAt = athlete?.strava_revoked_at ?? athlete?.stravaRevokedAt ?? null;
  if (revokedAt !== null && revokedAt !== undefined) {
    const apiBase = ctx?.config?.apiBaseUrl ?? '';
    throw new HttpError(403, ERROR_CODES.STRAVA_REVOKED, 'Your Strava connection was revoked. Reconnect to keep syncing.', {
      reauth_url: `${apiBase}/api/auth/strava/reconnect`,
    });
  }
  return athlete;
}

export { TEAM_REQUIRED };
