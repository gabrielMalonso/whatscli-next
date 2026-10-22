import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import fs, {
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  configureObservability,
  Observability,
  queryObservability,
} from '../src/observability.js';

process.umask(0o077);
const temporary = () =>
  realpathSync(mkdtempSync(join(tmpdir(), 'wobs-regression-')));
const logs = (directory: string) =>
  queryObservability(directory, { limit: 500 }).records;

const canary = 'FICTIONAL_OBS_PRIVATE_CANARY';
function raw(directory: string): string {
  const root = join(directory, 'observability');
  return existsSync(root)
    ? readdirSync(root)
        .map((name) => readFileSync(join(root, name), 'utf8'))
        .join('')
    : '';
}

for (const cleanup of ['close', 'release'] as const)
  test(`a complete append survives ${cleanup} failure without becoming a dropped row`, async () => {
    const directory = temporary();
    configureObservability(directory, true);
    const observer = new Observability(directory, 'runtime');
    observer.record('sample');
    const write = fs.writeSync;
    const close = fs.closeSync;
    const release = fs.rmdirSync;
    let appended: number | undefined;
    fs.writeSync = ((
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      const result = Reflect.apply(write, fs, [fd, data, ...args]);
      if (typeof data === 'string' && data.includes('"action":"chats"'))
        appended = fd;
      return result;
    }) as typeof fs.writeSync;
    fs.closeSync = ((fd: number) => {
      close(fd);
      if (cleanup === 'close' && fd === appended) {
        appended = undefined;
        throw new Error(canary);
      }
    }) as typeof fs.closeSync;
    fs.rmdirSync = ((path, ...args) => {
      if (
        cleanup === 'release' &&
        path === join(directory, 'observability.lock')
      )
        throw new Error(canary);
      return Reflect.apply(release, fs, [path, ...args]);
    }) as typeof fs.rmdirSync;
    syncBuiltinESMExports();
    try {
      observer.record('execution', { action: 'chats' });
    } finally {
      fs.writeSync = write;
      fs.closeSync = close;
      fs.rmdirSync = release;
      syncBuiltinESMExports();
    }
    const page = queryObservability(directory, {});
    assert.equal(
      page.records.filter((row) => row.action === 'chats').length,
      1,
    );
    assert.equal(observer.status().dropped, 0);
    assert.equal(observer.status().degraded, true);
    assert.equal(page.gaps.lossEvidence, null);
    assert.equal(
      existsSync(join(directory, 'observability.lock')),
      cleanup === 'release',
    );
    assert.doesNotMatch(raw(directory), new RegExp(canary));
    if (cleanup === 'release') {
      observer.record('execution', { action: 'search' });
      assert.equal(observer.status().buffer.pending, 1);
      await observer.close();
      assert.equal(observer.status().dropped, 1);
      assert.equal(
        logs(directory).some((row) => row.action === 'search'),
        false,
      );
    } else await observer.close();
  });

test('digest failure omits only the selector and retains degraded health without claiming a lost row', () => {
  const directory = temporary();
  configureObservability(directory, true);
  const observer = new Observability(directory, 'runtime');
  const hmac = crypto.createHmac;
  crypto.createHmac = (() => {
    throw new Error(canary);
  }) as typeof crypto.createHmac;
  syncBuiltinESMExports();
  try {
    assert.equal(observer.opaque('query', canary), undefined);
  } finally {
    crypto.createHmac = hmac;
    syncBuiltinESMExports();
  }
  observer.record('execution', { action: 'search' });
  assert.equal(logs(directory).length, 1);
  assert.equal(observer.status().dropped, 0);
  assert.equal(observer.status().degraded, true);
  assert.equal(queryObservability(directory, {}).gaps.lossEvidence, null);
  assert.doesNotMatch(raw(directory), new RegExp(canary));
});

