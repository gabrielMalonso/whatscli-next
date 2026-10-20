import { lstatSync, mkdirSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CommandError } from './errors.js';

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Trust the whole namespace before creating/opening private state. The owning UID/root
 * remain trusted; these checks do not isolate processes running as either of them.
 */
export function checkAncestors(
  path: string,
  inspect: (path: string) => Stats = lstatSync,
  allowMissing = false,
): void {
  for (let ancestor = resolve(path); ; ancestor = dirname(ancestor)) {
    let stat: Stats | undefined;
    try {
      stat = inspect(ancestor);
    } catch (error) {
      if (!allowMissing || !isMissing(error)) throw error;
    }
    if (stat) {
      const sharedTemporary = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
        ((stat.mode & 0o022) !== 0 && !sharedTemporary)
      ) {
        throw new CommandError(
          'PRECONDITION_FAILED',
          'Private state ancestors must belong to the runtime user or root, without symlinks or unsafe write permissions; choose a canonical trusted path',
        );
      }
    }
    if (dirname(ancestor) === ancestor) break;
  }
}

export function checkPrivatePath(
  path: string,
  kind?: 'directory' | 'file' | 'socket',
): Stats {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (kind === 'directory' && !stat.isDirectory()) ||
    (kind === 'file' && !stat.isFile()) ||
    (kind === 'socket' && !stat.isSocket())
  ) {
    throw new CommandError(
      'PRECONDITION_FAILED',
      'Expected an owned private path (directory 0700 / file or socket 0600) of the correct type; existing content was preserved',
    );
  }
  return stat;
}

export function ensurePrivateDirectory(directory: string): void {
  directory = resolve(directory);
  const missing: string[] = [];
  let parent = directory;
  for (;;) {
    try {
      lstatSync(parent);
      break;
    } catch (error) {
      if (!isMissing(error) || dirname(parent) === parent) throw error;
    }
    missing.push(parent);
    parent = dirname(parent);
  }
  checkAncestors(parent);
  for (const path of missing.reverse()) {
    // A missing component can be claimed by another UID under a sticky parent.
    // Nonrecursive mkdir never follows that claim; validate EEXIST before descending.
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
    }
    checkPrivatePath(path, 'directory');
  }
  checkAncestors(directory);
  checkPrivatePath(directory, 'directory');
}
