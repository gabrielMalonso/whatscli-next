import { chmodSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { installConsoleDiagnostics, writeDiagnostic } from './diagnostics.js';
import { parseRequest, RequestError } from './protocol.js';
import { dataDirectory, socketPath } from './paths.js';
import { createRuntime } from './runtime.js';
import { CommandError, errorResponse, errorSummary } from './errors.js';
import { obsAction, obsCode } from './observability.js';
import { commandFields, wireFields } from './observability-context.js';
import type { ObsFields } from './observability.js';

process.umask(0o077);

let lifecycleInstalled = false;
/** Route dependency console output to stderr diagnostics and record the process exit once. */
function installLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  installConsoleDiagnostics();
  // A missing exit line after the last entry means the process was killed (for example SIGKILL).
  process.once('exit', (code) => {
    writeDiagnostic({
      level: 'lifecycle',
      event: 'exit',
      pid: process.pid,
      code,
    });
  });
}

export type DaemonOptions = {
  dataDir: string;
  offline: boolean;
  allowJid?: string | undefined;
};

/** Why an orderly shutdown ran after the daemon became ready. */
export type StopReason = 'stop-command' | 'SIGINT' | 'SIGTERM';

/**
 * Run the daemon in this process. Resolves once it is ready (after the `ready` lifecycle line);
 * `stopped` settles after an orderly shutdown, or rejects if cleanup failed.
 * Startup failures reject; classify them with runtimeExitCode.
 */
