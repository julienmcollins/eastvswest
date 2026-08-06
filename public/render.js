/**
 * The ONLY module in public/ that touches the DOM.
 *
 * Two halves, deliberately separated:
 *
 *  1. Pure shaping functions (`shapeRiderRow`, `shapeScoreboard`) that turn a contract
 *     payload into plain objects of display strings. No DOM, total, unit-testable in Node.
 *  2. DOM writers that take those objects and put them on the page.
 *
 * Text is assigned with `textContent`, always, everywhere. Rider display names come
 * straight from Strava and are attacker-controlled: a rider can rename themselves to
 * `<img src=x onerror=...>` at will. The HTML-parsing assignment sink is banned in this
 * file — that is a security control, not a style preference, and the meta CSP in
 * index.html is its backstop, not its replacement.
 *
 * Nothing here touches `document` at import time: every lookup goes through `dom()`,
 * which caches on first call. That is what lets test/frontend-contract.test.js import
 * this module in Node with no DOM at all.
 */

import { MAX_PICKER_MONTHS, TEAMS, TEAM_LABELS } from './config.js?v=2';
import {
  AVATAR_FALLBACK,
  EM_DASH,
  dateRange,
  int,
  miles,
  pct,
  pctCss,
  plural,
  relTime,
  safeAvatar,
  safeHref,
  teamLabel,
} from './format.js?v=2';

/* ------------------------------------------------------------------ pure shaping ---- */

/**
 * Shape one rider from `/api/leaderboard`.`riders[]` into display strings.
 *
 * TOTAL: every field is defended, because this runs inside `riders.map(...)` and one
 * throw on one rider blanks the entire roster. The fixture's `rank: null` and
 * `avatar_url: null` rows are the canaries.
 *
 * @param {object} rider
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {object} display-ready row
 */
export function shapeRiderRow(rider, now = Date.now()) {
  const r = rider ?? {};
  const badges = [];

  // scope === 'read': the rider unchecked private activities on Strava's consent screen.
  // Fully functional, public rides count. Badge it, never lock them out.
  if (r.private_rides_counted === false) {
    badges.push({
      code: 'public-only',
      label: 'public rides only',
      title: 'This rider did not grant access to private activities, so only their public rides count.',
    });
  }
  // Row, team and history all survive a revocation so the total freezes instead of
  // vanishing mid-race.
  if (r.revoked === true) {
    badges.push({
      code: 'revoked',
      label: 'reconnect',
      title: 'This rider revoked access at Strava. Their total is frozen until they reconnect.',
    });
  }

  const hasRank = r.rank !== null && r.rank !== undefined;
  const name = typeof r.display_name === 'string' && r.display_name.trim() !== ''
    ? r.display_name
    : 'Unnamed rider';

  return {
    athleteId: r.athlete_id ?? null,
    // A null rank is contractual, not missing data: zero-mile ties are the common case on
    // day one, and a numeric rank there would be signup order dressed up as a ranking.
    rankText: hasRank ? int(r.rank) : EM_DASH,
    ranked: hasRank,
    name,
    profileHref: safeHref(r.profile_url),
    avatarSrc: safeAvatar(r.avatar_url, AVATAR_FALLBACK),
    team: typeof r.team === 'string' ? r.team : '',
    teamLabel: teamLabel(r.team, TEAM_LABELS),
    milesText: miles(r.miles),
    rideCountText: int(r.ride_count),
    longestText: miles(r.longest_ride_miles),
    isYou: r.is_you === true,
    frozen: r.revoked === true,
    syncedText: relTime(r.last_synced_at, now),
    badges,
  };
}

/**
 * Shape the headline scoreboard. `teams` is contractually two entries in EAST-then-WEST
 * order, but this rebuilds that order from TEAMS anyway so a server bug degrades into a
 * zero rather than a swapped scoreboard.
 *
 * @param {object} leaderboard the /api/leaderboard payload
 * @returns {object} `{cards, leaderText, tie, totalsText, totalMiles, barLabel}`
 */
