import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { parseArgs } from 'node:util';
import { installConsoleDiagnostics } from './diagnostics.js';
import { parseRequest, RequestError } from './protocol.js';
import { dataDirectory, socketPath } from './paths.js';
import { createRuntime } from './runtime.js';
import { CommandError, errorResponse } from './errors.js';

process.umask(0o077);
installConsoleDiagnostics();

async function main(): Promise<void> {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Only Linux and macOS are supported');
  const { values } = parseArgs({ options: {
    'data-dir': { type: 'string' }, offline: { type: 'boolean', default: false },
    'allow-jid': { type: 'string' },
  } });
  const directory = dataDirectory(values['data-dir']);
  const path = socketPath(directory);
  // The lifetime writer lock is acquired before any connection or stale socket cleanup.
  const runtime = createRuntime({ dataDir: directory, connect: !values.offline,
    ...(values['allow-jid'] === undefined ? {} : { allowedJid: values['allow-jid'] }) });
  const clients = new Set<Socket>();
  const active = new Set<Promise<void>>();
  let stopping: Promise<void> | undefined;
  let socketInode: number | undefined;
  const server = createServer(client => {
    clients.add(client);
    client.setEncoding('utf8');
    client.setTimeout(150000, () => client.destroy());
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    let buffer = '';
    const respond = (value: unknown): void => { if (!client.destroyed) client.end(JSON.stringify(value) + '\n'); };
    client.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 131072) { respond({ id: null, ...errorResponse(new CommandError('INVALID_ARGUMENT', 'Request exceeds 128 KiB')) }); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      client.removeAllListeners('data');
      const line = buffer.slice(0, end);
      const work = (async () => {
        let id: string | null = null;
        try {
          const request = parseRequest(line);
          id = request.id;
          if (stopping && request.command.command !== 'status') throw new CommandError('PRECONDITION_FAILED', 'Daemon is stopping');
          const data = await runtime.execute(request.command);
          respond({ id, ok: true, data, running: true, pid: process.pid, ...runtime.snapshot() });
          if (request.command.command === 'stop') void shutdown();
        } catch (error) { respond({ id: error instanceof RequestError ? error.id : id, ...errorResponse(error) }); }
      })();
      active.add(work);
      void work.finally(() => active.delete(work));
    });
  });
  function shutdown(): Promise<void> {
    if (stopping) return stopping;
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
        if (stat.isSocket() && stat.ino === socketInode && stat.uid === process.getuid?.()) unlinkSync(path);
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    })();
    stopping.catch(error => { process.stderr.write(JSON.stringify({ error: String(error) }) + '\n'); process.exitCode = 1; });
    return stopping;
  }
  try {
    try {
      const stale = lstatSync(path);
      if (!stale.isSocket() || stale.uid !== process.getuid?.() || (stale.mode & 0o077)) throw new Error('Existing control path is not an owned private socket; preserving it');
      await new Promise<void>((resolve, reject) => {
        const probe = connect(path);
        probe.setTimeout(500, () => { probe.destroy(); reject(new Error('Existing socket did not respond; preserving it')); });
        probe.once('connect', () => { probe.destroy(); reject(new Error('Existing socket is active; preserving it')); });
        probe.once('error', error => {
          probe.destroy();
          if ('code' in error && error.code === 'ECONNREFUSED') resolve(); else reject(error);
        });
      });
      if (lstatSync(path).ino !== stale.ino) throw new Error('Control socket changed; preserving it');
      unlinkSync(path);
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
    socketInode = lstatSync(path).ino;
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    runtime.start();
  } catch (error) { await shutdown(); throw error; }
}

main().catch(error => { process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Daemon failed' }) + '\n'); process.exitCode = 1; });
