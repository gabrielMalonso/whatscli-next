import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { stampedJavaScript } from './stamp-build.js';

const guidance = 'Preserve this candidate; install and build the exact source in a NEW directory, then verify again.';
class BuildVerificationError extends Error {}
function reject(reason: string): never { throw new BuildVerificationError(`${reason}. ${guidance}`); }

/** Compare all compiler output without writing files or importing any emitted application code. */
export function verifyBuild(sourceDirectory: string): { files: number; fingerprint: string } {
  const root = resolve(sourceDirectory);
  const output = join(root, 'dist');
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) reject('Cannot read tsconfig.json');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length || parsed.options.outDir !== output) reject('Expected a valid tsconfig.json with outDir dist');
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  if (ts.getPreEmitDiagnostics(program).length) reject('Source does not pass the installed TypeScript compiler');
  const expected = new Map<string, Buffer>();
  const emission = program.emit(undefined, (path, text, bom) => {
    const name = relative(output, path);
    if (name === '..' || name.startsWith(`..${sep}`)) reject('Compiler output is outside dist');
    expected.set(name, Buffer.from((bom ? '\uFEFF' : '') + text));
  });
  if (emission.emitSkipped || emission.diagnostics.length || !expected.size) reject('Compiler did not emit a complete build');
  const production = new Map([...expected].filter(([name]) => dirname(name) === 'src' && name.endsWith('.js'))
    .map(([name, bytes]) => [name.slice(4), bytes]));
  const stamp = stampedJavaScript(production);
  expected.set(join('src', 'runtime.js'), stamp.runtime);
  const seen = new Set<string>();
  const visit = (directory: string): void => {
    if (!lstatSync(directory).isDirectory()) reject('Build output contains a link or non-directory');
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const key = relative(output, path);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        if (![...expected.keys()].some(file => file.startsWith(key + sep))) reject('Build contains an unexpected directory');
        visit(path);
      } else {
        if (!stat.isFile()) reject('Build contains a link or non-regular file');
        const bytes = expected.get(key);
        if (!bytes) reject('Build contains an unexpected file');
        if (!bytes.equals(readFileSync(path))) reject('Build bytes differ from the current source emission or stamp');
        seen.add(key);
      }
    }
  };
  visit(output);
  if (seen.size !== expected.size) reject('Build is missing compiler output');
  return { files: seen.size, fingerprint: stamp.fingerprint };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) reject('Usage: verify-build.js [SOURCE_DIRECTORY]');
    const result = verifyBuild(process.argv[2] ?? '.');
    process.stdout.write(`Verified build: ${result.files} files; ${result.fingerprint}\n`);
  } catch (error) {
    process.stderr.write(`Build verification failed. ${error instanceof BuildVerificationError ? error.message : guidance}\n`);
    process.exitCode = 1;
  }
}
