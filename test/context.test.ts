import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateWAMessageContent, initAuthCreds, makeEventBuffer, proto } from 'baileys';
import type { BaileysEventEmitter, BaileysEventMap, SocketConfig, WAMessage, WAMessageKey, WASocket } from 'baileys';
import processMessage from 'baileys/lib/Utils/process-message.js';
import { pino } from 'pino';
import { messageOutput } from '../src/output.js';
import { perform } from '../src/operations.js';
import { createRuntime } from '../src/runtime.js';
import { decode, encode, Store } from '../src/store.js';

process.umask(0o077);
mkdirSync('.tmp', { recursive: true, mode: 0o700 });
const temporary = () => mkdtempSync(join(process.cwd(), '.tmp', 'context-'));
const pn = '12025550101@s.whatsapp.net';
const other = '12025550102@s.whatsapp.net';
const lid = '123450001@lid';
const group = '120363000000000001@g.us';
const message = (key: WAMessageKey = { remoteJid: pn, id: 'same-id', fromMe: false }): WAMessage => ({
  key, messageTimestamp: 1700000000, message: { conversation: 'Fictional original body' },
});
const vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Fictional Contact\r\nTEL;waid=12025550102:+1 (202) 555-0102\r\nEND:VCARD\r\n';

function fixture(directory = temporary(), events: BaileysEventEmitter = new EventEmitter()) {
  let getMessage: SocketConfig['getMessage'] | undefined;
  let reuploads = 0;
  const fake = { ev: events, end: async () => {}, updateMediaMessage: async () => { reuploads++; throw new Error('Unexpected media I/O'); } };
  const runtime = createRuntime({ dataDir: directory, connect: true }, config => {
    getMessage = config.getMessage;
    return fake as unknown as WASocket;
  });
  runtime.start();
  const emit = <K extends keyof BaileysEventMap>(name: K, value: BaileysEventMap[K]) => { events.emit(name, value); };
  const list = async (jid = pn) => await runtime.execute({ command: 'messages', jid, limit: 100, offset: 0 }) as ReturnType<typeof messageOutput>[];
  emit('connection.update', { connection: 'open' });
  return { runtime, emit, list, directory, getMessage: (key: WAMessageKey) => getMessage?.(key), reuploads: () => reuploads };
}

async function sdkRevocation(events: BaileysEventEmitter, notification: WAMessage) {
  const creds = initAuthCreds();
  creds.me = { id: '12025550199@s.whatsapp.net', name: 'Fictional self' };
  // REVOKE only needs creds and events. Fail if the real SDK touches any I/O service.
  const unused = new Proxy({}, { get() { throw new Error('Unexpected SDK I/O'); } });
  const context = { creds, ev: events, shouldProcessHistoryMsg: false, options: {},
    keyStore: unused, signalRepository: unused, getMessage: async () => undefined,
  } as unknown as Parameters<typeof processMessage>[1];
  await processMessage(notification, context);
}

test('quotes expose only one embedded text/caption level through SDK wrappers, without nested secrets', () => {
  for (const quoted of [
    { conversation: 'Fictional quoted text' },
    { viewOnceMessageV2: { message: { imageMessage: { caption: 'Fictional quoted caption', mediaKey: Buffer.from('PRIVATE_MEDIA_KEY') } } } },
    { documentWithCaptionMessage: { message: { documentMessage: { caption: 'Fictional quoted caption' } } } },
  ]) {
    const output = messageOutput({ ...message(), message: { ephemeralMessage: { message: { extendedTextMessage: {
      text: 'Fictional reply', contextInfo: {
        stanzaId: 'quoted-id', participant: other, remoteJid: group,
        ephemeralSharedSecret: Buffer.from('PRIVATE_EPHEMERAL_SECRET'),
        quotedMessage: { ...quoted, messageContextInfo: { messageSecret: Buffer.from('PRIVATE_MESSAGE_SECRET') },
          senderKeyDistributionMessage: { axolotlSenderKeyDistributionMessage: Buffer.from('PRIVATE_SENDER_KEY') } },
      },
    } } } } });
    assert.deepEqual(output.quote?.reference, { jid: group, id: 'quoted-id', participant: other, fromMe: null });
    assert.equal(output.quote?.source, 'embedded');
    assert.equal(output.quote?.state, 'available');
    assert.match(output.quote?.text ?? '', /Fictional quoted/);
    assert.doesNotMatch(encode(output), /PRIVATE_|mediaKey|SharedSecret|messageSecret|senderKey/);
  }
  const output = messageOutput({ ...message(), message: { extendedTextMessage: { text: 'Reply', contextInfo: {
    quotedMessage: { extendedTextMessage: { text: 'One level', contextInfo: { quotedMessage: { conversation: 'NESTED_QUOTE' } } } },
  } } } });
  assert.equal(output.quote?.reference.id, null);
  assert.equal(output.quote?.reference.participant, null);
  assert.equal(output.quote?.text, 'One level');
  assert.doesNotMatch(encode(output), /NESTED_QUOTE/);
});

