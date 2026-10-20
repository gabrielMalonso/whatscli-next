import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { CommandError } from './errors.js';

/** The manifest describes the verified artifact, never later counts from the live Store. */
export type BackupResult = {
  state: 'complete'; scope: 'sqlite-only'; sensitive: true;
  directory: string; path: string; manifestPath: string;
  bytes: number; sha256: string; schemaVersion: number; integrity: 'ok';
  startedAt: number; verifiedAt: number;
  excluded: string[];
};

function privatePath(path: string, kind: 'directory' | 'file') {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== (kind === 'directory' ? 0o700 : 0o600)
    || !(kind === 'directory' ? stat.isDirectory() : stat.isFile())) {
    throw new CommandError('PRECONDITION_FAILED', 'Backup paths must be owned, private directories (0700) and regular files (0600) without symlinks');
  }
  return stat;
}

function checkParent(path: string): void {
  privatePath(path, 'directory');
  // A private leaf cannot protect against an ancestor another user can replace.
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    const stat = lstatSync(ancestor);
    const sharedTemporary = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.mode & 0o022) !== 0 && !sharedTemporary)) {
      throw new CommandError('PRECONDITION_FAILED', 'Backup ancestors must be directories without symlinks or unsafe write permissions');
    }
    if (dirname(ancestor) === ancestor) break;
  }
}

/** Runtime-owned SQLite online backup. Only backup.json publishes successful verification.
 * Failed output stays private in the newly reserved directory; nothing is removed or reused.
 */
export async function createBackup(source: DatabaseSync, directory: string, copy = backup): Promise<BackupResult> {
  if (!isAbsolute(directory) || resolve(directory) !== directory || directory.includes('\0')) {
    throw new CommandError('INVALID_ARGUMENT', 'Backup output must be an absolute normalized NEW directory path');
  }
  if (source.isTransaction) throw new CommandError('PRECONDITION_FAILED', 'Backup requires a committed SQLite state');
  try {
    checkParent(dirname(directory));
    mkdirSync(directory, { mode: 0o700 }); // Exclusive reservation, including dangling symlinks.
  } catch (cause) {
    if (cause instanceof CommandError) throw cause;
    if (cause instanceof Error && 'code' in cause && cause.code === 'EEXIST') {
      throw new CommandError('PRECONDITION_FAILED', 'Backup output already exists; choose a NEW directory', { cause });
    }
    throw new CommandError('LOCAL_STATE', 'Backup directory could not be reserved; existing content was preserved', { cause });
  }
  const path = join(directory, 'probe.sqlite');
  const manifestPath = join(directory, 'backup.json');
  const startedAt = Date.now();
  try {
    const ownedDirectory = privatePath(directory, 'directory');
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const reserved = fstatSync(fd);
    closeSync(fd);
    privatePath(path, 'file');
    await copy(source, path);
    const currentDirectory = privatePath(directory, 'directory');
    const current = privatePath(path, 'file');
    if (currentDirectory.ino !== ownedDirectory.ino || currentDirectory.dev !== ownedDirectory.dev
      || current.ino !== reserved.ino || current.dev !== reserved.dev || current.nlink !== 1) throw new Error('Backup output changed');

    // The online backup retains WAL mode. Convert ONLY the artifact to a standalone
    // rollback-journal DB; no source checkpoint, VACUUM, logical rewrite or rowid change.
    const artifact = new DatabaseSync(path);
    let schemaVersion: number;
    try {
      if (artifact.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete') throw new Error('Backup is not standalone');
      const rows = artifact.prepare('PRAGMA integrity_check').all();
      if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') throw new Error('Backup integrity check failed');
      schemaVersion = Number(artifact.prepare('PRAGMA user_version').get()?.user_version);
      if (schemaVersion !== 1) throw new Error('Unsupported backup schema');
    } finally { artifact.close(); }

    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes = 0;
    const hash = createHash('sha256');
    try {
      const stat = await file.stat();
      if (stat.ino !== reserved.ino || stat.dev !== reserved.dev) throw new Error('Backup output changed');
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Expected backup bytes');
        bytes += chunk.length; hash.update(chunk);
      }
      if (bytes !== stat.size) throw new Error('Backup size changed');
      await file.sync();
    } finally { await file.close(); }
    const result: BackupResult = {
      state: 'complete', scope: 'sqlite-only', sensitive: true, directory, path, manifestPath,
      bytes, sha256: hash.digest('hex'), schemaVersion, integrity: 'ok', startedAt, verifiedAt: Date.now(),
      excluded: ['execution-lock', 'socket', 'logs', 'pairing-images', 'external-files'],
    };
    const pending = join(directory, 'backup.pending.json');
    const manifest = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(manifest, JSON.stringify(result) + '\n'); fsyncSync(manifest); }
    finally { closeSync(manifest); }
    privatePath(pending, 'file');
    const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
    // Atomic no-overwrite publication, last: interruption before this is incomplete.
    // Retain the pending name (same inode, no second copy) instead of cleanup on failure.
    linkSync(pending, manifestPath);
    return result;
  } catch (cause) {
    throw new CommandError('LOCAL_STATE', 'Backup did not complete; private partial output was preserved at the requested directory. Without backup.json it is incomplete; choose a NEW directory for another attempt', { cause });
  }
}
