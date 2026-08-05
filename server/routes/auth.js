import {
  COOKIES,
  OAUTH_FRAGMENT_ERRORS,
  OAUTH_STATE_TTL_SECONDS,
} from '../contracts.js';
import { sendNoContent, sendRedirect } from '../http/respond.js';
import { clearCookie, serializeCookie } from '../http/cookies.js';
import { createOAuthState, persistOAuthState, safeReturnTo, verifyAndConsumeOAuthState } from '../security/oauthState.js';
import { csrfCookieOptions, issueCsrfToken } from '../security/csrf.js';
import { createSession, revokeSession } from '../security/sessionStore.js';
import { assertScope, buildAuthorizeUrl } from '../strava/authUrl.js';
import { StravaError, StravaScopeError } from '../strava/client.js';
import { clearRevoked, setAdmin, upsertAthleteFromStrava } from '../db/athletes.js';
import { saveTokens } from '../db/tokens.js';
import { epochSeconds } from '../lib/dates.js';

/**
 * The OAuth legs and logout.
 *
 * EVERY failure in the callback is a 302 with a `#error=` fragment, never a JSON body. The
 * caller is a top-level browser navigation coming back from Strava, so a JSON error renders
 * as a raw blob of text in a tab the rider cannot act on. The fragment is read by
 * public/app.js and turned into a banner. (A fragment rather than a query parameter because
 * fragments are never sent to a server, a proxy, or a CDN log.)
 */

/**
 * `bc_oauth` carries the browser-binding nonce.
 *
 * `Path=/api/auth` narrows it to the only two routes that need it, so it is not attached to
 * every leaderboard poll. `SameSite=Lax`, never Strict: the callback IS a cross-site
 * top-level navigation, and Strict withholds the cookie on exactly that request -- which
 * would make every single login fail the nonce check.
 */
function oauthCookieOptions(config) {
  return {
    httpOnly: true,
    // Gated on config, never on X-Forwarded-Proto: the client controls that header and
    // could use it to downgrade the cookie off Secure.
    secure: config.isProduction,
    sameSite: 'Lax',
    path: '/api/auth',
    maxAge: OAUTH_STATE_TTL_SECONDS,
  };
}

/** `bc_sid`: the session credential. HttpOnly is what keeps XSS from becoming token theft. */
export function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'Lax',
    path: '/',
    maxAge: config.sessionTtlSeconds,
  };
}

/** Both cookies a logged-in browser holds, expired. Attribute sets must match what was set
 *  or the browser keeps the originals and logout only appears to work. */
export function clearAuthCookies(config) {
  return [
    clearCookie(COOKIES.SESSION, sessionCookieOptions(config)),
    clearCookie(COOKIES.CSRF, csrfCookieOptions(config)),
  ];
}

