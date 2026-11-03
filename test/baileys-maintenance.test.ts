import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkInstalledPackage,
  checkLockfile,
  pinLockfileIntegrity,
  sdkRelease,
  sdkRepository,
  validateUpdate,
} from '../scripts/baileys.js';

const sourceCommit = 'a'.repeat(40);
const manifest = {
  repository: sdkRepository,
  sourceCommit,
  upstreamVersion: '7.0.0-rc14',
  upstreamCommit: 'b'.repeat(40),
  version: '7.0.0-rc14-gabriel.aaaaaaaaaaaa',
  tag: `sdk-${sourceCommit}`,
  integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
  tarball: `https://github.com/${sdkRepository}/releases/download/sdk-${sourceCommit}/baileys.tgz`,
};

test('SDK dependency provenance must identify a commit-specific release in our repository', () => {
  assert.deepEqual(sdkRelease(manifest), manifest);
  for (const change of [
    { repository: 'WhiskeySockets/Baileys' },
    { sourceCommit: 'main' },
    { tarball: 'https://example.invalid/baileys.tgz' },
    { tag: 'latest' },
    { version: '7.0.0-rc14' },
    { integrity: 'sha512-incomplete' },
  ])
    assert.throws(() => sdkRelease({ ...manifest, ...change }));
});

test('the installed compiled SDK must identify the pinned fork source and upstream commit', () => {
  const pkg = {
    name: 'baileys',
    version: manifest.version,
    baileysFork: {
      repository: sdkRepository,
      sourceCommit,
      upstreamVersion: manifest.upstreamVersion,
      upstreamCommit: manifest.upstreamCommit,
    },
  };
  checkInstalledPackage(pkg, manifest);
  assert.throws(() =>
    checkInstalledPackage({ ...pkg, version: '7.0.0-rc14' }, manifest),
  );
  assert.throws(() =>
    checkInstalledPackage(
      {
        ...pkg,
        baileysFork: { ...pkg.baileysFork, sourceCommit: 'c'.repeat(40) },
      },
      manifest,
    ),
  );
});

test('lockfile validation checks the actual SDK resolution rather than an unrelated matching digest', async () => {
  for (const key of [manifest.tarball, `baileys@${manifest.tarball}`]) {
    const lock = `packages:\n  '${key}':\n    resolution: {integrity: '${manifest.integrity}'}\n`;
    await checkLockfile(lock, manifest);
    await assert.rejects(
      checkLockfile(lock.replace(manifest.integrity, 'sha512-wrong'), manifest),
    );
  }
  await assert.rejects(
    checkLockfile(
      `packages:\n  unrelated:\n    resolution: {integrity: '${manifest.integrity}'}\n`,
      manifest,
    ),
  );
});

test('dependency proposals cannot change CLI scripts or other dependencies', () => {
  const current = {
    scripts: { test: 'offline' },
    dependencies: { baileys: 'old', pino: '9.14.0' },
  };
  const next = {
    ...current,
    dependencies: { ...current.dependencies, baileys: manifest.tarball },
  };
  validateUpdate(current, next, manifest);
  assert.throws(() =>
    validateUpdate(current, { ...next, scripts: { test: 'skip' } }, manifest),
  );
  assert.throws(() =>
    validateUpdate(
      current,
      { ...next, dependencies: { ...next.dependencies, pino: 'changed' } },
      manifest,
    ),
  );
});

test('URL resolution pinning adds the verified digest without accepting a conflicting digest', async () => {
  const lock = `packages:\n  'baileys@${manifest.tarball}':\n    resolution: {tarball: ${manifest.tarball}}\n`;
  const pinned = await pinLockfileIntegrity(lock, manifest);
  await checkLockfile(pinned, manifest);
  assert.equal(await pinLockfileIntegrity(pinned, manifest), pinned);
  await assert.rejects(
    pinLockfileIntegrity(
      pinned.replace(manifest.integrity, 'sha512-wrong'),
      manifest,
    ),
  );
  assert.equal(pinned.replace(`integrity: ${manifest.integrity}, `, ''), lock);
});
