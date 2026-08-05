#!/usr/bin/env node
/**
 * Interactive setup: collect your Strava credentials, write `.env`, then start the server.
 *
 *   npm run setup                 # prompt for anything missing, then start
 *   npm run setup -- --no-start   # write .env and stop
 *   npm run setup -- --reconfigure       # re-prompt even for values already set
 *   npm run setup -- --client-id 12345 --client-secret abc...   # non-interactive
 *
 * Safe to re-run. It never overwrites an existing SESSION_SECRET or
 * TOKEN_ENCRYPTION_KEY, because rotating TOKEN_ENCRYPTION_KEY makes every stored Strava
 * token undecryptable and forces every rider to reconnect.
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig, ConfigError } from '../server/config.js';
import { isCalendarDate, todayInTz, addDays } from '../server/lib/dates.js';

const ENV_PATH = '.env';
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const RECONFIGURE = flag('reconfigure');
const NO_START = flag('no-start');

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  orange: (s) => `\x1b[38;5;208m${s}\x1b[0m`,
};

// ---------------------------------------------------------------- .env handling

/** Parse `.env` into a plain object. Comments and blank lines are ignored. */
function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Set one key, editing in place so hand-written comments survive. Appends when the key is
 * absent -- rewriting the whole file from a template would silently discard notes you added.
 */
function upsertEnv(text, key, value) {
  const re = new RegExp(`^(\\s*${key}\\s*=).*$`, 'm');
  if (re.test(text)) return text.replace(re, `$1${value}`);
  return `${text.replace(/\n*$/, '')}\n${key}=${value}\n`;
}

