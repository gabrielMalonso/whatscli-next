import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { contactCard } from '../src/contact-card.js';
import { CommandError, errorResponse } from '../src/errors.js';
import { perform } from '../src/operations.js';
import { formatResponse } from '../src/response.js';
import { rpc, RpcError } from '../src/rpc.js';
import { Store } from '../src/store.js';
import type { Operation } from '../src/store.js';

process.umask(0o077);
const temporary = () => mkdtempSync(join(tmpdir(), 'wcn-errors-'));
const runFile = promisify(execFile);
const jid = '123450001@lid';

async function cli(directory: string, ...args: string[]) {
  try {
    const result = await runFile(process.execPath, ['dist/src/cli.js', '--data-dir', directory, ...args], { timeout: 15000 });
    return { status: 0, stderr: result.stderr, data: JSON.parse(result.stdout) as Record<string, unknown> };
  } catch (error) {
    assert.ok(error && typeof error === 'object' && 'stdout' in error && 'stderr' in error && 'code' in error);
    assert.equal(typeof error.stdout, 'string');
    assert.equal(String(error.stdout).trim().split('\n').length, 1);
    return { status: error.code, stderr: error.stderr, data: JSON.parse(String(error.stdout)) as Record<string, unknown> };
  }
}

async function wire(directory: string, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(directory, 'control.sock'));
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(line + '\n'));
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => resolve(JSON.parse(response) as Record<string, unknown>));
  });
}

test('public error projection preserves proven codes and never classifies arbitrary messages or code properties', () => {
  const secret = 'FICTIONAL_PRIVATE_BODY /private/example SDK auth';
  for (const error of [new Error(secret), new Error('Idempotency key already used with different arguments'),
    Object.assign(new Error('Daemon is not running'), { code: 'NOT_RUNNING' }), secret, null]) {
    assert.deepEqual(errorResponse(error), { ok: false, error: 'Command failed', code: 'UNKNOWN' });
  }
  for (const error of [new CommandError('LOCAL_STATE', 'Local completion failed', { cause: new Error(secret) }),
    new RpcError('TIMEOUT', 'Daemon response timed out')]) {
    const response = errorResponse(error);
    assert.deepEqual(response, { ok: false, error: error.message, code: error.code });
    for (const mode of ['full', 'compact'] as const) assert.equal(formatResponse('send', response, mode), response);
    assert.doesNotMatch(JSON.stringify(response), /FICTIONAL_PRIVATE_BODY|cause|stack/);
  }
});

