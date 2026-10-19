import { EventEmitter } from 'node:events';
import type { WASocket } from 'baileys';
import { createRuntime as actualRuntime } from '../../src/runtime.js';
import type { RuntimeOptions } from '../../src/runtime.js';

export function createRuntime(options: RuntimeOptions) {
  let release = () => {};
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  process.on('message', message => { if (message === 'release-cleanup') release(); });
  // The daemon starts --offline; exercise cleanup only with this in-memory socket.
  const runtime = actualRuntime({ ...options, connect: true }, () => {
    const events = new EventEmitter();
    const ws = Object.assign(new EventEmitter(), { isClosed: false });
    queueMicrotask(() => events.emit('connection.update', { connection: 'open' }));
    // Deliberately partial injected SDK boundary; no real makeWASocket or network.
    return { ev: events, ws, end: async () => {
      process.send?.('cleanup-started');
      await cleanup;
      ws.isClosed = true;
      ws.emit('close');
      events.emit('connection.update', { connection: 'close' });
    } } as unknown as WASocket;
  });
  return { ...runtime,
    start() { runtime.start(); process.send?.('ready'); },
    async close() { await runtime.close(); process.disconnect?.(); },
  };
}
