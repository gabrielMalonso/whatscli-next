import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { stampBuild } from '../scripts/stamp-build.js';

const runFile = promisify(execFile);
process.umask(0o077);
mkdirSync('.tmp', { recursive: true });
const fixture = () => mkdtempSync(resolve('.tmp/build-'));

test('build fingerprint covers emitted JS deterministically without maps, timestamps or Git metadata', () => {
  const directory = fixture();
  const runtime = 'const fingerprint = /* @build-fingerprint */ null;\n';
  writeFileSync(join(directory, 'runtime.js'), runtime);
  writeFileSync(join(directory, 'other.js'), 'export const example = 1;\n');
  const first = stampBuild(directory);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    stampBuild(directory),
    first,
    'restamping normalizes the embedded fingerprint',
  );
  writeFileSync(join(directory, 'runtime.js.map'), 'fictional source map');
  writeFileSync(join(directory, '.git'), 'fictional unrelated metadata');
  assert.equal(stampBuild(directory), first);
  appendFileSync(join(directory, 'other.js'), '// Changed emitted code\n');
  assert.notEqual(stampBuild(directory), first);
  writeFileSync(join(directory, 'runtime.js'), 'no build marker');
  assert.throws(
    () => stampBuild(directory),
    /one runtime build fingerprint marker/,
  );
});

test(
  'offline daemon retains build A across source/build/client B and reports B only after normal restart',
  { timeout: 30000 },
  async (t) => {
    // A source archive: no .git, no preexisting dist or sidecar, only public source/config.
    const root = fixture();
    cpSync('src', join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        extends: resolve('tsconfig.json'),
        include: ['src/**/*.ts'],
        compilerOptions: { outDir: 'dist' },
      }),
    );
    const compile = () =>
      runFile(process.execPath, [
        resolve('node_modules/typescript/bin/tsc'),
        '-p',
        join(root, 'tsconfig.json'),
      ]);
    await compile();
    const output = join(root, 'dist');
    const cliPath = join(output, 'cli.js');
    const directory = mkdtempSync(join(tmpdir(), 'whatscli-build-'));
    const cli = async (...args: string[]): Promise<Record<string, unknown>> => {
      const { stdout } = await runFile(
        process.execPath,
        [cliPath, '--data-dir', directory, ...args],
        { timeout: 12000 },
      );
      return JSON.parse(stdout) as Record<string, unknown>;
    };
    const build = (status: Record<string, unknown>): unknown => {
      assert.ok(
        status.data &&
          typeof status.data === 'object' &&
          'build' in status.data,
      );
      return status.data.build;
    };
    const launch = async () => {
      const child = spawn(
        process.execPath,
        [join(output, 'daemon.js'), '--offline', '--data-dir', directory],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let diagnostics = '';
      child.stderr.on('data', (chunk) => {
        diagnostics += String(chunk);
      });
      const exited = once(child, 'exit');
      const stop = async () => {
        await cli('stop');
        const [code, signal] = await exited;
        assert.equal(code, 0, diagnostics);
        assert.equal(signal, null);
      };
      t.after(stop);
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await cli('status');
        if (status.running === true) {
          assert.equal(
            status.pid,
            child.pid,
            'only our own offline child may answer',
          );
          return { status, stop };
        }
        assert.equal(child.exitCode, null, diagnostics);
        await delay(30);
      }
      throw new Error('Fictional daemon did not become ready');
    };

    const absent = await cli('status');
    assert.equal(absent.running, false);
    assert.doesNotMatch(JSON.stringify(absent), /"build":/);
    const unstamped = await launch();
    assert.deepEqual(
      build(unstamped.status),
      { fingerprint: null },
      'plain tsc never reuses a stale stamp',
    );
    await unstamped.stop();

    const fingerprintA = stampBuild(output);
    const a = await launch();
    assert.deepEqual(build(a.status), { fingerprint: fingerprintA });
    appendFileSync(
      join(root, 'src/runtime.ts'),
      '\n// Fictional modified source B\n',
    );
    // Source changes alone cannot relabel even a newly imported old artifact.
    assert.match(
      readFileSync(join(output, 'runtime.js'), 'utf8'),
      new RegExp(fingerprintA),
    );
    await compile();
    assert.match(
      readFileSync(join(output, 'runtime.js'), 'utf8'),
      /@build-fingerprint \*\/ null/,
    );
    const fingerprintB = stampBuild(output);
    assert.notEqual(fingerprintB, fingerprintA);
    for (const mode of ['full', 'compact']) {
      const status = await cli('status', '--output', mode);
      assert.equal(status.pid, a.status.pid);
      assert.deepEqual(build(status), { fingerprint: fingerprintA });
      assert.deepEqual(status.recovery, a.status.recovery);
      assert.deepEqual(status.receiveContinuity, a.status.receiveContinuity);
      const existing = await cli('start', '--offline', '--output', mode);
      assert.equal(existing.alreadyRunning, true);
      assert.equal(existing.pid, a.status.pid);
      assert.deepEqual(build(existing), { fingerprint: fingerprintA });
    }
    assert.equal(
      JSON.stringify(await cli('chats')).includes(fingerprintA),
      false,
    );
    await a.stop();
    const b = await launch();
    assert.notEqual(b.status.pid, a.status.pid);
    assert.deepEqual(build(b.status), { fingerprint: fingerprintB });
    await b.stop();
    assert.equal((await cli('status')).running, false);

    const probe = spawnSync(
      process.execPath,
      [
        join(output, 'probe.js'),
        '--data-dir',
        mkdtempSync(join(tmpdir(), 'whatscli-build-probe-')),
      ],
      {
        // Probe defaults offline and closes normally at EOF; it never receives --connect.
        input: '{"id":"fictional-build","command":"status"}\n',
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(
      build(JSON.parse(probe.stdout) as Record<string, unknown>),
      { fingerprint: fingerprintB },
    );
  },
);
