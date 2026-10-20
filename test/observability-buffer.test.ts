import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs, {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import {
  configureObservability,
  Observability,
  queryObservability,
} from '../src/observability.js';
import type { ObsFields, ObsRecord } from '../src/observability.js';
import { rpc } from '../src/rpc.js';
import { observeProcess } from '../src/observability-runtime.js';

process.umask(0o077);
const temporary = () =>
  realpathSync(mkdtempSync(join(tmpdir(), 'wobs-buffer-')));
const queryId = (value: number) => value.toString(16).padStart(32, '0');
function contents(directory: string) {
  const root = join(directory, 'observability');
  return existsSync(root)
    ? readdirSync(root).map((name) => [
        name,
        readFileSync(join(root, name), 'utf8'),
      ])
    : [];
}
function scheduled(args: string[], input?: string) {
  const child = spawn(process.execPath, args, {
    stdio: [
      input === undefined ? 'ignore' : 'pipe',
      'pipe',
      'pipe',
      'pipe',
      'pipe',
    ],
  });
  if (input !== undefined) child.stdin!.end(input);
  const notifications = child.stdio[3];
  const release = child.stdio[4];
  assert.ok(notifications instanceof Readable);
  assert.ok(release instanceof Writable);
  const stages = createInterface({ input: notifications })[
    Symbol.asyncIterator
  ]();
  let stdout = '',
    stderr = '';
  child.stdout!.on('data', (data) => {
    stdout += String(data);
  });
  child.stderr!.on('data', (data) => {
    stderr += String(data);
  });
  const exited = once(child, 'close');
  // Only this fixture's pipe is closed on a failure deadline; no process is signalled.
  const deadline = setTimeout(() => release.end(), 15000);
  child.once('exit', () => clearTimeout(deadline));
  return {
    release,
    exited,
    async stage(expected: string) {
      assert.equal((await stages.next()).value, expected, stderr);
    },
    async result() {
      assert.deepEqual(await exited, [0, null], stderr);
      return { stdout, stderr };
    },
  };
}

for (const mode of [
  'release',
  'off',
  'cycle',
  'overflow',
  'real-expired',
] as const)
  test(`productive FIFO with an independent process: ${mode}`, async () => {
    const directory = temporary();
    configureObservability(directory, true);
    const holder = scheduled([
      '--import',
      './dist/test/fixtures/observability-order-hooks.js?mode=cli-lock',
      'dist/src/cli.js',
      '--data-dir',
      directory,
      'help',
    ]);
    let worker: ReturnType<typeof scheduled> | undefined;
    try {
      await holder.stage('cli-locked');
      worker = scheduled([
        'dist/test/fixtures/observability-buffer-worker.js',
        directory,
        mode,
      ]);
      await worker.stage('admitted');
      if (mode !== 'real-expired') {
        holder.release.write('x');
        await holder.result();
      }
      if (mode === 'off' || mode === 'cycle')
        configureObservability(directory, false);
      if (mode === 'cycle') configureObservability(directory, true);
      const before = contents(directory);
      worker.release.write('x');
      const output = await worker.result();
      const result = JSON.parse(output.stdout) as {
        timestamp: string;
        elapsedMs: number;
        identities: string[];
        records: ObsRecord[];
        status: ReturnType<Observability['status']>;
        gaps: ReturnType<typeof queryObservability>['gaps'];
      };
      if (mode === 'real-expired') {
        holder.release.write('x');
        await holder.result();
      }
      const retained = mode === 'release' ? 2 : mode === 'overflow' ? 16 : 0;
      assert.equal(result.records.length, retained);
      assert.deepEqual(
        result.records.map((row) => row.query),
        result.identities.slice(0, retained),
      );
      assert.ok(
        result.records.every(
          (row) => row.action === 'chats' && row.timestamp === result.timestamp,
        ),
      );
      assert.equal(result.status.buffer.admitted, mode === 'overflow' ? 17 : 2);
      assert.equal(result.status.buffer.pending, 0);
      assert.equal(result.status.buffer.bytes, 0);
      assert.equal(result.status.buffer.closed, true);
      assert.equal(
        result.status.dropped,
        mode === 'overflow' ? 1 : mode === 'real-expired' ? 2 : 0,
      );
      if (mode === 'off' || mode === 'cycle') {
        assert.equal(result.status.buffer.invalidated, 2);
        assert.deepEqual(contents(directory), before);
      }
      if (mode === 'real-expired') {
        assert.ok(result.elapsedMs >= 25);
        assert.equal(result.status.buffer.expired, 2);
        assert.ok(result.status.buffer.lockAttempts >= 2);
        assert.match(output.stderr, /OBSERVABILITY_DEGRADED/);
        assert.equal(result.gaps.lossEvidence?.origin, 'runtime');
      }
      if (mode === 'overflow') {
        assert.equal(result.status.buffer.overflow, 1);
        assert.equal(result.records[0]?.dropped, 1); // Later failure survives the older snapshot.
        assert.ok(result.records.slice(1).every((row) => row.dropped === 0));
      }
      assert.equal(result.gaps.captureCompleteness, 'unknown');
      const beforeQuery = contents(directory);
      queryObservability(directory, {});
      assert.deepEqual(contents(directory), beforeQuery);
      assert.doesNotMatch(
        JSON.stringify(contents(directory)),
        /FICTIONAL_BUFFER_PRIVATE_CANARY/,
      );
    } finally {
      holder.release.end();
      worker?.release.end();
      if (worker) await worker.exited;
      await holder.exited;
    }
  });

function occupied(directory: string) {
  const mkdir = fs.mkdirSync;
  let busy = true;
  fs.mkdirSync = ((path, ...args) => {
    if (busy && path === join(directory, 'observability.lock'))
      throw Object.assign(new Error('Fictional busy acquisition'), {
        code: 'EEXIST',
      });
    return Reflect.apply(mkdir, fs, [path, ...args]);
  }) as typeof fs.mkdirSync;
  syncBuiltinESMExports();
  return {
    set(value: boolean) {
      busy = value;
    },
    restore() {
      fs.mkdirSync = mkdir;
      syncBuiltinESMExports();
    },
  };
}

test('snapshots retain their span/context across retries and UTC rotation; retained preference FDs all close', async (t) => {
  const directory = temporary();
  configureObservability(directory, true);
  let now = Math.floor(Date.now() / 86400000) * 86400000 + 86399999;
  t.mock.method(Date, 'now', () => now);
  const observer = new Observability(
    directory,
    'runtime',
    () => now,
    () => 0,
  );
  const held = new Set<number>();
  const open = fs.openSync,
    close = fs.closeSync,
    random = crypto.randomBytes;
  const spans: string[] = [];
  fs.openSync = ((path, ...args) => {
    const fd = Reflect.apply(open, fs, [path, ...args]);
    if (path === join(directory, 'observability.json')) held.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.closeSync = ((fd) => {
    close(fd);
    held.delete(fd);
  }) as typeof fs.closeSync;
  crypto.randomBytes = ((...args: unknown[]) => {
    const value: unknown = Reflect.apply(random, crypto, args);
    if (args[0] === 16 && Buffer.isBuffer(value))
      spans.push(value.toString('hex'));
    return value;
  }) as typeof crypto.randomBytes;
  syncBuiltinESMExports();
  const gate = occupied(directory);
  try {
    const fields: ObsFields = { action: 'chats', query: queryId(1) };
    observer.record('execution', fields);
    fields.action = 'search';
    fields.query = queryId(2);
    observer.record('execution', fields);
    fields.query = queryId(3);
    assert.equal(held.size, 2);
    assert.equal(observer.status().buffer.pending, 2);
    now += 2;
    gate.set(false);
    await observer.drain();
    observer.record('execution', { action: 'chats', query: queryId(3) });
    await observer.close();
    const page = queryObservability(directory, {});
    assert.deepEqual(
      page.records.map((row) => row.span),
      spans,
    );
    assert.deepEqual(
      page.records.map((row) => row.query),
      [queryId(1), queryId(2), queryId(3)],
    );
    assert.deepEqual(
      page.records.map((row) => row.action),
      ['chats', 'search', 'chats'],
    );
    assert.equal(page.records[0]?.timestamp, new Date(now - 2).toISOString());
    assert.equal(page.records[2]?.timestamp, new Date(now).toISOString());
    assert.equal(readdirSync(join(directory, 'observability')).length, 2);
    assert.equal(held.size, 0);
  } finally {
    gate.restore();
    fs.openSync = open;
    fs.closeSync = close;
    crypto.randomBytes = random;
    syncBuiltinESMExports();
  }
});

test('bounded snapshots, one timer/shared drain, and new arrivals cannot extend the active deadline', async (t) => {
  const directory = temporary();
  configureObservability(directory, true);
  let elapsed = 0;
  const observer = new Observability(
    directory,
    'runtime',
    Date.now,
    () => elapsed,
  );
  const timeout = t.mock.method(globalThis, 'setTimeout');
  const gate = occupied(directory);
  try {
    for (let index = 0; index < 16; index++)
      observer.record('execution', { action: 'chats', query: queryId(index) });
    const status = observer.status();
    assert.equal(status.buffer.pending, 16);
    assert.equal(status.buffer.maxPending, 16);
    assert.equal(status.buffer.maxBytes, status.buffer.bytes);
    assert.equal(status.buffer.busyAttempts, 16);
    assert.equal(status.buffer.deferred, 16);
    assert.equal(status.dropped, 0);
    assert.ok(
      status.buffer.bytes > 0 &&
        status.buffer.bytes <= status.buffer.limits.bytes,
    );
    const baseBytes = Buffer.byteLength(
      JSON.stringify({
        schema: 1,
        timestamp: new Date().toISOString(),
        origin: 'runtime',
        category: 'execution',
        span: queryId(0),
        generation: status.generation,
        session: status.session,
        action: 'chats',
        query: queryId(0),
      }),
    );
    assert.equal(status.buffer.bytes, 16 * baseBytes);
    assert.equal(timeout.mock.callCount(), 1);
    const first = observer.drain();
    assert.equal(observer.drain(), first);
    elapsed = 25;
    // No renewed 25ms budget is granted by this newly admitted observation.
    observer.record('execution', { action: 'chats', query: queryId(16) });
    await first;
    assert.equal(observer.status().buffer.pending, 0);
    assert.equal(observer.status().buffer.expired, 16);
    assert.equal(observer.status().buffer.overflow, 1);
    assert.equal(observer.status().dropped, 17);
    assert.equal(timeout.mock.callCount(), 1);
    await observer.close();
    observer.record('execution');
    assert.equal(observer.status().buffer.admitted, 17);
    assert.equal(observer.status().effective, false);
  } finally {
    gate.restore();
  }
});

for (const reason of ['append', 'expired', 'overflow'] as const)
  test(`same-generation replacement invalidates old ${reason} without publishing a witness`, async () => {
    const directory = temporary();
    configureObservability(directory, true);
    let elapsed = 0;
    const observer = new Observability(
      directory,
      'runtime',
      Date.now,
      () => elapsed,
    );
    const generation = observer.status().generation;
    const gate = occupied(directory);
    try {
      for (let index = 0; index < (reason === 'overflow' ? 16 : 2); index++)
        observer.record('execution', {
          action: 'chats',
          query: queryId(index),
        });
      const cycle = () => {
        gate.set(false);
        configureObservability(directory, false);
        configureObservability(directory, true);
        gate.set(true);
      };
      if (reason === 'overflow')
        observer.record('execution', {
          get action(): 'chats' {
            cycle();
            return 'chats';
          },
        });
      else cycle();
      const before = contents(directory);
      if (reason === 'expired') elapsed = 25;
      gate.set(false);
      await observer.close();
      const status = observer.status();
      assert.equal(status.generation, generation);
      assert.equal(status.buffer.invalidated, reason === 'overflow' ? 17 : 2);
      assert.equal(status.dropped, 0);
      assert.equal(status.uncertain, 0);
      assert.deepEqual(contents(directory), before);
      assert.equal(queryObservability(directory, {}).gaps.lossEvidence, null);
    } finally {
      gate.restore();
    }
  });

test('reentrant capture stays FIFO and a later failure is not erased by the older append carry', async () => {
  const directory = temporary();
  configureObservability(directory, true);
  const observer = new Observability(directory, 'runtime');
  const write = fs.writeSync;
  let reentered = false;
  fs.writeSync = ((
    fd: number,
    data: string | NodeJS.ArrayBufferView,
    ...args: unknown[]
  ) => {
    const count = Reflect.apply(write, fs, [fd, data, ...args]);
    if (
      !reentered &&
      typeof data === 'string' &&
      data.includes(`"query":"${queryId(1)}"`)
    ) {
      reentered = true;
      observer.failure('runtime', 'uncertain');
      observer.record('execution', { action: 'chats', query: queryId(2) });
    }
    return count;
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    observer.record('execution', { action: 'chats', query: queryId(1) });
    await observer.close();
  } finally {
    fs.writeSync = write;
    syncBuiltinESMExports();
  }
  const rows = queryObservability(directory, {}).records;
  assert.deepEqual(
    rows.map((row) => row.query),
    [queryId(1), queryId(2)],
  );
  assert.deepEqual(
    rows.map((row) => row.uncertain),
    [0, 1],
  );
  assert.equal(observer.status().uncertain, 1);
  assert.equal(observer.status().buffer.captured, 2);
});

test('OFF and preparation refusal create no timer, admission, dropped row or witness', async (t) => {
  const directory = temporary();
  const timeout = t.mock.method(globalThis, 'setTimeout');
  const off = new Observability(directory, 'cli');
  off.record('command');
  await off.close();
  assert.equal(off.status().buffer.admitted, 0);
  assert.deepEqual(readdirSync(directory), []);
  configureObservability(directory, true);
  const observer = new Observability(directory, 'cli');
  observer.record('command', {
    get action(): 'help' {
      throw new Error('FICTIONAL_PREPARATION_CANARY');
    },
  });
  await observer.close();
  assert.equal(observer.status().buffer.preparationFailures, 1);
  assert.equal(observer.status().buffer.admitted, 0);
  assert.equal(observer.status().dropped, 0);
  assert.equal(observer.status().degraded, true);
  assert.equal(queryObservability(directory, {}).gaps.lossEvidence, null);
  assert.equal(timeout.mock.callCount(), 0);
});

test('a drain watermark is not extended by reentrant arrivals after its admission boundary', async () => {
  const directory = temporary();
  configureObservability(directory, true);
  const observer = new Observability(directory, 'runtime', Date.now, () => 0);
  const gate = occupied(directory);
  const write = fs.writeSync;
  let reentered = false;
  fs.writeSync = ((
    fd: number,
    data: string | NodeJS.ArrayBufferView,
    ...args: unknown[]
  ) => {
    const result = Reflect.apply(write, fs, [fd, data, ...args]);
    if (
      !reentered &&
      typeof data === 'string' &&
      data.includes(`"query":"${queryId(2)}"`)
    ) {
      reentered = true;
      observer.record('execution', { action: 'chats', query: queryId(3) });
      gate.set(true);
    }
    return result;
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    observer.record('execution', { query: queryId(1) });
    observer.record('execution', { query: queryId(2) });
    const draining = observer.drain();
    gate.set(false);
    await draining;
    assert.equal(observer.status().buffer.pending, 1);
    gate.set(false);
    await observer.close();
    assert.deepEqual(
      queryObservability(directory, {}).records.map((row) => row.query),
      [queryId(1), queryId(2), queryId(3)],
    );
  } finally {
    fs.writeSync = write;
    gate.restore();
    syncBuiltinESMExports();
  }
});

test('scheduler failure settles bounded pending observations without changing command flow', async (t) => {
  const directory = temporary();
  configureObservability(directory, true);
  const observer = new Observability(directory, 'runtime');
  const gate = occupied(directory);
  t.mock.method(globalThis, 'setTimeout', () => {
    throw new Error('FICTIONAL_TIMER_CANARY');
  });
  try {
    assert.doesNotThrow(() =>
      observer.record('execution', { query: queryId(1) }),
    );
    await observer.close();
    const status = observer.status();
    assert.equal(status.dropped, 1);
    assert.equal(status.buffer.schedulerDiscarded, 1);
    assert.equal(status.buffer.pending, 0);
    assert.equal(status.buffer.bytes, 0);
    assert.equal(
      queryObservability(directory, {}).gaps.lossEvidence?.origin,
      'runtime',
    );
    assert.doesNotMatch(
      JSON.stringify(contents(directory)),
      /FICTIONAL_TIMER_CANARY/,
    );
  } finally {
    gate.restore();
  }
});

test('EEXIST thrown by write is uncertain and never enters acquisition retry', async () => {
  const directory = temporary();
  configureObservability(directory, true);
  const observer = new Observability(directory, 'runtime');
  observer.record('sample');
  const write = fs.writeSync;
  let attempts = 0;
  fs.writeSync = ((
    fd: number,
    data: string | NodeJS.ArrayBufferView,
    ...args: unknown[]
  ) => {
    if (typeof data === 'string' && data.includes(`"query":"${queryId(1)}"`)) {
      attempts++;
      throw Object.assign(new Error('FICTIONAL_WRITE_EEXIST'), {
        code: 'EEXIST',
      });
    }
    return Reflect.apply(write, fs, [fd, data, ...args]);
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    observer.record('execution', { query: queryId(1) });
    await observer.close();
  } finally {
    fs.writeSync = write;
    syncBuiltinESMExports();
  }
  assert.equal(attempts, 1);
  assert.equal(observer.status().uncertain, 1);
  assert.equal(observer.status().buffer.busyAttempts, 0);
  assert.equal(observer.status().buffer.deferred, 0);
});

test('an actual append failure stays known, but a subsequent same-generation cycle blocks its old witness', async () => {
  const directory = temporary();
  configureObservability(directory, true);
  const observer = new Observability(directory, 'runtime');
  const open = fs.openSync,
    release = fs.rmdirSync;
  let cycled = false;
  let afterCycle: ReturnType<typeof contents> = [];
  fs.openSync = ((path, flags, ...args) => {
    if (
      typeof path === 'string' &&
      path.endsWith('.jsonl') &&
      typeof flags === 'number' &&
      flags & fs.constants.O_WRONLY
    )
      throw new Error('FICTIONAL_OPEN_FAILURE');
    return Reflect.apply(open, fs, [path, flags, ...args]);
  }) as typeof fs.openSync;
  fs.rmdirSync = ((path, ...args) => {
    const result = Reflect.apply(release, fs, [path, ...args]);
    if (!cycled && path === join(directory, 'observability.lock')) {
      cycled = true;
      configureObservability(directory, false);
      configureObservability(directory, true);
      afterCycle = contents(directory);
    }
    return result;
  }) as typeof fs.rmdirSync;
  syncBuiltinESMExports();
  try {
    observer.record('execution', { query: queryId(1) });
    await observer.close();
  } finally {
    fs.openSync = open;
    fs.rmdirSync = release;
    syncBuiltinESMExports();
  }
  assert.equal(cycled, true);
  assert.equal(observer.status().dropped, 1); // Failed while its original append gate was valid.
  assert.equal(observer.status().buffer.pending, 0);
  assert.equal(queryObservability(directory, {}).gaps.lossEvidence, null);
  assert.deepEqual(contents(directory), afterCycle);
});

test('preference close uncertainty is sticky health and never blindly retries the descriptor', async () => {
  const directory = temporary();
  configureObservability(directory, true);
  const observer = new Observability(directory, 'runtime');
  const open = fs.openSync,
    close = fs.closeSync;
  let target: number | undefined;
  let injected = false,
    reused = false,
    blindRetries = 0;
  fs.openSync = ((path, ...args) => {
    const fd = Reflect.apply(open, fs, [path, ...args]);
    if (
      !injected &&
      target === undefined &&
      path === join(directory, 'observability.json')
    )
      target = fd;
    if (injected && fd === target) reused = true;
    return fd;
  }) as typeof fs.openSync;
  fs.closeSync = ((fd) => {
    if (injected && !reused && fd === target) blindRetries++;
    close(fd);
    if (!injected && fd === target) {
      injected = true;
      throw new Error('FICTIONAL_CLOSE_UNCERTAINTY');
    }
  }) as typeof fs.closeSync;
  syncBuiltinESMExports();
  try {
    observer.record('execution', { query: queryId(1) });
    observer.record('execution', { query: queryId(2) });
    await observer.close();
  } finally {
    fs.openSync = open;
    fs.closeSync = close;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.equal(blindRetries, 0);
  assert.equal(queryObservability(directory, {}).records.length, 2);
  assert.equal(observer.status().dropped, 0);
  assert.equal(observer.status().cleanupFailures, 1);
  assert.equal(observer.status().components.cleanupDegraded, true);
});

for (const shared of [false, true])
  test(`RPC lifetime drains owned observations and leaves a shared recorder open: shared=${shared}`, async () => {
    const directory = temporary();
    configureObservability(directory, true);
    const holder = scheduled([
      '--import',
      './dist/test/fixtures/observability-order-hooks.js?mode=cli-lock',
      'dist/src/cli.js',
      '--data-dir',
      directory,
      'help',
    ]);
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as {
          id: string;
        };
        socket.end(
          JSON.stringify({ id: request.id, ok: true, data: [] }) + '\n',
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(join(directory, 'control.sock'), resolve),
    );
    try {
      await holder.stage('cli-locked');
      const observer = shared
        ? new Observability(directory, 'cli', Date.now, () => 0)
        : undefined;
      const result = await rpc(
        directory,
        { command: 'events', after: 0 },
        1000,
        observer ? { observer, root: queryId(9) } : undefined,
      );
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, []);
      if (observer) {
        assert.equal(observer.status().buffer.pending, 1);
        assert.equal(observer.status().buffer.closed, false);
        assert.equal(observer.status().dropped, 0);
      } else
        assert.equal(
          queryObservability(directory, {}).gaps.lossEvidence?.origin,
          'rpc',
        );
      holder.release.write('x');
      await holder.result();
      if (observer) await observer.close();
      const before = contents(directory);
      await rpc(
        directory,
        { command: 'events', after: 0 },
        1000,
        undefined,
        false,
      );
      assert.deepEqual(contents(directory), before);
      const rows = queryObservability(directory, {}).records.filter(
        (row) => row.origin === 'rpc',
      );
      assert.equal(rows.length, shared ? 1 : 0);
    } finally {
      holder.release.end();
      await holder.exited;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

for (const mode of ['release', 'held'] as const)
  test(`probe EOF owns its final productive drain: ${mode}`, async () => {
    const directory = temporary();
    configureObservability(directory, true);
    const holder = scheduled([
      '--import',
      './dist/test/fixtures/observability-order-hooks.js?mode=cli-lock',
      'dist/src/cli.js',
      '--data-dir',
      directory,
      'help',
    ]);
    let probe: ReturnType<typeof scheduled> | undefined;
    try {
      await holder.stage('cli-locked');
      probe = scheduled(
        [
          '--import',
          `./dist/test/fixtures/observability-probe-hooks.js?mode=${mode}`,
          'dist/src/probe.js',
          '--data-dir',
          directory,
        ],
        JSON.stringify({ id: 'fictional-probe', command: 'status' }) + '\n',
      );
      await probe.stage('startup-pending');
      if (mode === 'release') {
        holder.release.write('x');
        await holder.result();
      }
      probe.release.write('x');
      const result = await probe.result();
      assert.equal((JSON.parse(result.stdout) as { ok: boolean }).ok, true);
      if (mode === 'held') {
        holder.release.write('x');
        await holder.result();
      }
      const page = queryObservability(directory, {});
      const rows = page.records.filter((row) =>
        row.query?.startsWith('9'.repeat(24)),
      );
      if (mode === 'release') {
        assert.deepEqual(
          rows.map((row) => [row.origin, row.category]),
          [
            ['runtime', 'lifecycle'],
            ['runtime', 'execution'],
            ['probe', 'transport'],
            ['runtime', 'lifecycle'],
          ],
        );
        assert.deepEqual(
          rows.map((row) => row.query),
          [1, 2, 3, 4].map(
            (n) => '9'.repeat(24) + n.toString(16).padStart(8, '0'),
          ),
        );
      } else {
        assert.deepEqual(rows, []);
        assert.match(result.stderr, /OBSERVABILITY_DEGRADED/);
        assert.equal(page.gaps.lossEvidence?.origin, 'runtime');
      }
    } finally {
      holder.release.end();
      probe?.release.end();
      if (probe) await probe.exited;
      await holder.exited;
    }
  });

test('sampler computation failure is pre-admission health, not a claimed lost row', (t) => {
  const directory = temporary();
  configureObservability(directory, true);
  const observer = new Observability(directory, 'runtime');
  t.mock.timers.enable({ apis: ['setInterval'] });
  const processObserver = observeProcess(observer, 10);
  t.mock.method(process, 'memoryUsage', () => {
    throw new Error('FICTIONAL_SAMPLE_CANARY');
  });
  try {
    t.mock.timers.tick(10);
    assert.equal(observer.status().buffer.admitted, 0);
    assert.equal(observer.status().buffer.preparationFailures, 1);
    assert.equal(observer.status().dropped, 0);
    assert.equal(queryObservability(directory, {}).gaps.lossEvidence, null);
  } finally {
    processObserver.stop();
  }
});

test('closing reentrantly during preparation cannot admit a snapshot after its owner is sealed', async () => {
  const directory = temporary();
  configureObservability(directory, true);
  const observer = new Observability(directory, 'runtime');
  const closing: Promise<void>[] = [];
  observer.record('execution', {
    get action(): 'chats' {
      closing.push(observer.close());
      return 'chats';
    },
  });
  await Promise.all(closing);
  assert.equal(observer.status().buffer.admitted, 0);
  assert.equal(observer.status().buffer.closed, true);
  assert.equal(observer.status().dropped, 0);
  assert.deepEqual(contents(directory), []);
});
