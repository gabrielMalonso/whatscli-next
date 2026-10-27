import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  comparePackageMetadata,
  compareSdkFiles,
  publishUpdate,
  sameSdkBytes,
  sdkManifest,
  sdkVersion,
  validateSdkUpdate,
} from '../scripts/baileys.js';

const manifest = {
  version: '7.0.0-rc14',
  commit: '7'.repeat(40),
  integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
  patches: ['baileys-source/02-app-state.patch'],
};

test('SDK provenance requires an exact release, commit, integrity and confined unique patches', () => {
  assert.deepEqual(sdkManifest(manifest), manifest);
  assert.deepEqual(sdkManifest({ ...manifest, patches: [] }).patches, []);
  for (const version of ['latest', '^7.0.0', '../7.0.0', '7.0.0;echo secret'])
    assert.throws(() => sdkVersion(version));
  for (const changes of [
    { commit: 'master' },
    { integrity: 'sha512-missing' },
    { patches: ['../outside.patch'] },
    { patches: ['baileys-source/../../outside.patch'] },
    { patches: [...manifest.patches, ...manifest.patches] },
  ])
    assert.throws(() => sdkManifest({ ...manifest, ...changes }));
});

test('source-map newline handling cannot conceal changes to mappings or executable files', () => {
  const map = Buffer.from('{"mappings":"AAAA"}');
  assert.equal(
    sameSdkBytes('a.js.map', map, Buffer.concat([map, Buffer.from('\n')])),
    true,
  );
  assert.equal(
    sameSdkBytes('a.js.map', map, Buffer.from('{"mappings":"AAAB"}\n')),
    false,
  );
  assert.equal(
    sameSdkBytes('a.js', Buffer.from('code'), Buffer.from('code\n')),
    false,
  );
  assert.equal(
    sameSdkBytes('a.d.ts', Buffer.from('type A'), Buffer.from('type B')),
    false,
  );
});

