import { readFileSync } from 'node:fs';

/**
 * In-process Strava test double.
 *
 * It is a `fetchImpl(input, init) -> Response`, NOT an HTTP server: `server.listen()`
 * fails with EPERM in this sandbox, so anything socket-based cannot run at all. The
 * client takes `fetchImpl` as an injected dependency precisely so this file can exist.
 *
 * Behaviours here are not cosmetic -- each one reproduces a real Strava trait that a
 * naive client gets wrong:
 *
 *  - Activities come back ASCENDING when `after` is present and DESCENDING otherwise.
 *    That inconsistency is what proves the watermark must be a Math.max over all pages
 *    rather than `arr[0]` or `arr.at(-1)`.
 *  - `refresh_token` ROTATES by default, and the previous one stops working, so a client
 *    that persists the new token "only if it changed" locks the athlete out.
 *  - A replayed authorization code returns Strava's 400 envelope, because a code is
 *    single-use and a retried exchange must not look like a transient failure.
 *  - Anything unexpected 404s AND logs loudly, so a stray call fails visibly instead of
 *    quietly returning an empty page that reads as "this athlete has no rides".
 */

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/activities.json', import.meta.url), 'utf8'));

const DEFAULT_ATHLETE = Object.freeze({
  id: 12345678,
  username: 'julien',
  resource_state: 2,
  firstname: 'Julien',
  lastname: 'Collins',
  city: 'Boston',
  state: 'MA',
  country: 'United States',
  sex: 'M',
  premium: true,
  // [UNVERIFIED] the real avatar CDN host. Recorded on the first live login; the server
  // stores NULL for anything that is not an absolute https: URL either way.
  profile_medium: 'https://dgalywyr863hv.cloudfront.net/pictures/athletes/12345678/medium.jpg',
  profile: 'https://dgalywyr863hv.cloudfront.net/pictures/athletes/12345678/large.jpg',
});

/** Strava's error envelope. Shape matters: the client classifies on `field`/`resource`. */
function stravaErrors(resource, field, code, message = 'Bad Request') {
  return { message, errors: [{ resource, field, code }] };
}

