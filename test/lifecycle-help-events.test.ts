import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { writeDiagnostic } from '../src/diagnostics.js';
import { parseRequest } from '../src/protocol.js';
import { Store } from '../src/store.js';

process.umask(0o077);
const runFile = promisify(execFile);
const temporary = (): string => mkdtempSync(join(tmpdir(), 'whatscli-life-'));

async function invoke(
  directory: string,
  ...args: string[]
): Promise<{ code: number; result: Record<string, unknown>; stderr: string }> {
  try {
    const { stdout, stderr } = await runFile(
      process.execPath,
      ['dist/src/cli.js', '--data-dir', directory, ...args],
      { timeout: 5000 },
    );
    return { code: 0, result: JSON.parse(stdout), stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return {
      code: failed.code,
      result: JSON.parse(failed.stdout),
      stderr: failed.stderr,
    };
  }
}

test('diagnostic lines are JSON with an ISO-8601 at field first', () => {
  const lines: string[] = [];
  writeDiagnostic(
    { level: 'lifecycle', event: 'signal', signal: 'SIGTERM' },
    () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)),
    (line) => lines.push(line),
  );
  assert.deepEqual(lines, [
    '{"at":"2026-01-02T03:04:05.006Z","level":"lifecycle","event":"signal","signal":"SIGTERM"}\n',
  ]);
});

test('--help and -h anywhere return the help reference with exit 0, even beside invalid options', async () => {
  const directory = temporary();
  const reference = await invoke(directory, 'help');
  assert.equal(reference.code, 0);
  assert.match(
    String(
      (reference.result.data as { commands: Record<string, string> }).commands
        .events,
    ),
    /--tail .*--kind/,
  );
  for (const args of [
    ['--help'],
    ['-h'],
    ['send', '--help'],
    ['events', '-h'],
    ['observability', 'query', '--help'],
    ['send', '--not-an-option', '--help'],
    ['-h', 'chats', '--limit', 'many'],
  ]) {
    const { code, result, stderr } = await invoke(directory, ...args);
    assert.equal(code, 0, args.join(' '));
    assert.equal(stderr, '');
    assert.deepEqual(result, reference.result, args.join(' '));
  }
  // A string option's separate value is data, not a help request.
  for (const args of [
    ['send', '--jid', 'x', '--key', 'k', '--text', '-h'],
    ['search', '--query', '--help'],
  ]) {
    const { result } = await invoke(directory, ...args);
    assert.notDeepEqual(result, reference.result, args.join(' '));
  }
  // After the terminator, -h is not a flag; the normal parser still decides.
  assert.equal(
    (await invoke(directory, 'status', '--', '-h')).result.code,
    'INVALID_ARGUMENT',
  );
});

test('events --tail and --kind validate locally and reach the daemon unchanged', async (t) => {
  const directory = temporary();
  const commands: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const command = JSON.parse(buffer.trim()) as Record<string, unknown>;
      commands.push(command);
      socket.end(JSON.stringify({ id: command.id, ok: true, data: [] }) + '\n');
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, 'control.sock'), resolve),
  );
  t.after(() => server.close());

  for (const [args, message] of [
    [['--tail', '0'], /--tail must be an integer from 1 to 100/],
    [['--tail', '101'], /--tail must be an integer from 1 to 100/],
    [['--tail', '2.5'], /--tail must be an integer from 1 to 100/],
    [['--tail', 'latest'], /--tail must be an integer from 1 to 100/],
    [['--after', 'abc'], /--after must be a non-negative integer/],
    [['--after=-5'], /--after must be a non-negative integer/],
    [['--after', '1.5'], /--after must be a non-negative integer/],
    [['--kind', 'not a kind'], /--kind must be an event kind/],
    [['--kind', ''], /--kind must be an event kind/],
  ] as const) {
    const { code, result } = await invoke(directory, 'events', ...args);
    assert.equal(code, 1);
    assert.equal(result.code, 'INVALID_ARGUMENT');
    assert.match(String(result.error), message);
  }
  assert.equal(commands.length, 0, 'invalid event queries never reach I/O');

  for (const [args, expected] of [
    [[], { after: 0 }],
    [['--tail', '5'], { after: 0, tail: 5 }],
    [['--kind', 'messages.upsert'], { after: 0, kind: 'messages.upsert' }],
    [
      ['--after', '7', '--tail', '3', '--kind', 'connection'],
      { after: 7, tail: 3, kind: 'connection' },
    ],
  ] as const) {
    const { code } = await invoke(directory, 'events', ...args);
    assert.equal(code, 0);
    const { id: _id, ...sent } = commands.at(-1)!;
    assert.deepEqual(sent, { command: 'events', ...expected });
  }
});

