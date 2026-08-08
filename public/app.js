/**
 * Boot, state, event wiring. The only module allowed to know the sequence of things.
 *
 * It touches no DOM (render.js does that) and issues no fetch (api.js does that). What it
 * does own is the two pure functions below, which are where the two worst bugs in this
 * file's history lived, so they are exported and tested directly:
 *
 *   resolveBootState()  - unwraps Promise.allSettled results
 *   parseAuthFragment() - reads the URL fragment exactly once
 */

import {
  API_SCHEMA,
  SYNC_POLL_INTERVAL_MS,
  SYNC_POLL_MAX_MS,
  TEAMS,
} from './config.js?v=2';
import * as api from './api.js?v=2';
import * as ui from './render.js?v=2';

/* --------------------------------------------------------------- pure boot logic ---- */

/**
 * @param {PromiseSettledResult<any>|undefined} result
 * @returns {any|null} the fulfilled value, or null
 */
function settledValue(result) {
  return result && result.status === 'fulfilled' ? (result.value ?? null) : null;
}

/**
 * @param {PromiseSettledResult<any>|undefined} result
 * @returns {any|null} the rejection reason, or null
 */
function settledError(result) {
  return result && result.status === 'rejected' ? (result.reason ?? new Error('unknown')) : null;
}

/**
 * Reduce the two settled boot requests into everything the renderers need.
 *
 * THE TRAP THIS FUNCTION EXISTS TO CLOSE. `Promise.allSettled` resolves to wrapper
 * objects, so the tempting
 *
 *     const [me, lb] = await Promise.allSettled([getMe(), getLeaderboard()]);
 *     if (me.authenticated && me.rider.needs_team) ...
 *
 * reads `undefined` off the wrapper. `showTeamPicker` is then always false, the mandatory
 * one-time picker never opens, and the new rider is silently left off the board forever
 * with no error logged anywhere. Unwrapping happens here, once, and nowhere else.
 *
 * Also note the asymmetry: a REJECTED /api/me must still yield a renderable board. The
 * leaderboard is public data; failing to identify the viewer is not a reason to show them
 * a blank page.
 *
 * @param {PromiseSettledResult<any>} meResult settled result of GET /api/me
 * @param {PromiseSettledResult<any>} lbResult settled result of GET /api/leaderboard
 * @param {{schema?: number}} [options]
 * @returns {{
 *   me: object|null, leaderboard: object|null,
 *   meError: unknown, leaderboardError: unknown,
 *   authenticated: boolean, rider: object|null,
 *   showTeamPicker: boolean, canRenderBoard: boolean,
 *   competition: object|null, isEmptyBoard: boolean, schemaMismatch: boolean
 * }}
 */
export function resolveBootState(meResult, lbResult, options = {}) {
  const expectedSchema = options.schema ?? API_SCHEMA;

  const me = settledValue(meResult);
  const leaderboard = settledValue(lbResult);

  const authenticated = me?.authenticated === true;
  const rider = authenticated ? (me.rider ?? null) : null;

  const schemas = [me?.schema, leaderboard?.schema].filter((v) => v !== undefined && v !== null);

  return {
    me,
    leaderboard,
    meError: settledError(meResult),
    leaderboardError: settledError(lbResult),
    authenticated,
    rider,
    // `needs_team` from /api/me is the ONE authoritative trigger for the picker. Not a
    // `#pick-team` fragment, not `team === null`, not anything else, anywhere.
    showTeamPicker: rider !== null && rider.needs_team === true,
    canRenderBoard: leaderboard !== null,
    // Prefer the leaderboard's copy: it is the payload the board is drawn from.
    competition: leaderboard?.competition ?? me?.competition ?? null,
    // Drives the "no rides yet" empty state, per the contract's sync.last_synced_at rule.
    isEmptyBoard: leaderboard !== null && (leaderboard.sync?.last_synced_at ?? null) === null,
    schemaMismatch: schemas.some((v) => v !== expectedSchema),
  };
}

/**
 * Parse the OAuth result fragment ONCE, reading every value before anything mutates the
 * URL.
 *
 * THE TRAP THIS FUNCTION EXISTS TO CLOSE. The obvious implementation reads `token`,
 * calls `history.replaceState` to scrub it, and then reads `error` from a fragment that
 * no longer exists — so `#error=access_denied` becomes a completely silent no-op and a
 * failed login looks like a page that simply did nothing.
 *
 * @param {string} hash e.g. `location.hash`
 * @returns {{token: string|null, error: string|null, present: boolean}}
 */
