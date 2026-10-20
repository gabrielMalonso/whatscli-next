import { randomBytes, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { resolve as resolvePath } from 'node:path';
import { object } from './protocol.js';
import type { Command } from './protocol.js';
import { socketPath } from './paths.js';
import { CommandError, errorResponse } from './errors.js';
import {
  checkAncestors,
  checkPrivatePath,
  isMissing,
} from './private-paths.js';
import { Observability, obsCode } from './observability.js';
import {
  commandFields,
  resultFields,
  wireFields,
} from './observability-context.js';

export class RpcError extends CommandError {
  constructor(
    readonly code: 'NOT_RUNNING' | 'TIMEOUT' | 'PROTOCOL',
    message: string,
  ) {
    super(code, message);
  }
}

/** One command per connection. A timeout never causes an automatic command retry. */
export async function rpc(
  directory: string,
  command: Command,
  timeoutMs = 120000,
  context?: { observer: Observability; root: string },
  capture = true,
): Promise<Record<string, unknown>> {
  const id = context
    ? `${context.root}.${randomBytes(16).toString('hex')}`
    : randomUUID();
  const started = performance.now();
  const bytes = { requestBytes: 0, responseBytes: 0 };
  let response: Record<string, unknown> | undefined;
  let code = 'UNKNOWN';
  try {
    response = await exchange(directory, command, timeoutMs, id, bytes);
    code = response.ok ? 'OK' : obsCode(response.code);
    return response;
  } catch (error) {
    code = errorResponse(error).code;
    throw error;
  } finally {
    // Operational endpoint admission happens before optional preference I/O.
    const observer = context?.observer ?? new Observability(directory, 'rpc');
    if (capture)
      observer.record(
        'transport',
        {
          ...commandFields(observer, command),
          ...wireFields(observer, id),
          ...resultFields(response?.data),
          ...bytes,
          durationMs: performance.now() - started,
          ok: response?.ok === true,
          code,
        },
        'rpc',
      );
  }
}

async function exchange(
  directory: string,
  command: Command,
  timeoutMs: number,
  id: string,
  bytesObserved: { requestBytes: number; responseBytes: number },
): Promise<Record<string, unknown>> {
  directory = resolvePath(directory);
  const path = socketPath(directory);
  try {
    checkAncestors(directory);
    checkPrivatePath(directory, 'directory');
    checkPrivatePath(path, 'socket');
  } catch (error) {
    if (isMissing(error)) {
      // Check remaining existing ancestors, but never promote a missing namespace
      // into a requestable endpoint if something appears during that inspection.
      checkAncestors(directory, undefined, true);
      throw new RpcError('NOT_RUNNING', 'Daemon is not running');
    }
    throw error;
  }
  const line = JSON.stringify({ ...command, id }) + '\n';
  if (Buffer.byteLength(line) > 131072)
    throw new CommandError('INVALID_ARGUMENT', 'Request exceeds 128 KiB');
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const chunks: string[] = [];
    let bytes = 0;
    let completed = false;
    const finish = (
      error?: Error,
      response?: Record<string, unknown>,
    ): void => {
      if (completed) return;
      completed = true;
      bytesObserved.responseBytes = socket.bytesRead;
      socket.destroy();
      if (error) reject(error);
      else if (response) resolve(response);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () =>
      finish(
        new RpcError(
          'TIMEOUT',
          command.command === 'backup'
            ? 'Backup response timed out; work may continue. Inspect backup.json in the requested directory before choosing a NEW output directory'
            : 'Daemon response timed out; query the idempotency key before considering another send',
        ),
      ),
    );
    socket.once('connect', () => {
      socket.write(line);
      bytesObserved.requestBytes = Buffer.byteLength(line);
    });
    socket.on('data', (chunk: string) => {
      if (completed) return;
      // Inspect each decoded fragment once; flatten the response only when its line is complete.
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024)
        return finish(
          new RpcError(
            'PROTOCOL',
            'Response exceeds 8 MiB; request fewer results',
          ),
        );
      const end = chunk.indexOf('\n');
      if (end < 0) {
        chunks.push(chunk);
        return;
      }
      chunks.push(chunk.slice(0, end));
      try {
        const response = object(JSON.parse(chunks.join('')));
        if (response.id !== id || typeof response.ok !== 'boolean')
          throw new Error('Unexpected daemon response');
        finish(undefined, response);
      } catch {
        finish(new RpcError('PROTOCOL', 'Invalid daemon response'));
      }
    });
    socket.once('error', (error) => {
      const missing =
        'code' in error &&
        ['ENOENT', 'ECONNREFUSED'].includes(String(error.code));
      finish(
        missing ? new RpcError('NOT_RUNNING', 'Daemon is not running') : error,
      );
    });
    socket.once('end', () =>
      finish(
        new RpcError(
          'PROTOCOL',
          'Daemon closed before returning a result; query the idempotency key before resending',
        ),
      ),
    );
  });
}
