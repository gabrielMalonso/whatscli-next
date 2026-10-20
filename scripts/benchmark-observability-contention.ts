import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import {
  configureObservability,
  queryObservability,
} from '../src/observability.js';
import { Store } from '../src/store.js';

// Same bounded workload runs on the baseline and final sources; all state is fictional.
process.umask(0o077);
const run = promisify(execFile);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'wobs-cost-')));
const hook = resolve('dist/test/fixtures/observability-benchmark-hooks.js');
type Metrics = {
  userMs: number;
  systemMs: number;
  rssBytes: number;
  dropped: number;
};
function metrics(stderr: string): Metrics {
  const line = stderr.split('\n').find((line) => line.startsWith('OBS_BENCH '));
  assert.ok(line, stderr);
  return JSON.parse(line.slice(10)) as Metrics;
}
const expected = new Map<string, string>();
async function command(directory: string, args: string[], compare = true) {
  const start = performance.now();
  const { stdout, stderr } = await run(
    process.execPath,
    ['--import', hook, 'dist/src/cli.js', '--data-dir', directory, ...args],
    { timeout: 15000 },
  );
  const ms = performance.now() - start;
  const {
    id: _id,
    pid: _pid,
    ...result
  } = JSON.parse(stdout) as Record<string, unknown>;
  const hash = createHash('sha256')
    .update(JSON.stringify(result))
    .digest('hex');
  if (compare) {
    const key = args.join(' ');
    const prior = expected.get(key);
    if (prior) assert.equal(hash, prior);
    else expected.set(key, hash);
  }
  return { ms, bytes: Buffer.byteLength(stdout), hash, ...metrics(stderr) };
}
const scenarios = [
  {
    name: 'sequential-replay',
    width: 1,
    args: [
      'send',
      '--jid',
      '123450001@lid',
      '--key',
      'fictional-key',
      '--text',
      'fictional intent',
    ],
  },
  {
    name: 'concurrent-search',
    width: 4,
    args: ['search', '--query', 'fictional', '--limit', '10'],
  },
];
const rows = [];
for (const enabled of [false, true]) {
  for (const scenario of scenarios) {
    const directory = join(root, `${enabled}-${scenario.name}`);
    const store = new Store(directory);
    store.observeChat({ id: '123450001@lid' });
    for (let index = 0; index < 30; index++)
      store.observeMessage({
        key: {
          remoteJid: '123450001@lid',
          id: `fictional-${index}`,
          fromMe: false,
        },
        messageTimestamp: index + 1,
        message: { conversation: 'fictional '.repeat(200) + index },
      });
    store.saveRequest({
      key: 'fictional-key',
      operation: {
        kind: 'send',
        jid: '123450001@lid',
        text: 'fictional intent',
      },
      messageId: 'FICTIONAL_OUTGOING_ID',
      attempt: 'uncertain',
      acceptance: 'unknown',
      delivery: 'unknown',
      read: 'unknown',
      errorObserved: true,
    });
    store.close();
    if (enabled) configureObservability(directory, true);
    const daemon = spawn(
      process.execPath,
      [
        '--import',
        hook,
        'dist/src/daemon.js',
        '--offline',
        '--data-dir',
        directory,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
    );
    const exited = once(daemon, 'close');
    let stderr = '';
    assert.ok(daemon.stderr);
    daemon.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const ready = daemon.stdio[3];
    assert.ok(ready);
    // Runtime startup observation precedes socket listen; protocol status admits readiness.
    await once(ready, 'data');
    await command(directory, ['status'], false);
    const start = performance.now();
    const samples = [];
    try {
      for (let batch = 0; batch < 4; batch++)
        samples.push(
          ...(await Promise.all(
            Array.from({ length: scenario.width }, () =>
              command(directory, scenario.args),
            ),
          )),
        );
    } finally {
      await command(directory, ['stop'], false);
      assert.deepEqual(await exited, [0, null]);
    }
    const area = join(directory, 'observability');
    const files = existsSync(area) ? readdirSync(area) : [];
    const query = queryObservability(directory, { limit: 500 });
    rows.push({
      enabled,
      scenario: scenario.name,
      width: scenario.width,
      batches: 4,
      elapsedIncludingStopMs: performance.now() - start,
      samples,
      daemon: metrics(stderr),
      telemetryFiles: files.length,
      telemetryBytes: files.reduce(
        (sum, name) => sum + statSync(join(area, name)).size,
        0,
      ),
      retainedRows: query.records.length,
      queryGaps: query.gaps,
    });
  }
}
const output = process.argv[2];
assert.ok(output);
writeFileSync(
  output,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      method:
        'OFF then ON per scenario; four sequential uncertain replays / four batches of four concurrent search clients; 30 fictional 2KB messages; fresh offline daemon each row; current exit RSS, CPU includes Node startup; hashes exclude random wire id/PID; no peak claim; uncontrolled OS cache/scheduling; artifacts retained',
      rows,
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
process.stdout.write(
  JSON.stringify({ output, retainedFictionalState: root }) + '\n',
);
