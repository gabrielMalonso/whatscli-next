import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CommandError } from '../src/errors.js';
import { dataDirectory } from '../src/paths.js';
import { queryObservability } from '../src/observability.js';
import { Store } from '../src/store.js';

process.umask(0o077);

function fixture(homeSuffix = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wa-')));
  const home = join(root, homeSuffix);
  const preload = join(root, 'home.mjs');
  // Inject a fictional home without changing HOME or using an existing session.
  writeFileSync(
    preload,
    `import os from 'node:os';
     import { syncBuiltinESMExports } from 'node:module';
     os.homedir = () => ${JSON.stringify(home)};
     syncBuiltinESMExports();`,
  );
  const env = { ...process.env };
  delete env.XDG_STATE_HOME;
  const base =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'whatscli-next')
      : join(home, '.local', 'state', 'whatscli-next');
  function cli(args: string[], exitCode = 0): Record<string, unknown> {
    const child = spawnSync(
      process.execPath,
      ['--import', preload, 'dist/src/cli.js', ...args],
      { env, encoding: 'utf8', timeout: 15000 },
    );
    assert.equal(child.status, exitCode, child.stdout + child.stderr);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout.trim().split('\n').length, 1);
    return JSON.parse(child.stdout) as Record<string, unknown>;
  }
  return { root, base, cli };
}

test('named accounts resolve below the unchanged platform default with case-independent names', () => {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'whatscli-next')
      : join(
          process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
          'whatscli-next',
        );
  assert.equal(dataDirectory(), base);
  assert.equal(dataDirectory({ path: './example' }), resolve('example'));
  for (const account of ['pessoal', 'central-ES', 'central-RJ', 'Team_01'])
    assert.equal(
      dataDirectory({ account }),
      join(base, 'accounts', account.toLowerCase()),
    );
  assert.equal(
    dataDirectory({ account: 'central-ES' }),
    dataDirectory({ account: 'CENTRAL-es' }),
  );
});

test('account names cannot select paths or accept ambiguous directory selectors', () => {
  const invalid = (error: unknown) =>
    error instanceof CommandError && error.code === 'INVALID_ARGUMENT';
  for (const account of [
    '',
    '.',
    '..',
    '../pessoal',
    '/pessoal',
    'a/b',
    'a\\b',
    'a.b',
    'a b',
    ' pessoal',
    'pessoal\n',
    '-pessoal',
    '_pessoal',
    'pessoál',
    'a\0b',
    'a'.repeat(33),
  ])
    assert.throws(() => dataDirectory({ account }), invalid);
  assert.doesNotThrow(() => dataDirectory({ account: 'a'.repeat(32) }));
  assert.throws(
    () => dataDirectory({ path: '/example', account: 'pessoal' }),
    invalid,
  );
  assert.throws(() => dataDirectory({ path: '' }), invalid);
});

test('CLI rejects invalid, conflicting and repeated account selectors as JSON before creating state', () => {
  const { root, base, cli } = fixture();
  const explicit = join(root, 'explicit');
  assert.equal(cli(['--account'], 1).code, 'INVALID_ARGUMENT');
  const cases = [
    ['--account='],
    ['--account', '../escape'],
    ['--account', '/absolute'],
    ['--account', 'with space'],
    ['--account', 'pessoal\n'],
    ['--account', 'a'.repeat(33)],
    ['--account', 'pessoal', '--data-dir', explicit],
    ['--data-dir', explicit, '--account=pessoal'],
    ['--account', 'pessoal', '--account=central-RJ'],
    ['--account=pessoal', '--account=pessoal'],
    ['--data-dir', explicit, '--data-dir', explicit],
    ['--data-dir='],
  ];
  for (const args of cases) {
    const response = cli([...args, 'start', '--offline'], 1);
    assert.equal(response.ok, false);
    assert.equal(response.code, 'INVALID_ARGUMENT');
    assert.equal(existsSync(base), false);
    assert.equal(existsSync(explicit), false);
  }
  assert.deepEqual(readdirSync(root), ['home.mjs']);
  const help = cli(['help']);
  assert.match(
    String((help.data as { globalOption: string }).globalOption),
    /--account NAME.*--data-dir PATH/,
  );
  assert.equal(existsSync(base), false);
});