test('missing quote content stays unknown and never pulls a colliding body from another chat or author', () => {
  const store = new Store(temporary());
  try {
    store.observeMessage(message());
    const reply = { ...message({ remoteJid: other, id: 'reply', fromMe: false }), message: { extendedTextMessage: {
      text: 'Reply', contextInfo: { stanzaId: 'same-id' },
    } } };
    const quote = store.messageView(reply).quote;
    assert.equal(quote?.state, 'unknown');
    assert.equal(quote?.text, null);
    assert.equal(quote?.reference.jid, other);
    assert.equal(quote?.reference.participant, null);
  } finally { store.close(); }
});

test('single and multiple cards expose shared names/phones with missing, incomplete and malformed states', () => {
  const card = messageOutput({ ...message(), message: { contactMessage: { displayName: 'Shared label', vcard } } }).contacts?.cards[0];
  assert.equal(card?.name, 'Fictional Contact');
  assert.equal(card?.displayName, 'Shared label');
  assert.deepEqual(card?.phones, ['+1 (202) 555-0102']);
  assert.equal(card?.state, 'available');
  const cards = messageOutput({ ...message(), message: { contactsArrayMessage: { contacts: [
    { vcard }, { displayName: 'No vCard' }, { vcard: 'BEGIN:VCARD\nFN:Name only\nEND:VCARD' },
    { vcard: 'BEGIN:VCARD\nFN:Broken\nTEL:invalid\nEND:VCARD' }, { vcard: 'not a card' },
    { vcard: 'BEGIN:VCARD\nFN:Folded\\, Name\nTEL;TYPE=CELL:020 555\n 0101\nEND:VCARD' },
    { vcard: 'BEGIN:VCARD\nFN;ENCODING=b:TmFtZQ==\nTEL:+12025550102\nEND:VCARD' },
  ] } } }).contacts;
  assert.deepEqual(cards?.cards.map(item => item.state), ['available', 'missing', 'incomplete', 'malformed', 'malformed', 'available', 'malformed']);
  assert.equal(cards?.cards[5]?.name, 'Folded, Name');
  assert.deepEqual(cards?.cards[5]?.phones, ['020 5550101']);
  assert.equal(messageOutput({ ...message(), message: { contactsArrayMessage: {} } }).contacts?.state, 'missing');
});

test('received cards do not create verification or PN/LID associations', async () => {
  const f = fixture();
  try {
    f.emit('messages.upsert', { type: 'notify', messages: [{ ...message(), message: { contactMessage: { vcard } } }] });
    const contact = await f.runtime.execute({ command: 'contact', jid: other });
    assert.match(encode(contact), /"status":"unknown"/);
    assert.doesNotMatch(encode(contact), /whatsapp-confirmed|message-key/);
    assert.equal((await f.list())[0]?.contacts?.source, 'shared-content');
  } finally { await f.runtime.close(); }
});

test('legitimate null/status updates preserve content; SDK REVOKE hides it and keeps receipts separate', async () => {
  const f = fixture();
  try {
    f.emit('messages.upsert', { type: 'notify', messages: [message()] });
    f.emit('messages.update', [{ key: message().key, update: { message: null, status: proto.WebMessageInfo.Status.DELIVERY_ACK } }]);
    assert.equal((await f.list())[0]?.text, 'Fictional original body');
    f.emit('messages.update', [{ key: message().key, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE } }]);
    const output = (await f.list())[0];
    assert.equal(output?.id, 'same-id');
    assert.equal(output?.deletion.status, 'deleted');
    assert.equal(output?.text, null);
    assert.equal(output?.media, null);
    assert.equal(output?.quote, null);
    assert.equal(output?.contacts, null);
    assert.deepEqual(await f.runtime.execute({ command: 'search', query: 'original', limit: 100, offset: 0 }), []);
    assert.equal(await f.getMessage(message().key), undefined);
  } finally { await f.runtime.close(); }
});