test('the daemon protocol rejects invalid tail and kind values with clear messages', () => {
  const parse = (value: Record<string, unknown>) =>
    parseRequest(
      JSON.stringify({ id: 'fictional', command: 'events', ...value }),
    ).command;
  assert.deepEqual(parse({ tail: 100, kind: 'chats.update' }), {
    command: 'events',
    after: 0,
    tail: 100,
    kind: 'chats.update',
  });
  for (const [value, message] of [
    [{ tail: 0 }, /tail must be an integer from 1 to 100/],
    [{ tail: '5' }, /tail must be an integer from 1 to 100/],
    [{ kind: 5 }, /kind must be an event kind/],
    [{ kind: 'x'.repeat(65) }, /kind must be an event kind/],
  ] as const)
    assert.throws(
      () => parse(value),
      (error: Error & { code?: string }) =>
        error.code === 'INVALID_ARGUMENT' && message.test(error.message),
    );
});

test('events tail returns the latest matching entries in ascending order', () => {
  const store = new Store(temporary());
  try {
    for (let index = 1; index <= 150; index++)
      store.event(index % 3 === 0 ? 'connection' : 'history-status', {
        index,
      });
    const indexes = (rows: unknown[]) =>
      rows.map((row) => (row as { data: { index: number } }).data.index);
    const sequences = (rows: unknown[]) =>
      rows.map((row) => (row as { sequence: number }).sequence);

    const page = store.events(0);
    assert.equal(page.length, 100);
    assert.deepEqual(indexes(page).slice(0, 2), [1, 2]);

    assert.deepEqual(indexes(store.events(0, { tail: 3 })), [148, 149, 150]);
    const latest = store.events(0, { tail: 3, kind: 'connection' });
    assert.deepEqual(indexes(latest), [144, 147, 150]);
    assert.deepEqual(
      sequences(latest),
      [...sequences(latest)].sort((a, b) => a - b),
      'tail output stays ascending',
    );
    assert.deepEqual(
      (latest as { kind: string }[]).map(({ kind }) => kind),
      ['connection', 'connection', 'connection'],
    );
    // --after bounds the window; tail picks the newest within it.
    assert.deepEqual(
      indexes(store.events(145, { tail: 100, kind: 'connection' })),
      [147, 150],
    );
    assert.deepEqual(
      indexes(store.events(0, { kind: 'connection' })).slice(0, 3),
      [3, 6, 9],
    );
    assert.deepEqual(store.events(0, { kind: 'never-recorded' }), []);
  } finally {
    store.close();
  }
});

test(
  'the daemon log records startup, connection changes, the signal, shutdown and exit with timestamps',
  { timeout: 10000 },
  async () => {
    const directory = temporary();
    const child = spawn(
      process.execPath,
      [
        '--import',
        './dist/test/fixtures/daemon-hooks.js',
        'dist/src/daemon.js',
        '--offline',
        '--data-dir',
        directory,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let diagnostics = '';
    child.stderr?.on('data', (chunk) => {
      diagnostics += String(chunk);
    });
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(9000) });
    child.on('message', (message) => {
      if (message === 'cleanup-started') child.send('release-cleanup');
    });
    assert.deepEqual(
      await once(child, 'message', { signal: AbortSignal.timeout(5000) }),
      ['ready', undefined],
    );
    // The fictional socket reports open on a microtask after start.
    const deadline = Date.now() + 5000;
    while (!diagnostics.includes('"state":"open"') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0, diagnostics);
    assert.equal(signal, null);

    const lines = diagnostics
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of lines) {
      assert.equal(typeof line.at, 'string', JSON.stringify(line));
      assert.equal(new Date(String(line.at)).toISOString(), line.at);
    }
    const lifecycle = lines
      .filter((line) => line.level === 'lifecycle')
      .map(({ at: _at, level: _level, ...rest }) => rest);
    assert.deepEqual(lifecycle, [
      {
        event: 'startup',
        pid: child.pid,
        build: lifecycle[0]?.build ?? null,
        network: false,
      },
      { event: 'ready', pid: child.pid },
      {
        event: 'connection',
        state: 'open',
        recovery: 'open',
        reason: null,
        disconnectCode: null,
        attempt: 0,
      },
      { event: 'signal', signal: 'SIGTERM' },
      { event: 'shutdown-started', reason: 'SIGTERM' },
      { event: 'shutdown-complete', reason: 'SIGTERM' },
      { event: 'exit', pid: child.pid, code: 0 },
    ]);
    const build = lifecycle[0]?.build;
    assert.ok(build === null || /^sha256:[a-f0-9]{64}$/.test(String(build)));
    assert.doesNotMatch(diagnostics, /@s\.whatsapp\.net|@lid|creds|Error:/);
  },
);
