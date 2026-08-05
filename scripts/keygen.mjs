#!/usr/bin/env node
/**
 * Print the two secrets `.env` needs. Output goes to stdout only -- nothing is written to
 * disk, so a stray run cannot clobber a working .env.
 *
 *   npm run keygen
 */
import { randomBytes } from 'node:crypto';

const sessionSecret = randomBytes(48).toString('base64'); // >= 32 bytes required
const tokenKey = randomBytes(32).toString('base64'); // exactly 32 bytes required

process.stdout.write(`# Generated ${new Date().toISOString()} -- paste into .env
SESSION_SECRET=${sessionSecret}
TOKEN_ENCRYPTION_KEY=${tokenKey}
`);

process.stderr.write(
  `\nCopy the two lines above into your .env.\n` +
    `TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes -- if you replace it, keep that.\n` +
    `Changing TOKEN_ENCRYPTION_KEY makes every stored Strava token undecryptable; riders\n` +
    `will simply be asked to reconnect, so it is recoverable but not free.\n`,
);