export function shapeScoreboard(leaderboard) {
  const data = leaderboard ?? {};
  const rows = Array.isArray(data.teams) ? data.teams : [];
  const byTeam = new Map();
  for (const row of rows) {
    if (row && typeof row.team === 'string') byTeam.set(row.team, row);
  }

  const cards = TEAMS.map((code) => {
    const row = byTeam.get(code) ?? {};
    const share = Number.isFinite(Number(row.share)) ? Number(row.share) : 0.5;
    return {
      team: code,
      label: typeof row.label === 'string' && row.label !== '' ? row.label : TEAM_LABELS[code],
      miles: Number(row.miles) || 0,
      milesText: miles(row.miles ?? 0),
      rideCountText: int(row.ride_count ?? 0),
      riderCountText: plural(row.rider_count ?? 0, 'rider'),
      share,
      shareText: pct(share),
      shareCss: pctCss(share),
    };
  });

  const totals = data.totals ?? {};
  const totalMiles = Number(totals.miles) || 0;
  const leader = data.leader ?? null;
  const tie = leader === null;
  const monthState = data.competition?.state;

  let leaderText;
  if (tie && totalMiles === 0) {
    // An empty board is no longer only "day one". With a month picker any finished month with
    // no rides is one click away, and "everything is still up for grabs" would be a lie about
    // a race that is already over -- so the wording follows the month's own state.
    if (monthState === 'closed') leaderText = 'Nobody logged a ride this month.';
    else if (monthState === 'upcoming') leaderText = 'This month has not started yet.';
    else leaderText = 'No miles on the board yet. Everything is still up for grabs.';
  } else if (tie) {
    leaderText = `Dead heat — ${cards[0].label} and ${cards[1].label} are level at ${cards[0].milesText} mi.`;
  } else {
    const code = typeof leader.team === 'string' ? leader.team : '';
    const label = teamLabel(code, TEAM_LABELS);
    const marginNumber = Number(leader.margin_miles);
    const margin = Number.isFinite(marginNumber) ? Math.max(0, marginNumber) : 0;
    leaderText = margin === 0
      ? `${label} leads on the tiebreak.`
      : `${label} leads by ${miles(margin)} mi.`;
  }

  return {
    cards,
    tie,
    leaderText,
    totalMiles,
    totalMilesText: miles(totalMiles),
    totalsText: `${miles(totalMiles)} mi total · ${plural(totals.ride_count ?? 0, 'ride')} · ${plural(totals.rider_count ?? 0, 'rider')}`,
    barLabel: `${cards[0].label} ${cards[0].shareText}, ${cards[1].label} ${cards[1].shareText}`,
    unit: typeof data.units?.distance === 'string' ? data.units.distance : 'mi',
  };
}

/* ---------------------------------------------------------------------- the month ---- */

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** Long month names, for the picker's option labels. `Jan`/`Feb` in format.js are for dates. */
const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

/**
 * `"2026-08"` -> `"August 2026"`. TOTAL: returns the input unchanged for anything it cannot
 * read, because this labels the `<option>` a reader has to click and a thrown error here
 * would leave the picker with no options at all.
 *
 * @param {unknown} month
 * @returns {string}
 */
export function monthLabel(month) {
  const m = MONTH_RE.exec(String(month ?? ''));
  if (!m) return typeof month === 'string' && month !== '' ? month : EM_DASH;
  const index = Number(m[2]) - 1;
  if (index < 0 || index > 11) return String(month);
  return `${MONTH_NAMES[index]} ${m[1]}`;
}

/**
 * Every selectable month from `first` to `last`, inclusive, oldest first.
 *
 * Arithmetic on the STRING, never on a Date: `new Date('2026-08')` is midnight UTC and
 * formats as July for anyone west of Greenwich, which is exactly the class of bug that
 * `format.js`'s `shortDate` also exists to avoid. A month is a label, not an instant.
 *
 * Capped at MAX_PICKER_MONTHS from the LAST month backwards, so the months nearest now survive.
 * The server caps its own range with the mirrored constant in server/contracts.js, so reaching
 * this limit means the server ignored its cap -- the guard stays because a corrupt
 * `start_date_local` in one activity row can widen the server's range without anyone editing
 * config, and twelve thousand DOM nodes on first paint is a blank page, not a slow one.
 *
 * @param {unknown} first `YYYY-MM`
 * @param {unknown} last `YYYY-MM`
 * @returns {string[]}
 */
