import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateWAMessage, proto } from 'baileys';
import type { BaileysEventMap, WAMessage, WASocket } from 'baileys';
import { contactCard } from '../src/contact-card.js';
import { perform } from '../src/operations.js';
import { messageOutput } from '../src/output.js';
import { parseCommand, parseRequest } from '../src/protocol.js';
import { formatResponse } from '../src/response.js';
import { createRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { Operation, RequestRecord } from '../src/store.js';

process.umask(0o077);
mkdirSync('.tmp', { recursive: true, mode: 0o700 });
const temporary = () => mkdtempSync(join(process.cwd(), '.tmp', 'contact-card-'));
const pn = '12025550101@s.whatsapp.net';
const otherPn = '12025550102@s.whatsapp.net';
const lid = '123450001@lid';
const group = '120363000000000001@g.us';
const command = { command: 'send-contact' as const, key: 'card', jid: pn, name: 'Fictional Contact', phone: '+12025550103' };
const operation = { kind: 'send-contact' as const, jid: pn, name: command.name, phone: command.phone, vcard: contactCard(command.name, command.phone).vcard };
const gate = () => {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

function fixture(directory = temporary(), allowedJid?: string) {
  const sockets: EventEmitter[] = [];
  const calls: Parameters<WASocket['sendMessage']>[] = [];
  let send: WASocket['sendMessage'] = async (jid, content, options) => generateWAMessage(jid, content, {
    userJid: '12025550199@s.whatsapp.net', ...options,
    upload: async () => { throw new Error('No uploads in offline fixtures'); },
  });
  const runtime = createRuntime({ dataDir: directory, connect: true, ...(allowedJid ? { allowedJid } : {}) }, () => {
    const events = new EventEmitter();
    sockets.push(events);
    return {
      ev: events, ws: { isClosed: true },
      end: async () => { events.emit('connection.update', { connection: 'close' }); },
      onWhatsApp: async () => { assert.fail('Sending a shared card must not resolve any phone'); },
      sendMessage: async (...args: Parameters<WASocket['sendMessage']>) => {
        calls.push(args);
        const persisted = await runtime.execute({ command: 'request', key: 'card' }) as RequestRecord;
        assert.equal(persisted.messageId, args[2]?.messageId);
        assert.equal(persisted.attempt, 'uncertain');
        assert.deepEqual(persisted.operation, { ...operation, jid: args[0] });
        return send(...args);
      },
    } as unknown as WASocket; // Deliberately partial injected SDK boundary, never a live socket.
  });
  const emit = <K extends keyof BaileysEventMap>(name: K, value: BaileysEventMap[K]) => { sockets.at(-1)!.emit(name, value); };
  runtime.start();
  emit('connection.update', { connection: 'open' });
  return { runtime, directory, emit, calls, sockets, send(value: WASocket['sendMessage']) { send = value; } };
}

test('contact protocol validates exact recipients, Unicode, international phone and bounded safe names', () => {
  assert.deepEqual(parseRequest(JSON.stringify({ id: 'rpc-card', ...command })), { id: 'rpc-card', command });
  for (const name of ['名 👩🏽‍💻', 'e\u0301', ' x ', 'é'.repeat(128)]) assert.equal(parseCommand({ ...command, name }).command, 'send-contact');
  for (const name of ['', '   ', '\t', 'x\r\nTEL:+12025550104', 'x\nx', 'x\rx', 'x\0', 'x\u007f', 'x\u0085', 'x\u2028', 'x\u2029', '\ud800', 'é'.repeat(129), 'x'.repeat(257)]) {
    assert.throws(() => parseCommand({ ...command, name }), /name/);
    assert.throws(() => contactCard(name, command.phone), /name/);
  }
  for (const phone of ['12025550103', '+012025550103', '+1 (202) 555-0103', '+123', '+1234567890123456', `${command.phone}\r\nFN:Injected`, lid]) assert.throws(() => parseCommand({ ...command, phone }), /phone/);
  for (const jid of ['Fictional Contact', '+12025550101', '12025550101:2@s.whatsapp.net']) assert.throws(() => parseCommand({ ...command, jid }), /exact JID/);
  for (const field of ['name', 'phone', 'jid', 'key']) assert.throws(() => parseCommand({ ...command, [field]: undefined }));
  assert.equal(contactCard('Fictional', '+12345678').displayName, 'Fictional');
  assert.ok(contactCard('Fictional', '+123456789012345').vcard.includes('+123456789012345'));
});

test('builder escapes vCard properties, folds UTF-8 safely and generates a real rc14 contactMessage offline', async () => {
  const name = '名; Fictional, \\name: 👩🏽‍💻 ' + 'é'.repeat(60);
  const card = contactCard(name, command.phone);
  assert.equal(card.displayName, name);
  assert.equal(card.vcard, contactCard(name, command.phone).vcard);
  const lines = card.vcard.split('\r\n');
  assert.ok(lines.every(line => Buffer.byteLength(line) <= 75));
  const unfolded = card.vcard.replace(/\r\n /g, '');
  assert.match(unfolded, /FN:名\\; Fictional\\, \\\\name:/);
  assert.deepEqual(unfolded.trim().split('\r\n').map(line => line.split(':')[0]), ['BEGIN', 'VERSION', 'N', 'FN', 'TEL;TYPE=CELL', 'END']);
  const message = await generateWAMessage(pn, { contacts: { contacts: [card] } }, {
    userJid: otherPn, messageId: 'persisted-fictional-id',
    upload: async () => { assert.fail('No network/media generation'); },
  });
  const decoded = proto.Message.decode(proto.Message.encode(message.message!).finish());
  assert.equal(decoded.contactMessage?.vcard, card.vcard);
  assert.equal(decoded.contactMessage?.displayName, name);
  assert.equal(decoded.contactsArrayMessage, null);
  assert.equal(decoded.conversation, null);
  const projected = messageOutput({ ...message, message: decoded });
  assert.equal(projected.contacts?.cards[0]?.name, name);
  assert.deepEqual(projected.contacts?.cards[0]?.phones, [command.phone]);
  assert.equal(projected.contacts?.cards[0]?.state, 'available');
});

test('invalid cards create no intent and never reach the injected SDK, including direct runtime calls', async () => {
  const f = fixture();
  try {
    for (const change of [{ name: 'x\nFN:Injected' }, { phone: pn }, { name: ' ' }, { jid: '12025550101:2@s.whatsapp.net' }, { key: 'x'.repeat(201) }]) {
      await assert.rejects(f.runtime.execute({ ...command, ...change }));
    }
    assert.equal(await f.runtime.execute({ command: 'request', key: 'card' }), null);
    assert.equal(f.calls.length, 0);
  } finally { await f.runtime.close(); }
});

test('verified exact first contact persists payload before SDK without creating chat or shared identity', async () => {
  const directory = temporary();
  const store = new Store(directory);
  store.set('recipient-check', pn, { status: 'confirmed', source: 'baileys.onWhatsApp', observedAt: 10 });
  store.close();
  const f = fixture(directory);
  try {
    const before = await f.runtime.execute({ command: 'contact', jid: '12025550103@s.whatsapp.net' });
    const result = await f.runtime.execute(command) as RequestRecord;
    assert.deepEqual(result.operation, operation);
    assert.equal(result.attempt, 'sdk-returned');
    assert.equal(result.acceptance, 'unknown');
    assert.equal(result.delivery, 'unknown');
    assert.equal(result.read, 'unknown');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0]?.[1], { contacts: { displayName: command.name, contacts: [contactCard(command.name, command.phone)] } });
    assert.equal(await f.runtime.execute({ command: 'chat', jid: pn }), null);
    assert.deepEqual(await f.runtime.execute({ command: 'chats', limit: 100, offset: 0 }), []);
    assert.deepEqual(await f.runtime.execute({ command: 'contact', jid: '12025550103@s.whatsapp.net' }), before);
    for (const action of ['send-contact', 'request']) for (const mode of ['full', 'compact'] as const) {
      assert.deepEqual(formatResponse(action, { ok: true, data: result }, mode).data, result);
    }
    assert.doesNotMatch(JSON.stringify(await f.runtime.execute({ command: 'events', after: 0 })), /vcard|messageSecret|mediaKey/);
  } finally { await f.runtime.close(); }
});

