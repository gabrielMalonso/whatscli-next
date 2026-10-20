import { CommandError } from './errors.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function dataDirectory(value?: string): string {
  if (value) return resolve(value);
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'whatscli-next')
    : join(
        process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
        'whatscli-next',
      );
}

export function socketPath(directory: string): string {
  const path = join(directory, 'control.sock');
  if (Buffer.byteLength(path) > 100)
    throw new CommandError(
      'INVALID_ARGUMENT',
      'Unix socket path is too long; use a shorter --data-dir (socket path limit: 100 bytes)',
    );
  return path;
}