export function monthOptions(first, last) {
  const lo = MONTH_RE.test(String(first ?? '')) ? String(first) : null;
  const hi = MONTH_RE.test(String(last ?? '')) ? String(last) : null;
  if (lo === null || hi === null || hi < lo) return [];

  const out = [];
  // Walk down from `hi`, then reverse: that is what makes the cap drop the OLDEST months.
  let cursor = hi;
  while (cursor >= lo && out.length < MAX_PICKER_MONTHS) {
    out.push(cursor);
    cursor = stepMonth(cursor, -1);
  }
  return out.reverse();
}

/** @param {string} month @param {number} delta @returns {string} */
function stepMonth(month, delta) {
  const m = MONTH_RE.exec(month);
  const year = Number(m[1]);
  const index = Number(m[2]) - 1 + delta;
  // Math on integers rather than Date, so no timezone can get involved. Floor division is
  // what makes January - 1 roll back to the previous December instead of month -1.
  const yearShift = Math.floor(index / 12);
  const normalized = index - yearShift * 12;
  return `${String(year + yearShift).padStart(4, '0')}-${String(normalized + 1).padStart(2, '0')}`;
}

/**
 * Shape the competition line for the SELECTED MONTH.
 * @param {object} competition the `competition` object from /api/me or /api/leaderboard
 */
export function shapeCompetition(competition) {
  const c = competition ?? {};
  const month = typeof c.month === 'string' ? c.month : '';
  const days = Number(c.days_remaining);
  let statusText;
  if (c.state === 'upcoming') statusText = 'Not started yet';
  else if (c.state === 'closed') statusText = 'Final results';
  else if (Number.isFinite(days)) statusText = days === 0 ? 'Last day' : plural(days, 'day') + ' to go';
  else statusText = 'In progress';
  return {
    month,
    // The month IS the competition, so its name is the headline. `dateRange` stays as the
    // fallback for a payload with no `month` -- a stale cached module paired with a new
    // server shows the dates rather than an em-dash.
    rangeText: month !== '' ? monthLabel(month) : dateRange(c.start, c.end),
    statusText,
    timezoneText: typeof c.timezone === 'string' && c.timezone !== '' ? `dates in ${c.timezone}` : '',
    sportsText: Array.isArray(c.allowed_sport_types) && c.allowed_sport_types.length > 0
      ? `Counting ${c.allowed_sport_types.join(', ')}.`
      : '',
    manualText: c.manual_rides_counted === true
      ? 'Manual entries count once an admin approves them.'
      : 'Manual entries do not count.',
    state: typeof c.state === 'string' ? c.state : 'open',
  };
}

/**
 * Shape the month picker: the options, the selection, and whether prev/next are live.
 *
 * `prev_month`/`next_month` come straight off the wire rather than being derived from the
 * option list, because the server is the only side that knows the bounds for certain -- and
 * `null` from it IS the disabled state, so there is no arithmetic here to get wrong.
 *
 * @param {object} competition
 * @returns {{options: {month: string, label: string, current: boolean}[], selected: string,
 *            prev: string|null, next: string|null, hasPrev: boolean, hasNext: boolean,
 *            usable: boolean}}
 */
export function shapeMonthPicker(competition) {
  const c = competition ?? {};
  const selected = typeof c.month === 'string' ? c.month : '';
  const current = typeof c.current_month === 'string' ? c.current_month : '';
  const months = monthOptions(c.first_month, c.last_month);

  // A selected month absent from the list would leave the <select> showing the wrong value
  // silently, so it is added rather than dropped. Only reachable if the server ever emits a
  // month outside its own bounds; belt and braces, because the alternative is invisible.
  if (selected !== '' && !months.includes(selected)) {
    months.push(selected);
    months.sort();
  }

  const prev = typeof c.prev_month === 'string' ? c.prev_month : null;
  const next = typeof c.next_month === 'string' ? c.next_month : null;

  return {
    options: months.map((month) => ({ month, label: monthLabel(month), current: month === current })),
    selected,
    prev,
    next,
    hasPrev: prev !== null,
    hasNext: next !== null,
    // Visible whenever the server offered ANY month. It deliberately does NOT hide itself on a
    // single-month range any more: hiding is indistinguishable from the feature not existing,
    // which is exactly how this control got reported missing on a one-month `.env`. A lone
    // option with two dead arrows is honest about a one-month deployment, and because every
    // calendar month is its own competition the list grows on its own from there. Zero options
    // -- a payload with no first_month/last_month at all -- is the one case worth hiding.
    usable: months.length > 0,
  };
}

