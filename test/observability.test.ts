import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs, { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { configureObservability, Observability, OBS_LIMITS, queryObservability, readObservability } from '../src/observability.js';
import { observeProcess } from '../src/observability-runtime.js';
import { rpc } from '../src/rpc.js';
import { Store } from '../src/store.js';
import { createRuntime } from '../src/runtime.js';
import type { WASocket } from 'baileys';

process.umask(0o077);
const temporary = () => realpathSync(mkdtempSync(join(tmpdir(), 'wobs-')));
const run = promisify(execFile);
const lid = '123450001@lid';
const canary = 'FICTIONAL_OBS_PRIVATE_CANARY';
async function cli(directory: string, ...args: string[]) {
  try { return JSON.parse((await run(process.execPath, ['dist/src/cli.js', '--data-dir', directory, ...args], { timeout: 15000 })).stdout) as Record<string, unknown>; }
  catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout) as Record<string, unknown>;
    throw error;
  }
}
function logs(directory: string) { return queryObservability(directory, { limit: 500 }).records; }
function raw(directory: string): string {
  const root = join(directory, 'observability');
  return existsSync(root) ? readdirSync(root).map(name => readFileSync(join(root, name), 'utf8')).join('') : '';
}

test('missing/off never creates telemetry; persistent preference is private, atomic and independent of SQLite', () => {
  const directory = temporary();
  const observer = new Observability(directory, 'cli');
  observer.record('command', { action: 'help' });
  assert.equal(observer.enabled, false);
  assert.deepEqual(readdirSync(directory), []);
  configureObservability(directory, true);
  assert.equal(new Observability(directory, 'cli').enabled, true);
  assert.equal(existsSync(join(directory, 'probe.sqlite')), false);
  observer.record('command', { action: 'help', ok: true, code: 'OK' });
  assert.equal(statSync(join(directory, 'observability.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'observability')).mode & 0o777, 0o700);
  const before = raw(directory);
  configureObservability(directory, false);
  observer.record('command', { action: 'send' });
  assert.equal(raw(directory), before);
  assert.equal(new Observability(directory, 'cli').enabled, false);
  assert.equal(readdirSync(directory).includes('observability.pending.json'), false);
});

test('CLI lifecycle, live preference reconciliation, correlation, all command families and no analysis feedback', async () => {
  const directory = temporary();
  const store = new Store(directory);
  store.observeChat({ id: lid, name: canary });
  store.observeMessage({ key: { remoteJid: lid, fromMe: false, id: canary }, messageTimestamp: 1,
    message: { conversation: canary, messageContextInfo: { messageSecret: Buffer.from(canary) } } });
  store.close();
  const child = spawn(process.execPath, ['dist/src/daemon.js', '--offline', '--data-dir', directory], { stdio: 'pipe' });
  const exited = once(child, 'exit');
  let diagnostics = ''; child.stderr?.on('data', data => { diagnostics += String(data); });
  try {
    for (let i = 0; i < 100; i++) {
      if (existsSync(join(directory, 'control.sock'))) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await cli(directory, 'observability', 'status')).ok, true);
    assert.equal(existsSync(join(directory, 'observability')), false);
    const enabled = await cli(directory, 'observability', 'enable');
    assert.equal((enabled.data as { configured: boolean; effective: boolean }).configured, true);
    assert.equal((enabled.data as { effective: boolean }).effective, true);
    const cases = [
      ['help'], ['start', '--offline'], ['status'], ['pair', 'qr'], ['pair', 'code', '--phone', '12025550101'],
      ['chats', '--unread', 'unknown'], ['chat', '--jid', lid], ['messages', '--jid', lid, '--output', 'compact'],
      ['search', '--query', canary], ['contact', '--jid', lid], ['resolve', '--phone', '+12025550101'], ['group', '--jid', '120363000000000001@g.us'],
      ['send', '--jid', lid, '--key', canary, '--text', canary],
      ['send', '--jid', lid, '--key', canary, '--text', canary, '--quote-id', canary, '--quote-from-me', 'false'],
      ['send-file', '--jid', lid, '--key', canary, '--file', '/fictional/' + canary, '--caption', canary],
      ['send-contact', '--jid', lid, '--key', canary, '--name', canary, '--phone', '+12025550103'],
      ['request', '--key', canary], ['events'], ['download', '--jid', lid, '--id', canary, '--out', '/fictional/' + canary],
      ...['archive', 'unarchive', 'read', 'unread'].map(action => [action, '--jid', lid, '--key', canary]),
      ['reconnect'], ['resync'], ['drop-connection'], ['backup', '--out', join(directory, 'snapshot')],
      ['messages', '--jid', lid, '--limit=-1'], ['send'], ['search', '--query', canary, '--output', 'invalid'], ['--unknown=' + canary],
    ];
    for (const args of cases) await cli(directory, ...args);
    const records = logs(directory);
    const actions = new Set<string | undefined>(records.filter(row => row.origin === 'cli').map(row => row.action));
    for (const action of ['help', 'start', 'status', 'pair', 'chats', 'chat', 'messages', 'search', 'contact', 'resolve', 'group', 'send', 'send-file', 'send-contact', 'request', 'events', 'download', 'archive', 'unarchive', 'read', 'unread', 'reconnect', 'resync', 'drop-connection', 'backup', 'observability']) assert.ok(actions.has(action), action);
    const search = records.find(row => row.origin === 'cli' && row.action === 'search' && row.code === 'OK')!;
    const correlated = records.filter(row => row.correlation === search.correlation);
    assert.deepEqual(new Set(correlated.map(row => row.origin)), new Set(['cli', 'rpc', 'daemon', 'runtime']));
    assert.equal(new Set(correlated.filter(row => row.origin !== 'cli').map(row => row.parent)).size, 1);
    assert.equal(correlated.find(row => row.origin === 'rpc')?.responseBytes, correlated.find(row => row.origin === 'daemon')?.responseBytes);
    assert.ok(search.stdoutBytes! > 0);
    assert.ok(records.some(row => row.code === 'INVALID_ARGUMENT' && row.origin === 'cli'));
    assert.ok(records.some(row => row.code === 'INVALID_ARGUMENT' && row.origin === 'daemon' && row.category === 'parser' && row.action === 'messages'));
    assert.ok(records.some(row => row.code === 'PRECONDITION_FAILED' && row.origin === 'runtime'));
    const beforeQuery = raw(directory);
    const query = await cli(directory, 'observability', 'query', '--origin', 'cli', '--limit', '2');
    assert.equal((query.data as { records: unknown[] }).records.length, 2);
    assert.equal(raw(directory), beforeQuery);
    const disabled = await cli(directory, 'observability', 'disable');
    assert.equal((disabled.data as { configured: boolean; effective: boolean }).configured, false);
    const afterDisable = raw(directory);
    await cli(directory, 'help'); await cli(directory, 'status');
    assert.equal(raw(directory), afterDisable);
    const status = await rpc(directory, { command: 'observability' }, 1000, undefined, false);
    assert.equal((status.data as { samplerActive: boolean }).samplerActive, false);
    assert.equal((await cli(directory, 'stop')).running, false);
    assert.deepEqual(await exited, [0, null]);
    assert.doesNotMatch(raw(directory), new RegExp(`${canary}|${lid.replaceAll('.', '\\.')}|1202555010|messageSecret|snapshot|vcard|caption|/fictional`));
    assert.doesNotMatch(diagnostics, new RegExp(canary));
    assert.equal(existsSync(join(directory, 'snapshot', 'observability')), false);
  } finally {
    if (child.exitCode === null) { await cli(directory, 'stop'); await exited; }
  }
  // Persistence after normal restart with default-off remains off; re-enable once while stopped.
  configureObservability(directory, true);
  const probe = spawnSync(process.execPath, ['dist/src/probe.js', '--data-dir', directory], { encoding: 'utf8', input:
    `{${canary}}\n` + JSON.stringify({ id: canary, command: 'status' }) + '\n' + JSON.stringify({ id: 'stop', command: 'stop' }) + '\n' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(logs(directory).some(row => row.origin === 'probe' && row.code === 'INVALID_ARGUMENT'));
  assert.ok(logs(directory).some(row => row.label === 'startup'));
  assert.ok(logs(directory).some(row => row.label === 'shutdown'));
  assert.doesNotMatch(raw(directory), new RegExp(canary));
});

test('timeout/protocol/missing transport is one attempt, with a late daemon result on the same correlation', async () => {
  const directory = temporary(); configureObservability(directory, true);
  const observer = new Observability(directory, 'daemon');
  let connections = 0;
  const server = createServer(socket => {
    connections++; socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.once('data', data => {
      const request = JSON.parse(String(data)) as { id: string; command: string };
      if (request.command === 'events') { socket.end('{invalid}\n'); return; }
      setTimeout(() => {
        observer.record('execution', { action: 'request', correlation: observer.opaque('correlation', request.id)!, ok: true, code: 'OK', empty: true });
        socket.end(JSON.stringify({ id: request.id, ok: true, data: null }) + '\n');
      }, 60);
    });
  });
  await new Promise<void>(resolve => server.listen(join(directory, 'control.sock'), resolve));
  try {
    await assert.rejects(rpc(directory, { command: 'request', key: canary }, 15), { code: 'TIMEOUT' });
    await new Promise(resolve => setTimeout(resolve, 90));
    await assert.rejects(rpc(directory, { command: 'events', after: 0 }, 1000), { code: 'PROTOCOL' });
    assert.equal(connections, 2);
    const records = logs(directory);
    const timeout = records.find(row => row.code === 'TIMEOUT')!;
    assert.ok(records.some(row => row.category === 'execution' && row.correlation === timeout.correlation && row.code === 'OK'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  await assert.rejects(rpc(directory, { command: 'events', after: 0 }), { code: 'NOT_RUNNING' });
  assert.ok(logs(directory).some(row => row.code === 'NOT_RUNNING'));
  assert.doesNotMatch(raw(directory), new RegExp(canary));
});

test('runtime distinguishes actual invocation, concurrent replay, conflict and uncertain SDK evidence without new sends', async () => {
  const directory = temporary(); configureObservability(directory, true);
  const seed = new Store(directory); seed.observeChat({ id: lid }); seed.close();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const events = new EventEmitter();
  let outgoingId: string | undefined;
  const runtime = createRuntime({ dataDir: directory, connect: true }, () => ({
    ev: events, ws: { isClosed: true }, end() { events.emit('connection.update', { connection: 'close' }); },
    async sendMessage(_jid: string, _content: unknown, options: { messageId: string }) {
      outgoingId = options.messageId; calls++; await gate; throw new Error(canary);
    },
  }) as unknown as WASocket);
  const command = { command: 'send' as const, key: canary, jid: lid, text: canary };
  runtime.start(); events.emit('connection.update', { connection: 'open' });
  try {
    const first = runtime.execute(command);
    assert.equal(calls, 1);
    const replay = await runtime.execute(command) as { attempt: string };
    assert.equal(replay.attempt, 'uncertain');
    events.emit('messages.update', [{ key: { id: outgoingId, remoteJid: lid, fromMe: true }, update: { status: 3 } }]);
    release();
    const result = await first as { attempt: string; delivery: string };
    assert.equal(result.attempt, 'uncertain'); assert.equal(result.delivery, 'delivered');
    const records = logs(directory);
    assert.equal(records.filter(row => row.category === 'execution' && row.invoked === true).length, 1);
    const attempted = records.find(row => row.invoked === true)!;
    assert.ok(records.some(row => row.label === 'receipt' && row.message === attempted.message && row.destination === attempted.destination && row.delivery === 'delivered'));
  } finally { release(); await runtime.close(); }
  const offline = createRuntime({ dataDir: directory, connect: false });
  try {
    const command = { command: 'send' as const, key: canary, jid: lid, text: canary };
    const [a, b] = await Promise.all([offline.execute(command), offline.execute(command)]);
    assert.deepEqual(a, b);
    await assert.rejects(offline.execute({ ...command, text: 'changed' }), { code: 'KEY_CONFLICT' });
    assert.equal(calls, 1);
    const records = logs(directory).filter(row => row.category === 'execution' && row.action === 'send');
    assert.equal(records.filter(row => row.replay === true && row.invoked === false && row.attempt === 'uncertain').length, 3);
    assert.ok(records.some(row => row.code === 'KEY_CONFLICT'));
    assert.doesNotMatch(raw(directory), new RegExp(canary));
  } finally { await offline.close(); }
});

test('global file cap, TTL, rotation, partial tails and many short clients stay bounded and preserve operational files', () => {
  const directory = temporary(); configureObservability(directory, true);
  writeFileSync(join(directory, 'daemon.log'), canary, { mode: 0o600 });
  writeFileSync(join(directory, 'probe.sqlite'), canary, { mode: 0o600 });
  let now = Date.now() - 4 * 86400000;
  const observer = new Observability(directory, 'cli', () => now);
  for (let index = 0; index < 36; index++) { observer.record('command', { action: 'help' }); now += 1800001; }
  const root = join(directory, 'observability');
  assert.equal(readdirSync(root).length, OBS_LIMITS.files);
  assert.equal(observer.status().evicted, 4);
  const last = readdirSync(root).sort().at(-1)!;
  appendFileSync(join(root, last), '{partial');
  observer.record('command', { action: 'status' });
  assert.equal(readdirSync(root).length, OBS_LIMITS.files);
  assert.ok(raw(directory).includes('{partial'));
  now = Date.now();
  for (let index = 0; index < 1000; index++) new Observability(directory, 'cli', () => now).record('command', { action: 'help', count: index });
  assert.ok(readdirSync(root).length <= OBS_LIMITS.files);
  assert.ok(readdirSync(root).every(name => statSync(join(root, name)).size <= OBS_LIMITS.segment));
  assert.ok(readdirSync(root).reduce((sum, name) => sum + statSync(join(root, name)).size, 0) <= OBS_LIMITS.bytes);
  now += 6 * 86400000;
  configureObservability(directory, false);
  observer.maintain();
  assert.equal(readdirSync(root).length, 0);
  assert.equal(readFileSync(join(directory, 'daemon.log'), 'utf8'), canary);
  assert.equal(readFileSync(join(directory, 'probe.sqlite'), 'utf8'), canary);
});

test('unknown entries, hardlinks, symlinks, unsafe ancestry and incompatible config are preserved, never repaired', () => {
  for (const kind of ['unknown', 'symlink', 'hardlink', 'header']) {
    const directory = temporary(); configureObservability(directory, true);
    const observer = new Observability(directory, 'cli'); observer.record('command');
    const root = join(directory, 'observability');
    const entry = join(root, kind === 'unknown' ? 'unfamiliar' : `v1-1000000000000-00000000-0000-0000-0000-000000000000.jsonl`);
    const sentinel = join(directory, 'sentinel'); writeFileSync(sentinel, canary, { mode: 0o600 });
    if (kind === 'symlink') symlinkSync(sentinel, entry);
    else if (kind === 'hardlink') linkSync(sentinel, entry);
    else writeFileSync(entry, canary, { mode: 0o600 });
    observer.record('command', { action: 'help' });
    assert.equal(observer.status().degraded, true, kind);
    assert.equal(readFileSync(entry, 'utf8'), canary);
    assert.equal(readFileSync(sentinel, 'utf8'), canary);
  }
  const directory = temporary(); configureObservability(directory, true);
  const original = readFileSync(join(directory, 'observability.json'));
  chmodSync(directory, 0o755);
  assert.throws(() => configureObservability(directory, false), { code: 'LOCAL_STATE' });
  assert.deepEqual(readFileSync(join(directory, 'observability.json')), original);
  assert.equal(statSync(directory).mode & 0o777, 0o755);
  const incompatible = temporary();
  writeFileSync(join(incompatible, 'observability.json'), JSON.stringify({ version: 99, enabled: true, secret: canary }), { mode: 0o600 });
  const observer = new Observability(incompatible, 'cli'); observer.record('command');
  assert.equal(observer.status().configured, null);
  assert.equal(observer.status().degraded, true);
  assert.throws(() => configureObservability(incompatible, false), { code: 'LOCAL_STATE' });
  assert.equal(existsSync(join(incompatible, 'observability')), false);
});

test('contention/crash lock is preserved, drops are visible and faulted telemetry never changes a successful result', async () => {
  const directory = temporary(); configureObservability(directory, true);
  const observer = new Observability(directory, 'cli');
  mkdirSync(join(directory, 'observability.lock'), { mode: 0o700 });
  writeFileSync(join(directory, 'observability.lock', 'unfamiliar'), canary, { mode: 0o600 });
  const started = performance.now();
  observer.record('command', { action: 'status' });
  assert.ok(performance.now() - started < 100);
  assert.equal(observer.status().dropped, 1);
  assert.equal(observer.status().degraded, true);
  assert.throws(() => configureObservability(directory, false), { code: 'LOCAL_STATE' });
  assert.equal(readFileSync(join(directory, 'observability.lock', 'unfamiliar'), 'utf8'), canary);
  const runtime = createRuntime({ dataDir: directory, connect: false });
  try { assert.equal((await runtime.execute({ command: 'status' }) as { networkEnabled: boolean }).networkEnabled, false); }
  finally { await runtime.close(); }
  assert.equal((await cli(directory, 'help')).ok, true);
});

test('disk-full injection drops safely; next successful record reports loss without exposing exceptions', () => {
  const directory = temporary(); configureObservability(directory, true);
  const observer = new Observability(directory, 'cli');
  observer.record('command', { action: 'status' });
  const write = fs.writeSync;
  fs.writeSync = (() => { throw new Error(canary); }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try { observer.record('command', { action: 'help' }); }
  finally { fs.writeSync = write; syncBuiltinESMExports(); }
  assert.equal(observer.status().dropped, 1);
  assert.equal(observer.status().degraded, true);
  observer.record('command', { action: 'help' });
  assert.equal(logs(directory).at(-1)?.dropped, 1);
  assert.equal(observer.status().degraded, false);
  assert.doesNotMatch(raw(directory), new RegExp(canary));
});

test('bounded query pagination, filters, corrupt lines and allowlisted output do not echo private data', () => {
  const directory = temporary(); configureObservability(directory, true);
  const observer = new Observability(directory, 'cli');
  for (let index = 0; index < 7; index++) observer.record('command', { action: index % 2 ? 'search' : 'messages', count: index, ok: true, code: 'OK' });
  const path = join(directory, 'observability', readdirSync(join(directory, 'observability'))[0]!);
  appendFileSync(path, `{"text":"${canary}"}\n${canary}\n`);
  appendFileSync(path, JSON.stringify({ ...logs(directory)[0], text: canary, action: canary, build: canary, label: canary, correlation: canary }) + '\n');
  const first = queryObservability(directory, { limit: 2 });
  assert.equal(first.records.length, 2); assert.ok(first.next);
  observer.record('command', { action: 'send' });
  const second = queryObservability(directory, { limit: 2, cursor: first.next! });
  assert.equal(new Set([...first.records, ...second.records].map(row => row.span)).size, 4);
  assert.equal(second.cutoff, first.cutoff);
  const filtered = queryObservability(directory, { action: 'search', origin: 'cli', code: 'OK', limit: 500 });
  assert.equal(filtered.records.length, 3);
  assert.equal(filtered.invalid, 2);
  assert.doesNotMatch(JSON.stringify(queryObservability(directory, { limit: 500 })), new RegExp(canary));
  assert.throws(() => queryObservability(directory, { cursor: canary }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => queryObservability(directory, { limit: 501 }), { code: 'INVALID_ARGUMENT' });
});

test('sampler measures CPU deltas/current RSS, disables promptly and does not retain sampling after stop', async () => {
  const directory = temporary(); configureObservability(directory, true);
  const observer = new Observability(directory, 'runtime');
  const processObserver = observeProcess(observer, 15);
  try {
    await new Promise(resolve => setTimeout(resolve, 65));
    const sample = logs(directory).find(row => row.category === 'sample')!;
    assert.ok(sample.rssBytes! > 0); assert.ok(sample.elapsedMs! >= 10); assert.ok(sample.cpuUserUs! >= 0);
    assert.equal('maxRSS' in sample, false);
    configureObservability(directory, false); processObserver.reconcile();
    assert.equal(processObserver.status().samplerActive, false);
    const before = raw(directory);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(raw(directory), before);
  } finally { processObserver.stop(); }
  assert.equal(processObserver.status().samplerActive, false);
});

test('concurrent short clients share bounded segments and atomic configuration failures are honest', async () => {
  const directory = temporary(); configureObservability(directory, true);
  const results = await Promise.all(Array.from({ length: 12 }, () => cli(directory, 'help')));
  assert.ok(results.every(result => result.ok === true));
  const root = join(directory, 'observability');
  assert.ok(readdirSync(root).length <= 2);
  assert.ok(logs(directory).length > 0);
  const toggles = await Promise.all(Array.from({ length: 8 }, (_, index) => cli(directory, 'observability', index % 2 ? 'enable' : 'disable')));
  assert.ok(toggles.every(result => result.ok === true || result.code === 'LOCAL_STATE'));
  assert.equal(readObservability(directory).degraded, false);
  assert.equal(existsSync(join(directory, 'observability.pending.json')), false);
});

test('offline configuration and legacy daemon visibility never claim an effective runtime', async () => {
  const directory = temporary();
  const enabled = await cli(directory, 'observability', 'enable');
  assert.equal((enabled.data as { configured: boolean; effective: boolean }).configured, true);
  assert.equal((enabled.data as { effective: boolean }).effective, false);
  assert.equal(existsSync(join(directory, 'probe.sqlite')), false);
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    socket.once('data', line => { const request = JSON.parse(String(line)) as { id: string }; socket.end(JSON.stringify({ id: request.id, ok: false, error: 'Unknown command' }) + '\n'); });
  });
  await new Promise<void>(resolve => server.listen(join(directory, 'control.sock'), resolve));
  try {
    const result = await cli(directory, 'observability', 'status');
    assert.equal((result.data as { configured: boolean }).configured, true);
    assert.equal((result.data as { effective: string }).effective, 'unknown');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('full/compact command bytes and results remain equivalent ON/OFF outside explicit status diagnostics', async () => {
  const directory = temporary();
  const store = new Store(directory);
  store.observeChat({ id: lid, unreadCount: 0 });
  store.observeMessage({ key: { id: 'fictional', remoteJid: lid, fromMe: false }, messageTimestamp: 1, message: { conversation: canary } });
  store.close();
  const child = spawn(process.execPath, ['dist/src/daemon.js', '--offline', '--data-dir', directory], { stdio: 'pipe' });
  const exited = once(child, 'exit');
  child.stderr?.resume();
  try {
    for (let index = 0; index < 100 && !existsSync(join(directory, 'control.sock')); index++) await new Promise(resolve => setTimeout(resolve, 20));
    const cases = [['chats'], ['messages', '--jid', lid], ['search', '--query', canary], ['request', '--key', canary], ['send', '--jid', lid, '--key', canary, '--text', canary], ['send']];
    for (const mode of ['full', 'compact']) {
      configureObservability(directory, false);
      const off = await Promise.all(cases.map(args => cli(directory, ...args, '--output', mode)));
      configureObservability(directory, true);
      const on = await Promise.all(cases.map(args => cli(directory, ...args, '--output', mode)));
      const withoutId = (rows: Record<string, unknown>[]) => rows.map(({ id: _id, ...row }) => row);
      assert.deepEqual(withoutId(on), withoutId(off));
    }
  } finally { await cli(directory, 'stop'); await exited; }
});

test('CLI help/config/query stay lightweight with SDK, SQLite and runtime imports forbidden', () => {
  const directory = temporary(); configureObservability(directory, true);
  for (const args of [['help'], ['observability', 'status'], ['observability', 'query']]) {
    const child = spawnSync(process.execPath, ['--import', './dist/test/fixtures/observability-cli-hooks.js', 'dist/src/cli.js', '--data-dir', directory, ...args], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal((JSON.parse(child.stdout) as { ok: boolean }).ok, true);
  }
});

test('telemetry allowlists discard every private payload class and keep a healthy OFF sampler absent', () => {
  const directory = temporary(); configureObservability(directory, true);
  const observer = new Observability(directory, 'cli');
  const unsafe = { action: 'unknown' as const, label: canary, issue: canary, key: canary, resource: canary,
    argv: [canary], text: canary, caption: canary, vcard: canary, quote: { text: canary }, name: canary,
    filename: canary, path: canary, phone: canary, jid: canary, messageId: canary,
    media: Buffer.from(canary), qr: canary, pairingCode: canary, credentials: { privateKey: canary },
    error: canary, cause: canary, stack: canary };
  observer.record('diagnostic', unsafe);
  assert.doesNotMatch(raw(directory), new RegExp(canary));
  const off = temporary(); configureObservability(off, false);
  const processObserver = observeProcess(new Observability(off, 'runtime'));
  try { assert.equal(processObserver.status().samplerActive, false); assert.equal(processObserver.status().retentionActive, false); }
  finally { processObserver.stop(); }
});

test('query racing authorized expiry reports a missing segment without echoing or consuming partial evidence', () => {
  const directory = temporary(); configureObservability(directory, true);
  let now = Date.now();
  const observer = new Observability(directory, 'cli', () => now);
  observer.record('command', { action: 'help' });
  const file = join(directory, 'observability', readdirSync(join(directory, 'observability'))[0]!);
  const inspect = fs.lstatSync;
  let expired = false;
  const replacement = ((...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === file && !expired) { expired = true; now += 6 * 86400000; observer.maintain(); }
    return inspect(...args);
  }) as typeof fs.lstatSync;
  Object.defineProperty(fs, 'lstatSync', { value: replacement });
  syncBuiltinESMExports();
  try {
    const page = queryObservability(directory, {});
    assert.equal(page.missing, 1); assert.deepEqual(page.records, []);
  } finally { Object.defineProperty(fs, 'lstatSync', { value: inspect }); syncBuiltinESMExports(); }
});

for (const existing of [false, true]) test(`query preserves prior evidence during ${existing ? 'rotation' : 'initial creation'} before the first append`, () => {
  const directory = temporary(); configureObservability(directory, true);
  let now = Date.now() - 3600000;
  const observer = new Observability(directory, 'cli', () => now);
  if (existing) { observer.record('command', { action: 'help' }); now += 1800001; }
  const open = fs.openSync;
  let concurrent: ReturnType<typeof queryObservability> | undefined;
  let queryError: unknown;
  let intercepted = false;
  const replacement: typeof fs.openSync = (path, flags, mode) => {
    const fd = open(path, flags, mode);
    if (!intercepted && String(path).endsWith('.jsonl') && typeof flags === 'number' && (flags & fs.constants.O_CREAT)) {
      intercepted = true;
      try { concurrent = queryObservability(directory, {}); } catch (error) { queryError = error; }
    }
    return fd;
  };
  fs.openSync = replacement; syncBuiltinESMExports();
  try { observer.record('command', { action: 'status' }); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(intercepted, true);
  assert.equal(queryError, undefined);
  assert.equal(concurrent?.records.length, existing ? 1 : 0);
  assert.equal(concurrent && 'incompleteHeaders' in concurrent.gaps ? concurrent.gaps.incompleteHeaders : undefined, 1);
  assert.equal(logs(directory).length, existing ? 2 : 1);
  assert.equal(observer.status().degraded, false);
});
