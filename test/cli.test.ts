import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { rpc, RpcError } from '../src/rpc.js';
import { Store } from '../src/store.js';
import type { WAMessage } from 'baileys';
import { publicResponse, uncertain } from './fixtures/responses.js';
import { contactCard } from '../src/contact-card.js';

process.umask(0o077);
mkdirSync('.tmp', { recursive: true, mode: 0o700 });
// Keep real Unix socket paths below the platform limit, including in long worktree paths.
const temporary = (): string => mkdtempSync(join(tmpdir(), 'whatscli-cli-'));
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
  assert.deepEqual(first.recovery, { state: 'offline', reason: null, code: null, attempt: 0, nextRetryAt: null });
  assert.deepEqual(first.receiveContinuity, { status: 'unproven', lastInterruption: null });
  for (const mode of ['full', 'compact']) {
    const status = await cli(directory, 'status', '--output', mode);
    assert.deepEqual(status.recovery, first.recovery);
    assert.deepEqual(status.receiveContinuity, first.receiveContinuity);
  }
  const contact = await cli(directory, 'contact', '--jid', '123450001@lid');
  assert.equal(contact.ok, true);
  assert.equal((contact.data as { phone: unknown }).phone, null);
  assert.equal((contact.data as { source: string }).source, 'local');
  const resolution = await cli(directory, 'resolve', '--phone', '+12025550101');
  assert.equal(resolution.ok, false);
  assert.match(String(resolution.error), /not open/);
  assert.equal((await cli(directory, 'resolve')).ok, false);
  assert.equal((await cli(directory, 'resolve', '--phone', '12025550101')).ok, false);
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
  const beforeCompactEvents = await cli(directory, 'events');
  const compactMessages = await cli(directory, '--output', 'compact', 'messages', '--jid', jid, '--limit', '1', '--offset', '1');
  assert.deepEqual((compactMessages.data as { messages: { id: string }[] }).messages.map(message => message.id), ['example-1']);
  assert.equal((compactMessages.data as { jid: string }).jid, jid);
  const compactNextPage = await cli(directory, 'messages', '--output', 'compact', '--jid', jid, '--limit', '1', '--offset', '2');
  assert.deepEqual(compactNextPage.data, { jid, messages: [] });
  const explicitFull = await cli(directory, 'messages', '--output', 'full', '--jid', jid, '--limit', '1', '--offset', '1');
  assert.deepEqual(explicitFull.data, messages.data);
  assert.deepEqual((await cli(directory, 'events')).data, beforeCompactEvents.data);
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