/* ------------------------------------------------------------------- DOM plumbing ---- */

/** @type {Record<string, Element|null>|null} */
let cache = null;

/**
 * Signature of the `<option>` list currently in the month `<select>`, so an identical list is
 * not rebuilt. Reset alongside `cache`, because a new DOM means a new, empty `<select>` and a
 * stale signature would skip the one rebuild that IS needed.
 * @type {string|null}
 */
let monthOptionsSignature = null;

/** Lazily resolve and cache every element we write to. Throws only if called with no DOM. */
function dom() {
  if (cache !== null) return cache;
  if (typeof document === 'undefined') {
    throw new Error('render.js DOM functions require a document; import-time use is pure only.');
  }
  const byId = (id) => document.getElementById(id);
  cache = {
    root: document.documentElement,
    banners: byId('banners'),
    status: byId('status'),

    windowRange: byId('window-range'),
    windowStatus: byId('window-status'),
    windowMeta: byId('window-meta'),

    monthPicker: byId('month-picker'),
    monthSelect: byId('month-select'),
    monthPrev: byId('btn-month-prev'),
    monthNext: byId('btn-month-next'),

    scoreboard: byId('scoreboard'),
    splitBar: byId('split-bar'),
    leaderLine: byId('leader-line'),
    totalsLine: byId('totals-line'),

    emptyState: byId('empty-state'),
    roster: byId('roster'),
    riderRows: byId('rider-rows'),
    rosterEmpty: byId('roster-empty'),
    rosterNote: byId('roster-note'),
    syncLine: byId('sync-line'),

    connect: byId('btn-connect'),
    refresh: byId('btn-refresh'),
    logout: byId('btn-logout'),
    pickTeam: byId('btn-pick-team'),
    reconnect: byId('btn-reconnect'),

    viewer: byId('viewer'),
    viewerAvatar: byId('viewer-avatar'),
    viewerName: byId('viewer-name'),
    viewerTeam: byId('viewer-team'),

    dialog: byId('team-dialog'),
    dialogError: byId('team-dialog-error'),
    dialogLogout: byId('btn-dialog-logout'),

    tplRow: byId('tpl-rider-row'),
    tplBanner: byId('tpl-banner'),
    tplBadge: byId('tpl-badge'),
  };
  for (const code of TEAMS) {
    const key = code.toLowerCase();
    cache[`${key}Label`] = byId(`${key}-label`);
    cache[`${key}Miles`] = byId(`${key}-miles`);
    cache[`${key}Share`] = byId(`${key}-share`);
    cache[`${key}Sub`] = byId(`${key}-sub`);
    cache[`${key}Fill`] = byId(`split-${key}`);
  }
  return cache;
}

/** Test/teardown hook: forget the cached element references. */
export function resetDomCache() {
  cache = null;
  // Must be cleared with it: the signature describes the OLD <select>'s contents, and keeping
  // it would make the first render against a fresh DOM skip building any options at all.
  monthOptionsSignature = null;
}

/** @param {Element|null} el @param {string} text */
function setText(el, text) {
  if (el) el.textContent = text;
}

/** @param {Element|null} el @param {boolean} visible */
function setVisible(el, visible) {
  if (el) el.hidden = !visible;
}

/** @param {Element|null} el @param {string} name @param {boolean} on */
function setFlag(el, name, on) {
  if (el) el.classList.toggle(name, Boolean(on));
}

/* ------------------------------------------------------------------- DOM writers ---- */