export function parseAuthFragment(hash) {
  const raw = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  if (raw === '') return { token: null, error: null, present: false };
  const params = new URLSearchParams(raw);
  const token = params.get('token');
  const error = params.get('error');
  return {
    token: token === null || token === '' ? null : token,
    error: error === null || error === '' ? null : error,
    present: params.has('token') || params.has('error'),
  };
}

/**
 * Human text for an OAuth failure fragment code.
 * @param {string} code
 * @returns {string}
 */
export function oauthErrorMessage(code) {
  switch (code) {
    case 'denied':
    case 'access_denied':
      return 'Strava sign-in was cancelled, so nothing was connected. You can try again whenever you like.';
    case 'state_expired':
      return 'That sign-in link had expired or was already used. Please start again.';
    case 'scope':
      return 'Sign-in needs permission to read your activities. Try again and leave the activity permission checked.';
    case 'oauth_failed':
      return 'Strava sign-in did not complete. Please try again.';
    default:
      return 'Strava sign-in did not complete. Please try again.';
  }
}

/**
 * Human text for a failed POST /api/me/sync, keyed on the server's `error` code.
 * @param {{code?: string, message?: string, retryAfterSeconds?: number|null}} error
 * @returns {{text: string, actionLabel: string|null, action: 'reconnect'|'login'|'retry'|null}}
 */
export function syncErrorMessage(error) {
  const code = error?.code;
  const wait = error?.retryAfterSeconds;
  switch (code) {
    case 'rate_limited':
      return {
        text: wait === null || wait === undefined
          ? 'Strava is rate-limiting us. Try again shortly.'
          : `Too many syncs. Try again in ${Math.max(1, Math.ceil(wait))} s.`,
        actionLabel: null,
        action: null,
      };
    case 'insufficient_scope':
      return {
        text: 'Strava did not grant permission to read your activities. Reconnect and leave the activity permission checked.',
        actionLabel: 'Reconnect with Strava',
        action: 'reconnect',
      };
    case 'strava_revoked':
      return {
        text: 'Your Strava access was revoked, so your total is frozen. Reconnect to start counting again.',
        actionLabel: 'Reconnect with Strava',
        action: 'reconnect',
      };
    case 'unauthenticated':
      return {
        text: 'Your session has expired. Connect with Strava again to sync.',
        actionLabel: 'Connect with Strava',
        action: 'login',
      };
    case 'strava_unavailable':
      return { text: 'Strava is not responding right now. Try again in a few minutes.', actionLabel: 'Retry', action: 'retry' };
    case 'network_error':
      return { text: 'Could not reach the server. Check your connection and try again.', actionLabel: 'Retry', action: 'retry' };
    default:
      return {
        text: error?.message ? `Sync failed: ${error.message}` : 'Sync failed. Try again in a moment.',
        actionLabel: 'Retry',
        action: 'retry',
      };
  }
}

/* --------------------------------------------------------------------- live state ---- */

const state = {
  /** @type {object|null} last /api/me payload */
  me: null,
  /** @type {object|null} last /api/leaderboard payload */
  leaderboard: null,
  /**
   * `YYYY-MM` on screen, or null meaning "whatever the server calls current".
   *
   * Null is the BOOT value and is deliberately not replaced by a guess: the server owns
   * which month is current in COMPETITION_TZ, and a client that derived it from its own
   * clock would disagree with the picker on a laptop set to yesterday, or one timezone east
   * of the configured one. It is filled in from the response, never from the reader's click,
   * which is what makes a clamped month self-correcting.
   * @type {string|null}
   */
  month: null,
  /** @type {object|null} last `competition` block; the source of prev/next for stepping. */
  competition: null,
  /** True while the rider still owes us a team; gates the dialog's reopen-on-close. */
  needsTeam: false,
  /** True while a sync (including its 409 wait) is in flight. */
  syncing: false,
  /** True while a month change is in flight, so a double-click cannot race two loads. */
  monthLoading: false,
};