test('target checks preserve exact PN/LID/group authority and reject unknown, conflict and aliases', async () => {
  for (const scenario of ['unknown', 'alias', 'conflict', 'restricted', 'lid', 'group'] as const) {
    const directory = temporary();
    const store = new Store(directory);
    if (scenario !== 'unknown') {
      store.set('recipient-check', pn, { status: 'confirmed', source: 'baileys.onWhatsApp', observedAt: 1 });
      store.observeMapping(pn, lid, 'lid-mapping.update');
    }
    if (scenario === 'conflict') store.observeMapping(otherPn, lid, 'contacts.update');
    if (scenario === 'lid' || scenario === 'group') store.observeChat({ id: scenario === 'lid' ? lid : group });
    store.close();
    const f = fixture(directory, scenario === 'restricted' ? lid : undefined);
    try {
      const jid = scenario === 'alias' || scenario === 'lid' ? lid : scenario === 'group' ? group : pn;
      if (scenario === 'lid' || scenario === 'group') assert.equal((await f.runtime.execute({ ...command, jid }) as RequestRecord).attempt, 'sdk-returned');
      else {
        await assert.rejects(f.runtime.execute({ ...command, jid }), /verification|conflicting|allowed recipient/);
        assert.equal(await f.runtime.execute({ command: 'request', key: command.key }), null);
        assert.equal(f.calls.length, 0);
      }
    } finally { await f.runtime.close(); }
  }
});