/**
 * Render the masthead competition line for the selected month, and the picker with it.
 * @param {object} competition
 */
export function renderCompetition(competition) {
  const d = dom();
  const shaped = shapeCompetition(competition);
  setText(d.windowRange, shaped.rangeText);
  setText(d.windowStatus, shaped.statusText);
  setText(
    d.windowMeta,
    [shaped.timezoneText, shaped.sportsText, shaped.manualText].filter(Boolean).join(' · '),
  );
  if (d.windowStatus) d.windowStatus.dataset.state = shaped.state;
  renderMonthPicker(competition);
}

/**
 * Render the month picker from the server's own view of what is selectable.
 *
 * Rebuilt wholesale on every render rather than diffed: the option list only changes when
 * the bounds do, and `replaceChildren` + one `value` assignment is far less code than a
 * reconciliation nobody will read again. `option.textContent` (never innerHTML) for the same
 * reason it is used everywhere else in this file.
 *
 * The `<select>`'s value is set from the RESPONSE, not from whatever the reader clicked.
 * That is what makes a clamped month self-correcting: ask for 2030-01, get 2026-08 back, and
 * the control snaps to what is actually on screen instead of lying about it.
 *
 * @param {object} competition
 */
export function renderMonthPicker(competition) {
  const d = dom();
  const shaped = shapeMonthPicker(competition);

  setVisible(d.monthPicker, shaped.usable);

  const select = d.monthSelect;
  if (select) {
    // Rebuild the option list ONLY when it actually differs.
    //
    // This runs on every render pass -- including each poll of a running sync -- and the list
    // can be MAX_PICKER_MONTHS long, so the naive version recreated up to 120 elements a few
    // times a second to produce byte-identical markup. Worse than the wasted work: replacing a
    // <select>'s children is a destructive reset of a control the reader may be using, which
    // is what made the dropdown feel like it was fighting back.
    //
    // The signature covers the month AND its "(this month)" marker, so a rollover from August
    // to September relabels rather than silently keeping a stale marker.
    const signature = shaped.options.map((item) => (item.current ? `${item.month}*` : item.month)).join(',');
    if (signature !== monthOptionsSignature) {
      const options = document.createDocumentFragment();
      for (const item of shaped.options) {
        const option = document.createElement('option');
        option.value = item.month;
        // "(this month)" rather than a style, because styles.css is not this module's to write
        // and the distinction has to survive in text either way.
        option.textContent = item.current ? `${item.label} (this month)` : item.label;
        options.append(option);
      }
      select.replaceChildren(options);
      monthOptionsSignature = signature;
    }
    // Always reasserted, even when the list was reused: the selected month is what the SERVER
    // resolved to, and that changes on every month switch while the option list does not.
    if (shaped.selected !== '') select.value = shaped.selected;
  }

  // `disabled` and not `hidden`: a button that vanishes at the ends of the range moves the
  // two controls next to it sideways on every click.
  if (d.monthPrev) d.monthPrev.disabled = !shaped.hasPrev;
  if (d.monthNext) d.monthNext.disabled = !shaped.hasNext;
}

/**
 * Render the scoreboard headline and the split bar.
 * @param {object} leaderboard
 */
export function renderScoreboard(leaderboard) {
  const d = dom();
  const shaped = shapeScoreboard(leaderboard);

  for (const card of shaped.cards) {
    const key = card.team.toLowerCase();
    setText(d[`${key}Label`], card.label);
    setText(d[`${key}Miles`], card.milesText);
    setText(d[`${key}Share`], card.shareText);
    setText(d[`${key}Sub`], `${card.rideCountText} rides · ${card.riderCountText}`);
    // Width via CSSOM, never a style attribute: CSP `style-src 'self'` blocks inline style
    // attributes in markup, but does not reach programmatic CSSOM writes.
    if (d[`${key}Fill`]) d[`${key}Fill`].style.setProperty('--share', card.shareCss);
  }
  if (d.splitBar) d.splitBar.setAttribute('aria-label', shaped.barLabel);

  setText(d.leaderLine, shaped.leaderText);
  setFlag(d.leaderLine, 'is-tie', shaped.tie);
  setText(d.totalsLine, shaped.totalsText);
}