const BANNER = Object.freeze({
  SCHEMA: 'schema',
  OAUTH: 'oauth',
  BOARD: 'board',
  IDENTITY: 'identity',
  SYNC: 'sync',
  LOGOUT: 'logout',
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------------ actions ---- */

/**
 * Fetch both boot endpoints, reduce, render.
 *
 * `options.board` lets a caller that ALREADY holds a fresh leaderboard payload skip
 * re-fetching it. POST /api/me/sync embeds a whole board in its response precisely so
 * Refresh is one round trip; without this, Refresh fetched that same board a second time and
 * rendered the scoreboard and roster TWICE, which is both a wasted request and a visible
 * double paint on the slowest interaction in the app.
 *
 * @param {{board?: object|null}} [options]
 * @returns {Promise<object>} the boot state
 */
async function loadAll(options = {}) {
  const board = options.board ?? null;
  // Both wrapped: settled, never awaited bare, so one failure cannot hide the other.
  // `state.month` is passed to BOTH: /api/me carries the competition block too, and letting
  // the two requests disagree about the month would render a June board under an August
  // heading depending on which response resolved second.
  const [meResult, lbResult] = await Promise.allSettled([
    api.getMe(undefined, state.month),
    board === null ? api.getLeaderboard(undefined, state.month) : Promise.resolve(board),
  ]);
  const boot = resolveBootState(meResult, lbResult);
  applyBootState(boot);
  return boot;
}

/**
 * Fetch and render ONLY the board, for a month change.
 *
 * Half the round trips of `loadAll`, because /api/me cannot tell us anything new here: who is
 * signed in, their badges, their avatar and whether they still owe us a team are all
 * month-independent. The one thing a month change does alter -- the `competition` block -- is
 * carried by the leaderboard payload itself.
 *
 * Errors are thrown, not swallowed: `selectMonth` owns the retry banner and has to be able to
 * roll `state.month` back to what is actually on screen.
 *
 * @returns {Promise<object>} the leaderboard payload
 */
async function loadBoard() {
  const board = await api.getLeaderboard(undefined, state.month);

  // A schema bump mid-session means this payload may not be safe to read. Hand off to the
  // full path, which owns the "reload to update" banner rather than duplicating it here.
  if (board?.schema !== undefined && board.schema !== API_SCHEMA) {
    await loadAll({ board });
    return board;
  }

  state.leaderboard = board;
  if (board?.competition) {
    state.competition = board.competition;
    if (typeof board.competition.month === 'string') state.month = board.competition.month;
    ui.renderCompetition(board.competition);
  }
  ui.renderScoreboard(board);
  ui.renderRoster(board);
  return board;
}

/** @param {object} boot output of resolveBootState */
function applyBootState(boot) {
  state.me = boot.me;
  state.leaderboard = boot.leaderboard;
  state.needsTeam = boot.showTeamPicker;

  // Adopt the month the SERVER reports, not the one that was asked for. Asking for 2030-01
  // and getting 2026-08 back has to leave `state.month` on 2026-08, or every subsequent
  // Refresh and month step would keep re-sending the out-of-range value.
  if (boot.competition !== null) {
    state.competition = boot.competition;
    if (typeof boot.competition.month === 'string') state.month = boot.competition.month;
  }

  ui.renderIdentity(boot.me);
  if (boot.competition !== null) ui.renderCompetition(boot.competition);
  if (boot.canRenderBoard) {
    ui.renderScoreboard(boot.leaderboard);
    ui.renderRoster(boot.leaderboard);
  }

  ui.removeBanner(BANNER.BOARD);
  if (!boot.canRenderBoard) {
    ui.showBanner({
      id: BANNER.BOARD,
      kind: 'error',
      text: 'Could not load the leaderboard.',
      actionLabel: 'Retry',
      onAction: () => { loadAll().catch(reportFatal); },
      dismissible: false,
    });
  }

  ui.removeBanner(BANNER.IDENTITY);
  if (boot.meError !== null && boot.canRenderBoard) {
    // Deliberately not fatal: the board below is public and still correct.
    ui.showBanner({
      id: BANNER.IDENTITY,
      kind: 'warn',
      text: 'Could not check whether you are signed in. The board below is still up to date.',
    });
  }

  ui.removeBanner(BANNER.SCHEMA);
  if (boot.schemaMismatch) {
    ui.showBanner({
      id: BANNER.SCHEMA,
      kind: 'warn',
      text: 'This page is out of date with the server. Reload to update.',
      actionLabel: 'Reload',
      onAction: () => { if (typeof location !== 'undefined') location.reload(); },
      dismissible: false,
    });
  }

  if (boot.showTeamPicker) ui.openTeamPicker();
  else ui.closeTeamPicker();
}

/**
 * Claim a team. One-time and atomic server-side, so a 409 means someone (probably a
 * double click) already won — which is a success from the rider's point of view.
 * @param {string} team
 */
async function chooseTeam(team) {
  if (!TEAMS.includes(team)) {
    ui.setTeamPickerError('Pick East or West.');
    return;
  }
  ui.setTeamPickerPending(true);
  ui.setTeamPickerError('');
  try {
    await api.setTeam(team);
    // Clear the flag BEFORE closing, or the reopen-on-close guard fights us.
    state.needsTeam = false;
    ui.closeTeamPicker();
    ui.setStatus('Team locked in.');
    const boot = await loadAll();
    if (boot.authenticated) await refresh({ reason: 'first-sync' });
  } catch (error) {
    if (error?.code === 'team_already_set') {
      state.needsTeam = false;
      ui.closeTeamPicker();
      await loadAll();
      return;
    }
    if (error?.code === 'unauthenticated') {
      ui.setTeamPickerError('Your session expired. Close this and connect with Strava again.');
      return;
    }
    ui.setTeamPickerError(error?.message ? `Could not set your team: ${error.message}` : 'Could not set your team. Try again.');
  } finally {
    ui.setTeamPickerPending(false);
  }
}

/**
 * The dialog closed. If the rider still owes us a team, reopen it.
 *
 * Escape fires `cancel` then `close`, and preventing `cancel` is unreliable without
 * history-action user activation, so two Escape presses would otherwise dismiss a
 * mandatory choice permanently. The masthead "Pick your team" button stays visible
 * regardless, so the modal is never the only path.
 */
function handleTeamPickerClosed() {
  if (!state.needsTeam) return;
  ui.setStatus('Choose East or West to join the board.');
  // Deferred a turn: reopening inside the close handler is fighting the dialog's own
  // teardown, and this also breaks any pathological open/close loop into separate tasks.
  setTimeout(() => {
    if (state.needsTeam && !ui.isTeamPickerOpen()) ui.openTeamPicker();
  }, 0);
}

/**
 * Switch the board to another month.
 *
 * Guarded by `state.monthLoading` rather than by disabling the control alone: the prev/next
 * buttons are re-enabled by `renderMonthPicker` on every render, so a reader who clicks twice
 * quickly can otherwise start two loads whose responses land in either order and leave the
 * heading describing a different month than the rows beneath it.
 *
 * The requested month is NOT written to `state.month` here. `applyBootState` adopts whatever
 * month the server reports instead, so an out-of-range request self-corrects to the clamped
 * value rather than sticking around to be re-sent on the next Refresh.
 *
 * @param {string} month `YYYY-MM`
 */
async function selectMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return;
  if (state.monthLoading || state.syncing) return;
  if (month === state.month) return;

  state.monthLoading = true;
  const previousMonth = state.month;
  ui.setMonthPickerPending(true);
  ui.removeBanner(BANNER.BOARD);
  try {
    state.month = month;
    // ONE request, not two: see loadBoard. A month change is the most frequently repeated
    // interaction in the app, so halving its round trips is the difference the reader feels.
    await loadBoard();
  } catch (error) {
    state.month = previousMonth;
    ui.showBanner({
      id: BANNER.BOARD,
      kind: 'error',
      text: 'Could not load that month.',
      actionLabel: 'Retry',
      onAction: () => { selectMonth(month).catch(reportFatal); },
    });
  } finally {
    state.monthLoading = false;
    ui.setMonthPickerPending(false);
  }
}

/**
 * Step one month earlier or later.
 *
 * The target comes from the SERVER's `prev_month`/`next_month` rather than from local date
 * arithmetic, so the ends of the range are wherever the server says they are and the client
 * never has to know the bounds rule.
 *
 * @param {-1|1} direction
 */
function stepMonth(direction) {
  const shaped = ui.shapeMonthPicker(state.competition);
  const target = direction < 0 ? shaped.prev : shaped.next;
  if (typeof target === 'string' && target !== '') selectMonth(target).catch(reportFatal);
}

/**
 * Refresh: POST /api/me/sync, whose response embeds a whole leaderboard payload, so this
 * is one round trip.
 *
 * `mode: 'full'` on an explicit press, and that is a bug fix rather than a preference. Omitting
 * `mode` lets the server pick, and its auto rule is 'incremental' for the 24 hours after each full
 * sync -- which asks Strava only for the months since the watermark, i.e. normally the current one.
 * So a rider looking at a short July and pressing Refresh got a sync that could not possibly fix
 * July, reported "Up to date.", and left the board unchanged. A button labelled Refresh has to
 * actually re-ask for every month.
 *
 * The automatic boot sync stays on auto (`reason: 'first-sync'`): a brand-new rider has no
 * `last_full_sync_at`, so auto already resolves to full for them, and a returning rider gets the
 * cheap incremental on page load instead of a full rescan every time they open the tab.
 *
 * Cost, since a full sync is one Strava request per month: the 60-second per-athlete cooldown
 * bounds a single rider to one of these a minute, and the client's own rate-limit reserve refuses
 * to send rather than walking into a block -- surfacing as 429 `scope:"local"` with a wait time.
 *
 * @param {{reason?: string}} [options]
 */
async function refresh(options = {}) {
  if (state.syncing) return;
  const firstSync = options.reason === 'first-sync';
  state.syncing = true;
  ui.removeBanner(BANNER.SYNC);
  ui.setRefreshPending(true);
  ui.setStatus(firstSync
    ? 'Fetching your rides from Strava for the first time…'
    : 'Syncing your rides from Strava…');
  try {
    // The month ON SCREEN goes with the sync, or the embedded board comes back for the
    // server's current month and Refresh silently snaps the view from June to August.
    const result = await api.syncNow(firstSync ? undefined : 'full', state.month);
    const board = result?.leaderboard ?? null;
    // Hand the embedded board straight to loadAll instead of rendering it here and then
    // letting loadAll fetch and render it AGAIN. That double paint was the most visible
    // stutter in the app, on its slowest interaction: three round trips and two full roster
    // rebuilds where two round trips and one rebuild do the same work.
    await loadAll({ board });
    ui.setStatus('Up to date.');
  } catch (error) {
    await handleSyncError(error);
  } finally {
    state.syncing = false;
    ui.setRefreshPending(false);
  }
}

/** @param {import('./api.js').ApiError} error */
async function handleSyncError(error) {
  if (error?.code === 'sync_in_progress') {
    await waitOutRunningSync(error);
    return;
  }
  const { text, actionLabel, action } = syncErrorMessage(error);
  ui.setStatus('');
  ui.showBanner({
    id: BANNER.SYNC,
    kind: error?.code === 'rate_limited' ? 'warn' : 'error',
    text,
    actionLabel,
    onAction: actionLabel === null ? undefined : () => {
      if (action === 'reconnect') api.startLogin({ reconnect: true });
      else if (action === 'login') api.startLogin();
      else refresh().catch(reportFatal);
    },
  });
}

/**
 * A 409 means another sync (another tab, or the same rider on their phone) holds the lock.
 * Poll the board on a BOUNDED schedule, then give up and hand the button back.
 *
 * The bound is the point. An unbounded "wait until it finishes" loop leaves the Refresh
 * button spinning forever the moment the other worker dies holding the lock.
 *
 * @param {import('./api.js').ApiError} error the 409, whose body may carry retry_after_seconds
 * @returns {Promise<boolean>} true if the sync visibly completed
 */
async function waitOutRunningSync(error) {
  const deadline = Date.now() + SYNC_POLL_MAX_MS;
  const before = state.leaderboard?.sync?.last_synced_at ?? null;
  ui.setStatus('A sync is already running. Waiting for it to finish…');
  ui.setRefreshPending(true, 'Waiting…');

  while (Date.now() < deadline) {
    await sleep(SYNC_POLL_INTERVAL_MS);
    let board = null;
    try {
      board = await api.getLeaderboard(undefined, state.month);
    } catch {
      // Keep polling until the deadline; a transient failure is not a reason to stop.
    }
    if (board !== null) {
      state.leaderboard = board;
      ui.renderScoreboard(board);
      ui.renderRoster(board);
      if ((board.sync?.last_synced_at ?? null) !== before) {
        ui.setStatus('Sync finished.');
        return true;
      }
    }
  }

  ui.setStatus('');
  const wait = error?.retryAfterSeconds;
  ui.showBanner({
    id: BANNER.SYNC,
    kind: 'warn',
    text: wait === null || wait === undefined
      ? 'A sync was already running and has not finished yet. Give it a moment and press Refresh again.'
      : `A sync was already running. Try again in about ${Math.max(1, Math.ceil(wait))} s.`,
    actionLabel: 'Refresh',
    onAction: () => { refresh().catch(reportFatal); },
  });
  return false;
}

/** Log out locally no matter what the server says. */
async function doLogout() {
  // Clear first so the dialog's reopen guard cannot trap a rider who is leaving.
  state.needsTeam = false;
  ui.closeTeamPicker();
  const { ok } = await api.logout();
  ui.removeBanner(BANNER.LOGOUT);
  if (!ok) {
    ui.showBanner({
      id: BANNER.LOGOUT,
      kind: 'warn',
      text: 'Signed out of this browser. The server did not confirm, so sign out again later if you are on a shared computer.',
    });
  }
  await loadAll();
}

/**
 * Read the OAuth fragment once and scrub it with a single history.replaceState.
 * @returns {{token: string|null, error: string|null, present: boolean}}
 */
function consumeAuthFragment() {
  const parsed = parseAuthFragment(typeof location === 'undefined' ? '' : location.hash);
  if (!parsed.present) return parsed;

  // Adopt the bearer token, if the deploy is on the cross-site path that issues one.
  if (parsed.token !== null) api.storeToken(parsed.token);

  // Exactly ONE mutation of the URL, after every value has been read out of `parsed`.
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  } catch {
    /* replaceState can throw on exotic origins; the fragment is cosmetic at this point */
  }
  return parsed;
}

