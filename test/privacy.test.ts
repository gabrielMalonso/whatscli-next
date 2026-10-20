import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CommandError } from '../src/errors.js';
import { checkAncestors } from '../src/private-paths.js';
import { rpc } from '../src/rpc.js';
import { Store } from '../src/store.js';

process.umask(0o077);
const temporary = () => mkdtempSync(join(tmpdir(), 'wcn-private-'));
const refused = (error: unknown) =>
  error instanceof CommandError && error.code === 'PRECONDITION_FAILED';
const runFile = promisify(execFile);

for (const kind of ['symlink', 'foreign']) {
  for (const entry of ['Store', 'CLI']) {
    test(`${entry} refuses an ancestor ${kind} inserted during directory creation before opening state`, () => {
      const root = temporary();
      const redirected = join(root, 'redirected');
      mkdirSync(redirected, { mode: 0o700 });
      writeFileSync(
        join(redirected, 'preserved'),
        'Fictional preserved content',
        { mode: 0o600 },
      );
      const parent = join(root, 'missing');
      const hook = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const [root, kind, entry] = JSON.parse(process.env.WCN_PRIVATE_FIXTURE);
        const parent = root + '/missing';
        const directory = parent + '/state';
        const mkdir = fs.mkdirSync;
        const inspect = fs.lstatSync;
        const open = fs.openSync;
        let inserted = false;
        let opens = 0;
        fs.mkdirSync = (path, options) => {
          if (!inserted && (path === parent || path.startsWith(parent + '/'))) {
            inserted = true;
            if (kind === 'symlink') fs.symlinkSync(root + '/redirected', parent);
            else { mkdir(parent, { mode: 0o700 }); fs.chmodSync(parent, 0o777); }
          }
          return mkdir(path, options);
        };
        fs.lstatSync = (...args) => {
          const stat = inspect(...args);
          return inserted && kind === 'foreign' && args[0] === parent
            ? Object.assign(stat, { uid: 999999 }) : stat;
        };
        fs.openSync = (...args) => {
          if (String(args[0]).includes('.sqlite') || String(args[0]).endsWith('/daemon.log')) {
            opens++;
            // Stop the base CLI at its unsafe open so no daemon is spawned by the probe.
            if (entry === 'CLI') throw new Error('Fictional intercepted log open');
          }
          return open(...args);
        };
        syncBuiltinESMExports();
        process.once('exit', () => fs.writeSync(2, JSON.stringify({ inserted, opens })));
        if (entry === 'Store') {
          const { Store } = await import('./dist/src/store.js');
          try { new Store(directory).close(); process.stdout.write(JSON.stringify({ code: null })); }
          catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
        }
      `;
      const args =
        entry === 'Store'
          ? ['--input-type=module', '-e', hook]
          : [
              '--import',
              'data:text/javascript,' + encodeURIComponent(hook),
              'dist/src/cli.js',
              '--data-dir',
              join(parent, 'state'),
              'start',
              '--offline',
            ];
      const child = spawnSync(process.execPath, args, {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          WCN_PRIVATE_FIXTURE: JSON.stringify([root, kind, entry]),
        },
      });
      assert.equal(child.status, entry === 'Store' ? 0 : 1);
      assert.equal(JSON.parse(child.stdout).code, 'PRECONDITION_FAILED', entry);
      assert.deepEqual(
        JSON.parse(child.stderr),
        { inserted: true, opens: 0 },
        entry,
      );
      assert.equal(existsSync(join(parent, 'state')), false);
      assert.deepEqual(readdirSync(redirected), ['preserved']);
      assert.equal(
        readFileSync(join(redirected, 'preserved'), 'utf8'),
        'Fictional preserved content',
      );
      if (kind === 'symlink') assert.ok(lstatSync(parent).isSymbolicLink());
      else {
        assert.equal(lstatSync(parent).mode & 0o777, 0o777);
        assert.deepEqual(readdirSync(parent), []);
      }
    });
  }
}

for (const kind of ['writable', 'foreign', 'symlink']) {
  test(`Store rejects ${kind} ancestors before creating directories or opening SQLite, preserving existing state`, () => {
    const root = temporary();
    const parent = join(root, 'parent');
    mkdirSync(parent, { mode: 0o700 });
    const directory = join(parent, 'state');
    const existing = new Store(directory);
    existing.set('fixture', 'value', 'Fictional');
    existing.close();
    const before = new Map(
      readdirSync(directory).map((name) => [
        name,
        readFileSync(join(directory, name)),
      ]),
    );
    let selected = parent;
    if (kind === 'writable') chmodSync(root, 0o777);
    if (kind === 'symlink') {
      selected = join(root, 'alias');
      symlinkSync(parent, selected);
    }
    // Only metadata is injected for another UID. No chown or actual multi-user attack.
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [root, selected, kind] = process.argv.slice(1);
      const inspect = fs.lstatSync;
      fs.lstatSync = (...args) => {
        const stat = inspect(...args);
        return kind === 'foreign' && args[0] === root
          ? Object.assign(stat, { uid: 999999, mode: (stat.mode & ~0o777) | 0o755 }) : stat;
      };
      let opens = 0;
      const open = fs.openSync;
      fs.openSync = (...args) => { opens++; return open(...args); };
      syncBuiltinESMExports();
      const { Store } = await import('./dist/src/store.js');
      opens = 0;
      const results = [];
      for (const name of ['state', 'new/nested']) {
        try { new Store(selected + '/' + name).close(); results.push(null); }
        catch (error) { results.push(error.code); }
      }
      process.stdout.write(JSON.stringify({ results, opens }));
    `,
        root,
        selected,
        kind,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(
      JSON.parse(child.stdout),
      { results: ['PRECONDITION_FAILED', 'PRECONDITION_FAILED'], opens: 0 },
      kind,
    );
    assert.equal(existsSync(join(parent, 'new')), false);
    for (const [name, bytes] of before)
      assert.deepEqual(readFileSync(join(directory, name)), bytes);
    assert.equal(
      lstatSync(root).mode & 0o777,
      kind === 'writable' ? 0o777 : 0o700,
    );
  });
}

test('RPC never sends through a missing namespace introduced during validation', async () => {
  const root = temporary();
  const trusted = join(root, 'trusted');
  mkdirSync(trusted, { mode: 0o700 });
  const directory = join(trusted, 'state');
  mkdirSync(directory, { mode: 0o700 });
  let connections = 0;
  let bytes = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', (data) => {
      bytes += data.length;
      const request: unknown = JSON.parse(data.toString());
      const id =
        request && typeof request === 'object' && 'id' in request
          ? request.id
          : null;
      socket.end(JSON.stringify({ id, ok: true }) + '\n');
    });
  });
  await new Promise<void>((done) =>
    server.listen(join(directory, 'control.sock'), done),
  );
  try {
    const { stdout } = await runFile(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const root = process.argv[1];
      const inspect = fs.lstatSync;
      let inserted = false;
      fs.lstatSync = (...args) => {
        const stat = inspect(...args);
        if (args[0] === root && !inserted) {
          fs.symlinkSync(root + '/trusted', root + '/missing');
          inserted = true;
        }
        return stat;
      };
      syncBuiltinESMExports();
      const { rpc } = await import('./dist/src/rpc.js');
      let code = null;
      try { await rpc(root + '/missing/state', { command: 'send', jid: '123450001@lid', key: 'fictional', text: 'FICTIONAL_PRIVATE_BODY' }); }
      catch (error) { code = error.code; }
      process.stdout.write(JSON.stringify({ inserted, code }));
    `,
        root,
      ],
      { timeout: 5000 },
    );
    assert.deepEqual(JSON.parse(stdout), {
      inserted: true,
      code: 'NOT_RUNNING',
    });
    assert.equal(connections, 0);
    assert.equal(bytes, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});

test('RPC refuses unsafe endpoints before connection/request bytes; owned private endpoint still works', async () => {
  const root = temporary();
  const directory = join(root, 'state');
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'control.sock');
  const sockets = new Set<Socket>();
  let connections = 0;
  let bytes = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', (data) => {
      bytes += data.length;
      const request: unknown = JSON.parse(data.toString());
      const id =
        request && typeof request === 'object' && 'id' in request
          ? request.id
          : null;
      socket.end(JSON.stringify({ id, ok: true, data: 'Fictional' }) + '\n');
    });
  });
  await new Promise<void>((done) => server.listen(path, done));
  try {
    chmodSync(path, 0o666);
    await assert.rejects(
      rpc(directory, {
        command: 'send',
        jid: '123450001@lid',
        key: 'fictional',
        text: 'FICTIONAL_PRIVATE_BODY',
      }),
      refused,
    );
    assert.equal(connections, 0);
    assert.equal(bytes, 0);
    chmodSync(path, 0o600);
    chmodSync(root, 0o777);
    await assert.rejects(
      rpc(directory, { command: 'pair-code', phone: '12025550100' }),
      refused,
    );
    assert.equal(connections, 0);
    assert.equal(bytes, 0);
    chmodSync(root, 0o700);
    const alias = join(root, 'alias');
    symlinkSync(directory, alias);
    await assert.rejects(rpc(alias, { command: 'status' }), refused);
    assert.equal(connections, 0);
    const linked = join(root, 'linked');
    mkdirSync(linked, { mode: 0o700 });
    symlinkSync(path, join(linked, 'control.sock'));
    await assert.rejects(rpc(linked, { command: 'status' }), refused);
    for (const selected of [root, directory, path]) {
      const { stdout } = await runFile(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const [directory, selected] = process.argv.slice(1);
        const inspect = fs.lstatSync;
        fs.lstatSync = (...args) => {
          const stat = inspect(...args);
          return args[0] === selected ? Object.assign(stat, { uid: 999999 }) : stat;
        };
        syncBuiltinESMExports();
        const { rpc } = await import('./dist/src/rpc.js');
        try { await rpc(directory, { command: 'send', jid: '123450001@lid', key: 'fictional', text: 'FICTIONAL_PRIVATE_BODY' }); }
        catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
      `,
          directory,
          selected,
        ],
        { timeout: 5000 },
      );
      assert.deepEqual(JSON.parse(stdout), { code: 'PRECONDITION_FAILED' });
      assert.equal(connections, 0);
      assert.equal(bytes, 0);
    }
    assert.equal((await rpc(directory, { command: 'status' })).ok, true);
    assert.equal(connections, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});

