import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CommandError, runtimeExitCode } from '../src/errors.js';
import { Store } from '../src/store.js';

process.umask(0o077);
const runFile = promisify(execFile);
const temporary = (): string => mkdtempSync(join(tmpdir(), 'whatscli-fg-'));

async function invoke(
  directory: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await runFile(
      process.execPath,
      ['dist/src/cli.js', '--data-dir', directory, ...args],
      { timeout: 8000 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

/** Exactly one JSON object on stdout, as for every other command. */
function single(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, stdout);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function lifecycle(stderr: string): Record<string, unknown>[] {
  return stderr
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.level === 'lifecycle')
    .map(({ at: _at, level: _level, ...rest }) => rest);
}

function foreground(
  directory: string,
  hooks: boolean,
  ...args: string[]
): {
  child: ChildProcess;
  output: { stdout: string; stderr: string };
  exited: Promise<unknown[]>;
} {
  const child = spawn(
    process.execPath,
    [
      ...(hooks ? ['--import', './dist/test/fixtures/daemon-hooks.js'] : []),
      'dist/src/cli.js',
      '--data-dir',
      directory,
      'start',
      '--foreground',
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', ...(hooks ? ['ipc' as const] : [])] },
  );
  const output = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    output.stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output.stderr += String(chunk);
  });
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(9000) });
  return { child, output, exited };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  'start --foreground runs the daemon in the CLI process, refuses a second runtime and stops in order on SIGTERM',
  { timeout: 15000 },
  async () => {
    const directory = temporary();
    const { child, output, exited } = foreground(directory, true, '--offline');
    let released = false;
    const release = (): void => {
      if (!released && child.connected) {
        child.send('release-cleanup');
        released = true;
      }
    };
    try {
      assert.deepEqual(
        await once(child, 'message', { signal: AbortSignal.timeout(5000) }),
        ['ready', undefined],
      );
      await until(
        () => output.stderr.includes('"event":"ready"'),
        'the ready line',
      );
      assert.equal(output.stdout, '', 'stdout stays empty while running');
      // systemd's main PID is the process that serves the control socket.
      const status = single((await invoke(directory, 'status')).stdout);
      assert.equal(status.running, true);
      assert.equal(status.pid, child.pid);

      const second = await invoke(directory, 'start', '--foreground');
      assert.equal(second.code, 69, second.stderr);
      assert.deepEqual(single(second.stdout), {
        ok: false,
        error:
          'Data directory is locked by another runtime; stop it before starting a new one',
        code: 'PRECONDITION_FAILED',
        details: { reason: 'data-directory-in-use' },
      });
      assert.deepEqual(lifecycle(second.stderr), [
        { event: 'exit', pid: lifecycle(second.stderr)[0]?.pid, code: 69 },
      ]);
      assert.match(second.stderr, /"code":"PRECONDITION_FAILED"/);

      // The detached start still returns the running process unchanged.
      const background = single((await invoke(directory, 'start')).stdout);
      assert.equal(background.alreadyRunning, true);
      assert.equal(background.pid, child.pid);

      await until(
        () => output.stderr.includes('"state":"open"'),
        'the fictional open connection',
      );
      const cleaning = once(child, 'message', {
        signal: AbortSignal.timeout(5000),
      });
      child.kill('SIGTERM');
      assert.deepEqual(await cleaning, ['cleanup-started', undefined]);
      // A repeated signal during cleanup is logged and ignored, never fatal.
      child.kill('SIGINT');
      await until(
        () => output.stderr.includes('"signal":"SIGINT"'),
        'the repeated signal line',
      );
      const stopping = single((await invoke(directory, 'status')).stdout);
      assert.equal(stopping.running, true, 'status stays reachable');
      assert.equal((stopping.recovery as { state: string }).state, 'stopping');
      release();
      const [code, signal] = await exited;
      assert.equal(code, 0, output.stderr);
      assert.equal(signal, null);
    } finally {
      release();
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
      await exited.catch(() => {});
    }
    assert.deepEqual(single(output.stdout), {
      ok: true,
      running: false,
      data: { running: false, foreground: true, reason: 'SIGTERM' },
    });
    const events = lifecycle(output.stderr);
    assert.deepEqual(events, [
      {
        event: 'startup',
        pid: child.pid,
        build: events[0]?.build ?? null,
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
      { event: 'signal', signal: 'SIGINT', ignored: true },
      { event: 'shutdown-complete', reason: 'SIGTERM' },
      { event: 'exit', pid: child.pid, code: 0 },
    ]);
    assert.doesNotMatch(output.stderr, /@s\.whatsapp\.net|@lid|creds|Error:/);
    // Foreground diagnostics go to stderr only; daemon.log belongs to the background start.
    assert.equal(existsSync(join(directory, 'daemon.log')), false);
    assert.equal(existsSync(join(directory, 'control.sock')), false);
    new Store(directory).close();
  },
);

