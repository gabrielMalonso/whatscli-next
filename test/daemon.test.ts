import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Store } from '../src/store.js';

process.umask(0o077);
const runFile = promisify(execFile);

test('CLI stop waits for delayed SDK cleanup and writer release before reporting stopped', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'whatscli-stop-'));
  const child = spawn(process.execPath, ['--import', './dist/test/fixtures/daemon-hooks.js', 'dist/src/daemon.js', '--offline', '--data-dir', directory],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = '';
  child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(9000) });
  const cli = async (...args: string[]): Promise<Record<string, unknown>> => {
    const { stdout } = await runFile(process.execPath, ['dist/src/cli.js', '--data-dir', directory, ...args], { timeout: 8000 });
    return JSON.parse(stdout) as Record<string, unknown>;
  };
  let stop: Promise<Record<string, unknown>> | undefined;
  let released = false;
  const release = () => {
    if (!released && child.connected) { child.send('release-cleanup'); released = true; }
  };
  try {
    assert.deepEqual(await once(child, 'message', { signal: AbortSignal.timeout(5000) }), ['ready', undefined]);
    const initial = await cli('status');
    const cleaning = once(child, 'message', { signal: AbortSignal.timeout(5000) });
    let stopped = false;
    stop = cli('stop').then(result => { stopped = true; return result; });
    assert.deepEqual(await cleaning, ['cleanup-started', undefined]);
    const status = await cli('status');
    assert.equal(status.running, true, 'the control endpoint remains available during cleanup');
    assert.equal(status.pid, initial.pid);
    assert.deepEqual((status.recovery as { state: string }).state, 'stopping');
    assert.equal(stopped, false);
    const lock = new DatabaseSync(join(directory, 'writer-lock.sqlite'));
    try { assert.throws(() => lock.exec('BEGIN EXCLUSIVE'), /locked/); } finally { lock.close(); }
    release();
    assert.equal((await stop).running, false);
    assert.equal(existsSync(join(directory, 'control.sock')), false);
    const reopened = new Store(directory);
    reopened.close();
    assert.equal((await cli('status')).running, false);
  } finally {
    release();
    if (!stop && child.connected) stop = cli('stop');
    await stop;
    const [code, signal] = await exited;
    assert.equal(code, 0, diagnostics);
    assert.equal(signal, null);
  }
});
