import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Store } from '../src/store.js';
import { configureObservability } from '../src/observability.js';

const run = promisify(execFile);
process.umask(0o077);
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wobs-bench-')));
const metrics = resolve('dist/scripts/benchmark-observability-metrics.js');
const jid = '123450001@lid';
const scenarios = [
  { name: 'small', args: ['chats', '--limit', '10'] },
  { name: 'history-100', args: ['messages', '--jid', jid, '--limit', '100'] },
  {
    name: 'search-100',
    args: ['search', '--query', 'fictional', '--limit', '100'],
  },
  { name: 'error', args: ['messages', '--jid', jid, '--limit=-1'] },
  {
    name: 'replay',
    args: [
      'send',
      '--jid',
      jid,
      '--key',
      'fictional-key',
      '--text',
      'fictional intent',
    ],
  },
];
type Metrics = {
  userMs: number;
  systemMs: number;
  rssBytes: number;
  heapBytes: number;
};
function metric(stderr: string): Metrics {
  const line = stderr.split('\n').find((line) => line.startsWith('OBS_BENCH '));
  assert.ok(line);
  return JSON.parse(line.slice(10)) as Metrics;
}
async function command(directory: string, ...args: string[]) {
  const started = performance.now();
  let stdout: string;
  let stderr: string;
  let code = 0;
  try {
    ({ stdout, stderr } = await run(
      process.execPath,
      [
        '--import',
        metrics,
        'dist/src/cli.js',
        '--data-dir',
        directory,
        ...args,
      ],
      { maxBuffer: 8 * 1024 * 1024, timeout: 15000 },
    ));
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('stdout' in error) ||
      typeof error.stdout !== 'string' ||
      !('stderr' in error) ||
      typeof error.stderr !== 'string'
    )
      throw error;
    stdout = error.stdout;
    stderr = error.stderr;
    code = 1;
  }
  const ms = performance.now() - started;
  const {
    id: _id,
    pid: _pid,
    ...result
  } = JSON.parse(stdout) as Record<string, unknown>;
  return {
    ms,
    ...metric(stderr),
    bytes: Buffer.byteLength(stdout),
    code,
    hash: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  };
}
const rows = [];
const daemons = [];
const expected = new Map<string, string>();
for (const enabled of [false, true]) {
  const directory = join(fixtureRoot, enabled ? 'on' : 'off');
  const store = new Store(directory);
  store.observeChat({ id: jid, unreadCount: 0, archived: false });
  store.transaction(() => {
    for (let index = 0; index < 300; index++)
      store.observeMessage({
        key: { remoteJid: jid, id: `fictional-${index}`, fromMe: false },
        messageTimestamp: index + 1,
        message: { conversation: 'fictional '.repeat(200) + index },
      });
    store.saveRequest({
      key: 'fictional-key',
      operation: { kind: 'send', jid, text: 'fictional intent' },
      messageId: 'FICTIONAL_OUTGOING_ID',
      attempt: 'uncertain',
      acceptance: 'unknown',
      delivery: 'unknown',
      read: 'unknown',
      errorObserved: true,
    });
    store.db.exec('UPDATE chats SET observed_at=1700000000000');
  });
  store.close();
  if (enabled) configureObservability(directory, true);
  const daemon = spawn(
    process.execPath,
    [
      '--import',
      metrics,
      'dist/src/daemon.js',
      '--offline',
      '--data-dir',
      directory,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const exited = once(daemon, 'exit');
  let daemonStderr = '';
  daemon.stderr.on('data', (data) => {
    daemonStderr += String(data);
  });
  try {
    for (
      let i = 0;
      i < 100 && !existsSync(join(directory, 'control.sock'));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(join(directory, 'control.sock')));
    for (const scenario of scenarios)
      for (const output of ['full', 'compact']) {
        const samples = [];
        for (let index = 0; index < 6; index++) {
          const sample = await command(
            directory,
            ...scenario.args,
            '--output',
            output,
          );
          const key = scenario.name + output;
          const prior = expected.get(key);
          if (prior) assert.equal(sample.hash, prior);
          else expected.set(key, sample.hash);
          samples.push(sample);
        }
        const { hash, code, bytes } = samples[0]!;
        rows.push({
          enabled,
          scenario: scenario.name,
          output,
          hash,
          code,
          bytes,
          first: samples[0],
          subsequent: samples.slice(1),
        });
      }
  } finally {
    await command(directory, 'stop');
    assert.deepEqual(await exited, [0, null]);
  }
  const root = join(directory, 'observability');
  daemons.push({
    enabled,
    ...metric(daemonStderr),
    files: existsSync(root) ? readdirSync(root).length : 0,
    telemetryBytes: existsSync(root)
      ? readdirSync(root).reduce(
          (sum, file) => sum + statSync(join(root, file)).size,
          0,
        )
      : 0,
  });
}
// Focused retention + sampler cost, separate from the CLI/daemon comparison above.
const maintenance = await run(process.execPath, [
  '--import',
  metrics,
  '--input-type=module',
  '-e',
  String.raw`
  import assert from 'node:assert/strict';
  import { configureObservability, Observability, queryObservability, OBS_LIMITS } from './dist/src/observability.js';
  import { observeProcess } from './dist/src/observability-runtime.js';
  import { mkdirSync, readdirSync, statSync } from 'node:fs';
  import { join } from 'node:path';
  const day = 86400000;
  const directory = process.argv[1]; mkdirSync(directory, {mode:0o700});
  configureObservability(directory, true);
  let now = Math.floor(Date.now()/day)*day-day+day/2;
  const observer = new Observability(directory, 'runtime', () => now);
  const sample = {elapsedMs:60000,cpuUserUs:0,cpuSystemUs:0,rssBytes:104857600,heapBytes:52428800,lagMs:0};
  const volumeRoot = join(directory,'observability');
  const cpu = process.cpuUsage(); const started = performance.now();
  let writes=0; let state=observer.status();
  while(state.evicted<4 && writes<40000) {
    for(let i=0;i<64;i++) { observer.record('sample',sample); now++; writes++; }
    state=observer.status();
  }
  const volumeMs=performance.now()-started;
  const volumeFiles=readdirSync(volumeRoot);
  const volumeBytes=volumeFiles.reduce((sum,name)=>sum+statSync(join(volumeRoot,name)).size,0);
  assert.equal(volumeFiles.length,OBS_LIMITS.segments); assert.ok(state.evicted>=4);
  assert.equal(state.dropped,0); assert.ok(volumeBytes<=OBS_LIMITS.bytes);
  const volume={writes,ms:volumeMs,files:volumeFiles.length,bytes:volumeBytes,evicted:state.evicted};
  now += 6*day; const expiryStart=performance.now(); observer.maintain();
  const expiryMs = performance.now()-expiryStart;
  assert.equal(readdirSync(volumeRoot).length,0);
  const sparseDirectory=directory+'-sparse'; mkdirSync(sparseDirectory,{mode:0o700});
  configureObservability(sparseDirectory,true);
  let sparseTime=Date.now()-4*day;
  const sparseObserver=new Observability(sparseDirectory,'runtime',()=>sparseTime);
  const sparseStart=performance.now();
  for(let i=0;i<186;i++) { sparseObserver.record('sample',sample); sparseTime+=31*60000; }
  const sparseMs=performance.now()-sparseStart;
  const retained=queryObservability(sparseDirectory,{limit:500}).records;
  const sparseRoot=join(sparseDirectory,'observability'); const sparseFiles=readdirSync(sparseRoot);
  const sparseBytes=sparseFiles.reduce((sum,name)=>sum+statSync(join(sparseRoot,name)).size,0);
  assert.equal(retained.length,186); assert.equal(sparseObserver.status().evicted,0);
  const sparse={writes:186,retained:retained.length,ms:sparseMs,files:sparseFiles.length,bytes:sparseBytes,
    oldestHours:(Date.now()-Date.parse(retained[0].timestamp))/3600000,evicted:sparseObserver.status().evicted};
  now = Date.now();
  const sampler = observeProcess(observer, 10);
  await new Promise(resolve=>setTimeout(resolve,65)); sampler.stop();
  const used=process.cpuUsage(cpu);
  process.stdout.write(JSON.stringify({volume,expiryMs,sparse,userMs:used.user/1000,systemMs:used.system/1000,
    rssBytes:process.memoryUsage.rss(),samples:queryObservability(directory,{}).records.filter(r=>r.category==='sample').length,
    status:observer.status()})+'\n');
`,
  join(fixtureRoot, 'maintenance'),
]);
const maintenanceResult = JSON.parse(maintenance.stdout) as {
  status: { directory?: string };
};
delete maintenanceResult.status.directory;
const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  method: {
    variants:
      'OFF absent preference then ON, sequential; one fresh offline daemon per variant; 300 fictional 2KB messages and one durable uncertain intent',
    calls:
      'one first + five subsequent fresh CLI processes per scenario/mode; CPU totals include Node/imports; wall includes process + socket + formatting + optional telemetry drain',
    memory:
      'current RSS/heap at child exit; no resourceUsage.maxRSS, GC, cold-cache or peak claim',
    equivalence:
      'SHA256 of public response excluding randomized wire id and daemon PID; status excluded due explicit observability diagnostics',
    maintenance:
      'separate fresh process: real sample-shaped writes within one UTC day until four file-cap evictions (40k safety bound, counters polled every 64 writes), whole-day TTL expiry, 186 sparse samples across four days, then ~65ms of 10ms sampler ticks; production 60s',
  },
  rows,
  daemons,
  maintenance: {
    ...maintenanceResult,
    childMetrics: metric(maintenance.stderr),
  },
};
const out = process.argv[2] ?? '.tmp/observability-results.json';
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(
  JSON.stringify({
    report: out,
    retainedFictionalState: fixtureRoot,
    equivalent: true,
    rows: rows.length,
  }) + '\n',
);
