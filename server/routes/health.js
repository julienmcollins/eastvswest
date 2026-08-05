import { API_SCHEMA, REQUESTED_SCOPE } from '../contracts.js';
import { sendJson } from '../http/respond.js';
import { isoUtcNow } from '../lib/dates.js';

/**
 * Health endpoints.
 *
 * `GET /api/health` is unauthenticated on purpose: it is what a deploy probe and an uptime
 * monitor call, and requiring a credential there means the monitor tests the credential
 * rather than the service.
 */
export function registerHealthRoutes(router, { config, strava }) {
  router.add('GET', '/api/health', (req, res) => {
    sendJson(res, 200, { ok: true, schema: API_SCHEMA, time: isoUtcNow() });
  });

  /**
   * The rate-limit and quota view. ADMIN ONLY, and it must never carry a token.
   *
   * `admin: true` is honoured by the single admin middleware in routes/index.js -- this
   * route is the reason that middleware takes a predicate rather than just the /api/admin
   * prefix.
   *
   * `strava.rateLimit` is a frozen snapshot of counters (see the getter in strava/client.js):
   * there is no token, no client secret and no header anywhere in it. Handing back the live
   * internals instead would let a route mutate the gate that stands between a double-clicked
   * Refresh and a 15-minute lockout for every rider.
   */
  router.add(
    'GET',
    '/api/health/strava',
    (req, res) => {
      sendJson(res, 200, {
        rateLimit: strava.rateLimit,
        // The API base, not the OAuth base: the OAuth base is only ever reached with a
        // client secret attached, and naming it here invites someone to build a URL.
        apiBase: config.stravaApiBase,
        /** What we ASK for. What we got per rider lives in `granted_scope`. */
        scope: REQUESTED_SCOPE.split(','),
        schema: API_SCHEMA,
        time: isoUtcNow(),
      });
    },
    { admin: true },
  );
}
