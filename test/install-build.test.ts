import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { stampBuild } from '../scripts/stamp-build.js';
import { verifyBuild } from '../scripts/verify-build.js';

process.umask(0o077);
mkdirSync('.tmp', { recursive: true });
const fixture = () => mkdtempSync(resolve('.tmp/install-build-'));
const compiler = resolve('node_modules/typescript/bin/tsc');
const verifier = resolve('dist/scripts/verify-build.js');
const environment = { ...process.env };
delete environment.NODE_PATH;
delete environment.NODE_OPTIONS;

function compile(root: string): void {
  const result = spawnSync(process.execPath, [compiler, '-p', root], { encoding: 'utf8', env: environment });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function source(): string {
  const root = fixture();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: '.', outDir: 'dist', sourceMap: true, types: [], skipLibCheck: true,
  }, include: ['src/*.ts'] }));
  writeFileSync(join(root, 'src/runtime.ts'), 'export const fingerprint: string | null = /* @build-fingerprint */ null;\n');
  // The verifier must not execute this application, load SQLite, or contact any endpoint.
  writeFileSync(join(root, 'src/cli.ts'), 'throw new Error("FICTIONAL_APPLICATION_MUST_NOT_EXECUTE");\n');
  return root;
}

function snapshot(root: string): unknown {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name);
    const stat = lstatSync(path);
    return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? snapshot(path) : stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString('base64')];
  });
}

test('fresh source archive verifies stamped output through relative and absolute paths without writing or running it', () => {
  const root = source();
  assert.equal(existsSync(join(root, '.git')), false);
  assert.equal(existsSync(join(root, 'dist')), false);
  assert.throws(() => verifyBuild(root));
  assert.equal(existsSync(join(root, 'dist')), false);
  compile(root);
  const fingerprint = stampBuild(join(root, 'dist/src'));
  const before = snapshot(root);
  assert.deepEqual(verifyBuild(root), { files: 4, fingerprint });
  for (const path of [root, relative(process.cwd(), root)]) {
    const result = spawnSync(process.execPath, [verifier, path], { encoding: 'utf8', env: environment });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `Verified build: 4 files; ${fingerprint}\n`);
  }
  assert.deepEqual(snapshot(root), before);
});

test('verification rejects plain tsc/null and stale source; a fresh B build has its own verified label', () => {
  const root = source();
  compile(root);
  const unstamped = snapshot(root);
  assert.throws(() => verifyBuild(root), /bytes differ/);
  assert.deepEqual(snapshot(root), unstamped);
  const fingerprintA = stampBuild(join(root, 'dist/src'));
  assert.equal(verifyBuild(root).fingerprint, fingerprintA);
  appendFileSync(join(root, 'src/cli.ts'), '// Fictional source B\n');
  const stale = snapshot(root);
  assert.throws(() => verifyBuild(root), /bytes differ/);
  assert.deepEqual(snapshot(root), stale);
  const fresh = fixture();
  cpSync(join(root, 'src'), join(fresh, 'src'), { recursive: true });
  for (const name of ['package.json', 'tsconfig.json']) cpSync(join(root, name), join(fresh, name));
  compile(fresh);
  const fingerprintB = stampBuild(join(fresh, 'dist/src'));
  assert.notEqual(fingerprintB, fingerprintA);
  assert.equal(verifyBuild(fresh).fingerprint, fingerprintB);
});

test('verification rejects obsolete, missing, modified and linked output, preserving every failed candidate', () => {
  const original = source();
  compile(original);
  stampBuild(join(original, 'dist/src'));
  const cases: Array<(root: string) => void> = [
    root => { writeFileSync(join(root, 'dist/src/retired.js'), 'FICTIONAL_PRIVATE_CANARY'); compile(root); stampBuild(join(root, 'dist/src')); },
    root => renameSync(join(root, 'dist/src/cli.js.map'), join(root, 'saved-cli.js.map')),
    root => appendFileSync(join(root, 'dist/src/cli.js.map'), 'FICTIONAL_PRIVATE_CANARY'),
    root => appendFileSync(join(root, 'dist/src/runtime.js'), '// FICTIONAL_PRIVATE_CANARY'),
    root => mkdirSync(join(root, 'dist/unexpected-empty')),
    root => symlinkSync(join(root, 'src/cli.ts'), join(root, 'dist/src/unexpected.js')),
    root => { renameSync(join(root, 'dist'), join(root, 'saved-dist')); symlinkSync(join(root, 'saved-dist'), join(root, 'dist')); },
  ];
  for (const change of cases) {
    const root = fixture();
    cpSync(original, root, { recursive: true });
    change(root);
    const before = snapshot(root);
    assert.throws(() => verifyBuild(root));
    const result = spawnSync(process.execPath, [verifier, root], { encoding: 'utf8', env: environment });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Build verification failed.*NEW directory/);
    assert.doesNotMatch(result.stderr, /FICTIONAL_PRIVATE_CANARY|FICTIONAL_APPLICATION_MUST_NOT_EXECUTE/);
    assert.deepEqual(snapshot(root), before);
  }
});

test('verification rejects invalid source and compiler configuration without emitting or exposing diagnostics', () => {
  const root = source();
  compile(root);
  stampBuild(join(root, 'dist/src'));
  appendFileSync(join(root, 'src/cli.ts'), 'const privateValue: number = "FICTIONAL_PRIVATE_CANARY";\n');
  const before = snapshot(root);
  assert.throws(() => verifyBuild(root), /does not pass/);
  const result = spawnSync(process.execPath, [verifier, root], { encoding: 'utf8', env: environment });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /FICTIONAL_PRIVATE_CANARY/);
  assert.deepEqual(snapshot(root), before);
  const invalid = source();
  writeFileSync(join(invalid, 'tsconfig.json'), '{"compilerOptions":{"outDir":"elsewhere"}}');
  const config = snapshot(invalid);
  assert.throws(() => verifyBuild(invalid), /outDir dist/);
  assert.deepEqual(snapshot(invalid), config);
});
