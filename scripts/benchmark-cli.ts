import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Command } from '../src/protocol.js';
import { object, parseRequest, RequestError } from '../src/protocol.js';
import { formatResponse } from '../src/response.js';
import { history, pn, publicResponse, uncertain } from '../test/fixtures/responses.js';

const BASE = 'a2d00b2da84e9db09ded1a31829cfa933962f2d4';
const WARM = 10;
process.umask(0o077);
const { values } = parseArgs({ options: { output: { type: 'string' } } });
const root = process.cwd();
mkdirSync('.tmp', { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(root, '.tmp', 'cli-bench-'));
// Unix socket paths must also work in long T3 worktree paths. Retain this fictional directory.
const directory = mkdtempSync(join(tmpdir(), 'wcn-cli-bench-'));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { n: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2, max: sorted.at(-1) };
}
async function run(program: string, args: string[], cwd = root) {
  const start = performance.now();
  return new Promise<{ stdout: string; stderr: string; code: number | null; ms: number }>((done, reject) => {
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => done({ stdout, stderr, code, ms: performance.now() - start }));
  });
}
async function checked(program: string, args: string[]) {
  const result = await run(program, args);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

// Extract only committed source; use the identical installed compiler/dependencies for both builds.
const baseline = join(scratch, 'baseline');
mkdirSync(join(baseline, 'src'), { recursive: true });
const files = (await checked('git', ['ls-tree', '-r', '--name-only', BASE, '--', 'src'])).trim().split('\n');
for (const file of files) writeFileSync(join(baseline, file), await checked('git', ['show', `${BASE}:${file}`]));
writeFileSync(join(baseline, 'package.json'), await checked('git', ['show', `${BASE}:package.json`]));
const config = JSON.parse(await checked('git', ['show', `${BASE}:tsconfig.json`])) as { include: string[]; compilerOptions: { rootDir?: string } };
config.include = ['src/**/*.ts']; config.compilerOptions.rootDir = '.';
writeFileSync(join(baseline, 'tsconfig.json'), JSON.stringify(config));
symlinkSync(join(root, 'node_modules'), join(baseline, 'node_modules'), 'dir');
await checked(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(baseline, 'tsconfig.json')]);
const sources = [join(baseline, 'dist/src'), join(root, 'dist/src')];
const metrics = fileURLToPath(new URL('./benchmark-cli-metrics.js', import.meta.url));
const worker = fileURLToPath(new URL('./benchmark-cli-worker.js', import.meta.url));

type Scenario = { name: string; action: string; args: string[]; response?: Record<string, unknown>; command?: Command; code: number };
function page(count: number, large: boolean) {
  const pattern = 'Fictional São 😀 100%_literal. ';
  const text = large ? pattern.repeat(Math.floor(60000 / Buffer.byteLength(pattern))) : pattern;
  return Array.from({ length: count }, (_, i) => ({ ...history[0]!, id: `fictional-${i}`, text, jid: pn }));
}
const scenarios: Scenario[] = [
  { name: 'help', action: 'help', args: ['help'], code: 0 },
  { name: 'status', action: 'status', args: ['status'], response: publicResponse({ networkEnabled: false }), command: { command: 'status' }, code: 0 },
  ...([['history-20', 20, false], ['history-100', 100, false], ['history-large-20', 20, true], ['history-large-100', 100, true]] as const).map(([name, count, large]) => ({
    name, action: 'messages', args: ['messages', '--jid', pn, '--limit', String(count)], response: publicResponse(page(count, large)),
    command: { command: 'messages', jid: pn, limit: count, offset: 0 } satisfies Command, code: 0,
  })),
  ...([['search-20', 20, false], ['search-large-100', 100, true]] as const).map(([name, count, large]) => ({
    name, action: 'search', args: ['search', '--jid', pn, '--query', 'São 😀 100%_', '--limit', String(count)], response: publicResponse(page(count, large)),
    command: { command: 'search', jid: pn, query: 'São 😀 100%_', limit: count, offset: 0 } satisfies Command, code: 0,
  })),
  { name: 'request', action: 'request', args: ['request', '--key', uncertain.key], response: publicResponse(uncertain), command: { command: 'request', key: uncertain.key }, code: 0 },
  { name: 'client-error', action: 'messages', args: ['messages'], code: 1 },
  { name: 'daemon-validation-error', action: 'messages', args: ['messages', '--jid', pn, '--limit=-1'], code: 1 },
];
let active: Scenario | undefined;
let tail = Buffer.alloc(0);
let connections = 0;
const server = createServer(socket => {
  connections++;
  socket.setEncoding('utf8');
  let input = '';
  socket.on('error', () => {});
  socket.on('data', (chunk: string) => {
    input += chunk;
    if (!input.includes('\n')) return;
    socket.removeAllListeners('data');
    try {
      const request = parseRequest(input.slice(0, input.indexOf('\n')));
      assert(active?.command);
      assert.deepEqual(request.command, active.command);
      socket.write('{"id":' + JSON.stringify(request.id) + ',');
      socket.end(tail);
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      socket.end(JSON.stringify({ id: error.id, ok: false, error: error.message }) + '\n');
    }
  });
});
await new Promise<void>(done => server.listen(join(directory, 'control.sock'), done));