test('CLI, socket and JSONL agree on validation, key conflicts and preconditions without changing durable replays', async () => {
  const directory = temporary();
  const path = join(directory, '--fictional-名.txt'); // Deliberately absent: replay must not open it.
  const name = '--名 👩🏽‍💻; Fictional';
  const phone = '+12025550103';
  const text = '--Olá 😀\n漢字';
  const operations: Operation[] = [
    { kind: 'send', jid, text },
    { kind: 'send-file', jid, path, mime: 'text/plain', caption: '', bytes: 12, sha256: 'a'.repeat(64) },
    { kind: 'send-contact', jid, name, phone, vcard: contactCard(name, phone).vcard },
  ];
  const store = new Store(directory);
  const records = [];
  let calls = 0;
  try {
    for (const operation of operations) records.push(await perform(store, `--${operation.kind}`, operation, () => {}, async () => {
      calls++;
      throw new Error('FICTIONAL_PRIVATE_SDK_ERROR');
    }));
  } finally { store.close(); }
  const commands = [
    { command: 'send', jid, key: '--send', text },
    { command: 'send-file', jid, key: '--send-file', path, mime: 'text/plain', caption: '' },
    { command: 'send-contact', jid, key: '--send-contact', name, phone },
  ];
  const args = [
    ['send', '--jid', jid, '--key=--send', `--text=${text}`],
    ['send-file', '--jid', jid, '--key=--send-file', '--file', path, '--mime', 'text/plain', '--caption='],
    ['send-contact', '--jid', jid, '--key=--send-contact', `--name=${name}`, '--phone', phone],
  ];
  const failures = [
    { command: { command: 'messages', jid, limit: -1 }, args: ['messages', '--jid', jid, '--limit=-1'], code: 'INVALID_ARGUMENT' },
    { command: { command: 'send', jid, key: '--send', text: 'Different' }, args: ['send', '--jid', jid, '--key=--send', '--text', 'Different'], code: 'KEY_CONFLICT' },
    { command: { command: 'send-file', jid, key: '--send-file', path, mime: 'text/plain', caption: 'Different' }, args: ['send-file', '--jid', jid, '--key=--send-file', '--file', path, '--mime', 'text/plain', '--caption', 'Different'], code: 'KEY_CONFLICT' },
    { command: { command: 'send-contact', jid: '12025550101@s.whatsapp.net', key: '--send-contact', name, phone }, args: ['send-contact', '--jid', '12025550101@s.whatsapp.net', '--key=--send-contact', `--name=${name}`, '--phone', phone], code: 'KEY_CONFLICT' },
    { command: { command: 'resolve', phone }, args: ['resolve', '--phone', phone], code: 'PRECONDITION_FAILED' },
  ];
  try {
    assert.equal((await cli(directory, 'status')).data.running, false);
    assert.equal((await cli(directory, 'stop')).data.running, false);
    assert.equal((await cli(directory, 'start', '--offline')).status, 0);
    const expected = [];
    for (const [index, failure] of failures.entries()) {
      const id = `failure-${index}`;
      const response = await wire(directory, JSON.stringify({ ...failure.command, id }));
      assert.equal(response.id, id);
      assert.equal(response.ok, false);
      assert.equal(response.code, failure.code);
      expected.push(response);
      for (const mode of ['full', 'compact']) {
        const result = await cli(directory, ...failure.args, '--output', mode);
        assert.equal(result.status, 1);
        assert.equal(result.stderr, '');
        const { id: _id, ...data } = result.data;
        const { id: _wireId, ...wireData } = response;
        assert.deepEqual(data, wireData);
      }
    }
    const malformed = '{"id":"private", FICTIONAL_PRIVATE_BODY}';
    const invalid = await wire(directory, malformed);
    assert.deepEqual(invalid, { id: null, ok: false, error: 'Invalid JSON request', code: 'INVALID_ARGUMENT' });
    assert.equal((await wire(directory, ' '.repeat(131073))).code, 'INVALID_ARGUMENT');
    for (const [index, commandArgs] of args.entries()) {
      for (const mode of ['full', 'compact']) {
        const result = await cli(directory, ...commandArgs, '--output', mode);
        assert.equal(result.status, 0);
        assert.deepEqual(result.data.data, records[index]);
        assert.equal('code' in result.data, false);
      }
    }
    const badOptions = await cli(directory, 'send', '--jid', jid, '--key=--send', '--text', '--FICTIONAL_PRIVATE_BODY');
    assert.equal(badOptions.data.code, 'INVALID_ARGUMENT');
    assert.equal(badOptions.status, 1);
    assert.doesNotMatch(JSON.stringify(badOptions), /FICTIONAL_PRIVATE_BODY/);
    const missing = await cli(directory, 'send', '--jid', jid, '--key', 'new');
    assert.equal(missing.data.code, 'INVALID_ARGUMENT');
    assert.equal('id' in missing.data, false, 'local errors do not invent a correlation id');
    assert.equal((await cli(directory, 'stop')).status, 0);
    const probe = spawnSync(process.execPath, ['dist/src/probe.js', '--data-dir', directory], { encoding: 'utf8', timeout: 10000,
      input: [...failures.map((failure, index) => JSON.stringify({ ...failure.command, id: `failure-${index}` })), malformed,
        ...commands.map((command, index) => JSON.stringify({ ...command, id: `replay-${index}` }))].join('\n') + '\n' });
    assert.equal(probe.status, 0, probe.stderr);
    const rows = probe.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(rows.slice(0, failures.length), expected);
    assert.deepEqual(rows[failures.length], invalid);
    for (const [index, record] of records.entries()) assert.deepEqual(rows[failures.length + 1 + index]?.data, record);
    assert.doesNotMatch(probe.stdout, /FICTIONAL_PRIVATE_BODY|FICTIONAL_PRIVATE_SDK_ERROR/);
    const reopened = new Store(directory);
    try { assert.equal(reopened.events(0).filter(event => (event as { kind: string }).kind === 'operation-attempt').length, 3); }
    finally { reopened.close(); }
    assert.equal(calls, 3);
  } finally { await cli(directory, 'stop'); }
});

