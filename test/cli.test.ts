import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { rpc, RpcError } from '../src/rpc.js';
import { Store } from '../src/store.js';
import type { WAMessage } from 'baileys';

process.umask(0o077);
mkdirSync('.tmp', { recursive: true, mode: 0o700 });
const temporary = (): string => mkdtempSync(join(process.cwd(), '.tmp', 'cli-'));
const runFile = promisify(execFile);
const jid = '12025550101@s.whatsapp.net';

async function cli(directory: string, ...args: string[]): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await runFile(process.execPath, ['dist/src/cli.js', '--data-dir', directory, ...args], { timeout: 15000 });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout) as Record<string, unknown>;
    throw error;
  }
}

test('offline CLI lifecycle, pagination, literal Unicode search, validation and single daemon ownership', async t => {
  const directory = temporary();
  const store = new Store(directory);
  const incoming: WAMessage = { key: { id: 'example-1', remoteJid: jid, fromMe: false }, messageTimestamp: 10,
    message: { conversation: 'São Paulo 100%_literal', messageContextInfo: { messageSecret: Buffer.from('PRIVATE_SEARCH_SECRET') } } };
  store.observeChat({ id: jid, name: 'Example contact', unreadCount: 0 });
  store.observeMessage(incoming);
  store.observeMessage({ ...incoming, key: { ...incoming.key, id: 'example-2' }, messageTimestamp: 20, message: { conversation: 'Second example' } });
  store.close();
  t.after(async () => { await cli(directory, 'stop'); });

  const first = await cli(directory, 'start', '--offline');
  assert.equal(first.ok, true);
  assert.equal(first.connection, 'offline');
  assert.equal(first.running, true);
  const again = await cli(directory, 'start', '--offline');
  assert.equal(again.alreadyRunning, true);
  assert.equal(again.pid, first.pid);
  const changedRecipient = await cli(directory, 'start', '--offline', '--allow-jid', jid);
  assert.equal(changedRecipient.ok, false);
  assert.match(String(changedRecipient.error), /different options/);
  assert.equal((await cli(directory, 'status')).pid, first.pid);
  assert.equal(statSync(join(directory, 'control.sock')).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'probe.sqlite')).mode & 0o777, 0o600);

  const chats = await cli(directory, 'chats', '--limit', '1');
  assert.equal((chats.data as { jid: string }[])[0]?.jid, jid);
  const messages = await cli(directory, 'messages', '--jid', jid, '--limit', '1', '--offset', '1');
  assert.equal((messages.data as { id: string }[])[0]?.id, 'example-1');
  const search = await cli(directory, 'search', '--query', 'SÃO PAULO 100%_');
  assert.equal((search.data as unknown[]).length, 1);
  assert.doesNotMatch(JSON.stringify(search), /PRIVATE_SEARCH_SECRET|messageSecret/);
  const notInBody = await cli(directory, 'search', '--query', 'PRIVATE_SEARCH_SECRET');
  assert.deepEqual(notInBody.data, []);
  const invalid = await cli(directory, 'messages', '--jid', jid, '--limit=-1');
  assert.equal(invalid.ok, false);
  assert.match(String(invalid.error), /integer/);
  const blocked = await cli(directory, 'send', '--jid', jid, '--key', 'offline-request', '--text', 'Fictional test');
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error), /not open/);
  const noIntent = await cli(directory, 'request', '--key', 'offline-request');
  assert.equal(noIntent.data, null);
  const offlineDownload = await cli(directory, 'download', '--jid', jid, '--id', 'example-1', '--out', join(directory, 'download.txt'));
  assert.equal(offlineDownload.ok, false);
  assert.match(String(offlineDownload.error), /requires network access/);
  assert.equal(existsSync(join(directory, 'download.txt')), false);

  assert.equal((await cli(directory, 'stop')).running, false);
  assert.equal(existsSync(join(directory, 'control.sock')), false);
  assert.equal((await cli(directory, 'status')).running, false);
  assert.equal((await cli(directory, 'start', '--offline')).ok, true);
  assert.equal(((await cli(directory, 'search', '--query', 'Second example')).data as unknown[]).length, 1);
});

test('restart recovers a private socket left by process exit and preserves an unfamiliar regular file', async t => {
  const directory = temporary();
  const path = join(directory, 'control.sock');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:net';
    import { chmodSync } from 'node:fs';
    createServer().listen(process.argv[1], () => { chmodSync(process.argv[1], 0o600); process.exit(0); });
  `, path], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(statSync(path).isSocket());
  t.after(async () => { await cli(directory, 'stop'); });
  assert.equal((await cli(directory, 'start', '--offline')).ok, true);
  assert.equal((await cli(directory, 'stop')).running, false);

  const other = temporary();
  const existing = join(other, 'control.sock');
  writeFileSync(existing, 'Preserve this unrelated file', { mode: 0o600 });
  const attempt = await cli(other, 'start', '--offline');
  assert.equal(attempt.ok, false);
  assert.equal(readFileSync(existing, 'utf8'), 'Preserve this unrelated file');
});

test('insecure existing storage is rejected without changing its permissions', async () => {
  const directory = temporary();
  chmodSync(directory, 0o755);
  const result = await cli(directory, 'start', '--offline');
  assert.equal(result.ok, false);
  assert.equal(statSync(directory).mode & 0o777, 0o755);
});

test('RPC timeout makes one attempt and instructs the caller to inspect the durable key', async t => {
  const directory = temporary();
  let connections = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => { connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(join(directory, 'control.sock'), resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  await assert.rejects(rpc(directory, { command: 'send', key: 'fictional-timeout-key', jid, text: 'Example' }, 80), error =>
    error instanceof RpcError && error.code === 'TIMEOUT' && /idempotency key/.test(error.message));
  assert.equal(connections, 1);
});