test('installed SDK comparison rejects stale files and missing or changed build output', () => {
  const temporary = join(process.cwd(), '.tmp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'sdk-comparison-'));
  const source = join(directory, 'source');
  const installed = join(directory, 'installed');
  mkdirSync(source);
  mkdirSync(installed);
  writeFileSync(join(source, 'index.js'), 'export const value = 1;');
  assert.throws(() => compareSdkFiles(source, installed), /inventory/);
  writeFileSync(join(installed, 'index.js'), 'export const value = 2;');
  assert.throws(
    () => compareSdkFiles(source, installed),
    /differs from source/,
  );
  writeFileSync(join(installed, 'index.js'), 'export const value = 1;');
  compareSdkFiles(source, installed);
  writeFileSync(join(installed, 'stale.js'), 'stale');
  assert.throws(() => compareSdkFiles(source, installed), /inventory/);
});

test('package validation includes dependencies, exports and published inventory', () => {
  const source = {
    name: 'baileys',
    version: manifest.version,
    dependencies: { fictional: '1.0.0' },
    files: ['lib/**/*', 'WAProto/**/*'],
    exports: { '.': './lib/index.js' },
  };
  comparePackageMetadata(source, structuredClone(source));
  for (const changes of [
    { dependencies: { fictional: '2.0.0' } },
    { files: ['lib/**/*'] },
    { exports: { '.': './other.js' } },
  ])
    assert.throws(() =>
      comparePackageMetadata(source, { ...source, ...changes }),
    );
});

test('automated updates preserve source patches and every unrelated package setting', () => {
  const current = {
    scripts: { test: 'offline-tests' },
    dependencies: { baileys: manifest.version, pino: '9.14.0' },
  };
  const next = { ...manifest, version: '7.0.0-rc15', commit: '8'.repeat(40) };
  const candidate = {
    ...current,
    dependencies: { ...current.dependencies, baileys: next.version },
  };
  validateSdkUpdate(manifest, next, current, candidate);
  assert.throws(
    () =>
      validateSdkUpdate(manifest, { ...next, patches: [] }, current, candidate),
    /canonical source patches/,
  );
  assert.throws(
    () =>
      validateSdkUpdate(manifest, next, current, {
        ...candidate,
        scripts: { test: 'skip' },
      }),
    /only change the Baileys dependency/,
  );
  assert.throws(
    () =>
      validateSdkUpdate(manifest, next, current, {
        ...candidate,
        dependencies: { ...candidate.dependencies, pino: '10.0.0' },
      }),
    /only change the Baileys dependency/,
  );
  assert.throws(
    () =>
      validateSdkUpdate(
        manifest,
        { ...manifest, commit: next.commit },
        current,
        current,
      ),
    /provenance/,
  );
});

for (const state of ['new', 'existing', 'human-edited', 'human-pr'] as const) {
  test(`update publication preserves branch ownership and dispatches CI (${state})`, () => {
    const temporary = join(process.cwd(), '.tmp');
    mkdirSync(temporary, { recursive: true });
    const directory = mkdtempSync(join(temporary, 'sdk-publication-'));
    const root = join(directory, 'repo');
    const input = join(directory, 'artifact');
    const next = { ...manifest, version: '7.0.0-rc15', commit: '8'.repeat(40) };
    const workspace = (version: string) =>
      `patchedDependencies:\n  baileys@${version}: patches/baileys@${version}.patch\n`;
    for (const [path, data] of [
      [root, manifest],
      [input, next],
    ] as const) {
      mkdirSync(join(path, 'patches'), { recursive: true });
      writeFileSync(
        join(path, 'patches/baileys-source.json'),
        JSON.stringify(data),
      );
      writeFileSync(
        join(path, 'package.json'),
        JSON.stringify({ dependencies: { baileys: data.version } }),
      );
      writeFileSync(join(path, 'pnpm-lock.yaml'), 'fictional lockfile');
      writeFileSync(join(path, 'pnpm-workspace.yaml'), workspace(data.version));
      writeFileSync(
        join(path, `patches/baileys@${data.version}.patch`),
        'fictional package patch',
      );
    }
    const calls: string[][] = [];
    const run = (_cwd: string, name: string, args: string[]) => {
      calls.push([name, ...args]);
      if (name === 'pnpm')
        writeFileSync(
          join(root, 'pnpm-workspace.yaml'),
          workspace(next.version),
        );
      if (name === 'git' && args[0] === 'ls-files')
        return `patches/baileys@${manifest.version}.patch\n`;
      if (name === 'git' && args[0] === 'diff') return 'package.json\n';
      if (name === 'git' && args[0] === 'ls-remote')
        return state === 'new'
          ? ''
          : `${next.commit}\trefs/heads/automation/baileys-update\n`;
      if (name === 'gh' && args[0] === 'api') {
        if (args[1]?.includes('/commits/'))
          return JSON.stringify({
            author: {
              login:
                state === 'human-edited'
                  ? 'fictional-maintainer'
                  : 'github-actions[bot]',
            },
          });
        return JSON.stringify(
          state === 'existing' || state === 'human-pr'
            ? [
                {
                  number: 1,
                  user: {
                    login:
                      state === 'human-pr'
                        ? 'fictional-maintainer'
                        : 'github-actions[bot]',
                  },
                },
              ]
            : [],
        );
      }
      return '';
    };
    if (state === 'human-edited' || state === 'human-pr') {
      assert.throws(
        () => publishUpdate(root, input, 'fictional/project', run),
        /edited by someone else|bot-owned update PR/,
      );
      assert.equal(
        calls.some((call) => call[0] === 'git' && call[1] === 'push'),
        false,
      );
      assert.equal(
        calls.some((call) => call[0] === 'gh' && call[1] === 'workflow'),
        false,
      );
    } else {
      publishUpdate(root, input, 'fictional/project', run);
      assert.ok(
        calls.some(
          (call) =>
            call[0] === 'gh' &&
            call[1] === 'pr' &&
            call[2] === (state === 'new' ? 'create' : 'edit'),
        ),
      );
      assert.deepEqual(calls.at(-1), [
        'gh',
        'workflow',
        'run',
        'ci.yml',
        '--ref',
        'automation/baileys-update',
      ]);
      assert.ok(
        calls.some(
          (call) =>
            call[0] === 'git' &&
            call[1] === 'push' &&
            call[2]?.startsWith('--force-with-lease='),
        ),
      );
    }
  });
}