test('delete before/after message, duplicates, late status/edit/history and restart never resurrect content', async () => {
  for (const before of [true, false]) {
    const directory = temporary();
    const f = fixture(directory);
    try {
      if (!before) f.emit('messages.upsert', { type: 'notify', messages: [message()] });
      f.emit('messages.delete', { keys: [message().key] });
      f.emit('messages.delete', { keys: [message().key] });
      f.emit('messages.upsert', { type: 'append', messages: [message()] });
      f.emit('messages.update', [{ key: message().key, update: { status: proto.WebMessageInfo.Status.READ } }]);
      f.emit('messages.update', [{ key: message().key, update: { message: { editedMessage: { message: { conversation: 'Fictional edited body' } } } } }]);
      f.emit('messaging-history.set', { chats: [], contacts: [], messages: [message()], isLatest: true });
      assert.equal((await f.list())[0]?.text, null);
    } finally { await f.runtime.close(); }
    const store = new Store(directory);
    store.observeMessage(message());
    try {
      assert.equal(store.messages(pn)[0]?.message, null);
      assert.equal(store.messageView(store.messages(pn)[0]!).deletion.status, 'deleted');
      assert.deepEqual(store.search('original', 100, 0), []);
      const audit = store.db.prepare('SELECT audit_json FROM message_deletions').get();
      assert.equal(decode<WAMessage>(String(audit?.audit_json)).message?.conversation, 'Fictional original body');
      assert.throws(() => store.locateMessage({ jid: pn, id: 'same-id' }), /unavailable after deletion/);
    } finally { store.close(); }
  }
});

test('revocation before the original, including protocol wrappers, targets the SDK account-relative key', async () => {
  for (const raw of [false, true]) {
    const f = fixture();
    try {
      if (raw) f.emit('messages.upsert', { type: 'notify', messages: [{
        ...message({ ...message().key, id: 'notification' }), message: { ephemeralMessage: { message: { protocolMessage: {
          type: proto.Message.ProtocolMessage.Type.REVOKE, key: { remoteJid: pn, id: 'same-id', fromMe: true },
        } } } },
      }] });
      else f.emit('messages.update', [{ key: message().key, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE } }]);
      f.emit('messages.upsert', { type: 'append', messages: [message()] });
      assert.equal((await f.list()).find(item => item.id === 'same-id')?.text, null);
      assert.equal((await f.list()).find(item => item.id === 'same-id')?.deletion.source, 'revoke');
    } finally { await f.runtime.close(); }
  }
});

test('real SDK REVOKE processing/buffering cannot override an inconsistent raw chat or participant target', async () => {
  for (const mode of ['immediate', 'buffered', 'merged']) for (const conflict of ['participant', 'chat', 'none']) {
    const events = makeEventBuffer(pino({ level: 'silent' }));
    const f = fixture(temporary(), events);
    const actorKey = { remoteJid: group, id: 'collision', fromMe: false, participant: pn };
    const otherKey = { ...actorKey, participant: other };
    const chatKey = { ...actorKey, remoteJid: '120363000000000002@g.us' };
    const notification: WAMessage = { ...message({ ...actorKey, id: 'notification' }), message: { protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.REVOKE,
      key: { id: 'collision', fromMe: true, remoteJid: conflict === 'chat' ? chatKey.remoteJid : group,
        participant: conflict === 'participant' ? other : pn },
    } } };
    try {
      f.emit('messages.upsert', { type: 'notify', messages: [message(actorKey), message(otherKey), message(chatKey)] });
      if (mode !== 'immediate') events.buffer();
      if (mode === 'merged') f.emit('messages.upsert', { type: 'append', messages: [message(actorKey), message(otherKey), message(chatKey)] });
      f.emit('messages.upsert', { type: 'notify', messages: [notification] });
      await sdkRevocation(events, notification);
      events.flush();
      const output = await f.list(group);
      assert.equal(output.find(item => item.id === 'collision' && item.participant === pn)?.text, conflict === 'none' ? null : 'Fictional original body', `${mode}/${conflict}`);
      assert.equal(output.find(item => item.id === 'collision' && item.participant === other)?.text, 'Fictional original body');
      assert.equal((await f.list(chatKey.remoteJid))[0]?.text, 'Fictional original body');
    } finally { events.destroy(); await f.runtime.close(); }
    const reopened = new Store(f.directory);
    try {
      assert.equal(reopened.message(actorKey)?.message?.conversation ?? null, conflict === 'none' ? null : 'Fictional original body');
      assert.equal(reopened.message(otherKey)?.message?.conversation, 'Fictional original body');
      assert.equal(reopened.message(chatKey)?.message?.conversation, 'Fictional original body');
    } finally { reopened.close(); }
  }
});

