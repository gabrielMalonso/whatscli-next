import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CommandError } from './errors.js';

export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Read one bounded immutable byte snapshot, so persisted hashes describe the actual send. */
export async function prepareFile(path: string) {
  if (!isAbsolute(path)) throw new CommandError('INVALID_ARGUMENT', 'File path must be absolute');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new CommandError('INVALID_ARGUMENT', 'Expected a regular file up to 64 MiB');
    const buffer = await file.readFile();
    if (buffer.length > MAX_FILE_BYTES) throw new CommandError('PRECONDITION_FAILED', 'File grew beyond the 64 MiB limit');
    return { buffer, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
  } finally { await file.close(); }
}

/** Never overwrite output. Failed/partial files remain private and are identified in the error. */
export async function saveMedia(path: string, source: () => Promise<Readable>, maxBytes = MAX_FILE_BYTES) {
  if (!isAbsolute(path)) throw new CommandError('INVALID_ARGUMENT', 'Output path must be absolute');
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const stream = await source();
    const bound = new Transform({ transform(chunk: Buffer, _encoding, next) {
      bytes += chunk.length;
      if (bytes > maxBytes) { next(new Error('Media exceeds the download limit')); return; }
      hash.update(chunk);
      next(null, chunk);
    } });
    await pipeline(stream, bound, file.createWriteStream());
    return { path, bytes, sha256: hash.digest('hex') };
  } catch (cause) {
    throw new CommandError('UNKNOWN', 'Download failed; partial file preserved at the requested output path', { cause });
  } finally { await file.close(); }
}