export async function runDaemon(
  options: DaemonOptions,
): Promise<{ stopped: Promise<StopReason> }> {
  installLifecycle();
  if (!['linux', 'darwin'].includes(process.platform))
    throw new CommandError(
      'PRECONDITION_FAILED',
      'Only Linux and macOS are supported',
    );
  const directory = options.dataDir;
  const path = socketPath(directory);
  // The lifetime writer lock is acquired before any connection or stale socket cleanup.
  const runtime = createRuntime({
    dataDir: directory,
    connect: !options.offline,
    ...(options.allowJid === undefined ? {} : { allowedJid: options.allowJid }),
    lifecycle: writeDiagnostic,
  });
  // The writer lock is held: record which process and build own this data directory.
  writeDiagnostic({
    level: 'lifecycle',
    event: 'startup',
    pid: process.pid,
    build: runtime.build,
    network: !options.offline,
  });
  installConsoleDiagnostics(() =>
    runtime.observability.record('diagnostic', { label: 'dependency' }),
  );
  const clients = new Set<Socket>();
  const active = new Set<Promise<void>>();
  let stopping: Promise<void> | undefined;
  let settleStopped!: (reason: StopReason, done: Promise<void>) => void;
  const stopped = new Promise<StopReason>((resolve, reject) => {
    settleStopped = (reason, done) => done.then(() => resolve(reason), reject);
  });
  // Callers observe cleanup failure; it is also logged as shutdown-failed.
  stopped.catch(() => {});
  let socketInode: number | undefined;
  const server = createServer((client) => {
    clients.add(client);
    client.setEncoding('utf8');
    client.setTimeout(150000, () => client.destroy());
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    let buffer = '';
    const started = performance.now();
    let fields: ObsFields = { action: 'unknown' };
    let capture = true;
    let parsed = false;
    const respond = (value: Record<string, unknown>): void => {
      const line = JSON.stringify(value) + '\n';
      if (capture)
        runtime.observability.record(
          parsed ? 'transport' : 'parser',
          {
            ...fields,
            durationMs: performance.now() - started,
            requestBytes: client.bytesRead,
            responseBytes: client.destroyed ? 0 : Buffer.byteLength(line),
            ok: value.ok === true,
            code: value.ok === true ? 'OK' : obsCode(value.code),
          },
          'daemon',
        );
      // Try capture before waking this client. Busy acquisition defers telemetry;
      // slow synchronous filesystem work still adds response latency.
      if (!client.destroyed) client.end(line);
    };
    client.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 131072) {
        client.removeAllListeners('data');
        respond({
          id: null,
          ...errorResponse(
            new CommandError('INVALID_ARGUMENT', 'Request exceeds 128 KiB'),
          ),
        });
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      client.removeAllListeners('data');
      const line = buffer.slice(0, end);
      const work = (async () => {
        let id: string | null = null;
        try {
          const request = parseRequest(line);
          parsed = true;
          id = request.id;
          fields = {
            ...commandFields(runtime.observability, request.command),
            ...wireFields(runtime.observability, id),
          };
          capture = request.command.command !== 'observability';
          // Before anything else: a request for another account does nothing here.
          if (request.expectAccount !== undefined)
            runtime.checkAccount(request.expectAccount);
          if (stopping && request.command.command !== 'status')
            throw new CommandError('PRECONDITION_FAILED', 'Daemon is stopping');
          const data = await runtime.execute(
            request.command,
            wireFields(runtime.observability, id),
          );
          respond({
            id,
            ok: true,
            data,
            running: true,
            pid: process.pid,
            ...runtime.snapshot(),
          });
          if (request.command.command === 'stop') void shutdown('stop-command');
        } catch (error) {
          if (error instanceof RequestError)
            fields = {
              action: obsAction(error.action),
              ...wireFields(runtime.observability, error.id),
            };
          respond({
            id: error instanceof RequestError ? error.id : id,
            ...errorResponse(error),
          });
        }
      })();
      active.add(work);
      void work.finally(() => active.delete(work));
    });
  });
  function shutdown(
    reason: 'stop-command' | 'SIGINT' | 'SIGTERM' | 'startup-failed',
  ): Promise<void> {
    if (stopping) return stopping;
    writeDiagnostic({ level: 'lifecycle', event: 'shutdown-started', reason });
    stopping = (async () => {
      // Cancel network waits first; their uncertain results are persisted before closing SQLite.
      await runtime.stop();
      await Promise.allSettled([...active]);
      await runtime.close();
      // Keep status reachable until SDK cleanup and the writer lock are both released.
      if (server.listening) server.close();
      for (const client of clients) client.destroy();
      try {
        const stat = lstatSync(path);
        if (
          stat.isSocket() &&
          stat.ino === socketInode &&
          stat.uid === process.getuid?.()
        )
          unlinkSync(path);
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
      writeDiagnostic({
        level: 'lifecycle',
        event: 'shutdown-complete',
        reason,
      });
    })();
    if (reason !== 'startup-failed') settleStopped(reason, stopping);
    stopping.catch((error) => {
      writeDiagnostic({
        ...errorSummary(error),
        level: 'lifecycle',
        event: 'shutdown-failed',
      });
      process.exitCode = 1;
    });
    return stopping;
  }
  try {
    try {
      const stale = lstatSync(path);
      if (
        !stale.isSocket() ||
        stale.uid !== process.getuid?.() ||
        stale.mode & 0o077
      )
        throw new CommandError(
          'PRECONDITION_FAILED',
          'Existing control path is not an owned private socket; preserving it',
        );
      await new Promise<void>((resolve, reject) => {
        const probe = connect(path);
        probe.setTimeout(500, () => {
          probe.destroy();
          reject(
            new CommandError(
              'PRECONDITION_FAILED',
              'Existing socket did not respond; preserving it',
            ),
          );
        });
        probe.once('connect', () => {
          probe.destroy();
          reject(
            new CommandError(
              'PRECONDITION_FAILED',
              'Existing socket is active; preserving it',
              { details: { reason: 'data-directory-in-use' } },
            ),
          );
        });
        probe.once('error', (error) => {
          probe.destroy();
          if ('code' in error && error.code === 'ECONNREFUSED') resolve();
          else reject(error);
        });
      });
      if (lstatSync(path).ino !== stale.ino)
        throw new CommandError(
          'PRECONDITION_FAILED',
          'Control socket changed; preserving it',
        );
      unlinkSync(path);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    chmodSync(path, 0o600);
    socketInode = lstatSync(path).ino;
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        writeDiagnostic({ level: 'lifecycle', event: 'signal', signal });
        void shutdown(signal);
      });
    runtime.start();
    writeDiagnostic({ level: 'lifecycle', event: 'ready', pid: process.pid });
  } catch (error) {
    await shutdown('startup-failed');
    throw error;
  }
  return { stopped };
}

/** The internal entry used by the background `start`: same lifecycle, stderr to daemon.log. */
async function main(): Promise<void> {
  installLifecycle();
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      offline: { type: 'boolean', default: false },
      'allow-jid': { type: 'string' },
    },
  });
  // Cleanup failure is logged as shutdown-failed and exits with code 1.
  await runDaemon({
    dataDir: dataDirectory({ path: values['data-dir'] }),
    offline: values.offline,
    allowJid: values['allow-jid'],
  });
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  (() => {
    try {
      return pathToFileURL(realpathSync(entry)).href === import.meta.url;
    } catch {
      return false;
    }
  })()
)
  main().catch((error) => {
    writeDiagnostic(errorSummary(error));
    process.exitCode = 1;
  });