test('named-account telemetry captures parser errors only for an unambiguous valid selector', () => {
  const { base, cli } = fixture();
  const directory = join(base, 'accounts', 'pessoal');
  cli(['--account', 'pessoal', 'observability', 'enable']);
  cli(['--account=PESSOAL', '--unknown=FICTIONAL_PRIVATE_ARGUMENT'], 1);
  const before = queryObservability(directory, { limit: 100 }).records;
  assert.ok(
    before.some(
      (row) => row.origin === 'cli' && row.code === 'INVALID_ARGUMENT',
    ),
  );
  assert.doesNotMatch(JSON.stringify(before), /FICTIONAL_PRIVATE_ARGUMENT/);
  cli(['--account=pessoal', '--account=other', 'help'], 1);
  cli(['--account=pessoal', '--data-dir', base, 'help'], 1);
  assert.deepEqual(
    queryObservability(directory, { limit: 100 }).records,
    before,
  );
  assert.equal(existsSync(join(base, 'accounts', 'other')), false);
});

test('offline named accounts isolate history and lifecycle while preserving the default session', (t) => {
  const { base, cli } = fixture();
  const directories = [
    base,
    join(base, 'accounts', 'central-es'),
    join(base, 'accounts', 'central-rj'),
  ];
  const selectors = [[], ['--account', 'central-ES'], ['--account=central-RJ']];
  for (const [index, directory] of directories.entries()) {
    const store = new Store(directory);
    store.observeChat({ id: `1202555010${index}@s.whatsapp.net` });
    store.close();
  }
  t.after(() => {
    for (const directory of directories) cli(['--data-dir', directory, 'stop']);
  });
  const pids = new Set<unknown>();
  for (const [index, selector] of selectors.entries()) {
    const start = cli([...selector, 'start', '--offline']);
    assert.equal(start.ok, true);
    assert.equal(start.connection, 'offline');
    pids.add(start.pid);
    const directory = directories[index]!;
    assert.equal(cli(['--data-dir', directory, 'status']).pid, start.pid);
    assert.equal(statSync(join(directory, 'probe.sqlite')).mode & 0o777, 0o600);
    assert.deepEqual(
      (cli([...selector, 'chats']).data as { jid: string }[]).map(
        (chat) => chat.jid,
      ),
      [`1202555010${index}@s.whatsapp.net`],
    );
  }
  assert.equal(pids.size, 3);
  const again = cli(['--account=central-es', 'start', '--offline']);
  assert.equal(again.alreadyRunning, true);
  assert.equal(again.pid, cli(['--account', 'CENTRAL-ES', 'status']).pid);
  assert.equal(cli(['--account', 'central-es', 'stop']).running, false);
  assert.equal(cli(['--account', 'central-RJ', 'status']).running, true);
  assert.equal(cli(['status']).running, true);
  assert.equal(cli(['--account', 'central-es', 'status']).running, false);
  assert.equal(cli(['--account', 'central-es', 'start', '--offline']).ok, true);
});

test('named accounts preserve private-path admission and the socket length limit', () => {
  const { root, base, cli } = fixture();
  const accounts = join(base, 'accounts');
  mkdirSync(accounts, { recursive: true, mode: 0o700 });
  const target = join(root, 'preserved');
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(join(target, 'sentinel'), 'FICTIONAL_PRIVATE_CONTENT');
  symlinkSync(target, join(accounts, 'pessoal'));
  const rejected = cli(['--account', 'pessoal', 'start', '--offline'], 1);
  assert.equal(rejected.code, 'PRECONDITION_FAILED');
  assert.deepEqual(readdirSync(target), ['sentinel']);
  assert.equal(
    readFileSync(join(target, 'sentinel'), 'utf8'),
    'FICTIONAL_PRIVATE_CONTENT',
  );
  const longFixture = fixture('long-home-directory');
  const long = longFixture.cli(
    ['--account', 'a'.repeat(32), 'start', '--offline'],
    1,
  );
  assert.equal(long.code, 'INVALID_ARGUMENT');
  assert.match(String(long.error), /socket path.*too long/);
  assert.equal(existsSync(longFixture.base), false);
});