function stable(stdout: string) {
  const { id: _id, ...value } = object(JSON.parse(stdout));
  return value;
}
function select(scenario: Scenario) {
  active = scenario;
  const { id: _id, ...response } = scenario.response ?? {};
  tail = Buffer.from(JSON.stringify(response).slice(1) + '\n');
}
const measurements = [];
try {
  // Each pair alternates order, so all variants/scenarios remain sequential without grouped drift.
  for (const scenario of scenarios) {
    select(scenario);
    for (const mode of ['full', 'compact'] as const) {
      process.stderr.write(`${scenario.name} ${mode}\n`);
      const variants: { ms: number; userMs: number; systemMs: number; peakRssBytes: number }[][] = [[], []];
      let expected: string | undefined;
      let stdoutBytes = 0;
      for (let i = 0; i <= WARM; i++) for (const variant of i % 2 ? [1, 0] : [0, 1]) {
        const before = connections;
        const result = await run(process.execPath, ['--import', metrics, join(sources[variant]!, 'cli.js'), '--data-dir', directory, ...scenario.args, '--output', mode]);
        assert.equal(result.code, scenario.code, result.stderr);
        assert.equal(connections - before, scenario.command || scenario.name === 'daemon-validation-error' ? 1 : 0);
        assert.equal(result.stdout.trim().split('\n').length, 1);
        const stderr = result.stderr.trim().split('\n');
        assert.equal(stderr.length, 1, result.stderr);
        assert(stderr[0]!.startsWith('WHATSCLI_BENCH_METRICS '), result.stderr);
        const usage = JSON.parse(stderr[0]!.slice('WHATSCLI_BENCH_METRICS '.length)) as { userMs: number; systemMs: number; peakRssBytes: number };
        const payload = stable(result.stdout);
        const digest = hash(JSON.stringify(payload));
        expected ??= digest;
        assert.equal(digest, expected, 'base/candidate output mismatch');
        if (scenario.response) {
          const { id: _id, ...response } = formatResponse(scenario.action, scenario.response, mode, pn);
          assert.deepEqual(payload, response);
        }
        stdoutBytes = Buffer.byteLength(result.stdout);
        variants[variant]!.push({ ms: result.ms, ...usage });
      }
      measurements.push({ scenario: scenario.name, mode, stdoutBytes, resultHash: expected,
        wireBytes: scenario.response ? Buffer.byteLength('{"id":"' + '0'.repeat(36) + '",') + tail.length : null,
        variants: variants.map((runs, i) => ({ name: i ? 'candidate' : 'baseline', first: runs[0], warm: {
          ms: distribution(runs.slice(1).map(r => r.ms)), userMs: distribution(runs.slice(1).map(r => r.userMs)),
          systemMs: distribution(runs.slice(1).map(r => r.systemMs)), peakRssBytes: distribution(runs.slice(1).map(r => r.peakRssBytes)),
        }, samples: runs })) });
    }
  }
  const rawRpc = [];
  for (const scenario of scenarios.filter(s => ['status', 'history-20', 'history-large-20', 'history-large-100'].includes(s.name))) {
    assert(scenario.command); select(scenario);
    const variants = [];
    for (const [i, source] of sources.entries()) {
      const runs = JSON.parse(await checked(process.execPath, [worker, join(source, 'rpc.js'), directory, JSON.stringify(scenario.command)])) as {
        ms: number; userMs: number; systemMs: number; peakRssBytes: number; hash: string;
      }[];
      const { id: _id, ...expected } = scenario.response!;
      for (const run of runs) assert.equal(run.hash, hash(JSON.stringify(expected)));
      variants.push({ name: i ? 'candidate' : 'baseline', first: runs[0], warm: {
        ms: distribution(runs.slice(1).map(r => r.ms)), userMs: distribution(runs.slice(1).map(r => r.userMs)),
        systemMs: distribution(runs.slice(1).map(r => r.systemMs)), peakRssBytes: distribution(runs.slice(1).map(r => r.peakRssBytes)),
      }, samples: runs });
    }
    rawRpc.push({ scenario: scenario.name, variants });
  }
  const startup = [];
  for (const [name, code] of [
    ['node-empty', ''], ['protocol-import', 'await import(' + JSON.stringify(join(sources[1]!, 'protocol.js')) + ')'],
    ['rpc-import', 'await import(' + JSON.stringify(join(sources[1]!, 'rpc.js')) + ')'],
  ]) {
    const samples = [];
    for (let i = 0; i <= WARM; i++) {
      const result = await run(process.execPath, ['--import', metrics, '--input-type=module', '-e', code!]);
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, '');
      const usage = JSON.parse(result.stderr.trim().slice('WHATSCLI_BENCH_METRICS '.length)) as { userMs: number; systemMs: number; peakRssBytes: number };
      samples.push({ ms: result.ms, ...usage });
    }
    startup.push({ name, first: samples[0], warmMs: distribution(samples.slice(1).map(r => r.ms)), samples });
  }
  assert.deepEqual(readdirSync(directory), ['control.sock'], 'the fake server must create no database or writer lock');
  const report = { baseline: BASE, candidateCommit: (await checked('git', ['rev-parse', 'HEAD'])).trim(),
    candidateDiff: (await checked('git', ['diff', '--stat'])).trim(), recordedAt: new Date().toISOString(),
    sourceHashes: sources.map((source, i) => ({ name: i ? 'candidate' : 'baseline', files: Object.fromEntries(files.map(file => {
      const js = file.replace(/^src\//, '').replace(/\.ts$/, '.js');
      return [js, hash(readFileSync(join(source, js), 'utf8'))];
    })) })),
    toolchain: { node: process.version, pnpm: (await checked('pnpm', ['--version'])).trim(),
      typescript: JSON.parse(readFileSync('node_modules/typescript/package.json', 'utf8')).version as string,
      baileys: JSON.parse(readFileSync('node_modules/baileys/package.json', 'utf8')).version as string, platform: process.platform, arch: process.arch },
    method: { sequential: true, warmN: WARM, first: 'First process per scenario/variant, not cold disk. OS cache uncontrolled, warmed by build/prior scenarios.',
      cli: 'New Node processes, same exit-metrics preload; elapsed includes startup, RPC, formatting, stdout captured through exit. Alternating variant order.',
      metrics: 'Each CLI reports own process.resourceUsage at exit: CPU microseconds converted to ms; maxRSS KiB converted to bytes. No sampled heap peak.',
      fake: 'One fictional Unix socket server, authoritative parseRequest, fixed public fixture envelopes. Preencoded body, fresh correlated UUID prefix. No Store, runtime, SDK connection or WhatsApp.',
      raw: 'New process per scenario/variant. RPC time and CPU measured after imports; first + 10 sequential calls. RSS high-water includes imports and prior result hashing. No CLI formatting/stdout body.',
      limits: 'Fake transport isolates response assembly, not daemon/Store/network performance. All RAM effects are transient clients; persistent daemon RAM/disk/ingestion unchanged by this scope.',
      equivalence: 'Every CLI output and raw result SHA256 asserted across variants after removing only random RPC id; also compared with expected full/compact public fixture.',
      scratch, fictionalSocketDirectory: directory }, startup, measurements, rawRpc };
  const output = resolve(values.output ?? join(scratch, 'report.json'));
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ output, scratch, directory }) + '\n');
} finally {
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
assert(!existsSync(join(directory, 'control.sock')), 'fake server must release its own socket');