test('pending concurrent card keys are immutable across kind/content changes, identity changes and offline restart', { timeout: 5000 }, async () => {
  const directory = temporary();
  const store = new Store(directory);
  store.observeChat({ id: pn, archived: true, unreadCount: -1, conversationTimestamp: 100 });
  store.close();
  const f = fixture(directory);
  const wait = gate();
  f.send(async () => { await wait.promise; throw new Error('SDK_PRIVATE_SECRET'); });
  const pending = f.runtime.execute(command);
  try {
    const original = await f.runtime.execute(command) as RequestRecord;
    assert.equal(original.attempt, 'uncertain');
    assert.equal(f.calls.length, 1);
    for (const change of [{ name: 'Other' }, { phone: '+12025550104' }, { jid: lid }]) await assert.rejects(f.runtime.execute({ ...command, ...change }), /different arguments/);
    for (const other of [
      { command: 'send' as const, text: 'Example' },
      { command: 'send-file' as const, path: '/fictional/missing', mime: 'text/plain', caption: '' },
      { command: 'archive' as const, value: true }, { command: 'mark-read' as const, value: true },
    ]) await assert.rejects(f.runtime.execute({ key: command.key, jid: pn, ...other }), /different arguments/);
    const before = await f.runtime.execute({ command: 'chat', jid: pn });
    f.emit('lid-mapping.update', { pn, lid });
    f.emit('lid-mapping.update', { pn: otherPn, lid });
    f.emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error('Offline'), { output: { statusCode: 408 } }), date: new Date() } });
    assert.deepEqual(await f.runtime.execute(command), original);
    await f.runtime.execute({ command: 'reconnect' });
    f.emit('connection.update', { connection: 'open' });
    assert.equal(f.sockets.length, 2);
    assert.deepEqual(await f.runtime.execute(command), original);
    assert.deepEqual(await f.runtime.execute({ command: 'chat', jid: pn }), before);
    wait.release();
    const failed = await pending as RequestRecord;
    assert.equal(failed.errorObserved, true);
    assert.equal(failed.attempt, 'uncertain');
    assert.doesNotMatch(JSON.stringify(failed), /SDK_PRIVATE_SECRET/);
    assert.equal(f.calls.length, 1);
    await f.runtime.close();
    const offline = createRuntime({ dataDir: directory, connect: false, allowedJid: lid });
    try { assert.deepEqual(await offline.execute(command), failed); }
    finally { await offline.close(); }
  } finally { wait.release(); await pending; await f.runtime.close(); }
});

test('cards cannot reuse other operation keys, including changed persisted vCard bytes', async () => {
  const store = new Store(temporary());
  const others: Operation[] = [
    { kind: 'send', jid: pn, text: 'Example' },
    { kind: 'send-file', jid: pn, path: '/fictional', mime: 'text/plain', caption: '', bytes: 1, sha256: 'fictional' },
    { kind: 'archive', jid: pn, value: true }, { kind: 'mark-read', jid: pn, value: true },
    { ...operation, vcard: operation.vcard + 'changed' },
  ];
  try {
    for (const [index, other] of others.entries()) {
      const key = `collision-${index}`;
      const prior = await perform(store, key, other, () => {}, async () => { throw new Error('Simulated interruption'); });
      await assert.rejects(perform(store, key, operation, () => assert.fail('No revalidation'), async () => assert.fail('No send')), /different arguments/);
      assert.deepEqual(store.request(key), prior);
    }
  } finally { store.close(); }
});

