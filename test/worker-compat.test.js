import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WORKER COMPATIBILITY GUARD, enforced statically.
 *
 * `server/worker.js` and everything it STATICALLY imports has to load inside a Cloudflare
 * Worker isolate. That is not a thing the rest of the suite can catch, because on Node every
 * one of these modules imports fine -- the failure only appears on a real deploy, as a Worker
 * that dies during module evaluation before it ever sees a request, which surfaces as a bare
 * "Error 1101" with the cause only in `wrangler tail`.
 *
 * This has already bitten once: `server/db/activities.js` imported `placeholders` from
 * `server/db/db.js` purely for a string helper, and `db.js` imports `node:sqlite`, which does
 * not exist on Workers at all. One unnecessary import made the entire route tree unloadable.
 * `server/db/bind.js` exists to break that edge, and this test is what stops it growing back.
 *
 * DYNAMIC `import()` IS DELIBERATELY NOT FOLLOWED. `server/app.js` reaches `http/static.js`
 * (and therefore `node:fs`) through a lazy `import()` that only runs when `publicDir` is set,
 * which a Worker never does. That is the escape hatch, and treating it as an edge here would
 * defeat its purpose.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * Node builtins that workerd provides under `compatibility_flags = ["nodejs_compat"]` and that
 * this code actually relies on.
 *
 * Deliberately short. Anything absent from this list is either unavailable on Workers or
 * available-but-partial in a way that would fail at runtime rather than at import, so a new
 * entry here is a claim that needs checking against Cloudflare's docs, not a formality.
 */
const ALLOWED_BUILTINS = new Set([
  // randomBytes, createHmac, createHash, timingSafeEqual, createCipheriv('aes-256-gcm').
  'node:crypto',
  // Buffer. Used by respond.js to length-prefix a JSON body and by security/crypto.js.
  'node:buffer',
]);

/**
 * Every `from '…'` and bare `import '…'` specifier in a module, static edges only.
 *
 * `[^;'"]*?` between the keyword and `from` is what keeps this honest: it cannot cross a
 * statement terminator or a string literal, so a multi-line `import { a, b } from './x.js'`
 * matches while a sentence containing the word "from" inside a thrown message does not. A
 * looser `[\s\S]*?` reads prose in `strava/client.js` as an import specifier.
 */