function isValidBase64Bytes(value, exactly) {
  if (!value) return false;
  try {
    return Buffer.from(value, 'base64').length === exactly;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- prompting

const rl = createInterface({ input: process.stdin, output: process.stdout });
let muted = false;
const realWrite = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => {
  if (!muted) realWrite(s);
};

/**
 * Buffer every line as it arrives rather than calling rl.question per prompt.
 *
 * With piped or redirected stdin, readline drains the whole stream and emits 'close' long
 * before the later prompts run, so a question-at-a-time approach silently loses every
 * answer after the first. Queueing the lines makes `npm run setup < answers.txt` behave the
 * same as typing them.
 */
const buffered = [];
const waiting = [];
let closed = false;

rl.on('line', (line) => {
  const next = waiting.shift();
  if (next) next(line);
  else buffered.push(line);
});
rl.on('close', () => {
  closed = true;
  while (waiting.length) waiting.shift()(null);
});

/** Next line of input, or null once input is exhausted. */
function readLine() {
  if (buffered.length) return Promise.resolve(buffered.shift());
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiting.push(resolve));
}

async function ask(question, { fallback = '', hidden = false, validate = null } = {}) {
  for (;;) {
    const suffix = fallback ? c.dim(` [${hidden ? '•'.repeat(8) : fallback}]`) : '';
    process.stdout.write(`${question}${suffix}: `);
    if (hidden) muted = true;

    const answer = await readLine();

    if (hidden) {
      muted = false;
      process.stdout.write('\n');
    }

    if (answer === null) {
      if (fallback) {
        process.stdout.write(c.dim(`${fallback}\n`));
        return fallback;
      }
      console.error(
        `\n${c.red('No more input.')} This script is interactive — run it in a terminal, or pass\n` +
          c.dim('  --client-id <id> --client-secret <secret> --no-start\n'),
      );
      process.exit(1);
    }

    const value = answer.trim() || fallback;
    if (!value) {
      process.stdout.write(c.red('  Required.\n'));
      continue;
    }
    const problem = validate?.(value);
    if (problem) {
      process.stdout.write(c.red(`  ${problem}\n`));
      continue;
    }
    return value;
  }
}

async function confirm(question, defaultYes = true) {
  const answer = await ask(`${question} ${c.dim(defaultYes ? '(Y/n)' : '(y/N)')}`, {
    fallback: defaultYes ? 'y' : 'n',
  });
  return /^y/i.test(answer);
}

// ---------------------------------------------------------------- main

console.log(`
${c.bold('East vs West — Strava mileage leaderboard')}
${c.dim('setup')}
`);

if (!existsSync(ENV_PATH)) {
  if (existsSync('.env.example')) {
    copyFileSync('.env.example', ENV_PATH);
    console.log(`${c.green('created')} .env from .env.example`);
  } else {
    writeFileSync(ENV_PATH, '');
    console.log(`${c.green('created')} an empty .env`);
  }
} else {
  console.log(`${c.dim('found')} an existing .env — keeping everything already set${RECONFIGURE ? ' unless re-prompted' : ''}`);
}

let text = readFileSync(ENV_PATH, 'utf8');
let env = parseEnv(text);

console.log(`
${c.bold('1. Strava application')}

  Open ${c.orange('https://www.strava.com/settings/api')} and either create an app or open your
  existing one. The only setting that matters for local use:

    ${c.bold('Authorization Callback Domain')} = ${c.bold('localhost')}

  ${c.dim('(just the word "localhost" — no http://, no port, no path)')}

  Then copy the Client ID and Client Secret from that page.
`);

const needsId = RECONFIGURE || !env.STRAVA_CLIENT_ID || env.STRAVA_CLIENT_ID === '000000';
const needsSecret =
  RECONFIGURE ||
  !env.STRAVA_CLIENT_SECRET ||
  env.STRAVA_CLIENT_SECRET.startsWith('replace-me');

const clientId =
  opt('client-id') ??
  (needsId
    ? await ask('  Client ID', {
        fallback: needsId ? '' : env.STRAVA_CLIENT_ID,
        validate: (v) => (/^\d+$/.test(v) ? null : 'Should be all digits, e.g. 143722.'),
      })
    : env.STRAVA_CLIENT_ID);

const clientSecret =
  opt('client-secret') ??
  (needsSecret
    ? await ask('  Client Secret', {
        hidden: true,
        validate: (v) =>
          v.startsWith('replace-me')
            ? 'That is still the placeholder.'
            : v.length < 20
              ? 'Too short — Strava secrets are 40 hex characters.'
              : null,
      })
    : env.STRAVA_CLIENT_SECRET);

if (!/^[0-9a-f]{40}$/.test(clientSecret)) {
  console.log(c.yellow('  note: that does not look like Strava\'s usual 40-character hex secret. Continuing anyway.'));
}

text = upsertEnv(text, 'STRAVA_CLIENT_ID', clientId);
text = upsertEnv(text, 'STRAVA_CLIENT_SECRET', clientSecret);

// ---------------------------------------------------------------- secrets

console.log(`\n${c.bold('2. Local secrets')}\n`);

if (isValidBase64Bytes(env.SESSION_SECRET, 48) || Buffer.from(env.SESSION_SECRET ?? '', 'base64').length >= 32) {
  console.log(`  ${c.dim('SESSION_SECRET already set — keeping it')}`);
} else {
  text = upsertEnv(text, 'SESSION_SECRET', randomBytes(48).toString('base64'));
  console.log(`  ${c.green('generated')} SESSION_SECRET`);
}

if (isValidBase64Bytes(env.TOKEN_ENCRYPTION_KEY, 32)) {
  console.log(`  ${c.dim('TOKEN_ENCRYPTION_KEY already set — keeping it')}`);
  console.log(`  ${c.dim('(rotating it would make every stored Strava token undecryptable)')}`);
} else {
  text = upsertEnv(text, 'TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  console.log(`  ${c.green('generated')} TOKEN_ENCRYPTION_KEY`);
}

// ---------------------------------------------------------------- competition window

console.log(`\n${c.bold('3. Competition window')}\n`);

const today = todayInTz(env.COMPETITION_TZ || 'UTC');
const windowSet = isCalendarDate(env.COMPETITION_START) && isCalendarDate(env.COMPETITION_END);
const windowIsCurrent = windowSet && env.COMPETITION_START <= today && today <= env.COMPETITION_END;

if (windowSet && windowIsCurrent && !RECONFIGURE) {
  console.log(`  ${c.dim(`${env.COMPETITION_START} → ${env.COMPETITION_END} (open today) — keeping it`)}`);
} else {
  if (windowSet) {
    const state = today < env.COMPETITION_START ? 'has not started yet' : 'has already ended';
    console.log(`  ${c.yellow(`The window in .env (${env.COMPETITION_START} → ${env.COMPETITION_END}) ${state}.`)}`);
  }
  console.log(`  ${c.dim('A ride counts if its local calendar date falls inside this range, inclusive.')}\n`);
  const start = await ask('  Start date (YYYY-MM-DD)', {
    fallback: windowSet ? env.COMPETITION_START : today,
    validate: (v) => (isCalendarDate(v) ? null : 'Needs to be a real date like 2026-09-01.'),
  });
  const end = await ask('  End date (YYYY-MM-DD)', {
    fallback: windowSet ? env.COMPETITION_END : addDays(start, 30),
    validate: (v) =>
      !isCalendarDate(v) ? 'Needs to be a real date like 2026-09-30.' : v < start ? 'Must not precede the start date.' : null,
  });
  text = upsertEnv(text, 'COMPETITION_START', start);
  text = upsertEnv(text, 'COMPETITION_END', end);
}

// ---------------------------------------------------------------- admin

console.log(`\n${c.bold('4. Admin (optional)')}\n`);
if (env.ADMIN_BOOTSTRAP_ATHLETE_IDS && !RECONFIGURE) {
  console.log(`  ${c.dim(`already set to ${env.ADMIN_BOOTSTRAP_ATHLETE_IDS} — keeping it`)}`);
} else {
  console.log(`  ${c.dim('An admin can move riders between teams and approve manual rides.')}`);
  console.log(`  ${c.dim('Your athlete ID is the number in your Strava profile URL.')}`);
  console.log(`  ${c.dim('You can skip this and run `npm run make-admin -- <id>` after signing in.\n')}`);
  const id = await ask('  Your Strava athlete ID', {
    fallback: 'skip',
    validate: (v) => (v === 'skip' || /^\d+$/.test(v) ? null : 'Digits only, or "skip".'),
  });
  if (id !== 'skip') text = upsertEnv(text, 'ADMIN_BOOTSTRAP_ATHLETE_IDS', id);
}

// ---------------------------------------------------------------- write + validate

writeFileSync(ENV_PATH, text);
console.log(`\n${c.green('wrote')} ${ENV_PATH} ${c.dim('(gitignored — it never leaves this machine)')}`);

env = parseEnv(text);
try {
  const config = loadConfig({ ...process.env, ...env });
  console.log(`${c.green('validated')} configuration`);
  console.log(`
  ${c.dim('competition')}  ${config.competitionStart} → ${config.competitionEnd} (${config.competitionTz})
  ${c.dim('counts')}       ${config.allowedSportTypes.join(', ')}
  ${c.dim('url')}          ${config.appBaseUrl}
  ${c.dim('database')}     ${config.databasePath}`);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n${c.red('Configuration is not valid:')} ${err.message}`);
    console.error(c.dim('Fix that line in .env and re-run `npm run setup`.'));
    rl.close();
    process.exit(1);
  }
  throw err;
}

// ---------------------------------------------------------------- start

if (NO_START) {
  console.log(`\n${c.bold('Next:')} ${c.green('npm start')}\n`);
  rl.close();
  process.exit(0);
}

const start = await confirm(`\n${c.bold('Start the server now?')}`);
rl.close();

if (!start) {
  console.log(`\nWhen you are ready: ${c.green('npm start')}\n`);
  process.exit(0);
}

const port = env.PORT || '3000';
console.log(`
${c.bold('Starting.')} Open ${c.orange(`http://localhost:${port}`)} and click "Connect with Strava".
${c.dim('Press Ctrl-C to stop.')}
`);

const child = spawn(process.execPath, ['server/index.js'], { stdio: 'inherit' });

child.on('exit', (code, signal) => {
  if (code === 0 || signal) process.exit(0);
  console.error(`
${c.red('The server stopped.')}

  ${c.bold('listen EADDRINUSE')}  Port ${port} is already taken. Either stop the other process
                     or set PORT to something else in .env.
  ${c.bold('listen EPERM')}       Something on this machine is blocking socket binds — a sandbox,
                     a security agent, or a VPN policy. Try a different terminal.

Full error above.`);
  process.exit(code ?? 1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