/**
 * Render the ranked rider table, or the pre-first-sync empty state.
 *
 * The empty state is driven by `sync.last_synced_at === null`, never by
 * `riders.length === 0`: a table with no rows and no explanation reads as a broken page.
 *
 * @param {object} leaderboard
 * @param {number} [now]
 */
export function renderRoster(leaderboard, now = Date.now()) {
  const d = dom();
  const data = leaderboard ?? {};
  const riders = Array.isArray(data.riders) ? data.riders : [];
  const neverSynced = (data.sync ?? {}).last_synced_at === null
    || (data.sync ?? {}).last_synced_at === undefined;

  setVisible(d.emptyState, neverSynced);
  setVisible(d.roster, !neverSynced);

  const tbody = d.riderRows;
  const template = d.tplRow;
  if (tbody) tbody.replaceChildren();
  if (!neverSynced && tbody && template) {
    const frag = document.createDocumentFragment();
    for (const rider of riders) {
      frag.append(buildRiderRow(shapeRiderRow(rider, now), template, d.tplBadge));
    }
    tbody.append(frag);
  }

  setVisible(d.rosterEmpty, !neverSynced && riders.length === 0);
  const sync = data.sync ?? {};
  const bits = [`Last sync ${relTime(sync.last_synced_at, now)}`];
  const never = Number(sync.riders_never_synced);
  if (Number.isFinite(never) && never > 0) bits.push(`${plural(never, 'rider')} not synced yet`);
  if (typeof data.generated_at === 'string') bits.push(`board built ${relTime(data.generated_at, now)}`);
  setText(d.syncLine, bits.join(' · '));

  const shapedComp = shapeCompetition(data.competition);
  setText(d.rosterNote, [shapedComp.sportsText, shapedComp.manualText].filter(Boolean).join(' '));
}

/**
 * @param {object} row output of shapeRiderRow
 * @param {HTMLTemplateElement} template
 * @param {HTMLTemplateElement|null} badgeTemplate
 * @returns {Element}
 */
function buildRiderRow(row, template, badgeTemplate) {
  const tr = template.content.firstElementChild.cloneNode(true);
  const field = (name) => tr.querySelector(`[data-f="${name}"]`);

  setText(field('rank'), row.rankText);
  setFlag(tr, 'is-unranked', !row.ranked);
  setFlag(tr, 'is-you', row.isYou);
  setFlag(tr, 'is-frozen', row.frozen);
  if (row.isYou) tr.setAttribute('aria-current', 'true');

  const avatar = field('avatar');
  if (avatar) {
    avatar.src = row.avatarSrc;
    avatar.alt = ''; // decorative; the name is right next to it
  }

  const link = field('profile');
  if (link) {
    setText(link, row.name);
    if (row.profileHref === null) {
      // No usable https: profile URL. A dead <a href> is worse than a plain label.
      link.removeAttribute('href');
      link.classList.add('no-link');
    } else {
      link.href = row.profileHref;
    }
  }

  setVisible(field('youtag'), row.isYou);
  setText(field('team'), row.teamLabel);
  const chip = field('team');
  if (chip) chip.dataset.team = row.team;
  setText(field('miles'), row.milesText);
  setText(field('rides'), row.rideCountText);
  setText(field('longest'), row.longestText);

  const badgeHost = field('badges');
  if (badgeHost) {
    badgeHost.replaceChildren();
    for (const badge of row.badges) {
      badgeHost.append(buildBadge(badge, badgeTemplate));
    }
  }
  return tr;
}

/** @returns {Element} */
function buildBadge(badge, badgeTemplate) {
  const el = badgeTemplate
    ? badgeTemplate.content.firstElementChild.cloneNode(true)
    : document.createElement('span');
  el.classList.add('badge', `badge-${badge.code}`);
  el.dataset.badge = badge.code;
  el.title = badge.title;
  el.textContent = badge.label;
  return el;
}

/**
 * Render everything that depends on who is looking.
 * @param {object|null} me the /api/me payload, or null if that call failed
 */