test('real SDK administrative revocations preserve exact directions and require an identifiable original author', async () => {
  const self = '12025550199@s.whatsapp.net';
  const cases: { own: boolean; target: WAMessageKey; deleted: 'incoming' | 'own' | null }[] = [
    { own: true, target: { fromMe: false }, deleted: null },
    { own: true, target: { fromMe: false, participant: pn }, deleted: 'incoming' },
    { own: true, target: { fromMe: true }, deleted: 'own' },
    { own: false, target: { fromMe: true, participant: pn }, deleted: 'incoming' },
    { own: false, target: { fromMe: false, participant: other }, deleted: null },
    { own: true, target: {}, deleted: null },
    { own: true, target: { fromMe: false, participant: self }, deleted: null },
  ];
  for (const mode of ['immediate', 'buffered', 'merged']) for (const entry of cases) {
    const events = makeEventBuffer(pino({ level: 'silent' }));
    const f = fixture(temporary(), events);
    const incoming = { remoteJid: group, id: 'collision', fromMe: false, participant: pn };
    const own = { ...incoming, fromMe: true, participant: self };
    const another = { ...incoming, participant: other };
    const content = await generateWAMessageContent({ delete: { remoteJid: group, id: 'collision', ...entry.target } }, {
      upload: async () => { throw new Error('Unexpected SDK upload'); },
    });
    const notification = { ...message({ remoteJid: group, id: 'notification', fromMe: entry.own, participant: entry.own ? self : pn }), message: content };
    try {
      f.emit('messages.upsert', { type: 'notify', messages: [message(incoming), message(own), message(another)] });
      if (mode !== 'immediate') events.buffer();
      if (mode === 'merged') f.emit('messages.upsert', { type: 'append', messages: [message(incoming), message(own), message(another)] });
      f.emit('messages.upsert', { type: 'notify', messages: [notification] });
      await sdkRevocation(events, notification);
      events.flush();
      f.emit('messages.upsert', { type: 'append', messages: [message(incoming), message(own), message(another)] });
      const output = await f.list(group);
      assert.equal(output.find(item => item.id === 'collision' && item.fromMe)?.text, entry.deleted === 'own' ? null : 'Fictional original body', `${mode}/${encode(entry)}`);
      assert.equal(output.find(item => item.id === 'collision' && !item.fromMe && item.participant === pn)?.text, entry.deleted === 'incoming' ? null : 'Fictional original body');
      assert.equal(output.find(item => item.id === 'collision' && item.participant === other)?.text, 'Fictional original body');
    } finally { events.destroy(); await f.runtime.close(); }
    const reopened = new Store(f.directory);
    try {
      assert.equal(reopened.message(incoming)?.message?.conversation ?? null, entry.deleted === 'incoming' ? null : 'Fictional original body');
      assert.equal(reopened.message(own)?.message?.conversation ?? null, entry.deleted === 'own' ? null : 'Fictional original body');
      assert.equal(reopened.message(another)?.message?.conversation, 'Fictional original body');
    } finally { reopened.close(); }
  }
});

test('a derived REVOKE without its notification cannot guess a target before the original or after restart', async () => {
  const f = fixture();
  const key = message().key;
  try {
    f.emit('messages.update', [{ key, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE,
      key: { ...key, id: 'missing-notification' },
    } }]);
    f.emit('messages.upsert', { type: 'notify', messages: [message()] });
    assert.equal((await f.list())[0]?.text, 'Fictional original body');
    assert.match(encode(await f.runtime.execute({ command: 'events', after: 0 })), /unverified-revoke-notification/);
  } finally { await f.runtime.close(); }
  const reopened = new Store(f.directory);
  try { assert.equal(reopened.message(key)?.message?.conversation, 'Fictional original body'); }
  finally { reopened.close(); }
});