export function registerAuthRoutes(router, { config, db, strava, now }) {
  /**
   * Start the flow. A mutating GET, which is normally banned here -- it is allowed because
   * it must be a top-level navigation (a `fetch` to a cross-origin 302 CORS-fails and looks
   * like a network outage). The write is bounded by a 600 s TTL, a purge on every insert, a
   * hard row cap, and `Cache-Control: no-store` so a link prefetcher cannot burn states.
   */
  async function begin(req, res, ctx, approvalPrompt) {
    const nowMs = ctx.nowMs ?? now();
    const minted = createOAuthState(config, { returnTo: ctx.query.get('return_to'), nowMs });

    await persistOAuthState(db, {
      stateHash: minted.stateHash,
      nonceHash: minted.nonceHash,
      expiresAt: minted.expiresAt,
      returnTo: minted.returnTo,
      nowEpoch: epochSeconds(nowMs),
    });

    sendRedirect(res, buildAuthorizeUrl(config, { state: minted.state, approvalPrompt }), {
      // The nonce goes in an HttpOnly cookie and NEVER in the URL: a nonce in a query
      // string ends up in Strava's logs, our access log, and the Referer header, at which
      // point it binds nothing.
      'Set-Cookie': serializeCookie(COOKIES.OAUTH_NONCE, minted.nonce, oauthCookieOptions(config)),
    });
  }

  router.add('GET', '/api/auth/strava/login', (req, res, ctx) => begin(req, res, ctx, 'auto'));

  /**
   * Reconnect uses `approval_prompt=force`.
   *
   * With `auto`, an athlete who revoked us in Strava's own settings page is bounced straight
   * back with the dead grant and never sees the consent screen -- so "Reconnect" appears to
   * do nothing at all, which is the single most confusing possible outcome for a rider whose
   * board total has frozen.
   */
  router.add('GET', '/api/auth/strava/reconnect', (req, res, ctx) => begin(req, res, ctx, 'force'));

  /**
   * The callback. Read the numbered steps: each one is load-bearing and the ORDER matters.
   */
  router.add('GET', '/api/auth/strava/callback', async (req, res, ctx) => {
    const nowMs = ctx.nowMs ?? now();

    // --- 1. `bc_oauth` is cleared on EVERY exit path, success or failure. ---
    //
    // A nonce left behind is a nonce that can be presented against a future state. Building
    // the header once, up front, is what makes "every path" true by construction instead of
    // by five separate remembering-to-do-it sites.
    const clearOauth = clearCookie(COOKIES.OAUTH_NONCE, oauthCookieOptions(config));

    /** Every failure exit. Never JSON -- see the file header. */
    const fail = (fragment, reason) => {
      ctx.log?.warn?.('oauth callback rejected', { fragment, reason });
      sendRedirect(res, `${config.webOrigin}/#error=${fragment}`, { 'Set-Cookie': clearOauth });
    };

    // --- 2. The rider said no on Strava's consent screen. ---
    //
    // Handled BEFORE the state is consumed: a denial is a legitimate outcome, not an attack,
    // and burning the state would turn "I changed my mind, let me click Connect again" into
    // a state_expired error on the retry.
    const oauthError = ctx.query.get('error');
    if (oauthError !== null) {
      const denied = oauthError === 'access_denied';
      fail(denied ? OAUTH_FRAGMENT_ERRORS.DENIED : OAUTH_FRAGMENT_ERRORS.OAUTH_FAILED, `strava_error:${oauthError}`);
      return;
    }

    // --- 3. Verify and atomically consume the state. ---
    //
    // verifyAndConsumeOAuthState does all four legs: length-checked HMAC, single-use
    // DELETE..RETURNING, server-side expiry, and the BROWSER-NONCE BINDING. That last leg is
    // the one that closes login CSRF, and HMAC plus single-use do not close it: an attacker
    // can complete consent with their own Strava account and mail the victim a genuine,
    // unused code+state pair, and without the cookie check the victim's browser gets a
    // session bound to the attacker's athlete id.
    let consumed;
    try {
      consumed = await verifyAndConsumeOAuthState(db, config, {
        state: ctx.query.get('state'),
        nonce: ctx.cookies.get(COOKIES.OAUTH_NONCE),
        nowMs,
      });
    } catch (err) {
      fail(err?.extra?.fragment ?? OAUTH_FRAGMENT_ERRORS.STATE_EXPIRED, err?.reason ?? 'state_rejected');
      return;
    }

    // --- 4. Scope. The CALLBACK's ?scope= is authoritative. ---
    //
    // Strava's consent screen lets the rider uncheck individual scopes, so what we asked for
    // in REQUESTED_SCOPE says nothing about what we got. A rider who granted only
    // `activity:read` MUST sign in successfully: their public rides are perfectly countable,
    // and hard-requiring read_all turns a privacy preference into a permanent lockout. Only
    // the case where NEITHER activity scope was granted is a failure.
    const grantedScope = ctx.query.get('scope') ?? '';
    try {
      assertScope(grantedScope);
    } catch (err) {
      if (err instanceof StravaScopeError) {
        fail(OAUTH_FRAGMENT_ERRORS.SCOPE, 'insufficient_scope');
        return;
      }
      throw err;
    }

    const code = ctx.query.get('code');
    if (typeof code !== 'string' || code === '') {
      fail(OAUTH_FRAGMENT_ERRORS.OAUTH_FAILED, 'code_missing');
      return;
    }

    // --- 5. Exchange the code. Never retried at any layer: the code is single-use. ---
    let granted;
    try {
      granted = await strava.exchangeCode(code);
    } catch (err) {
      if (err instanceof StravaError) {
        // The message is safe (client.js structurally keeps the form body and the client
        // secret out of every error), but it is still logged rather than shown.
        fail(OAUTH_FRAGMENT_ERRORS.OAUTH_FAILED, `exchange_failed:${err.code}`);
        return;
      }
      throw err;
    }

    // The token response usually embeds the athlete. Falling back to GET /athlete rather
    // than failing keeps login working if Strava ever drops the embedded copy.
    let rawAthlete = granted.athlete;
    if (!rawAthlete || typeof rawAthlete.id !== 'number') {
      try {
        rawAthlete = await strava.getAthlete(granted.accessToken);
      } catch (err) {
        if (err instanceof StravaError) {
          fail(OAUTH_FRAGMENT_ERRORS.OAUTH_FAILED, `athlete_fetch_failed:${err.code}`);
          return;
        }
        throw err;
      }
    }

    // --- 6. Upsert keyed on `athlete.id` -- Strava's own stable identity. ---
    //
    // Matching on the id (never a name, never an email) is what makes a returning rider's
    // team, history, and admin flag reattach. Insert-a-new-row-per-login would re-show the
    // one-time team picker and split their miles across two rows.
    const athlete = await upsertAthleteFromStrava(db, rawAthlete, { grantedScope });
    const athleteId = Number(athlete.strava_athlete_id);

    // --- 7. Bootstrap admins: GRANT ONLY, never revoke. ---
    //
    // If this also removed the flag for ids absent from the env var, then editing
    // ADMIN_BOOTSTRAP_ATHLETE_IDS (or deploying with it unset, which is the normal state
    // after the first admin exists) would silently demote a working admin on their next
    // login, with no log line and no error.
    if (config.adminBootstrapAthleteIds.includes(athleteId) && Number(athlete.is_admin) !== 1) {
      await setAdmin(db, athleteId, true);
    }

    // --- 8. Seal the tokens. ---
    //
    // `expectedVersion` is null deliberately: a fresh OAuth grant supersedes whatever was
    // stored, so there is no race to lose here. (The CAS matters on the refresh path, where
    // two workers can hold the same refresh token.)
    await saveTokens(db, config, athleteId, {
      accessToken: granted.accessToken,
      refreshToken: granted.refreshToken,
      expiresAt: granted.expiresAt,
      // The callback's scope, not the token response's: only the former is authoritative.
      scope: grantedScope,
      tokenType: granted.tokenType,
    });
    // A completed consent proves the grant is alive again, so the reconnect badge goes.
    await clearRevoked(db, athleteId);

    // --- 9. Session fixation defense: destroy any inbound session, then mint a NEW id. ---
    //
    // Reusing an inbound session id is the whole attack: the attacker plants a `bc_sid` they
    // know in the victim's browser, the victim logs in, and if the id survives the login the
    // attacker's cookie is now a live session for the victim's account. A fresh
    // randomBytes(32) id closes it; deleting the inbound row as well means the planted id is
    // dead rather than merely unused.
    if (ctx.rawSessionToken) await revokeSession(db, ctx.rawSessionToken);
    const session = await createSession(db, config, athleteId, {
      userAgent: req.headers['user-agent'] ?? '',
      nowMs,
    });

    // --- 10. Cookies, then the redirect. ---
    //
    // NOTE what is deliberately NOT here: a sync. Awaited, a rate-limit error turns into a
    // failed login and a blank tab for seconds. Fire-and-forget, it is silently killed on
    // Workers without ctx.waitUntil(), so a new rider lands on a permanently empty board
    // with nothing logged anywhere. public/ calls POST /api/me/sync once after login and the
    // 60 s cooldown makes that safe and idempotent.
    sendRedirect(res, `${config.webOrigin}${safeReturnTo(config, consumed.returnTo)}`, {
      'Set-Cookie': [
        clearOauth,
        serializeCookie(COOKIES.SESSION, session.rawToken, sessionCookieOptions(config)),
        // Readable by JS BY DESIGN: the double-submit pattern needs page script on our own
        // origin to echo it in X-CSRF-Token. It is not a credential on its own.
        serializeCookie(COOKIES.CSRF, issueCsrfToken(), csrfCookieOptions(config)),
      ],
    });
  });

  /**
   * Logout. 204 always, even with no credential -- it is idempotent, and a 401 here would
   * make "log out" fail for someone whose session already expired, which is the one moment
   * they most want it to succeed.
   *
   * Deletes the ROW, not just the cookie: clearing the cookie alone leaves the bearer path
   * alive, so anyone holding a token stays logged in while the UI says otherwise.
   */
  router.add('POST', '/api/auth/logout', async (req, res, ctx) => {
    if (ctx.rawSessionToken) await revokeSession(db, ctx.rawSessionToken);
    sendNoContent(res, { 'Set-Cookie': clearAuthCookies(config) });
  });

  // A GET on the logout path is a common mistake (a plain <a href>) and would be a mutating
  // GET if it worked. The router already answers it with 405 + an accurate Allow header
  // because only POST is registered; this note exists so nobody "fixes" that by adding a GET.
}