export function renderIdentity(me) {
  const d = dom();
  const authenticated = me?.authenticated === true;
  const rider = me?.rider ?? null;

  setVisible(d.connect, !authenticated);
  setVisible(d.refresh, authenticated);
  setVisible(d.logout, authenticated);
  setVisible(d.viewer, authenticated && rider !== null);
  // Persistent escape hatch: the modal must never be the only path to a team.
  setVisible(d.pickTeam, authenticated && rider !== null && rider.needs_team === true);
  setVisible(d.reconnect, authenticated && rider !== null && rider.revoked === true);

  if (authenticated && rider !== null) {
    setText(d.viewerName, typeof rider.display_name === 'string' && rider.display_name !== ''
      ? rider.display_name
      : 'You');
    if (d.viewerAvatar) {
      d.viewerAvatar.src = safeAvatar(rider.avatar_url, AVATAR_FALLBACK);
      d.viewerAvatar.alt = '';
    }
    const team = rider.team;
    setText(d.viewerTeam, team === null || team === undefined
      ? 'no team yet'
      : teamLabel(team, TEAM_LABELS));
    if (d.viewerTeam) d.viewerTeam.dataset.team = typeof team === 'string' ? team : '';
  }
}

/**
 * Point the Strava links at the origin config.js resolved. The markup ships with relative
 * fallbacks that are correct on a single-origin deploy even with JavaScript disabled.
 *
 * @param {string} loginHref
 * @param {string} [reconnectHref]
 */
export function setLoginHref(loginHref, reconnectHref) {
  const d = dom();
  if (d.connect) d.connect.href = loginHref;
  if (d.reconnect && typeof reconnectHref === 'string') d.reconnect.href = reconnectHref;
}

/**
 * Put the Refresh button into or out of its pending state.
 * @param {boolean} pending
 * @param {string} [label]
 */
export function setRefreshPending(pending, label) {
  const d = dom();
  const button = d.refresh;
  if (!button) return;
  button.disabled = Boolean(pending);
  button.setAttribute('aria-busy', pending ? 'true' : 'false');
  setFlag(button, 'is-pending', pending);
  const text = button.querySelector('[data-f="label"]') ?? button;
  setText(text, label ?? (pending ? 'Syncing…' : 'Refresh'));
}

/**
 * Disable the month controls while that month's board is in flight.
 *
 * Without it a reader can queue three month changes in a second and the board lands on
 * whichever response happens to arrive last, which is not necessarily the one they picked.
 *
 * @param {boolean} pending
 */