/** Last-resort error surface. Never let a boot failure leave a blank page. */
function reportFatal(error) {
  try {
    ui.setRefreshPending(false);
    ui.showBanner({
      id: 'fatal',
      kind: 'error',
      text: 'Something went wrong loading the page. Reload to try again.',
      actionLabel: 'Reload',
      onAction: () => { if (typeof location !== 'undefined') location.reload(); },
      dismissible: false,
    });
  } catch {
    /* the DOM itself is unusable; nothing left to do but not throw again */
  }
  // eslint-disable-next-line no-console
  console.error('[bike-comp] fatal', error);
}

/** Wire the page up and do the first load. */
export async function start() {
  ui.setLoginHref(api.loginHref(), api.loginHref({ reconnect: true }));
  ui.bindEvents({
    onConnect: (event) => {
      // A top-level navigation, never a fetch: /api/auth/strava/login 302s to strava.com
      // and a fetch of a cross-origin redirect fails CORS silently.
      event.preventDefault();
      api.startLogin();
    },
    onReconnect: (event) => {
      event.preventDefault();
      api.startLogin({ reconnect: true });
    },
    onRefresh: () => { refresh().catch(reportFatal); },
    onLogout: () => { doLogout().catch(reportFatal); },
    onMonthChange: (month) => { selectMonth(month).catch(reportFatal); },
    onMonthPrev: () => stepMonth(-1),
    onMonthNext: () => stepMonth(1),
    onOpenTeamPicker: () => ui.openTeamPicker(),
    onChooseTeam: (team) => { chooseTeam(team).catch(reportFatal); },
    onTeamPickerClosed: handleTeamPickerClosed,
  });

  const fragment = consumeAuthFragment();
  if (fragment.error !== null) {
    ui.showBanner({
      id: BANNER.OAUTH,
      kind: 'error',
      text: oauthErrorMessage(fragment.error),
      actionLabel: 'Try again',
      onAction: () => api.startLogin({ reconnect: true }),
    });
  }

  const boot = await loadAll();

  // A rider who has never synced sees an empty board otherwise: the OAuth callback
  // deliberately does not sync (awaiting it turns a rate limit into a failed login, and
  // fire-and-forget is killed on serverless without ctx.waitUntil). The server's 60 s
  // cooldown makes this safe and idempotent.
  if (boot.authenticated && !boot.showTeamPicker && boot.rider?.last_synced_at === null) {
    refresh({ reason: 'first-sync' }).catch(reportFatal);
  }
}

/* ------------------------------------------------------------------------- bootstrap ---- */

// Guarded so `import('./app.js')` in Node (test/frontend-contract.test.js) exercises the
// pure exports above without trying to touch a DOM that does not exist.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { start().catch(reportFatal); });
  } else {
    start().catch(reportFatal);
  }
}
