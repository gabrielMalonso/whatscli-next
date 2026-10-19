import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { object } from './protocol.js';
import type { Command } from './protocol.js';
import { socketPath } from './paths.js';

export class RpcError extends Error {
  constructor(readonly code: 'NOT_RUNNING' | 'TIMEOUT' | 'PROTOCOL', message: string) { super(message); }
}

/** One command per connection. A timeout never causes an automatic command retry. */
export function rpc(directory: string, command: Command, timeoutMs = 120000): Promise<Record<string, unknown>> {
  const path = socketPath(directory);
  const id = randomUUID();
  const line = JSON.stringify({ ...command, id }) + '\n';
  if (Buffer.byteLength(line) > 131072) throw new Error('Request exceeds 128 KiB');
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const chunks: string[] = [];
    let bytes = 0;
    let completed = false;
    const finish = (error?: Error, response?: Record<string, unknown>): void => {
      if (completed) return;
      completed = true;
      socket.destroy();
      if (error) reject(error); else if (response) resolve(response);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new RpcError('TIMEOUT', 'Daemon response timed out; query the idempotency key before considering another send')));
    socket.once('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => {
      if (completed) return;
      // Inspect each decoded fragment once; flatten the response only when its line is complete.
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) return finish(new RpcError('PROTOCOL', 'Response exceeds 8 MiB; request fewer results'));
      const end = chunk.indexOf('\n');
      if (end < 0) { chunks.push(chunk); return; }
      chunks.push(chunk.slice(0, end));
      try {
        const response = object(JSON.parse(chunks.join('')));
        if (response.id !== id || typeof response.ok !== 'boolean') throw new Error('Unexpected daemon response');
        finish(undefined, response);
      } catch { finish(new RpcError('PROTOCOL', 'Invalid daemon response')); }
    });
    socket.once('error', error => {
      const missing = 'code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code));
      finish(missing ? new RpcError('NOT_RUNNING', 'Daemon is not running') : error);
    });
    socket.once('end', () => finish(new RpcError('PROTOCOL', 'Daemon closed before returning a result; query the idempotency key before resending')));
  });
}