for (const appended of [false, true])
  test(`a write exception has an uncertain result, without retry, when underlying append=${appended}`, () => {
    const directory = temporary();
    configureObservability(directory, true);
    const now = Date.now();
    const observer = new Observability(directory, 'runtime', () => now);
    observer.record('sample');
    const write = fs.writeSync;
    let attempts = 0;
    fs.writeSync = ((
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      if (typeof data === 'string' && data.includes('"action":"chats"')) {
        attempts++;
        if (appended) Reflect.apply(write, fs, [fd, data, ...args]);
        throw new Error(canary);
      }
      return Reflect.apply(write, fs, [fd, data, ...args]);
    }) as typeof fs.writeSync;
    syncBuiltinESMExports();
    try {
      observer.record('execution', { action: 'chats' });
    } finally {
      fs.writeSync = write;
      syncBuiltinESMExports();
    }
    const status: Record<string, unknown> = observer.status();
    assert.equal(status.dropped, 0);
    assert.equal(status.uncertain, 1);
    assert.equal(attempts, 1);
    assert.equal(
      logs(directory).filter((row) => row.action === 'chats').length,
      appended ? 1 : 0,
    );
    observer.record('execution', { action: 'search' });
    const next: Record<string, unknown> = logs(directory).at(-1)!;
    assert.equal(next.uncertain, 1);
    assert.equal(next.dropped, 0);
    assert.deepEqual(logs(directory).at(-1)?.captureLoss, {
      groups: [
        {
          reason: 'write-uncertain',
          origin: 'runtime',
          category: 'execution',
          action: 'chats',
          count: 1,
          from: new Date(now).toISOString(),
          to: new Date(now).toISOString(),
        },
      ],
      unattributed: 0,
    });
    assert.equal(observer.status().degraded, false);
    assert.doesNotMatch(raw(directory), new RegExp(canary));
  });

test('failed appends restore carried loss details until a complete append succeeds', async () => {
  const directory = temporary();
  configureObservability(directory, true);
  const observer = new Observability(directory, 'runtime');
  observer.record('sample');
  const write = fs.writeSync;
  fs.writeSync = ((
    fd: number,
    data: string | NodeJS.ArrayBufferView,
    ...args: unknown[]
  ) => {
    if (typeof data === 'string' && JSON.parse(data).action === 'status')
      return 0;
    if (typeof data === 'string' && JSON.parse(data).action === 'messages')
      throw new Error(canary);
    return Reflect.apply(write, fs, [fd, data, ...args]);
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    observer.record('transport', { action: 'status' }, 'daemon');
    observer.record('execution', { action: 'messages' });
  } finally {
    fs.writeSync = write;
    syncBuiltinESMExports();
  }
  observer.record('execution', { action: 'contact' });
  observer.record('sample');
  await observer.close();
  const rows = logs(directory);
  assert.equal(rows[1]?.dropped, 1);
  assert.equal(rows[1]?.uncertain, 1);
  assert.deepEqual(
    rows[1]?.captureLoss?.groups.map(
      ({ reason, origin, category, action, count }) => ({
        reason,
        origin,
        category,
        action,
        count,
      }),
    ),
    [
      {
        reason: 'append-incomplete',
        origin: 'daemon',
        category: 'transport',
        action: 'status',
        count: 1,
      },
      {
        reason: 'write-uncertain',
        origin: 'runtime',
        category: 'execution',
        action: 'messages',
        count: 1,
      },
    ],
  );
  assert.equal(rows[1]?.captureLoss?.unattributed, 0);
  assert.equal(rows[2]?.captureLoss, undefined);
  assert.doesNotMatch(raw(directory), new RegExp(canary));
});

test('configuration still reports cleanup failure after a committed preference rename', () => {
  const directory = temporary();
  configureObservability(directory, true);
  const release = fs.rmdirSync;
  fs.rmdirSync = ((path, ...args) => {
    if (path === join(directory, 'observability.lock')) throw new Error(canary);
    return Reflect.apply(release, fs, [path, ...args]);
  }) as typeof fs.rmdirSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => configureObservability(directory, false), {
      code: 'LOCAL_STATE',
    });
  } finally {
    fs.rmdirSync = release;
    syncBuiltinESMExports();
  }
  assert.equal(
    new Observability(directory, 'runtime').status().configured,
    false,
  );
  assert.equal(existsSync(join(directory, 'observability.lock')), true);
});