test('exact deletion keys isolate colliding chats, directions, participants and PN/LID histories', () => {
  const store = new Store(temporary());
  const incoming = { remoteJid: group, id: 'same-id', fromMe: false, participant: pn };
  const keys = [incoming, { ...incoming, participant: other }, { ...incoming, fromMe: true },
    { remoteJid: pn, id: 'same-id', fromMe: false }, { remoteJid: lid, id: 'same-id', fromMe: false }];
  try {
    for (const key of keys) store.observeMessage(message(key));
    store.deleteMessages({ keys: [incoming] });
    assert.equal(store.message(incoming)?.message, null);
    for (const key of keys.slice(1)) assert.equal(store.message(key)?.message?.conversation, 'Fictional original body');
    store.deleteMessages({ keys: [{ remoteJid: group, id: 'same-id', fromMe: false }] });
    store.deleteMessages({ keys: [{ remoteJid: group, id: 'same-id', participant: other }] });
    store.observeMessage({ ...message({ ...incoming, id: 'inconsistent-notification' }), message: { protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.REVOKE, key: { remoteJid: pn, id: 'same-id', fromMe: true },
    } } });
    assert.equal(store.message(keys[1]!)?.message?.conversation, 'Fictional original body');
    assert.match(encode(store.events(0)), /message-deletion-unknown/);
  } finally { store.close(); }
});

test('own group deletion survives participant enrichment', async () => {
  const f = fixture();
  const key = { remoteJid: group, id: 'same-id', fromMe: true };
  try {
    f.emit('messages.upsert', { type: 'notify', messages: [message(key)] });
    f.emit('messages.delete', { keys: [{ ...key, participant: pn }] });
    f.emit('messages.upsert', { type: 'notify', messages: [message({ ...key, participant: lid })] });
    assert.equal((await f.list(group)).length, 1);
    assert.equal((await f.list(group))[0]?.text, null);
    assert.equal(await f.getMessage(key), undefined);
  } finally { await f.runtime.close(); }
});

test('deletion does not rewrite immutable intents, receipt evidence or idempotency keys', async () => {
  const directory = temporary();
  const store = new Store(directory);
  const operation = { kind: 'send' as const, jid: pn, text: 'Fictional outbound intent' };
  const sent = await perform(store, 'immutable', operation, () => {}, async id => message({ remoteJid: pn, id, fromMe: true }));
  const key = { remoteJid: pn, id: sent.messageId, fromMe: true };
  store.deleteMessages({ keys: [key] });
  store.updateMessage({ key, update: { status: proto.WebMessageInfo.Status.READ } });
  assert.equal(store.request('immutable')?.read, 'read');
  assert.deepEqual(store.request('immutable')?.operation, operation);
  store.close();
  const reopened = new Store(directory);
  try {
    const repeated = await perform(reopened, 'immutable', operation, () => { throw new Error('Unexpected validation'); }, async () => { throw new Error('Unexpected resend'); });
    assert.equal(repeated.messageId, sent.messageId);
    assert.equal(repeated.read, 'read');
    assert.equal(reopened.message(key)?.message, null);
    assert.equal(reopened.messages(lid).length, 0);
  } finally { reopened.close(); }
});

test('chat-wide deletes hide known rows and old/undated arrivals, while newer messages and other chats remain available', () => {
  const directory = temporary();
  const store = new Store(directory);
  store.observeMessage(message());
  store.observeMessage(message({ ...message().key, remoteJid: other }));
  const incompleteGroup = { remoteJid: group, id: 'incomplete-author', fromMe: false };
  store.observeMessage(message(incompleteGroup));
  store.deleteMessages({ jid: group, all: true });
  store.deleteMessages({ jid: pn, all: true });
  store.close();
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.message(incompleteGroup)?.message, null);
    assert.equal(reopened.deletion(incompleteGroup)?.status, 'deleted');
    reopened.observeMessage(message({ ...message().key, id: 'late-old' }));
    reopened.observeMessage({ key: { ...message().key, id: 'undated' }, message: { conversation: 'Undated body' } });
    reopened.observeMessage({ ...message({ ...message().key, id: 'new' }), messageTimestamp: Math.floor(Date.now() / 1000) + 60 });
    assert.equal(reopened.message(message().key)?.message, null);
    assert.equal(reopened.message({ ...message().key, id: 'late-old' })?.message, null);
    assert.equal(reopened.deletion({ ...message().key, id: 'late-old' })?.status, 'unknown');
    assert.equal(reopened.message({ ...message().key, id: 'undated' })?.message, null);
    assert.equal(reopened.message({ ...message().key, id: 'new' })?.message?.conversation, 'Fictional original body');
    assert.equal(reopened.message({ ...message().key, remoteJid: other })?.message?.conversation, 'Fictional original body');
    assert.equal(reopened.search('original', 100, 0, pn).length, 1);
  } finally { reopened.close(); }
});