test('start --foreground exits 0 after the stop command', async () => {
  const directory = temporary();
  const { output, exited } = foreground(directory, false, '--offline');
  await until(
    () => output.stderr.includes('"event":"ready"'),
    'the ready line',
  );
  const stop = await invoke(directory, 'stop');
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(single(stop.stdout).running, false);
  const [code] = await exited;
  assert.equal(code, 0, output.stderr);
  assert.deepEqual(single(output.stdout), {
    ok: true,
    running: false,
    data: { running: false, foreground: true, reason: 'stop-command' },
  });
  assert.deepEqual(
    lifecycle(output.stderr)
      .slice(2)
      .map(({ event }) => event),
    ['shutdown-started', 'shutdown-complete', 'exit'],
  );
});

test('start --foreground exit statuses tell a supervisor when not to restart', async () => {
  const usage = temporary();
  for (const args of [
    ['start', '--foreground', '--jid', 'x'],
    ['start', '--foreground', '--not-an-option'],
    ['start', '--foreground', '--offline', '--allow-jid', 'not a jid'],
  ]) {
    const result = await invoke(usage, ...args);
    assert.equal(result.code, 64, args.join(' '));
    assert.equal(single(result.stdout).code, 'INVALID_ARGUMENT');
  }
  const long = await invoke(
    join(usage, 'x'.repeat(100)),
    'start',
    '--foreground',
  );
  assert.equal(long.code, 64);
  // Without --foreground, failures keep the ordinary CLI status.
  assert.equal((await invoke(usage, 'start', '--jid', 'x')).code, 1);

  // A foreign file at the control path is preserved and needs intervention.
  const foreign = temporary();
  writeFileSync(join(foreign, 'control.sock'), '');
  const blocked = await invoke(foreign, 'start', '--foreground', '--offline');
  assert.equal(blocked.code, 77, blocked.stderr);
  assert.deepEqual(single(blocked.stdout), {
    ok: false,
    error:
      'Existing control path is not an owned private socket; preserving it',
    code: 'PRECONDITION_FAILED',
  });
  assert.deepEqual(
    lifecycle(blocked.stderr).map(({ event, reason }) => [event, reason]),
    [
      ['startup', undefined],
      ['shutdown-started', 'startup-failed'],
      ['shutdown-complete', 'startup-failed'],
      ['exit', undefined],
    ],
  );
  assert.equal(existsSync(join(foreign, 'control.sock')), true);
});

test('the internal daemon entry names a held data directory and keeps exit status 1', async () => {
  const directory = temporary();
  const holder = new Store(directory);
  try {
    const result = await runFile(
      process.execPath,
      ['dist/src/daemon.js', '--offline', '--data-dir', directory],
      { timeout: 8000 },
    ).catch((error: { code: number; stderr: string }) => error);
    assert.equal('code' in result ? result.code : 0, 1);
    assert.match(result.stderr, /Data directory is locked by another runtime/);
  } finally {
    holder.close();
  }
});

test('runtime exit codes classify startup failures', () => {
  assert.equal(runtimeExitCode(new Error('fictional')), 1);
  assert.equal(
    runtimeExitCode(new CommandError('UNKNOWN', 'Command failed')),
    1,
  );
  assert.equal(
    runtimeExitCode(new CommandError('LOCAL_STATE', 'fictional')),
    1,
  );
  assert.equal(
    runtimeExitCode(new CommandError('INVALID_ARGUMENT', 'fictional')),
    64,
  );
  assert.equal(
    runtimeExitCode(
      new CommandError('PRECONDITION_FAILED', 'fictional', {
        details: { reason: 'data-directory-in-use' },
      }),
    ),
    69,
  );
  assert.equal(
    runtimeExitCode(new CommandError('PRECONDITION_FAILED', 'fictional')),
    77,
  );
});
