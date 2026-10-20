import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const marker = /\/\* @build-fingerprint \*\/ (?:null|"sha256:[a-f0-9]{64}")/g;

/** Compute the stamp without I/O, also used to compare an in-memory compiler emission. */
export function stampedJavaScript(files: ReadonlyMap<string, Buffer>): { fingerprint: string; runtime: Buffer } {
  const runtime = files.get('runtime.js')?.toString('utf8') ?? '';
  if ([...runtime.matchAll(marker)].length !== 1) throw new Error('Expected one runtime build fingerprint marker');
  const normalized = runtime.replace(marker, '/* @build-fingerprint */ null');
  const hash = createHash('sha256');
  // Length framing makes file boundaries unambiguous; no paths, times or Git state enter the hash.
  for (const [name, original] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const bytes = name === 'runtime.js' ? Buffer.from(normalized) : original;
    hash.update(JSON.stringify([name, bytes.length]) + '\n');
    hash.update(bytes);
  }
  const fingerprint = `sha256:${hash.digest('hex')}`;
  return { fingerprint, runtime: Buffer.from(normalized.replace(marker, `/* @build-fingerprint */ ${JSON.stringify(fingerprint)}`)) };
}

/** Fingerprint emitted first-party JS, normalizing the embedded value to avoid self-reference. */
export function stampBuild(directory: string): string {
  const files = new Map(readdirSync(directory).filter(name => name.endsWith('.js'))
    .map(name => [name, readFileSync(join(directory, name))]));
  const stamped = stampedJavaScript(files);
  writeFileSync(join(directory, 'runtime.js'), stamped.runtime);
  return stamped.fingerprint;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fingerprint = stampBuild(fileURLToPath(new URL('../src/', import.meta.url)));
  process.stdout.write(`Build fingerprint: ${fingerprint}\n`);
}