test('deleted media cannot reach download/reupload or SDK getMessage, and no file is created', async () => {
  const f = fixture();
  const path = join(f.directory, 'must-not-exist.bin');
  try {
    f.emit('messages.upsert', { type: 'notify', messages: [{ ...message(), message: { imageMessage: {
      caption: 'Fictional private caption', mediaKey: Buffer.from('PRIVATE_MEDIA_KEY'), directPath: '/private',
    } } }] });
    f.emit('messages.delete', { keys: [message().key] });
    await assert.rejects(f.runtime.execute({ command: 'download', jid: pn, id: 'same-id', path }), /unavailable after deletion/);
    assert.equal(f.reuploads(), 0);
    assert.equal(existsSync(path), false);
    assert.equal(await f.getMessage(message().key), undefined);
    assert.doesNotMatch(encode(await f.list()), /caption|PRIVATE_|directPath|mediaKey/);
    assert.deepEqual(await f.runtime.execute({ command: 'search', query: 'caption', limit: 100, offset: 0 }), []);
  } finally { await f.runtime.close(); }
});

test('quoted snapshots of a known deleted target are hidden without crossing chat/author boundaries', () => {
  const store = new Store(temporary());
  const key = { remoteJid: group, id: 'same-id', fromMe: false, participant: pn };
  const reply = (jid: string, participant?: string): WAMessage => ({ ...message(), key: { remoteJid: jid, id: 'reply', fromMe: false },
    message: { extendedTextMessage: { text: 'Reply', contextInfo: {
      stanzaId: 'same-id', ...(participant ? { participant } : {}), quotedMessage: { conversation: 'Quoted snapshot' },
    } } },
  });
  try {
    store.deleteMessages({ keys: [key] });
    assert.equal(store.messageView(reply(group, pn)).quote?.state, 'deleted');
    assert.equal(store.messageView(reply(group, pn)).quote?.text, null);
    assert.equal(store.messageView(reply(group)).quote?.state, 'unknown');
    assert.equal(store.messageView(reply(group)).quote?.text, null);
    assert.equal(store.messageView(reply(other, pn)).quote?.text, 'Quoted snapshot');
    assert.equal(store.messageView(reply(group, other)).quote?.text, 'Quoted snapshot');
  } finally { store.close(); }
});

test('legacy delete journals migrate once without exposing retained audit data', () => {
  const directory = temporary();
  const store = new Store(directory);
  store.observeMessage(message());
  store.event('messages.delete', { keys: [message().key] });
  store.set('migration', 'message-deletions-v1', null);
  store.close();
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.message(message().key)?.message, null);
    assert.deepEqual(reopened.search('original', 100, 0), []);
    assert.doesNotMatch(encode(reopened.events(0)), /original body/);
    assert.match(String(reopened.db.prepare('SELECT audit_json FROM message_deletions').get()?.audit_json), /original body/);
  } finally { reopened.close(); }
});