test('new clients forward legacy and unfamiliar daemon codes verbatim without inventing evidence', async t => {
  const directory = temporary();
  let calls = 0;
  const legacy = { ok: false, error: 'Idempotency key already used with different arguments' };
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    socket.once('data', line => {
      calls++;
      const request = JSON.parse(String(line)) as { id: string; key: string };
      socket.end(JSON.stringify({ id: request.id, ...legacy, ...(request.key === 'future' ? { code: 'FUTURE_CODE' } : {}) }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(join(directory, 'control.sock'), resolve));
  t.after(() => server.close());
  for (const mode of ['full', 'compact']) {
    for (const key of ['legacy', 'future']) {
      const result = await cli(directory, 'request', '--key', key, '--output', mode);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, '');
      const { id, ...response } = result.data;
      assert.equal(typeof id, 'string');
      assert.deepEqual(response, { ...legacy, ...(key === 'future' ? { code: 'FUTURE_CODE' } : {}) });
    }
  }
  assert.equal(calls, 4);
  await assert.rejects(rpc(temporary(), { command: 'request', key: 'absent' }), error => error instanceof RpcError && error.code === 'NOT_RUNNING');
});

test('local completion failure crosses CLI/socket/JSONL as local, preserves receipts, and never becomes an SDK failure or resend', async () => {
  const directory = temporary();
  const seed = new Store(directory);
  seed.observeChat({ id: jid });
  seed.db.exec("CREATE TRIGGER fail_completion BEFORE INSERT ON events WHEN NEW.kind='operation-sdk-returned' BEGIN SELECT RAISE(ABORT,'FICTIONAL_PRIVATE_SQL_BODY'); END");
  seed.close();
  const child = spawn(process.execPath, ['--import', './dist/test/fixtures/error-hooks.js', 'dist/src/daemon.js', '--offline', '--data-dir', directory],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = '';
  child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    for (const mode of ['full', 'compact']) {
      const result = await cli(directory, 'send', '--jid', jid, '--key', mode, '--text', 'Fictional', '--output', mode);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, '');
      assert.equal(result.data.code, 'LOCAL_STATE');
      assert.match(String(result.data.error), /completion could not be persisted/);
      const record = (await cli(directory, 'request', '--key', mode)).data.data;
      assert.deepEqual((await cli(directory, 'send', '--jid', jid, '--key', mode, '--text', 'Fictional')).data.data, record);
    }
    const result = await wire(directory, JSON.stringify({ id: 'wire-local', command: 'send', jid, key: 'wire-local', text: 'Fictional' }));
    assert.equal(result.id, 'wire-local');
    assert.equal(result.code, 'LOCAL_STATE');
    const uncertain = await cli(directory, 'send', '--jid', jid, '--key', 'uncertain', '--text', 'uncertain');
    assert.equal(uncertain.status, 0);
    assert.equal(uncertain.data.ok, true);
    assert.equal('code' in uncertain.data, false);
    const unknown = await cli(directory, 'group', '--jid', '120363000000000001@g.us');
    assert.equal(unknown.status, 1);
    assert.equal(unknown.data.code, 'UNKNOWN');
    assert.equal(unknown.data.error, 'Command failed');
  } finally {
    await cli(directory, 'stop');
    assert.deepEqual(await exited, [0, null], diagnostics);
  }
  const commands = [
    { id: 'jsonl-local', command: 'send', jid, key: 'jsonl-local', text: 'Fictional' },
    { id: 'jsonl-replay', command: 'send', jid, key: 'full', text: 'Fictional' },
    { id: 'jsonl-unknown', command: 'group', jid: '120363000000000001@g.us' },
  ];
  const probe = spawnSync(process.execPath, ['--import', './dist/test/fixtures/error-hooks.js', 'dist/src/probe.js', '--data-dir', directory, '--test-jid', jid],
    { encoding: 'utf8', input: commands.map(command => JSON.stringify(command)).join('\n') + '\n', timeout: 10000 });
  assert.equal(probe.status, 0, probe.stderr);
  const rows = probe.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows[0]?.code, 'LOCAL_STATE');
  assert.equal(rows[0]?.id, 'jsonl-local');
  assert.equal(rows[1]?.ok, true);
  assert.equal(rows[2]?.code, 'UNKNOWN');
  assert.doesNotMatch(probe.stdout + diagnostics, /FICTIONAL_PRIVATE_|stack|cause/);
  const store = new Store(directory);
  try {
    for (const key of ['full', 'compact', 'wire-local', 'jsonl-local']) {
      const record = store.request(key);
      assert.ok(record?.messageId);
      assert.equal(record.attempt, 'uncertain');
      assert.equal(record.delivery, 'delivered');
      assert.equal(record.errorObserved, false, 'a local completion error is not an SDK error');
    }
    assert.equal(store.request('uncertain')?.errorObserved, true);
    assert.equal(store.request('uncertain')?.attempt, 'uncertain');
    assert.equal(store.request('uncertain')?.delivery, 'delivered');
    assert.equal(store.events(0).filter(event => (event as { kind: string }).kind === 'operation-attempt').length, 5);
  } finally { store.close(); }
});
