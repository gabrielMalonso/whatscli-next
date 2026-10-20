import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configureObservability, Observability } from '../src/observability.js';

process.umask(0o077);
const temporary = () =>
  realpathSync(mkdtempSync(join(tmpdir(), 'wobs-regression-')));
const canary = 'FICTIONAL_OBS_PRIVATE_CANARY';

test('disabled segment retention remains independent of an invalid witness and preserves unsafe state', () => {
  for (const obstruction of [
    'witness',
    'witness-lock',
    'generation',
    'unknown',
  ] as const) {
    const directory = temporary();
    configureObservability(directory, true);
    let now = Date.now() - 7 * 86400000;
    const observer = new Observability(directory, 'runtime', () => now);
    observer.record('sample');
    const root = join(directory, 'observability');
    const segment = join(root, readdirSync(root)[0]!);
    if (obstruction === 'generation') {
      const row = JSON.parse(readFileSync(segment, 'utf8')) as Record<
        string,
        unknown
      >;
      writeFileSync(
        segment,
        JSON.stringify({ ...row, generation: 'f'.repeat(32) }) + '\n',
      );
    }
    if (obstruction === 'unknown')
      writeFileSync(join(root, 'unfamiliar'), canary, { mode: 0o600 });
    const witness = join(root, 'loss-v1.json');
    if (obstruction === 'witness-lock') observer.failure();
    else writeFileSync(witness, '{', { mode: 0o600 });
    const original = readFileSync(witness);
    configureObservability(directory, false);
    if (obstruction === 'witness-lock')
      mkdirSync(join(directory, 'observability-loss.lock'), { mode: 0o700 });
    now += 7 * 86400000;
    assert.equal(observer.maintain(), true);
    assert.equal(
      existsSync(segment),
      !['witness', 'witness-lock'].includes(obstruction),
    );
    assert.deepEqual(readFileSync(witness), original);
    assert.equal(observer.status().degraded, true);
    if (obstruction === 'unknown')
      assert.equal(readFileSync(join(root, 'unfamiliar'), 'utf8'), canary);
  }
});