function staticImports(source) {
  const specifiers = [];
  // `from '…'` covers `import x from`, `import {x} from`, and `export … from`.
  for (const m of source.matchAll(/(?:^|\n)[ \t]*(?:import|export)\b[^;'"]*?\sfrom\s+['"]([^'"]+)['"]/g)) {
    specifiers.push(m[1]);
  }
  // Side-effect-only `import '…';`.
  for (const m of source.matchAll(/(?:^|\n)[ \t]*import\s+['"]([^'"]+)['"]/g)) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

/** Walk the static import graph from an entry file. */
function importGraph(entry) {
  const visited = new Map();
  const builtins = new Map();
  const queue = [resolve(ROOT, entry)];

  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    assert.ok(existsSync(file), `${relative(ROOT, file)} does not exist`);
    const source = readFileSync(file, 'utf8');
    visited.set(file, source);

    for (const specifier of staticImports(source)) {
      if (specifier.startsWith('node:')) {
        if (!builtins.has(specifier)) builtins.set(specifier, []);
        builtins.get(specifier).push(relative(ROOT, file));
        continue;
      }
      // A bare specifier would be an npm dependency, and this project has none.
      assert.ok(
        specifier.startsWith('.'),
        `${relative(ROOT, file)} imports the bare specifier "${specifier}"; this project has zero dependencies.`,
      );
      queue.push(resolve(dirname(file), specifier));
    }
  }

  return { files: [...visited.keys()].map((f) => relative(ROOT, f)), builtins };
}

test('worker: the static import graph uses no Node builtin a Worker lacks', () => {
  const { builtins, files } = importGraph('server/worker.js');

  const forbidden = [...builtins.entries()]
    .filter(([name]) => !ALLOWED_BUILTINS.has(name))
    .map(([name, importers]) => `${name} (imported by ${[...new Set(importers)].join(', ')})`);

  assert.deepEqual(
    forbidden,
    [],
    'server/worker.js statically reaches a Node builtin that Cloudflare Workers do not provide.\n'
    + 'The Worker will fail during module evaluation, before its first request, with the cause\n'
    + 'only visible in `wrangler tail`. Either drop the import or move the helper into a\n'
    + 'builtin-free module (see server/db/bind.js for the precedent).',
  );

  // Sanity: the walk actually found the tree rather than silently visiting one file.
  assert.ok(files.length > 20, `expected the whole server tree, walked only ${files.length} files`);
  assert.ok(files.includes('server/routes/index.js'));
  assert.ok(files.includes('server/db/activities.js'));
  assert.ok(files.includes('server/db/bind.js'));
});

test('worker: the four Node-only modules stay OUT of the graph', () => {
  const { files } = importGraph('server/worker.js');

  // Each of these is Node-only for a different reason, and each would fail differently on a
  // Worker: no node:sqlite at all, no filesystem to read migrations or static files from, no
  // socket to listen on.
  for (const nodeOnly of [
    'server/db/db.js',
    'server/db/migrate.js',
    'server/http/static.js',
    'server/index.js',
  ]) {
    assert.equal(files.includes(nodeOnly), false, `${nodeOnly} must not be on the Worker's import path`);
  }
});

test('worker: server/index.js still reaches the Node-only modules', () => {
  // The mirror of the test above. Without it, "keep node:fs off the Worker path" could be
  // satisfied by breaking local development instead, and `npm start` is how this gets tested.
  const { files, builtins } = importGraph('server/index.js');
  assert.ok(files.includes('server/db/db.js'), 'the Node path still uses node:sqlite');
  assert.ok(files.includes('server/db/migrate.js'));
  assert.ok(builtins.has('node:http'), 'index.js is the only file that opens a socket');
});

test('worker: app.js reaches http/static.js only through a dynamic import', () => {
  // The escape hatch this whole arrangement rests on. If someone "tidies" it back into a static
  // import at the top of app.js, the guard above catches it -- but this asserts the mechanism
  // directly, so the failure names the cause instead of just the symptom.
  const source = readFileSync(resolve(ROOT, 'server/app.js'), 'utf8');
  assert.match(source, /import\(\s*'\.\/http\/static\.js'\s*\)/, 'expected a lazy import() of http/static.js');
  assert.equal(
    staticImports(source).some((s) => s.includes('static.js')),
    false,
    'http/static.js must NOT be a static import of app.js: it pulls in node:fs.',
  );
});

test('worker: wrangler.toml.example points at the Worker entry, not the Node one', () => {
  const toml = readFileSync(resolve(ROOT, 'wrangler.toml.example'), 'utf8');
  const main = /^main = "([^"]+)"/m.exec(toml);
  assert.ok(main, 'wrangler.toml.example has no main');
  assert.equal(
    main[1],
    'server/worker.js',
    'main must be server/worker.js. server/index.js runs `await main()` at module scope, so a '
    + 'Worker pointed at it would try to bind a socket and read the filesystem during startup.',
  );
  // nodejs_compat is what provides node:crypto; without it the security layer cannot load.
  assert.match(toml, /compatibility_flags = \["nodejs_compat"\]/);
});

test('worker: wrangler.toml.example points migrations_dir at the real migrations folder', () => {
  // REGRESSION. This was missing, and the failure is remote-only and unhelpful: wrangler
  // defaults migrations_dir to `./migrations` relative to wrangler.toml, so
  // `wrangler d1 migrations apply` dies with "no migrations present at <root>/migrations" and
  // says nothing about the folder having simply moved under server/. Nothing on the Node path
  // notices, because server/db/migrate.js resolves the folder from its own module URL.
  const toml = readFileSync(resolve(ROOT, 'wrangler.toml.example'), 'utf8');
  const dir = /^migrations_dir = "([^"]+)"/m.exec(toml);
  assert.ok(dir, 'wrangler.toml.example has no migrations_dir; `wrangler d1 migrations apply` will find nothing');

  const resolved = resolve(ROOT, dir[1]);
  assert.ok(existsSync(resolved), `migrations_dir points at ${dir[1]}, which does not exist`);

  // It must be the SAME folder server/db/migrate.js reads, or local dev and production would
  // silently drift apart at the schema level -- the worst possible thing to have diverge.
  const migrateSource = readFileSync(resolve(ROOT, 'server/db/migrate.js'), 'utf8');
  const fromModule = /join\(dirname\(fileURLToPath\(import\.meta\.url\)\), '([^']+)', '([^']+)'\)/.exec(migrateSource);
  assert.ok(fromModule, 'could not read the migrations path out of server/db/migrate.js');
  assert.equal(
    resolve(ROOT, 'server/db', fromModule[1], fromModule[2]),
    resolved,
    'wrangler and server/db/migrate.js must read the same migrations folder',
  );

  // wrangler derives each migration's version from a leading number in the filename.
  const files = readdirSync(resolved).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0, `${dir[1]} contains no .sql files`);
  for (const file of files) {
    assert.match(file, /^\d+_/, `${file} needs a numeric prefix for wrangler to order it`);
  }
});