test('legacy derived administrative stubs cannot override raw direction evidence during migration or later status updates', async () => {
  for (const participant of [null, pn]) for (const deletedNotification of [false, true]) {
    const directory = temporary();
    const store = new Store(directory);
    const incoming = { remoteJid: group, id: 'collision', fromMe: false, participant: pn };
    const own = { remoteJid: group, id: 'collision', fromMe: true };
    store.observeMessage(message(incoming));
    store.observeMessage(message(own));
    const notification = { ...message({ ...own, id: 'notification' }), message: await generateWAMessageContent({ delete: {
      remoteJid: group, id: 'collision', fromMe: false, participant,
    } }, { upload: async () => { throw new Error('Unexpected SDK upload'); } }) };
    // Recreate the previous runtime's persisted snapshot, without running feature logic.
    store.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(group, 'notification', 1, '', 1700000000, encode(notification));
    store.db.prepare('UPDATE messages SET json=? WHERE jid=? AND id=? AND from_me=1').run(
      encode({ ...message(own), messageStubType: proto.WebMessageInfo.StubType.REVOKE }), group, 'collision');
    if (deletedNotification) store.event('messages.delete', { keys: [notification.key] });
    store.set('migration', 'message-deletions-v1', null);
    store.close();
    const reopened = new Store(directory);
    try {
      assert.equal(reopened.message(own)?.message?.conversation, 'Fictional original body');
      assert.equal(reopened.message(own)?.messageStubType, undefined);
      assert.equal(reopened.message(incoming)?.message?.conversation ?? null, participant ? null : 'Fictional original body');
      reopened.updateMessage({ key: own, update: { status: proto.WebMessageInfo.Status.READ } });
      assert.equal(reopened.message(own)?.message?.conversation, 'Fictional original body');
      assert.equal(reopened.deletion(own), undefined);
      if (deletedNotification) {
        assert.equal(reopened.message(notification.key)?.message, null);
        assert.equal(reopened.deletion(notification.key)?.source, 'messages.delete');
      }
    } finally { reopened.close(); }
    const again = new Store(directory);
    try {
      assert.equal(again.message(own)?.message?.conversation, 'Fictional original body');
      assert.equal(again.message(incoming)?.message?.conversation ?? null, participant ? null : 'Fictional original body');
      if (deletedNotification) assert.equal(again.message(notification.key)?.message, null);
    } finally { again.close(); }
  }
});

test('legacy chat deletes preserve newer history and suppress unknown quoted snapshots across restart', () => {
  const directory = temporary();
  const store = new Store(directory);
  store.observeMessage(message());
  store.event('messages.delete', { jid: pn, all: true });
  store.observeMessage({ ...message({ ...message().key, id: 'new' }), messageTimestamp: Math.floor(Date.now() / 1000) + 60 });
  store.set('migration', 'message-deletions-v1', null);
  store.close();
  const reopened = new Store(directory);
  const reply = (id: string): WAMessage => ({ ...message({ ...message().key, id: 'reply' }), message: { extendedTextMessage: { text: 'Reply', contextInfo: {
    stanzaId: id, participant: pn, quotedMessage: { conversation: 'Embedded snapshot' },
  } } } });
  try {
    assert.equal(reopened.message(message().key)?.message, null);
    assert.equal(reopened.message({ ...message().key, id: 'new' })?.message?.conversation, 'Fictional original body');
    assert.equal(reopened.messageView(reply('same-id')).quote?.state, 'unknown');
    assert.equal(reopened.messageView(reply('not-seen')).quote?.text, null);
    assert.equal(reopened.messageView(reply('new')).quote?.text, 'Embedded snapshot');
  } finally { reopened.close(); }
});

test('a new reply with no quote ID cannot expose a cleared chat snapshot through history or after restart', async () => {
  const f = fixture();
  const reply: WAMessage = { ...message({ ...message().key, id: 'new-reply' }), messageTimestamp: Math.floor(Date.now() / 1000) + 60,
    message: { extendedTextMessage: { text: 'New reply', contextInfo: {
      participant: pn, quotedMessage: { imageMessage: { caption: 'Cleared caption' } },
    } } },
  };
  try {
    f.emit('messages.upsert', { type: 'notify', messages: [message()] });
    f.emit('messages.delete', { jid: pn, all: true });
    f.emit('messages.upsert', { type: 'notify', messages: [reply] });
    const quote = (await f.list()).find(item => item.id === 'new-reply')?.quote;
    assert.equal(quote?.state, 'unknown');
    assert.equal(quote?.text, null);
    assert.equal(quote?.contentType, null);
  } finally { await f.runtime.close(); }
  const reopened = new Store(f.directory);
  try {
    const output = reopened.messages(pn).map(item => reopened.messageView(item));
    assert.doesNotMatch(encode(output), /Cleared caption/);
    assert.equal(output.find(item => item.id === 'new-reply')?.quote?.state, 'unknown');
  } finally { reopened.close(); }
});
