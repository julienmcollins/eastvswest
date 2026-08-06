#!/usr/bin/env node
/**
 * One-time DEPLOY setup: apply every mechanical edit docs/DEPLOY.md asks for, then tell you
 * exactly what is left that only you can do.
 *
 *   node scripts/deploy-setup.mjs                                  # prompt for a mode
 *   node scripts/deploy-setup.mjs --default-hosts                   # user.github.io + workers.dev
 *   node scripts/deploy-setup.mjs --web-host www.example.com --api-host api.example.com
 *   node scripts/deploy-setup.mjs --dry-run                        # print the diff, write nothing
 *   node scripts/deploy-setup.mjs --force                          # overwrite an existing wrangler.toml
 *   node scripts/deploy-setup.mjs --no-verify                      # skip the npm test run
 *
 * TWO SUPPORTED SHAPES, and the difference is not cosmetic:
 *
 *   --web-host/--api-host   www.example.com + api.example.com. ONE registrable domain, so the
 *                           session cookie is first-party and nothing else has to change.
 *
 *   --default-hosts         <user>.github.io + <worker>.<account>.workers.dev. No domain to
 *                           buy and no DNS, but the two are DIFFERENT registrable domains, so
 *                           `bc_sid` and `bc_csrf` are third-party cookies that Safari blocks
 *                           and Chrome partitions. This mode therefore also turns on
 *                           AUTH_TOKEN_IN_FRAGMENT (the callback hands the session token to
 *                           the frontend in the URL fragment) and shortens SESSION_TTL_SECONDS,
 *                           because that token lives in localStorage. It also sets
 *                           WEB_BASE_PATH, since a Pages PROJECT site is served from
 *                           `user.github.io/<repo>/` and the origin root is GitHub's own 404.
 *
 * This is the counterpart to `npm run setup`, which configures LOCAL dev (.env + start).
 * Nothing here touches .env or your local database.
 *
 * SAFE TO RE-RUN. Every edit is idempotent: applying it twice produces the same file, and a
 * second run with different hosts replaces the previous values rather than appending a second
 * copy. `wrangler.toml` is the one exception -- it is never overwritten without --force,
 * because by then it holds a real `database_id` this script cannot recover.
 *
 * WHAT IT DELIBERATELY CANNOT DO: change repo settings, add DNS records, update the Strava
 * app's callback domain, download the official Strava brand assets, or create the D1
 * database. Those need credentials, a browser, or network this script has no business
 * holding. They are printed as a checklist at the end instead of being silently skipped.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const DRY_RUN = flag('dry-run');
const FORCE = flag('force');
const NO_VERIFY = flag('no-verify');
// `--allow-cross-site` is the old name from when this script only warned about the cross-site
// deploy instead of configuring it. Kept so anyone following older notes is not stranded.
const BEARER = flag('bearer') || flag('allow-cross-site');

/**
 * Session lifetime used on the bearer path, in seconds.
 *
 * 12 hours, well under server/config.js's 24 h ceiling for this mode. The default 30 days is
 * fine for an HttpOnly cookie and is not fine for a token sitting in localStorage on an origin
 * shared with every other project the account has published.
 */
const BEARER_SESSION_TTL = 43200;

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const say = (...parts) => stdout.write(`${parts.join(' ')}\n`);
const changes = [];
const skipped = [];

function die(message, hint = null) {
  say(`\n${c.red('✖')} ${message}`);
  if (hint) say(`  ${c.dim(hint)}`);
  exit(1);
}

/* ------------------------------------------------------------------ host validation ---- */

