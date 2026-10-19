import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { distribution, runWorker } from './benchmark-store-worker.js';

const BASE = '9a7f36297b416a0953983e8bb58a0794c85269f6';
process.umask(0o077);
const args = parseArgs({ options: { worker: { type: 'boolean' }, source: { type: 'string' }, directory: { type: 'string' },
  phase: { type: 'string' }, count: { type: 'string' }, requests: { type: 'string' }, output: { type: 'string' } } }).values;

if (args.worker) {
  assert(args.source && args.directory && args.phase && args.count && args.requests);
  const result = await runWorker(args.source, args.directory, args.phase, Number(args.count), Number(args.requests));
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  const root = process.cwd();
  mkdirSync('.tmp', { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(root, '.tmp', 'store-bench-'));
  async function command(program: string, argv: string[], cwd = root): Promise<string> {
    return new Promise((resolveOutput, reject) => {
      const child = spawn(program, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolveOutput(stdout) : reject(new Error(`${program}: exit ${code}\n${stderr}`)));
    });
  }
  const baseline = join(scratch, 'baseline');
  mkdirSync(join(baseline, 'src'), { recursive: true });
  const files = (await command('git', ['ls-tree', '-r', '--name-only', BASE, '--', 'src'])).trim().split('\n');
  for (const file of files) writeFileSync(join(baseline, file), await command('git', ['show', `${BASE}:${file}`]));
  writeFileSync(join(baseline, 'package.json'), await command('git', ['show', `${BASE}:package.json`]));
  const config = JSON.parse(await command('git', ['show', `${BASE}:tsconfig.json`])) as { include: string[]; compilerOptions: { rootDir?: string } };
  config.include = ['src/**/*.ts'];
  config.compilerOptions.rootDir = '.';
  writeFileSync(join(baseline, 'tsconfig.json'), JSON.stringify(config));
  symlinkSync(join(root, 'node_modules'), join(baseline, 'node_modules'), 'dir');
  await command(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(baseline, 'tsconfig.json')]);
  const candidate = join(root, 'dist/src');
  const worker = fileURLToPath(import.meta.url);
  type WorkerResult = Awaited<ReturnType<typeof runWorker>>;
  async function measure(source: string, directory: string, phase: string, count: number, requests: number) {
    process.stderr.write(`${phase} ${count} ${source === candidate ? 'candidate' : 'baseline'}\n`);
    return JSON.parse(await command(process.execPath, [worker, '--worker', '--source', source, '--directory', directory,
      '--phase', phase, '--count', String(count), '--requests', String(requests)])) as WorkerResult;
  }
  const volumes = [];
  for (const count of [22973, 68919]) {
    const requests = count === 22973 ? 5000 : 15000;
    const variants = [];
    for (const [name, source] of [['baseline', join(baseline, 'dist/src')], ['candidate', candidate]] as const) {
      const directory = join(scratch, `${name}-${count}`);
      const seed = await measure(source, directory, 'seed', count, requests);
      const query = await measure(source, directory, 'query', count, requests);
      const diskBefore = await measure(source, directory, 'disk', count, requests);
      const mutate = await measure(source, directory, 'mutate', count, requests);
      const restart = await measure(source, directory, 'restart', count, requests);
      const diskAfter = await measure(source, directory, 'disk', count, requests);
      variants.push({ name, seed, query, diskBefore, mutate, restart, diskAfter });
      if (name === 'baseline') {
        // Copy only this run's generated, closed SQLite database for an equivalent upgrade timing.
        const upgradeDir = join(scratch, `upgrade-${count}`); mkdirSync(upgradeDir, { mode: 0o700 });
        cpSync(join(directory, 'probe.sqlite'), join(upgradeDir, 'probe.sqlite'));
      }
    }
    const [base, head] = variants;
    assert(base && head);
    assert.equal(base.seed.fixtureHash, head.seed.fixtureHash, 'fixture mismatch');
    for (const phase of ['query', 'restart'] as const) {
      assert.deepEqual(base[phase].measurements?.map(m => [m.name, m.resultCount, m.resultHash]), head[phase].measurements?.map(m => [m.name, m.resultCount, m.resultHash]), 'baseline/candidate result mismatch');
    }
    const upgrade = await measure(candidate, join(scratch, `upgrade-${count}`), 'upgrade', count, requests);
    volumes.push({ count, requests, variants, upgrade });
  }
  const cliStartup = [];
  for (const [name, source] of [['baseline', join(baseline, 'dist/src')], ['candidate', candidate]] as const) {
    const timings = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      const response = JSON.parse(await command(process.execPath, [join(source, 'cli.js'), '--data-dir', join(scratch, 'cli-unused'), 'help'])) as { ok: boolean };
      assert.equal(response.ok, true); timings.push(performance.now() - start);
    }
    cliStartup.push({ name, firstMs: timings[0], subsequentMs: distribution(timings.slice(1)) });
  }
  const report = { baseline: BASE, candidateCommit: (await command('git', ['rev-parse', 'HEAD'])).trim(),
    candidateDiff: (await command('git', ['diff', '--stat'])).trim(), recordedAt: new Date().toISOString(),
    toolchain: { node: process.version, pnpm: (await command('pnpm', ['--version'])).trim(),
      typescript: JSON.parse(readFileSync('node_modules/typescript/package.json', 'utf8')).version as string,
      baileys: JSON.parse(readFileSync('node_modules/baileys/package.json', 'utf8')).version as string, platform: process.platform, arch: process.arch },
    method: { sequential: true, processes: 'new Node per variant/volume/phase; query processes never ingest',
      first: 'first invocation per scenario after Store open; process-cold, OS cache uncontrolled and warmed by seed/previous phases',
      warm: '6 subsequent calls; same order/queries for both; no forced GC',
      memory: 'bytes; processPeakRss is OS high-water including imports, measured in each own process; heap sampled between operations (not a true heap peak)',
      startup: 'CLI help elapsed including Node startup/JSON, separate from direct Store calls; no socket/network/startup claim for daemon',
      disk: 'dbstat allocated pages by table/index; checkpointed DB plus WAL/SHM and writer lock while open; no VACUUM',
      retainedScratch: scratch, fixtureEquivalence: 'SHA256 same seeded messages/requests, query result SHA256 equality asserted for both volumes before/after mutations' },
    volumes, cliStartup };
  const output = resolve(args.output ?? join(scratch, 'report.json'));
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ output, scratch }) + '\n');
}
