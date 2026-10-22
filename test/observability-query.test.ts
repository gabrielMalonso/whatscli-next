import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
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
test('query compares accepted timestamp instants after normalization', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-20T13:00:00.000Z'));
  const directory = temporary();
  configureObservability(directory, true);
  new Observability(directory, 'runtime').record('sample');
  const root = join(directory, 'observability');
  const path = join(root, readdirSync(root)[0]!);
  const row = logs(directory)[0]!;
  writeFileSync(
    path,
    [row, { ...row, timestamp: '2026-10-20T09:00:00-03:00' }]
      .map((value) => JSON.stringify(value) + '\n')
      .join(''),
  );
  const from = queryObservability(directory, {
    from: '2026-10-20T11:30:00.000Z',
  });
  const to = queryObservability(directory, { to: '2026-10-20T11:30:00.000Z' });
  assert.equal(from.records.length, 2);
  assert.equal(from.invalid, 0);
  assert.equal(from.records[1]?.timestamp, '2026-10-20T12:00:00.000Z');
  assert.deepEqual(to.records, []);
  assert.equal(to.invalid, 0);
});

test('query rejects array-coerced span, generation and session identities', () => {
  const directory = temporary();
  configureObservability(directory, true);
  new Observability(directory, 'runtime').record('sample');
  const root = join(directory, 'observability');
  const path = join(root, readdirSync(root)[0]!);
  const row = logs(directory)[0]!;
  const invalid = ['span', 'generation', 'session'].flatMap((field) => [
    { ...row, [field]: ['a'.repeat(32)] },
    { ...row, [field]: [['a'.repeat(32)]] },
  ]);
  writeFileSync(
    path,
    [row, ...invalid].map((value) => JSON.stringify(value) + '\n').join(''),
  );
  const page = queryObservability(directory, {});
  assert.equal(page.records.length, 1);
  assert.equal(page.invalid, 6);
});

test('query allowlists bounded loss groups and omits malformed details without hiding legacy rows', () => {
  const directory = temporary();
  configureObservability(directory, true);
  new Observability(directory, 'runtime').record('sample');
  const root = join(directory, 'observability');
  const path = join(root, readdirSync(root)[0]!);
  const row = logs(directory)[0]!;
  const group = {
    reason: 'lock-expired',
    origin: 'daemon',
    category: 'transport',
    action: 'status',
    count: 2,
    from: row.timestamp,
    to: row.timestamp,
  };
  const extra = 'FICTIONAL_PRIVATE_LOSS_CANARY';
  const invalid = [
    { ...group, reason: extra },
    { ...group, origin: extra },
    { ...group, category: extra },
    { ...group, action: extra },
    { ...group, from: extra },
    { ...group, to: '2000-01-01T00:00:00.000Z' },
    { ...group, count: -1 },
  ].map((item) => ({ groups: [item], unattributed: 0 }));
  writeFileSync(
    path,
    [
      row,
      {
        ...row,
        dropped: 2,
        captureLoss: {
          groups: [{ ...group, error: extra, resource: extra }],
          unattributed: 0,
          error: extra,
        },
      },
      ...invalid.map((captureLoss) => ({ ...row, captureLoss })),
      {
        ...row,
        captureLoss: {
          groups: Array.from({ length: 5 }, () => group),
          unattributed: 0,
        },
      },
      { ...row, captureLoss: { groups: [], unattributed: -1 } },
    ]
      .map((value) => JSON.stringify(value) + '\n')
      .join(''),
  );
  const page = queryObservability(directory, {});
  assert.equal(page.invalid, 0);
  assert.equal(page.records.length, 11);
  assert.deepEqual(page.records[1]?.captureLoss, {
    groups: [group],
    unattributed: 0,
  });
  assert.equal(page.records[0]?.captureLoss, undefined);
  assert.ok(
    page.records.slice(2).every((row) => row.captureLoss === undefined),
  );
  assert.doesNotMatch(JSON.stringify(page), new RegExp(extra));
});