test('card receipts race with SDK return, remain exact and monotonic, and survive deletion/restart', { timeout: 5000 }, async () => {
  const directory = temporary();
  const store = new Store(directory);
  store.observeChat({ id: group, archived: true, unreadCount: 2, conversationTimestamp: 100 });
  store.close();
  const f = fixture(directory);
  const wait = gate();
  f.send(async (jid, content, options) => {
    await wait.promise;
    return generateWAMessage(jid, content, { userJid: otherPn, ...options, upload: async () => assert.fail('No upload') });
  });
  const sending = f.runtime.execute({ ...command, jid: group });
  let final: RequestRecord;
  try {
    const intent = await f.runtime.execute({ command: 'request', key: 'card' }) as RequestRecord;
    const key = { remoteJid: group, fromMe: true, id: intent.messageId! };
    for (const wrong of [{ ...key, remoteJid: lid }, { ...key, fromMe: false }, { ...key, id: 'other' }]) f.emit('messages.update', [{ key: wrong, update: { status: proto.WebMessageInfo.Status.READ } }]);
    f.emit('message-receipt.update', [{ key: { ...key, participant: lid }, receipt: { userJid: lid, readTimestamp: 123 } }]);
    for (const status of [999, -1, 3.5, NaN]) f.emit('messages.update', [{ key, update: { status } }]);
    assert.equal((await f.runtime.execute({ command: 'request', key: 'card' }) as RequestRecord).read, 'unknown');
    f.emit('messages.update', [{ key, update: { status: proto.WebMessageInfo.Status.READ } }]);
    // Deletion before the SDK returns cannot resurrect the current shared body.
    f.emit('messages.delete', { keys: [key] });
    const before = await f.runtime.execute({ command: 'chat', jid: group });
    wait.release();
    final = await sending as RequestRecord;
    assert.equal(final.attempt, 'sdk-returned');
    assert.equal(final.acceptance, 'server-ack');
    assert.equal(final.delivery, 'delivered');
    assert.equal(final.read, 'read');
    for (const status of [proto.WebMessageInfo.Status.PENDING, proto.WebMessageInfo.Status.SERVER_ACK, proto.WebMessageInfo.Status.ERROR]) f.emit('messages.update', [{ key, update: { status } }]);
    final = await f.runtime.execute({ command: 'request', key: 'card' }) as RequestRecord;
    assert.equal(final.read, 'read');
    assert.equal(final.errorObserved, true);
    assert.deepEqual(await f.runtime.execute({ command: 'chat', jid: group }), before);
    const messages = await f.runtime.execute({ command: 'messages', jid: group, limit: 20, offset: 0 }) as ReturnType<typeof messageOutput>[];
    assert.equal(messages[0]?.contacts, null);
    assert.equal(messages[0]?.deletion.status, 'deleted');
    assert.deepEqual(final.operation, { ...operation, jid: group });
  } finally { wait.release(); await sending; await f.runtime.close(); }
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.request('card'), final);
    assert.equal(reopened.messageView(reopened.messages(group)[0]!).contacts, null);
  } finally { reopened.close(); }
});

test('process exit immediately after card persistence preserves the exact intent without another invocation', async () => {
  const directory = temporary();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Store } from './dist/src/store.js';
    import { perform } from './dist/src/operations.js';
    const store = new Store(process.argv[1]);
    await perform(store, 'card', JSON.parse(process.argv[2]), () => {}, async () => process.exit(23));
  `, directory, JSON.stringify(operation)], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 23, child.stderr);
  const store = new Store(directory);
  try {
    const persisted = store.request('card');
    assert.deepEqual(persisted?.operation, operation);
    assert.equal(persisted?.attempt, 'uncertain');
    assert.ok(persisted?.messageId);
  } finally { store.close(); }
  const offline = createRuntime({ dataDir: directory, connect: false });
  try {
    const result = await offline.execute(command) as RequestRecord;
    assert.deepEqual(result.operation, operation);
    assert.equal(result.attempt, 'uncertain');
    assert.equal(result.errorObserved, false);
  } finally { await offline.close(); }
});

test('divergent or missing SDK card returns remain uncertain without storing unexpected messages', async () => {
  for (const mismatch of ['jid', 'id', 'fromMe', 'missing'] as const) {
    const directory = temporary();
    const store = new Store(directory);
    store.observeChat({ id: pn });
    store.close();
    const f = fixture(directory);
    f.send(async (_jid, _content, options): Promise<WAMessage | undefined> => mismatch === 'missing' ? undefined : {
      key: { remoteJid: mismatch === 'jid' ? lid : pn, id: mismatch === 'id' ? 'different' : options?.messageId ?? null, fromMe: mismatch !== 'fromMe' },
    });
    try {
      const result = await f.runtime.execute(command) as RequestRecord;
      assert.equal(result.attempt, 'uncertain');
      assert.equal(result.errorObserved, true);
      assert.equal(result.acceptance, 'unknown');
      assert.deepEqual(await f.runtime.execute(command), result);
      assert.equal(f.calls.length, 1);
      assert.deepEqual(await f.runtime.execute({ command: 'messages', jid: pn, limit: 20, offset: 0 }), []);
    } finally { await f.runtime.close(); }
  }
});