/**
 * Suffixes under which the NEXT label is the registrable domain.
 *
 * A naive "compare the last two labels" test says `foo.co.uk` and `bar.co.uk` share a
 * registrable domain, which is wrong and would wave through exactly the broken-cookie
 * deployment this script exists to prevent. There is no Public Suffix List here (zero
 * dependencies, no network), so this is a deliberately short list of the ones that actually
 * come up -- plus `github.io` and `workers.dev`, where each account's subdomain IS the
 * registrable domain, which is what makes the default-hosts pair get correctly identified as
 * cross-site below.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'co.jp', 'com.br', 'co.in',
  'github.io', 'pages.dev', 'workers.dev', 'netlify.app', 'vercel.app',
]);

function registrableDomain(hostname) {
  const labels = String(hostname).toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  return lastTwo;
}

function assertHostname(value, label) {
  const host = String(value ?? '').trim().toLowerCase();
  if (host === '') die(`${label} is required.`);
  if (/^https?:\/\//.test(host)) {
    die(`${label} must be a bare hostname, not a URL. Got "${host}".`, 'e.g. www.example.com');
  }
  if (host.includes('/') || host.includes(':')) {
    die(`${label} must be a hostname with no path or port. Got "${host}".`);
  }
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) {
    die(`${label} does not look like a hostname. Got "${host}".`);
  }
  return host;
}

/** Normalize a Pages sub-path the same way server/config.js#basePath does: `/repo` or ``. */
function assertBasePath(value) {
  const raw = String(value ?? '').trim();
  if (raw === '' || raw === '/') return '';
  const path = (raw.startsWith('/') ? raw : `/${raw}`).replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(path)) {
    die(`--web-base-path must be a simple path like "/my-repo". Got "${raw}".`);
  }
  return path;
}

/* ------------------------------------------------------------------------- git remote ---- */

/**
 * `{user, repo}` from the origin remote, or null.
 *
 * Only used to pre-fill the default-hosts values. Getting either one wrong produces a site
 * that 404s rather than one that is subtly broken, so guessing here is cheap; guessing at a
 * custom domain would not be, which is why that path still requires explicit flags.
 */
function gitRemote() {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(r.stdout.trim());
  return m ? { user: m[1], repo: m[2] } : null;
}

/* --------------------------------------------------------------------- file editing ---- */

function read(path) {
  if (!existsSync(path)) die(`${path} is missing.`, 'Run this from the repository root.');
  return readFileSync(path, 'utf8');
}

function write(path, next, note) {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (before === next) {
    skipped.push(`${path} — already correct`);
    return;
  }
  if (!DRY_RUN) writeFileSync(path, next);
  changes.push(`${path} — ${note}`);
}

/** Delete a file that must NOT exist in this mode. Reports rather than silently unlinking. */
function remove(path, note) {
  if (!existsSync(path)) return;
  if (!DRY_RUN) rmSync(path);
  changes.push(`${path} — REMOVED: ${note}`);
}

/**
 * Point public/config.js at the API origin.
 *
 * Rewrites the single entry under the PRODUCTION marker, whether it is still the commented
 * template or a live value from an earlier run. Anchoring on the marker rather than appending
 * is what makes a second run with a different domain replace instead of accumulate -- two
 * hostname keys would both "work" locally and then silently disagree in a browser.
 */
function editConfigJs(source, webHost, apiOrigin) {
  const re = /( *\/\/ ---- PRODUCTION[^\n]*\n)( *(?:\/\/ *)?'[^']+': *'https?:\/\/[^']+',[^\n]*\n)/;
  if (!re.test(source)) {
    die(
      'public/config.js has no PRODUCTION entry to rewrite.',
      'Expected the "// ---- PRODUCTION:" marker followed by a hostname entry. Restore it from git.',
    );
  }
  return source.replace(re, `$1  '${webHost}': '${apiOrigin}',\n`);
}

/**
 * Widen the meta CSP's connect-src to the API origin.
 *
 * Replaces the whole token list rather than appending, so re-running with a different API
 * host does not leave the old one permitted. An unused connect-src entry is a widened attack
 * surface, and the DEPLOY GUARD test in test/frontend-contract.test.js fails on it.
 */