test('trusted canonical user/root and sticky-root ancestors work; writable nonsticky ancestors are refused', () => {
  const root = temporary();
  for (const [uid, mode, allowed] of [
    [0, 0o755, true],
    [process.getuid?.(), 0o700, true],
    [0, 0o1777, true],
    [0, 0o777, false],
    [process.getuid?.(), 0o770, false],
    [999999, 0o755, false],
  ] as const) {
    const check = () =>
      checkAncestors(root, (path) => {
        const stat = lstatSync(path);
        return path === root
          ? Object.assign(stat, { uid, mode: (stat.mode & ~0o7777) | mode })
          : stat;
      });
    if (allowed) assert.doesNotThrow(check);
    else assert.throws(check, refused);
  }
});

test('CLI full/compact start/status/stop and offline daemon/probe refuse unsafe ancestry without creating log, lock or state', () => {
  const root = temporary();
  chmodSync(root, 0o777);
  const directory = join(root, 'new', 'state');
  for (const mode of ['full', 'compact']) {
    for (const action of ['start', 'status', 'stop']) {
      const child = spawnSync(
        process.execPath,
        [
          'dist/src/cli.js',
          '--data-dir',
          directory,
          '--output',
          mode,
          action,
          ...(action === 'start' ? ['--offline'] : []),
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(child.status, 1, child.stderr);
      assert.equal(child.stderr, '');
      assert.equal(JSON.parse(child.stdout).code, 'PRECONDITION_FAILED');
      assert.equal(existsSync(join(root, 'new')), false);
    }
  }
  for (const entry of ['daemon', 'probe']) {
    const child = spawnSync(
      process.execPath,
      [
        `dist/src/${entry}.js`,
        '--data-dir',
        directory,
        ...(entry === 'daemon' ? ['--offline'] : []),
      ],
      { encoding: 'utf8', timeout: 5000, input: '' },
    );
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.equal(JSON.parse(child.stderr).code, 'PRECONDITION_FAILED');
    assert.equal(existsSync(join(root, 'new')), false);
  }
});

test('CLI preserves an existing public log, symlink or directory instead of opening it for daemon output', () => {
  for (const kind of ['public', 'symlink', 'directory']) {
    const directory = temporary();
    const path = join(directory, 'daemon.log');
    const target = join(directory, 'preserved');
    writeFileSync(target, 'Fictional preserved content', { mode: 0o600 });
    if (kind === 'public') {
      writeFileSync(path, 'Fictional existing log');
      chmodSync(path, 0o644);
    }
    if (kind === 'symlink') symlinkSync(target, path);
    if (kind === 'directory') mkdirSync(path, { mode: 0o700 });
    const child = spawnSync(
      process.execPath,
      ['dist/src/cli.js', '--data-dir', directory, 'start', '--offline'],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stdout).code, 'PRECONDITION_FAILED');
    assert.equal(readFileSync(target, 'utf8'), 'Fictional preserved content');
    assert.equal(existsSync(join(directory, 'writer-lock.sqlite')), false);
    if (kind === 'public') {
      assert.equal(readFileSync(path, 'utf8'), 'Fictional existing log');
      assert.equal(lstatSync(path).mode & 0o777, 0o644);
    }
    if (kind === 'symlink') assert.ok(lstatSync(path).isSymbolicLink());
    if (kind === 'directory') assert.deepEqual(readdirSync(path), []);
  }
});

test('pinned SDK interpolated diagnostics and console error strings do not expose private fields or causes', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createRuntime } from './dist/src/runtime.js';
    import { installConsoleDiagnostics } from './dist/src/diagnostics.js';
    import { LIDMappingStore } from './node_modules/baileys/lib/Signal/lid-mapping.js';
    installConsoleDiagnostics();
    console.info('Closing session:', { privateKey: 'FICTIONAL_PRIVATE_KEY' });
    console.error('Session error:' + new Error('FICTIONAL_PRIVATE_ERROR'), 'FICTIONAL_PRIVATE_STACK');
    let work;
    const runtime = createRuntime({ dataDir: process.argv[1], connect: true }, config => {
      const mappings = new LIDMappingStore({}, config.logger);
      work = mappings.storeLIDPNMappings([{ lid: 'FICTIONAL_PRIVATE_LID', pn: 'FICTIONAL_PRIVATE_PHONE' }]).finally(() => mappings.close());
      config.logger.error({ err: new Error('FICTIONAL_PRIVATE_ERROR', { cause: 'FICTIONAL_PRIVATE_CAUSE' }), body: 'FICTIONAL_PRIVATE_BODY' }, 'FICTIONAL_PRIVATE_STRING');
      config.logger.error({ err: new Error('FICTIONAL_PRIVATE_ERROR') }, 'failed to decrypt message');
      throw new Error('Synthetic factory ends before any network');
    });
    runtime.start(); await work;
    process.stdout.write(JSON.stringify(runtime.snapshot()));
    await runtime.close();
  `,
      temporary(),
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(
    child.stderr + child.stdout,
    /FICTIONAL_PRIVATE_|privateKey|\bstack\b|\bcause\b/,
  );
  assert.match(child.stderr, /Closing session/);
  assert.match(child.stderr, /decryption-or-integrity-failure/);
  assert.match(child.stdout, /decryption-or-integrity-failure/);
});

for (const entry of ['daemon', 'probe']) {
  test(`${entry} startup diagnostics hide arbitrary parser values`, () => {
    const child = spawnSync(
      process.execPath,
      [`dist/src/${entry}.js`, '--FICTIONAL_PRIVATE_OPTION'],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.doesNotMatch(child.stderr, /FICTIONAL_PRIVATE_|stack|cause/);
    assert.match(child.stderr, /Command failed/);
  });
}