test('offline CLI chat filters preserve state, exact identity and redaction across daemon restart', async t => {
  const directory = temporary();
  const store = new Store(directory);
  const lid = '123450001@lid';
  const key = { remoteJid: jid, id: 'deleted', fromMe: false };
  const message = { key, messageTimestamp: 200, message: { conversation: 'DELETED_CHAT_BODY',
    messageContextInfo: { messageSecret: Buffer.from('PRIVATE_CHAT_SECRET') } } };
  store.observeChat({ id: jid, unreadCount: 1, archived: false, conversationTimestamp: 200, messages: [{ message }] });
  store.observeMessage(message);
  store.deleteMessages({ keys: [key] });
  store.observeChat({ id: lid });
  store.observeMapping(jid, lid, 'lid-mapping.update');
  store.close();
  t.after(async () => { await cli(directory, 'stop'); });
  assert.equal((await cli(directory, 'start', '--offline')).ok, true);
  const before = await cli(directory, 'chat', '--jid', jid);
  const events = await cli(directory, 'events');
  const { stdout } = await runFile(process.execPath, ['dist/src/cli.js', '--data-dir', directory, 'chats', '--unread', 'true', '--archived', 'false', '--limit', '1']);
  assert.equal(stdout.trim().split('\n').length, 1);
  const filtered = JSON.parse(stdout) as { data: { jid: string; activity: unknown }[]; source: string; coverage: string; connection: string };
  assert.equal(filtered.source, 'local');
  assert.equal(filtered.coverage, 'partial');
  assert.equal(filtered.connection, 'offline');
  assert.deepEqual(filtered.data.map(chat => chat.jid), [jid]);
  assert.deepEqual(filtered.data[0]?.activity, { timestamp: 200, source: 'chat.conversationTimestamp' });
  assert.doesNotMatch(stdout, /DELETED_CHAT_BODY|PRIVATE_CHAT_SECRET|messageSecret|messages|mediaKey/);
  assert.deepEqual(((await cli(directory, 'chats', '--unread', 'unknown', '--archived', 'unknown')).data as { jid: string }[]).map(chat => chat.jid), [lid]);
  assert.deepEqual((await cli(directory, 'chats', '--unread', 'false')).data, []);
  const compactFiltered = await cli(directory, '--output', 'compact', 'chats', '--unread', 'true', '--archived', 'false', '--limit', '1');
  assert.deepEqual((compactFiltered.data as { jid: string }[]).map(chat => chat.jid), [jid]);
  assert.deepEqual((await cli(directory, 'chats', '--output', 'compact', '--unread', 'true', '--offset', '1')).data, []);
  assert.deepEqual((await cli(directory, 'chats', '--unread', 'true', '--offset', '1')).data, []);
  for (const args of [['--unread', 'yes'], ['--archived', 'null'], ['--unread'], ['--jid', jid]]) assert.equal((await cli(directory, 'chats', ...args)).ok, false);
  assert.equal((await cli(directory, 'unread', '--limit', '1')).ok, false);
  // @ts-expect-error Deliberately malformed input exercises validation at the wire boundary.
  assert.equal((await rpc(directory, { command: 'chats', unread: 'true' })).ok, false);
  assert.deepEqual((await cli(directory, 'chat', '--jid', jid)).data, before.data);
  assert.deepEqual((await cli(directory, 'events')).data, events.data);
  assert.equal((await cli(directory, 'stop')).ok, true);
  assert.equal((await cli(directory, 'start', '--offline')).ok, true);
  assert.deepEqual((await cli(directory, 'chat', '--jid', jid)).data, before.data);
  assert.deepEqual((await cli(directory, 'chats', '--unread', 'true', '--archived', 'false')).data, filtered.data);
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

test('CLI compact sends one unchanged command, keeps JSON/exit codes, and validates output before I/O', async t => {
  const directory = temporary();
  const commands: Record<string, unknown>[] = [];
  const cardName = '名; Fictional, \\name';
  const cardPhone = '+12025550103';
  const card = { ...uncertain, key: 'card', operation: { kind: 'send-contact', jid, name: cardName, phone: cardPhone, vcard: contactCard(cardName, cardPhone).vcard } };
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const command = JSON.parse(buffer.trim()) as Record<string, unknown>;
      commands.push(command);
      if (command.key === 'closed') { socket.end(); return; }
      const response = command.key === 'error'
        ? { ok: false, error: 'Fictional conflict', code: 'CONFLICT' }
        : publicResponse(command.key === 'card' ? card : uncertain);
      socket.end(JSON.stringify({ ...response, id: command.id }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(join(directory, 'control.sock'), resolve));
  t.after(() => server.close());
  const invoke = (...args: string[]) => runFile(process.execPath, ['dist/src/cli.js', '--data-dir', directory, ...args], { timeout: 5000 });
  const { stdout, stderr } = await invoke('send', '--jid', jid, '--key', uncertain.key, '--text', uncertain.operation.kind === 'send' ? uncertain.operation.text : '', '--output', 'compact');
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.equal(stderr, '');
  assert.deepEqual((JSON.parse(stdout) as { data: unknown }).data, uncertain);
  assert.equal(commands.length, 1);
  assert.deepEqual(Object.keys(commands[0]!).sort(), ['command', 'id', 'jid', 'key', 'text']);
  assert.equal(commands[0]?.command, 'send');
  assert.equal(commands[0]?.key, uncertain.key);
  assert.equal(commands[0]?.jid, jid);

  for (const [key, code] of [['error', 'CONFLICT'], ['closed', 'PROTOCOL']]) {
    await assert.rejects(invoke('request', '--key', key!, '--output', 'compact'), error => {
      assert.ok(error && typeof error === 'object' && 'stdout' in error && 'code' in error);
      assert.equal(error.code, 1);
      assert.equal(typeof error.stdout, 'string');
      const result = JSON.parse(String(error.stdout)) as { ok: boolean; code: string };
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      return true;
    });
  }
  assert.equal(commands.length, 3, 'neither an error nor protocol uncertainty causes a retry');
  assert.equal((await cli(directory, 'send', '--output', 'short')).ok, false);
  assert.equal((await cli(directory, 'send', '--output')).ok, false);
  assert.equal(commands.length, 3, 'invalid presentation options cannot invoke an operation');

  for (const output of ['full', 'compact']) {
    const { stdout, stderr } = await invoke('send-contact', '--jid', jid, '--key', 'card', '--name', cardName, '--phone', cardPhone, '--output', output);
    assert.equal(stdout.trim().split('\n').length, 1);
    assert.equal(stderr, '');
    assert.deepEqual((JSON.parse(stdout) as { data: unknown }).data, card);
    const { id: _id, ...sent } = commands.at(-1)!;
    assert.deepEqual(sent, { command: 'send-contact', jid, key: 'card', name: cardName, phone: cardPhone });
    assert.deepEqual((await cli(directory, 'request', '--key', 'card', '--output', output)).data, card);
  }
  const count = commands.length;
  for (const args of [[], ['--phone', cardPhone], ['--name', cardName], ['--text', 'wrong']]) {
    assert.equal((await cli(directory, 'send-contact', '--jid', jid, '--key', 'card', ...args)).ok, false);
  }
  assert.equal(commands.length, count, 'invalid CLI fields never reach I/O');
  const help = await cli(directory, 'help');
  assert.match(String((help.data as { commands: Record<string, string> }).commands['send-contact']), /--name NAME --phone/);
  for (const output of ['full', 'compact']) {
    const { stdout } = await invoke('status', '--output', output);
    const legacy = JSON.parse(stdout) as { data: Record<string, unknown> };
    assert.equal('build' in legacy.data, false, 'a client cannot invent identity for a legacy daemon');
  }
});