function editCsp(html, apiOrigin) {
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  if (!meta) die('No <meta> Content-Security-Policy found in public/index.html.');
  if (!/connect-src [^;"]+/.test(meta[1])) die('The CSP has no connect-src directive to widen.');
  const widened = meta[1].replace(/connect-src [^;"]+/, `connect-src 'self' ${apiOrigin}`);
  return html.replace(meta[1], widened);
}

/**
 * The `[[routes]]` / `workers_dev` section, built from scratch rather than regex-patched.
 *
 * MUST stay above every [table] in the output. `workers_dev` is a TOP-LEVEL key, and in TOML a
 * bare key written after a `[[d1_databases]]` header belongs to THAT table -- so emitting it
 * lower down parses fine, passes review, and gives the Worker no hostname at all. That is why
 * this splices between the "# ---- Routing" and "# ---- D1" headers rather than anywhere more
 * convenient.
 */
function routingSection(plan) {
  if (plan.workersDev) {
    return [
      '# ---- Routing: the default workers.dev subdomain ---------------------------------------',
      '# No custom domain and no DNS. The hostname is `name` above plus your Cloudflare',
      '# workers.dev subdomain, so this Worker answers on:',
      `#   https://${plan.apiHost}`,
      '# That is a DIFFERENT registrable domain from the Pages site, which is why',
      '# AUTH_TOKEN_IN_FRAGMENT is true below. See docs/DEPLOY.md.',
      '#',
      '# A top-level key, so it must stay above every [table] in this file.',
      'workers_dev = true',
      '',
      '',
    ].join('\n');
  }
  return [
    '# ---- Routing: a custom domain on the same registrable domain as the Pages site --------',
    '# Same registrable domain, so the session cookie stays first-party and cookies do all the',
    '# work. `custom_domain = true` makes wrangler create the DNS record for you.',
    '[[routes]]',
    `pattern = "${plan.apiHost}/*"`,
    'custom_domain = true',
    '',
    '',
  ].join('\n');
}

/** Substitute the real hosts into the wrangler template, carrying .env values across. */
function buildWranglerToml(template, plan, envValues) {
  const ROUTING = '# ---- Routing';
  const NEXT_SECTION = '# ---- D1';
  const start = template.indexOf(ROUTING);
  const end = template.indexOf(NEXT_SECTION);
  if (start === -1 || end === -1 || end < start) {
    die(
      'wrangler.toml.example is missing its "# ---- Routing" or "# ---- D1" marker, or they are out of order.',
      'Restore it from git: this script replaces the whole routing section between those two headers,\n'
      + '  and the routing section must precede every [table] so `workers_dev` stays top-level.',
    );
  }

  let out = `${template.slice(0, start)}${routingSection(plan)}${template.slice(end)}`;

  out = out
    .replace(/^# Copy to `wrangler\.toml`.*$/m, '# Generated by scripts/deploy-setup.mjs. Safe to edit by hand.')
    .replace(/^name = "[^"]*"/m, `name = "${plan.workerName}"`)
    .replace(/APP_BASE_URL = "[^"]*"/, `APP_BASE_URL = "https://${plan.webHost}"`)
    .replace(/API_BASE_URL = "[^"]*"/, `API_BASE_URL = "https://${plan.apiHost}"`)
    .replace(/WEB_ORIGIN = "[^"]*"/, `WEB_ORIGIN = "https://${plan.webHost}"`)
    .replace(/WEB_BASE_PATH = "[^"]*"/, `WEB_BASE_PATH = "${plan.webBasePath}"`)
    .replace(/AUTH_TOKEN_IN_FRAGMENT = "[^"]*"/, `AUTH_TOKEN_IN_FRAGMENT = "${plan.bearer}"`)
    // Today, on the machine actually deploying. The template ships a placeholder marked
    // [UNVERIFIED] precisely because a stale compatibility_date silently opts you out of
    // runtime fixes.
    .replace(/compatibility_date = "[^"]*"[^\n]*/, `compatibility_date = "${new Date().toISOString().slice(0, 10)}"`);

  for (const [key, value] of Object.entries(envValues)) {
    out = out.replace(new RegExp(`^${key} = "[^"]*"`, 'm'), `${key} = "${value}"`);
  }
  // LAST, so it wins over whatever .env carried over. On the bearer path the server refuses to
  // boot above 86400, and a wrangler.toml that cannot boot is a worse failure than a short
  // session: it is a 500 on every route with the reason only in `wrangler tail`.
  if (plan.bearer) {
    out = out.replace(/^SESSION_TTL_SECONDS = "[^"]*"/m, `SESSION_TTL_SECONDS = "${plan.sessionTtl}"`);
  }
  return out;
}

/** Read the handful of non-secret values worth carrying over from a working .env. */
function readEnvValues() {
  const values = {};
  if (!existsSync('.env')) return values;
  const source = readFileSync('.env', 'utf8');
  const CARRY = [
    'STRAVA_CLIENT_ID', 'COMPETITION_START', 'COMPETITION_END', 'COMPETITION_TZ',
    'ALLOWED_SPORT_TYPES', 'COUNT_MANUAL_ACTIVITIES', 'ADMIN_BOOTSTRAP_ATHLETE_IDS',
    'SESSION_TTL_SECONDS', 'SYNC_COOLDOWN_SECONDS',
  ];
  for (const key of CARRY) {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(source);
    // Secrets are never carried: they must differ between dev and production, and a value
    // read from .env would end up in wrangler.toml, which is committed.
    if (m && m[1].trim() !== '') values[key] = m[1].trim();
  }
  return values;
}

/* ------------------------------------------------------------------------- the plan ---- */

/**
 * Resolve flags (and, if needed, prompts) into the single object every edit reads.
 *
 * Everything that can go wrong about the SHAPE of a deploy is decided here, before a byte is
 * written, so a mistake is a message rather than a half-edited tree.
 */
async function resolvePlan() {
  const remote = gitRemote();
  let webHost = opt('web-host');
  let apiHost = opt('api-host');
  let defaultHosts = flag('default-hosts');

  const githubUser = opt('github-user') ?? remote?.user ?? null;
  const repo = opt('repo') ?? remote?.repo ?? null;
  // The workers.dev subdomain is set per Cloudflare ACCOUNT (Workers & Pages -> Subdomain) and
  // has nothing to do with the GitHub username. Defaulting it to the GitHub user is a guess,
  // so it is stated as one in the checklist at the end.
  const workersSubdomain = opt('workers-subdomain') ?? githubUser;
  const workerName = (opt('worker-name') ?? repo ?? 'bike-comp-api').toLowerCase().replace(/[^a-z0-9-]/g, '-');

  if (!defaultHosts && !webHost && !apiHost) {
    if (!stdin.isTTY) {
      die(
        'No TTY and no hosts given.',
        'Pass --default-hosts, or both --web-host and --api-host.',
      );
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      say(c.bold('Which shape are you deploying?\n'));
      say(`  ${c.bold('1')} custom domain   www.example.com + api.example.com`);
      say(`    ${c.dim('One registrable domain, so the session cookie is first-party. Needs a domain + DNS.')}`);
      say(`  ${c.bold('2')} default hosts   ${githubUser ?? '<user>'}.github.io + ${workerName}.${workersSubdomain ?? '<account>'}.workers.dev`);
      say(`    ${c.dim('No domain, no DNS. Cross-site, so the session token moves to localStorage')}`);
      say(`    ${c.dim('via #token= and sessions get shortened to 12 h.')}\n`);
      const choice = (await rl.question('1 or 2 [2] : ')).trim();
      if (choice === '' || choice === '2') {
        defaultHosts = true;
      } else if (choice === '1') {
        say('');
        webHost = await rl.question('Frontend host (GitHub Pages)   e.g. www.example.com : ');
        apiHost = await rl.question('API host      (Workers)        e.g. api.example.com : ');
      } else {
        die(`Unrecognized choice "${choice}".`);
      }
    } finally {
      rl.close();
    }
  }

  if (defaultHosts) {
    if (!githubUser) {
      die('Could not work out your GitHub account.', 'Pass --github-user <account> (and --repo <name>).');
    }
    if (!repo) die('Could not work out the repository name.', 'Pass --repo <name>.');
    if (!workersSubdomain) die('Could not work out your workers.dev subdomain.', 'Pass --workers-subdomain <name>.');
    webHost = webHost ?? `${githubUser.toLowerCase()}.github.io`;
    apiHost = apiHost ?? `${workerName}.${workersSubdomain.toLowerCase()}.workers.dev`;
  }

  webHost = assertHostname(webHost, 'Frontend host');
  apiHost = assertHostname(apiHost, 'API host');

  if (webHost === apiHost) {
    die('The frontend and API hosts are identical.', 'Pages cannot serve /api/*; use two hosts, e.g. www. and api.');
  }

  /**
   * A GitHub Pages USER site (repo named `<user>.github.io`) is served at the domain root; any
   * other repo is a PROJECT site served from `/<repo>/`. Getting this backwards sends every
   * post-OAuth redirect to GitHub's 404 page, so it is derived rather than asked about.
   */
  const isUserSite = repo !== null && githubUser !== null
    && repo.toLowerCase() === `${githubUser.toLowerCase()}.github.io`;
  const explicitBasePath = opt('web-base-path');
  const webBasePath = explicitBasePath !== null
    ? assertBasePath(explicitBasePath)
    : (defaultHosts && !isUserSite ? assertBasePath(repo) : '');

  const webDomain = registrableDomain(webHost);
  const apiDomain = registrableDomain(apiHost);
  const crossSite = webDomain !== apiDomain;

  // THE CHECK THIS SCRIPT MOST EXISTS FOR. Cross-site WITHOUT the bearer path is a site where
  // OAuth succeeds and every subsequent /api/* is anonymous, with no CORS error and no 4xx to
  // debug -- so it is refused up front rather than reported later. `--default-hosts` implies
  // the bearer path because that shape can never be anything else.
  const bearer = crossSite ? (defaultHosts || BEARER) : false;
  if (crossSite && !bearer) {
    die(
      `"${webHost}" and "${apiHost}" are on different registrable domains (${webDomain} vs ${apiDomain}).`,
      'The session cookie would be third-party: Safari ITP blocks it unconditionally and Chrome\n'
      + '  partitions it, so sign-in appears to work and every later /api/* returns 401 forever.\n'
      + '  Either put both hosts on one registrable domain, or re-run with --bearer to configure\n'
      + '  the #token= handoff instead (docs/DEPLOY.md shape B). On a Pages PROJECT site add\n'
      + '  --web-base-path /<repo> too, or the post-OAuth redirect lands on GitHub\'s 404.',
    );
  }
  if (!crossSite && BEARER) {
    say(`${c.yellow('!')} --bearer ignored: these hosts share ${webDomain}, so the cookie works and is safer.\n`);
  }

  const carried = readEnvValues();
  const carriedTtl = Number(carried.SESSION_TTL_SECONDS);
  const sessionTtl = bearer
    ? (Number.isInteger(carriedTtl) && carriedTtl > 0 && carriedTtl <= 86400 ? carriedTtl : BEARER_SESSION_TTL)
    : (carried.SESSION_TTL_SECONDS ?? 2592000);

  return {
    webHost,
    apiHost,
    apiOrigin: `https://${apiHost}`,
    webBasePath,
    webAppUrl: `https://${webHost}${webBasePath}`,
    workerName,
    workersSubdomain,
    workersDev: defaultHosts || apiHost.endsWith('.workers.dev'),
    defaultHosts,
    crossSite,
    bearer,
    sessionTtl,
    webDomain,
    apiDomain,
    envValues: carried,
  };
}

/* ---------------------------------------------------------------------------- main ---- */

async function main() {
  say(c.bold('\nbike-comp deploy setup\n'));
  say('Applies every mechanical edit in docs/DEPLOY.md. Does not deploy anything.\n');

  const plan = await resolvePlan();

  say(`Frontend : ${c.bold(plan.webAppUrl)}`);
  say(`API      : ${c.bold(plan.apiOrigin)}`);
  if (plan.crossSite) {
    say(`Domains  : ${plan.webDomain} vs ${plan.apiDomain} ${c.yellow('(cross-site)')}`);
    say(`Auth     : ${c.yellow('#token= handoff')} — localStorage, ${plan.sessionTtl}s sessions, cookies inert`);
  } else {
    say(`Domain   : ${plan.webDomain} ${c.green('(shared)')}`);
    say(`Auth     : ${c.green('HttpOnly session cookie')}`);
  }
  say('');

  // ---- 1. the lockstep pair: config.js and the CSP -------------------------------------
  write(
    'public/config.js',
    editConfigJs(read('public/config.js'), plan.webHost, plan.apiOrigin),
    `API base for ${plan.webHost}`,
  );

  const indexHtml = editCsp(read('public/index.html'), plan.apiOrigin);
  write('public/index.html', indexHtml, `CSP connect-src widened to ${plan.apiOrigin}`);
  // Regenerated from index.html rather than edited in parallel, because "byte-for-byte
  // identical" is the actual requirement (Pages has no SPA fallback) and two independent
  // edits are how they drift apart.
  write('public/404.html', indexHtml, 'regenerated as a byte-for-byte copy of index.html');

  // ---- 2. Pages custom domain ----------------------------------------------------------
  if (plan.defaultHosts) {
    // A CNAME naming a domain you are not serving from makes Pages serve NOTHING -- not the
    // old site, not a 404 with a hint, nothing. Left behind from an earlier custom-domain run
    // it would silently break the deploy this script just configured.
    remove('public/CNAME', 'a CNAME would override the default github.io host and break Pages');
  } else if (!flag('no-cname')) {
    // Now safe to write: on the custom-domain path there IS a domain to name, and a CNAME
    // pointing at a domain you do not control makes Pages serve nothing at all.
    write('public/CNAME', `${plan.webHost}\n`, `Pages custom domain ${plan.webHost}`);
  }

  // ---- 3. wrangler.toml ----------------------------------------------------------------
  if (existsSync('wrangler.toml') && !FORCE) {
    skipped.push('wrangler.toml — exists; re-run with --force to regenerate (keep your database_id!)');
  } else {
    const template = read('wrangler.toml.example');
    write('wrangler.toml', buildWranglerToml(template, plan, plan.envValues), 'generated from the template');
  }

  // ---- report --------------------------------------------------------------------------
  say(c.bold(DRY_RUN ? '\nWould change:' : '\nChanged:'));
  if (changes.length === 0) say(`  ${c.dim('(nothing — already applied)')}`);
  for (const line of changes) say(`  ${c.green('✓')} ${line}`);
  if (skipped.length > 0) {
    say(c.bold('\nSkipped:'));
    for (const line of skipped) say(`  ${c.dim('·')} ${line}`);
  }

  if (DRY_RUN) {
    say(`\n${c.yellow('Dry run — nothing was written.')} Re-run without --dry-run to apply.`);
    return;
  }

  // ---- verify --------------------------------------------------------------------------
  // The suite contains the DEPLOY GUARD test, which fails if config.js and the CSP disagree.
  // Running it here means a bad edit surfaces now rather than as a silently dead site.
  if (!NO_VERIFY) {
    say(c.bold('\nVerifying (npm test) …'));
    const result = spawnSync('npm', ['test'], { encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const pass = /^ℹ pass (\d+)$/m.exec(output);
    const fail = /^ℹ fail (\d+)$/m.exec(output);
    if (result.status === 0) {
      say(`  ${c.green('✓')} ${pass ? pass[1] : '?'} passing, 0 failing`);
    } else {
      say(`  ${c.red('✖')} ${fail ? fail[1] : 'some'} test(s) failing.`);
      say(`  ${c.dim('Run `npm test` for detail. If DEPLOY GUARD failed, config.js and the CSP disagree.')}`);
    }
  }

  printChecklist(plan);
}

/** What only you can do: credentials, a browser, or a network this script does not hold. */
function printChecklist(plan) {
  const secrets = {
    SESSION_SECRET: randomBytes(48).toString('base64'),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  let n = 0;
  const step = (title) => say(`${c.bold(`${(n += 1)}. ${title}`)}`);

  say(c.bold('\n───────────────────────── still to do (needs you) ─────────────────────────\n'));

  step('Strava brand assets — CONTRACTUAL, blocks a public launch');
  say('   public/assets/btn-strava-connect.svg and powered-by-strava.svg are hand-authored');
  say('   placeholders. Shipping them publicly breaches the Strava API Agreement. Replace both');
  say('   with the official artwork from https://developers.strava.com/guidelines/, unmodified.\n');

  step('GitHub Pages');
  say('   Settings → Pages → Source = GitHub Actions   (otherwise the artifact is never served)');
  if (plan.defaultHosts) {
    say(`   Leave ${c.bold('Custom domain EMPTY')} — the site is served at ${plan.webAppUrl}/`);
    say('   HTTPS is automatic on github.io, so there is no "Enforce HTTPS" box to wait for.');
    say(`   ${c.dim('No DNS records and no registrar step at all on this path.')}\n`);
  } else {
    say(`   Settings → Pages → Custom domain = ${plan.webHost}`);
    say('   Enable "Enforce HTTPS" once it becomes available — the session cookie is Secure.\n');

    step('DNS at your registrar');
    const isApex = plan.webHost.split('.').length === 2;
    if (isApex) {
      say(`   ${plan.webHost} is an apex domain: it needs A/ALIAS records to GitHub's Pages IPs`);
      say("   (check GitHub's current documented addresses — they change).");
    } else {
      say(`   CNAME  ${plan.webHost.split('.')[0]}  →  <your-github-user>.github.io`);
    }
    say(`   ${plan.apiHost} → your Cloudflare Worker (wrangler sets this up with custom_domain = true)\n`);
  }

  if (plan.workersDev) {
    step('Confirm your Cloudflare workers.dev subdomain');
    say('   Dashboard → Workers & Pages → your account → Subdomain. It is per-ACCOUNT and need');
    say(`   not match your GitHub username, so ${c.bold(plan.workersSubdomain)} above is a guess.`);
    say(`   If it differs, re-run with --workers-subdomain <name> --force before deploying:`);
    say(`   ${c.dim('the API host is baked into public/config.js, the CSP, and API_BASE_URL.')}`);
    say(`   The Worker name in wrangler.toml (${c.bold(plan.workerName)}) is the first label of the host.\n`);
  }

  step('Strava app settings — https://www.strava.com/settings/api');
  say(`   Authorization Callback Domain = ${c.bold(plan.apiHost)}   (domain only: no scheme, port or path)`);
  say('   If the field takes one domain only, keep a second Strava app for localhost dev.\n');

  step('Cloudflare D1 + secrets');
  say('   wrangler d1 create bike-comp                  # paste the id into wrangler.toml');
  say('   wrangler d1 migrations apply bike-comp --remote');
  say('   wrangler secret put STRAVA_CLIENT_SECRET      # your Strava app secret');
  say('   wrangler secret put SESSION_SECRET');
  say('   wrangler secret put TOKEN_ENCRYPTION_KEY');
  say(`\n   ${c.dim('Fresh production secrets, generated now. Paste at the wrangler prompts — passing them')}`);
  say(`   ${c.dim('as command arguments would put them in your shell history.')}`);
  say(`   SESSION_SECRET        ${secrets.SESSION_SECRET}`);
  say(`   TOKEN_ENCRYPTION_KEY  ${secrets.TOKEN_ENCRYPTION_KEY}`);
  say(`   ${c.dim('These are NOT written to any file. Re-running this script prints different ones;')}`);
  say(`   ${c.dim('once riders have connected, changing TOKEN_ENCRYPTION_KEY forces them all to reconnect.')}\n`);

  step('The D1 port — code, not configuration');
  say('   server/db/db.js still uses node:sqlite, which does not exist on Workers. Map');
  say('   all/get/run onto D1PreparedStatement and batch onto D1.batch. Nothing above that');
  say('   file changes: every server/db/* method is already async. See docs/DEPLOY.md step 2.\n');

  if (plan.bearer) {
    say(c.yellow(c.bold('   ⚠ What you are accepting on the cross-site path')));
    say(`   The session token is handed over in the URL fragment and kept in ${c.bold('localStorage')},`);
    say(`   because ${plan.apiDomain} cannot set a usable cookie for ${plan.webDomain}. localStorage is`);
    say(`   keyed per ORIGIN with no path component, so ${c.bold('every other project you publish')}`);
    say(`   ${c.bold(`on ${plan.webHost}`)} — including a vendored third-party toy — can read that token`);
    say('   and act as any rider who has signed in, admin included. Sessions are shortened to');
    say(`   ${plan.sessionTtl}s to bound it, and that is a mitigation, not a fix. The only actual fix is one`);
    say('   registrable domain: re-run this script with --web-host/--api-host if you get a domain.\n');
  }

  say(`${c.dim('Full runbook and the verification sequence: docs/DEPLOY.md')}`);
}

await main();
