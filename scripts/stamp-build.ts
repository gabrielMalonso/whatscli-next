import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const marker = /\/\* @build-fingerprint \*\/ (?:null|"sha256:[a-f0-9]{64}")/g;

/** Fingerprint emitted first-party JS, normalizing the embedded value to avoid self-reference. */
export function stampBuild(directory: string): string {
  const names = readdirSync(directory).filter(name => name.endsWith('.js')).sort();
  const runtimePath = join(directory, 'runtime.js');
  const runtime = readFileSync(runtimePath, 'utf8');
  if ([...runtime.matchAll(marker)].length !== 1) throw new Error('Expected one runtime build fingerprint marker');
  const normalized = runtime.replace(marker, '/* @build-fingerprint */ null');
  const hash = createHash('sha256');
  // Length framing makes file boundaries unambiguous; no paths, times or Git state enter the hash.
  for (const name of names) {
    const bytes = name === 'runtime.js' ? Buffer.from(normalized) : readFileSync(join(directory, name));
    hash.update(JSON.stringify([name, bytes.length]) + '\n');
    hash.update(bytes);
  }
  const fingerprint = `sha256:${hash.digest('hex')}`;
  writeFileSync(runtimePath, normalized.replace(marker, `/* @build-fingerprint */ ${JSON.stringify(fingerprint)}`));
  return fingerprint;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fingerprint = stampBuild(fileURLToPath(new URL('../src/', import.meta.url)));
  process.stdout.write(`Build fingerprint: ${fingerprint}\n`);
}