export function setMonthPickerPending(pending) {
  const d = dom();
  const busy = Boolean(pending);
  if (d.monthSelect) {
    d.monthSelect.disabled = busy;
    d.monthSelect.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  // Re-enabled by the next renderMonthPicker, which is the only thing that knows whether
  // each end of the range is actually live.
  if (busy) {
    if (d.monthPrev) d.monthPrev.disabled = true;
    if (d.monthNext) d.monthNext.disabled = true;
  }
}

/** Announce transient progress in a polite live region. */
export function setStatus(text) {
  setText(dom().status, text ?? '');
}

/**
 * Append a banner.
 * @param {{kind?: 'info'|'warn'|'error', text: string, actionLabel?: string,
 *          onAction?: () => void, dismissible?: boolean, id?: string}} options
 */
export function showBanner(options) {
  const d = dom();
  if (!d.banners || !d.tplBanner) return null;
  const kind = options.kind ?? 'info';
  if (options.id) removeBanner(options.id);

  const el = d.tplBanner.content.firstElementChild.cloneNode(true);
  el.classList.add(`banner-${kind}`);
  el.dataset.kind = kind;
  if (options.id) el.dataset.bannerId = options.id;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  setText(el.querySelector('[data-f="text"]'), options.text);

  const action = el.querySelector('[data-f="action"]');
  if (action) {
    if (typeof options.onAction === 'function' && options.actionLabel) {
      setText(action, options.actionLabel);
      action.hidden = false;
      action.addEventListener('click', options.onAction);
    } else {
      action.hidden = true;
    }
  }
  const dismiss = el.querySelector('[data-f="dismiss"]');
  if (dismiss) {
    if (options.dismissible === false) dismiss.hidden = true;
    else dismiss.addEventListener('click', () => el.remove());
  }
  d.banners.append(el);
  return el;
}

/** Remove a banner previously shown with the same `id`. */
export function removeBanner(id) {
  const d = dom();
  if (!d.banners) return;
  for (const el of d.banners.querySelectorAll(`[data-banner-id="${id}"]`)) el.remove();
}

/** Remove every banner. */
export function clearBanners() {
  const d = dom();
  if (d.banners) d.banners.replaceChildren();
}

/* ------------------------------------------------------------------ team picker ---- */

/** @returns {boolean} */
export function isTeamPickerOpen() {
  return Boolean(dom().dialog?.open);
}

/** Open the one-time team picker. Idempotent. */
export function openTeamPicker() {
  const d = dom();
  const dialog = d.dialog;
  if (!dialog || dialog.open) return;
  setText(d.dialogError, '');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

/** Close the team picker. */
export function closeTeamPicker() {
  const dialog = dom().dialog;
  if (!dialog || !dialog.open) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

/** Show a failure inside the still-open picker. */
export function setTeamPickerError(text) {
  setText(dom().dialogError, text ?? '');
}

/** Disable/enable the picker's buttons while a claim is in flight. */
export function setTeamPickerPending(pending) {
  const dialog = dom().dialog;
  if (!dialog) return;
  for (const button of dialog.querySelectorAll('button')) {
    button.disabled = Boolean(pending);
  }
}

/* ---------------------------------------------------------------- event wiring ---- */

/**
 * Wire every listener. app.js owns the behaviour and passes callbacks in; it never
 * touches the DOM itself, which is what keeps this module the single DOM surface.
 *
 * @param {{
 *   onConnect?: (event: Event) => void,
 *   onRefresh?: () => void,
 *   onLogout?: () => void,
 *   onOpenTeamPicker?: () => void,
 *   onChooseTeam?: (team: string) => void,
 *   onTeamPickerClosed?: () => void,
 *   onReconnect?: (event: Event) => void,
 * }} handlers
 */
export function bindEvents(handlers) {
  const d = dom();

  if (d.connect && handlers.onConnect) d.connect.addEventListener('click', handlers.onConnect);
  if (d.reconnect && handlers.onReconnect) d.reconnect.addEventListener('click', handlers.onReconnect);
  if (d.refresh && handlers.onRefresh) {
    d.refresh.addEventListener('click', () => handlers.onRefresh());
  }
  if (d.logout && handlers.onLogout) d.logout.addEventListener('click', () => handlers.onLogout());

  // `change`, not `input`: on a <select> `input` fires for keyboard arrowing through the
  // options too, so every month between the old and new one would trigger its own fetch.
  if (d.monthSelect && handlers.onMonthChange) {
    d.monthSelect.addEventListener('change', () => handlers.onMonthChange(d.monthSelect.value));
  }
  if (d.monthPrev && handlers.onMonthPrev) {
    d.monthPrev.addEventListener('click', () => handlers.onMonthPrev());
  }
  if (d.monthNext && handlers.onMonthNext) {
    d.monthNext.addEventListener('click', () => handlers.onMonthNext());
  }
  if (d.dialogLogout && handlers.onLogout) {
    d.dialogLogout.addEventListener('click', () => handlers.onLogout());
  }
  if (d.pickTeam && handlers.onOpenTeamPicker) {
    d.pickTeam.addEventListener('click', () => handlers.onOpenTeamPicker());
  }

  if (d.dialog) {
    if (handlers.onChooseTeam) {
      for (const button of d.dialog.querySelectorAll('[data-team]')) {
        button.addEventListener('click', () => handlers.onChooseTeam(button.dataset.team));
      }
    }
    if (handlers.onTeamPickerClosed) {
      // Listen for `close`, not `cancel`. Calling preventDefault() on `cancel` is
      // unreliable without history-action user activation, so two Escape presses would
      // otherwise dismiss a mandatory choice for good. Reopening on `close` is the only
      // dependable guard.
      d.dialog.addEventListener('close', () => handlers.onTeamPickerClosed());
    }
  }
}