function epochOf(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

export function createFakeStrava(opts = {}) {
  const {
    apiBase = 'https://fake.strava.test/api/v3',
    oauthBase = 'https://fake.strava.test/oauth',
    clientId = '12345',
    /** When set, the token endpoints verify it -- lets a test prove the secret was sent. */
    clientSecret = null,
    athlete = DEFAULT_ATHLETE,
    activities = FIXTURE.activities,
    now = () => Date.now(),
    /** Default TRUE: Strava is believed to rotate, and the expensive bug is assuming it does not. */
    rotateRefreshToken = true,
    /** Cap Strava applies to per_page. */
    maxPerPage = 200,
    /** Set true to make per_page>100 a 400, exercising the client's fallback. */
    rejectLargePerPage = false,
    /**
     * Which field before/after filter on. [UNVERIFIED] in reality -- that is the whole
     * point of scripts/strava-probe.mjs. The client pads the window +/-86400 s so it is
     * correct under either setting, and a test can flip this to prove that.
     */
    windowField = 'start_date',
    rateLimit = {},
    logger = console,
  } = opts;

  const apiRoot = new URL(apiBase);
  const oauthRoot = new URL(oauthBase);

  const state = {
    activities: [...activities],
    athlete: { ...athlete },
    rotateRefreshToken,
    revoked: false,
    accessExpired: false,
    tokenSerial: 1,
    windowField,
    rejectLargePerPage,
    /** API (not OAuth) calls handled so far -- the clock the failure queue is scheduled on. */
    apiCalls: 0,
  };

  const tokens = {
    accessToken: 'fake-access-1',
    refreshToken: 'fake-refresh-1',
    expiresAt: Math.floor(now() / 1000) + 21_600,
    scope: 'read,activity:read_all',
    tokenType: 'Bearer',
  };

  const limits = {
    shortLimit: rateLimit.shortLimit ?? 100,
    dailyLimit: rateLimit.dailyLimit ?? 1000,
    shortUsage: rateLimit.shortUsage ?? 0,
    dailyUsage: rateLimit.dailyUsage ?? 0,
    readShortLimit: rateLimit.readShortLimit ?? 100,
    readDailyLimit: rateLimit.readDailyLimit ?? 1000,
    readShortUsage: rateLimit.readShortUsage ?? 0,
    readDailyUsage: rateLimit.readDailyUsage ?? 0,
  };

  /** code -> {scope, consumed} */
  const codes = new Map();
  /** Injected failures, consumed one per API request. */
  const failures = [];
  const requests = [];
  const unexpected = [];

  function rateHeaders(extra = {}) {
    return {
      'Content-Type': 'application/json; charset=utf-8',
      'X-RateLimit-Limit': `${limits.shortLimit},${limits.dailyLimit}`,
      'X-RateLimit-Usage': `${limits.shortUsage},${limits.dailyUsage}`,
      'X-ReadRateLimit-Limit': `${limits.readShortLimit},${limits.readDailyLimit}`,
      'X-ReadRateLimit-Usage': `${limits.readShortUsage},${limits.readDailyUsage}`,
      ...extra,
    };
  }

  function json(status, body, extraHeaders = {}) {
    return new Response(JSON.stringify(body), { status, headers: rateHeaders(extraHeaders) });
  }

  function authFailure() {
    return json(401, stravaErrors('Athlete', 'access_token', 'invalid', 'Authorization Error'));
  }

  /** Valid bearer? Mirrors Strava: an expired or revoked token is a 401, not a 403. */
  function checkAuth(bearer) {
    if (state.revoked) return authFailure();
    if (state.accessExpired) return authFailure();
    if (!bearer || bearer !== tokens.accessToken) return authFailure();
    return null;
  }

  function countRequest(isRead) {
    limits.shortUsage += 1;
    limits.dailyUsage += 1;
    if (isRead) {
      limits.readShortUsage += 1;
      limits.readDailyUsage += 1;
    }
  }

  /**
   * Pop the next injected failure, if it is due yet.
   *
   * `afterCalls` is what makes a MID-pagination failure expressible: queueing a plain
   * failure would break page 1 and the test would never reach the interesting case of
   * "some pages already delivered, then an error".
   */
  function nextInjectedFailure() {
    const head = failures[0];
    if (!head) return null;
    if (state.apiCalls <= head.afterCalls) return null;
    failures.shift();
    return head.fn;
  }

  function handleAuthorize(url) {
    if (url.searchParams.get('client_id') !== String(clientId)) {
      return json(400, stravaErrors('Application', 'client_id', 'invalid'));
    }
    const redirect = url.searchParams.get('redirect_uri');
    if (!redirect) return json(400, stravaErrors('Application', 'redirect_uri', 'invalid'));

    const target = new URL(redirect);
    const callerState = url.searchParams.get('state') ?? '';
    if (callerState) target.searchParams.set('state', callerState);

    if (url.searchParams.get('deny') === '1') {
      // Strava's actual denial: a redirect with error=access_denied, not an error page.
      target.searchParams.set('error', 'access_denied');
      return new Response(null, { status: 302, headers: { Location: target.toString() } });
    }

    // ?grant=read  -> only activity:read (rider unchecked "private activities")
    // ?grant=      -> neither activity scope (rider unchecked everything optional)
    // absent       -> full grant
    let granted = 'read,activity:read_all';
    if (url.searchParams.has('grant')) {
      const g = url.searchParams.get('grant');
      granted = g === 'read' ? 'read,activity:read' : (g === '' ? 'read' : g);
    }

    const code = `code-${codes.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
    codes.set(code, { scope: granted, consumed: false });
    target.searchParams.set('code', code);
    target.searchParams.set('scope', granted);
    return new Response(null, { status: 302, headers: { Location: target.toString() } });
  }

  function issueTokens(scope) {
    state.tokenSerial += 1;
    tokens.accessToken = `fake-access-${state.tokenSerial}`;
    if (state.rotateRefreshToken) tokens.refreshToken = `fake-refresh-${state.tokenSerial}`;
    tokens.expiresAt = Math.floor(now() / 1000) + 21_600;
    tokens.scope = scope ?? tokens.scope;
    state.accessExpired = false;
    return {
      token_type: 'Bearer',
      expires_at: tokens.expiresAt,
      expires_in: 21_600,
      refresh_token: tokens.refreshToken,
      access_token: tokens.accessToken,
      scope: tokens.scope,
    };
  }

  function handleToken(form) {
    if (form.get('client_id') !== String(clientId)) {
      return json(401, stravaErrors('Application', 'client_id', 'invalid'));
    }
    if (clientSecret !== null && form.get('client_secret') !== clientSecret) {
      return json(401, stravaErrors('Application', 'client_secret', 'invalid'));
    }

    const grantType = form.get('grant_type');

    if (grantType === 'authorization_code') {
      const code = form.get('code') ?? '';
      const entry = codes.get(code);
      // Unknown OR already consumed -> the same 400. A code is single-use; a client that
      // retries a code exchange must see a hard failure, not an empty success.
      if (!entry || entry.consumed) {
        return json(400, stravaErrors('AuthorizationCode', 'code', 'invalid'));
      }
      entry.consumed = true;
      return json(200, { ...issueTokens(entry.scope), athlete: state.athlete });
    }

    if (grantType === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      if (state.revoked || presented !== tokens.refreshToken) {
        // The rotated-away token lands here too, which is what makes a "persist only if
        // changed" client fail loudly in tests instead of in production.
        return json(400, stravaErrors('RefreshToken', 'refresh_token', 'invalid'));
      }
      return json(200, issueTokens(tokens.scope));
    }

    return json(400, stravaErrors('Application', 'grant_type', 'invalid'));
  }

  function handleDeauthorize(form, bearer) {
    const presented = bearer || form.get('access_token');
    if (state.revoked || !presented || presented !== tokens.accessToken) {
      // Already-revoked is a 401, which the client is required to treat as success.
      return authFailure();
    }
    state.revoked = true;
    // [UNVERIFIED] the documented response is {"access_token":"..."}; recorded by the probe.
    return json(200, { access_token: presented });
  }

  function handleActivities(url) {
    const injected = nextInjectedFailure();
    if (injected) return injected();

    const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
    if (state.rejectLargePerPage && perPageRaw > 100) {
      return json(400, stravaErrors('Application', 'per_page', 'invalid'));
    }
    const perPage = Math.min(Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.floor(perPageRaw) : 30, maxPerPage);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);

    const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : null;
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null;

    const rows = state.activities.filter((a) => {
      const epoch = epochOf(state.windowField === 'start_date_local' ? a.start_date_local : a.start_date);
      if (after !== null && !(epoch > after)) return false;
      if (before !== null && !(epoch < before)) return false;
      return true;
    });

    // The ordering flip. Ascending when `after` is set, descending otherwise.
    rows.sort((a, b) => epochOf(a.start_date) - epochOf(b.start_date));
    if (after === null) rows.reverse();

    const slice = rows.slice((page - 1) * perPage, page * perPage);
    // Summary activities carry the owning athlete, which is how normalizeActivity can
    // derive athlete_id without being told.
    return json(200, slice.map((a) => ({ athlete: { id: state.athlete.id, resource_state: 1 }, ...a })));
  }

  /**
   * The fetch double. Accepts either (url, init) or a Request, because the client uses
   * the former and a future caller might use the latter.
   */
  async function fetchImpl(input, init = {}) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const rawUrl = isRequest ? input.url : String(input);
    const method = (isRequest ? input.method : init.method ?? 'GET').toUpperCase();
    const url = new URL(rawUrl);

    const headers = new Headers(isRequest ? input.headers : init.headers ?? {});
    const authorization = headers.get('authorization');
    const bearer = authorization && /^Bearer\s+/i.test(authorization)
      ? authorization.replace(/^Bearer\s+/i, '')
      : null;

    let bodyText = '';
    if (isRequest) bodyText = await input.text();
    else if (typeof init.body === 'string') bodyText = init.body;
    const form = new URLSearchParams(bodyText);

    requests.push({
      method,
      url: rawUrl,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      form: bodyText ? Object.fromEntries(form) : null,
      bearer,
    });

    const isOauth = url.origin === oauthRoot.origin && url.pathname.startsWith(oauthRoot.pathname);
    const isApi = url.origin === apiRoot.origin && url.pathname.startsWith(apiRoot.pathname);
    const leaf = isOauth
      ? url.pathname.slice(oauthRoot.pathname.length)
      : (isApi ? url.pathname.slice(apiRoot.pathname.length) : null);

    if (isOauth) {
      countRequest(false);
      if (method === 'GET' && leaf === '/authorize') return handleAuthorize(url);
      if (method === 'POST' && leaf === '/token') return handleToken(form);
      if (method === 'POST' && leaf === '/deauthorize') return handleDeauthorize(form, bearer);
    } else if (isApi) {
      countRequest(method === 'GET');
      state.apiCalls += 1;
      const denied = checkAuth(bearer);
      if (denied) return denied;
      if (method === 'GET' && leaf === '/athlete') {
        const injected = nextInjectedFailure();
        if (injected) return injected();
        return json(200, state.athlete);
      }
      if (method === 'GET' && leaf === '/athlete/activities') return handleActivities(url);
    }

    // Loudly, on purpose. A silent 404 here is a test that passes because nothing happened.
    unexpected.push({ method, url: rawUrl });
    logger?.error?.(`[fakeStrava] UNEXPECTED ${method} ${rawUrl} -- returning 404. This is almost certainly a bug in the code under test.`);
    return json(404, { message: 'Record Not Found', errors: [{ resource: 'Fake', field: 'path', code: 'not found' }] });
  }

  return {
    fetchImpl,
    requests,
    unexpected,
    tokens,
    codes,
    limits,
    get athlete() {
      return state.athlete;
    },
    get activities() {
      return state.activities;
    },
    get rotateRefreshToken() {
      return state.rotateRefreshToken;
    },
    set rotateRefreshToken(v) {
      state.rotateRefreshToken = Boolean(v);
    },
    get revoked() {
      return state.revoked;
    },

    /** Next API call answers 401, as if the access token had aged out. */
    expireAccessToken() {
      state.accessExpired = true;
    },

    /** The athlete revoked us in Strava's settings: API 401s and refresh 400s forever. */
    revokeAthlete() {
      state.revoked = true;
    },

    /** Overwrite any subset of the emitted rate-limit numbers. */
    setRateLimit(next = {}) {
      Object.assign(limits, next);
    },

    /** Inject `count` 429s, starting only after `afterCalls` earlier API calls. */
    queue429(count = 1, { bucket = 'short', retryAfter = null, afterCalls = 0 } = {}) {
      for (let i = 0; i < count; i += 1) {
        failures.push({
          afterCalls,
          fn: () => {
            const extra = retryAfter === null ? {} : { 'Retry-After': String(retryAfter) };
            if (bucket === 'daily') {
              limits.dailyUsage = limits.dailyLimit;
              limits.readDailyUsage = limits.readDailyLimit;
            } else {
              limits.shortUsage = limits.shortLimit;
              limits.readShortUsage = limits.readShortLimit;
            }
            return json(429, { message: 'Rate Limit Exceeded', errors: [{ resource: 'Application', field: 'rate limit', code: 'exceeded' }] }, extra);
          },
        });
      }
    },

    /** Inject `count` 500s, starting only after `afterCalls` earlier API calls. */
    queue500(count = 1, { afterCalls = 0 } = {}) {
      for (let i = 0; i < count; i += 1) {
        failures.push({ afterCalls, fn: () => json(500, { message: 'Internal Server Error' }) });
      }
    },

    /** Simulate a deleted ride, for deletion reconciliation. */
    removeActivity(id) {
      const before = state.activities.length;
      state.activities = state.activities.filter((a) => a.id !== id);
      return before !== state.activities.length;
    },

    setActivities(next) {
      state.activities = [...next];
    },

    /** Flip the before/after interpretation, to prove the padded window works either way. */
    setWindowField(field) {
      state.windowField = field;
    },

    setRejectLargePerPage(v) {
      state.rejectLargePerPage = Boolean(v);
    },

    /** Everything the fixture knows, for tests that assert against derived totals. */
    fixture: FIXTURE,
  };
}

export { FIXTURE as ACTIVITY_FIXTURE };
