import { CommandError } from './errors.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function dataDirectory({
  path,
  account,
}: {
  path?: string | undefined;
  account?: string | undefined;
} = {}): string {
  if (path !== undefined && account !== undefined)
    throw new CommandError(
      'INVALID_ARGUMENT',
      '--account and --data-dir cannot be combined',
    );
  if (
    account !== undefined &&
    (account.length > 32 ||
      !/^[a-zA-Z0-9]/.test(account) ||
      /[^a-zA-Z0-9_-]/.test(account))
  )
    throw new CommandError(
      'INVALID_ARGUMENT',
      '--account must be 1-32 ASCII letters, digits, hyphens or underscores, starting with a letter or digit',
    );
  if (path !== undefined) {
    if (!path)
      throw new CommandError(
        'INVALID_ARGUMENT',
        '--data-dir must not be empty',
      );
    return resolve(path);
  }
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'whatscli-next')
      : join(
          process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
          'whatscli-next',
        );
  return account === undefined
    ? base
    : join(base, 'accounts', account.toLowerCase());
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
