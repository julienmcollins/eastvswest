import { COOKIES } from '../contracts.js';
import { createRouter } from '../http/router.js';
import { requireCsrf } from '../security/csrf.js';
import { requireAdmin } from '../security/guards.js';
import { resolveSession } from '../security/sessionStore.js';
import { getAthlete } from '../db/athletes.js';
import { registerHealthRoutes } from './health.js';
import { registerAuthRoutes } from './auth.js';
import { registerMeRoutes } from './me.js';
import { registerLeaderboardRoutes } from './leaderboard.js';
import { registerAdminRoutes } from './admin.js';

/**
 * The whole route table, plus the three cross-cutting guards.
 *
 * The guards are registered EXACTLY ONCE each, at the router level, over a predicate that
 * describes the set they protect. That is the entire point of this file: a `requireCsrf(...)`
 * line at the top of each mutating handler works right up until someone adds the fourteenth
 * mutating route and forgets, and nothing fails -- the endpoint simply becomes writable from
 * any origin. A predicate over `ctx.method` cannot be forgotten by a new route, because the
 * new route has to opt *out* to escape it.
 */

/** Every method that can change server state. A new one here covers every route at once. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const ADMIN_PREFIX = '/api/admin';

/**
 * @param {{config:object, db:object, strava:object, now?:()=>number}} deps
 *   `now` is injected for the same reason `fetchImpl` is injected into the Strava client:
 *   almost every response here is a function of the clock (competition state, the sync
 *   window, the 60 s cooldown), and a test that cannot move the clock can only assert
 *   things that are true today. Production passes nothing and gets Date.now.
 * @returns {ReturnType<typeof createRouter>}
 */
export function buildRoutes({ config, db, strava, now = () => Date.now() }) {
  if (!config) throw new TypeError('buildRoutes requires a config object.');
  if (!db) throw new TypeError('buildRoutes requires a database.');
  if (!strava) throw new TypeError('buildRoutes requires a Strava client.');
  if (typeof now !== 'function') throw new TypeError('buildRoutes: now must be a function returning epoch ms.');

  const deps = Object.freeze({ config, db, strava, now });
  const router = createRouter();

  // --- Guard 1: identity. Runs for every matched route, including the anonymous ones. ---
  //
  // /api/me and /api/leaderboard both answer 200 for a logged-out caller but change shape
  // when a session is present, so resolution cannot live behind requireSession. Resolving
  // once here is also what lets requireAdmin read a FRESH athlete row rather than trusting
  // anything carried in the session.
  router.use(async (req, res, ctx) => {
    await attachIdentity(ctx, deps);
  });

  // --- Guard 2: CSRF over the whole mutating set, in one line. ---
  //
  // Method-based rather than route-list-based on purpose: a route list is a thing you can
  // forget to add to. The only mutating GET in the system (the OAuth initiator, which must
  // be a top-level navigation) is exempt by construction because GET is not in the set.
  router.use(
    (ctx) => MUTATING_METHODS.has(ctx.method),
    (req, res, ctx) => {
      requireCsrf(req, config, ctx);
    },
  );

  // --- Guard 3: admin over the /api/admin prefix. ---
  //
  // GET /api/health/strava is admin-only but does not live under /api/admin, so the
  // predicate also honours an `{ admin: true }` route option. That keeps this a single
  // registration -- the property that matters -- instead of two, or worse, one plus an
  // in-handler check on the odd route out.
  router.use(
    (ctx) =>
      ctx.pathname === ADMIN_PREFIX
      || ctx.pathname.startsWith(`${ADMIN_PREFIX}/`)
      || ctx.route?.opts?.admin === true,
    (req, res, ctx) => {
      requireAdmin(ctx);
    },
  );

  registerHealthRoutes(router, deps);
  registerAuthRoutes(router, deps);
  registerMeRoutes(router, deps);
  registerLeaderboardRoutes(router, deps);
  registerAdminRoutes(router, deps);

  return router;
}

/**
 * Read the session credential, preferring `Authorization: Bearer` over the cookie.
 *
 * Bearer first because it is the explicit choice: a client that attaches a token is asking
 * to act as that token's owner, and a stale `bc_sid` left over in the same browser must not
 * silently win. Both hash to the same `sessions` row, so there is one code path behind them.
 */
function credentialFrom(req, cookies) {
  const header = req.headers?.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  return cookies?.get(COOKIES.SESSION) ?? null;
}

/**
 * Populate `ctx.session`, `ctx.athlete`, and `ctx.rawSessionToken`.
 *
 * Never throws for a bad credential. "Not logged in" is a valid state for /api/me and
 * /api/leaderboard, and turning an expired cookie into a 500 would break the anonymous
 * landing page for anyone who visited a month ago.
 */
async function attachIdentity(ctx, { config, db, now }) {
  const nowMs = now();
  ctx.nowMs = nowMs;

  const raw = credentialFrom(ctx.req, ctx.cookies);
  // Kept so logout can delete the row behind WHICHEVER credential matched. Clearing only
  // the cookie would leave the bearer path alive and make logout visibly fail.
  ctx.rawSessionToken = raw;
  if (!raw) return;

  const session = await resolveSession(db, config, raw, { nowMs });
  if (!session) return;

  const athlete = await getAthlete(db, session.athleteId);
  // A session whose athlete row is gone (deleted account) must not authenticate. The FK
  // cascade makes this unreachable today; leaving the session in place if it ever happened
  // would hand a caller an `athlete` of undefined inside every guard.
  if (!athlete) return;

  ctx.session = session;
  ctx.athlete = athlete;
}
