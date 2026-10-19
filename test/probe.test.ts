import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { proto } from 'baileys';
import type { WAMessage } from 'baileys';
import { hasLinkedCredentials, sqliteAuth } from '../src/auth.js';
import { diagnosticIssue, reconnectDelay } from '../src/health.js';
import { recipientJid } from '../src/identity.js';
import { perform } from '../src/operations.js';
import { chatOutput, messageOutput } from '../src/output.js';
import { savePairingQr } from '../src/pairing.js';
import { decode, encode, Store } from '../src/store.js';

process.umask(0o077);
mkdirSync('.tmp', { recursive: true, mode: 0o700 });
const temporary = (): string => mkdtempSync(join(process.cwd(), '.tmp', 'test-'));
const alice = '12025550101@s.whatsapp.net';
const bob = '12025550102@s.whatsapp.net';
const lid = '123456789012345@lid';
const group = '120363000000000001@g.us';
const message = (id = 'message-1'): WAMessage => ({
  key: { remoteJid: alice, id, fromMe: false }, messageTimestamp: 1700000000,
  message: { conversation: 'Fictional test message' },
});

test('credentials, Signal binary keys and protobuf app-state keys survive reopening', async () => {
  const path = temporary();
  const first = new Store(path);
  const auth = sqliteAuth(first);
  const identity = Buffer.from(auth.state.creds.signedIdentityKey.private);
  auth.save({ registered: true, accountSyncCounter: 3 });
  await auth.state.keys.set({
    session: { test: Buffer.from([1, 2, 3]) },
    'app-state-sync-key': { test: proto.Message.AppStateSyncKeyData.create({ keyData: Buffer.from([4, 5]) }) },
  });
  first.close();
  const reopened = new Store(path);
  try {
    const restored = sqliteAuth(reopened);
    assert.equal(restored.state.creds.registered, true);
    assert.equal(restored.state.creds.accountSyncCounter, 3);
    assert.deepEqual(Buffer.from(restored.state.creds.signedIdentityKey.private), identity);
    assert.deepEqual((await restored.state.keys.get('session', ['test'])).test, Buffer.from([1, 2, 3]));
    const key = (await restored.state.keys.get('app-state-sync-key', ['test'])).test;
    assert.ok(key instanceof proto.Message.AppStateSyncKeyData);
    assert.deepEqual(key.keyData, Buffer.from([4, 5]));
    await restored.state.keys.set({ session: { test: null } });
    assert.equal((await restored.state.keys.get('session', ['test'])).test, undefined);
  } finally { reopened.close(); }
});

test('a failed key batch rolls back every item', () => {
  const store = new Store(temporary());
  try {
    assert.throws(() => store.transaction(() => {
      store.set('session', 'first', Buffer.from([1]));
      throw new Error('Disk failure simulation');
    }));
    assert.equal(store.get('session', 'first'), undefined);
  } finally { store.close(); }
});

test('web pairing credentials survive restart even while the SDK registered flag stays false', () => {
  const path = temporary();
  const store = new Store(path);
  const auth = sqliteAuth(store);
  assert.equal(hasLinkedCredentials(auth.state.creds), false);
  // A code-pairing request can set me before any signed account has been installed.
  auth.save({ me: { id: alice } });
  assert.equal(hasLinkedCredentials(auth.state.creds), false);
  auth.save({ account: { details: Buffer.from('fictional-device-identity'), deviceSignature: Buffer.from('fictional-signature') } });
  store.close();
  const reopened = new Store(path);
  try {
    const restored = sqliteAuth(reopened);
    assert.equal(restored.state.creds.registered, false);
    assert.equal(hasLinkedCredentials(restored.state.creds), true);
  } finally { reopened.close(); }
});

test('duplicates keep one message; directions, participants and chats remain distinct', () => {
  const path = temporary();
  const store = new Store(path);
  store.observeMessage(message());
  store.observeMessage(message());
  store.observeMessage({ ...message(), key: { ...message().key, fromMe: true } });
  store.observeMessage({ ...message(), key: { ...message().key, remoteJid: bob } });
  store.observeMessage({ ...message(), key: { ...message().key, participant: bob } });
  store.observeChat({ id: alice, archived: true, unreadCount: -1 });
  store.observeChat({ id: alice, name: 'Example contact' });
  store.close();
  const reopened = new Store(path);
  try {
    assert.equal(reopened.messages(alice).length, 3);
    assert.equal(reopened.messages(bob).length, 1);
    assert.equal(reopened.chat(alice)?.archived, true);
    assert.equal(reopened.chat(alice)?.unreadCount, -1);
    assert.equal(reopened.chat(alice)?.name, 'Example contact');
  } finally { reopened.close(); }
});

test('unavailable content and incomplete keys remain visible as evidence gaps', () => {
  const store = new Store(temporary());
  try {
    store.observeMessage({ ...message(), message: null, messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT });
    store.observeMessage({ key: { id: 'missing-recipient' } });
    const events = encode(store.events(0));
    assert.match(events, /message-content-unavailable/);
    assert.match(events, /incomplete-message-key/);
    assert.equal(store.messages(alice)[0]?.message, null);
  } finally { store.close(); }
});

test('recipient identifiers are explicit and LIDs never turn into telephone JIDs', () => {
  assert.equal(recipientJid(alice), alice);
  assert.equal(recipientJid(lid), lid);
  assert.equal(recipientJid(group), group);
  assert.equal(recipientJid('12025550101-1700000000@g.us'), '12025550101-1700000000@g.us');
  for (const value of ['Example contact', '123456789012345', '+12025550101', '12025550101:3@s.whatsapp.net', 'Example group@g.us', 'status@broadcast']) {
    assert.throws(() => recipientJid(value));
  }
});

test('a group send and its phone echo share one message despite the echo adding a participant', () => {
  const store = new Store(temporary());
  try {
    const sent = { ...message(), key: { id: 'group-send', remoteJid: group, fromMe: true } };
    store.observeMessage(sent);
    store.observeMessage({ ...sent, key: { ...sent.key, participant: lid }, status: proto.WebMessageInfo.Status.SERVER_ACK });
    assert.equal(store.messages(group).length, 1);
    assert.equal(store.message(sent.key)?.key.participant, lid);
    assert.equal(store.message(sent.key)?.status, proto.WebMessageInfo.Status.SERVER_ACK);
  } finally { store.close(); }
});

test('group intents persist and SDK returns do not imply delivery to every participant', async () => {
  const store = new Store(temporary());
  try {
    const result = await perform(store, 'group-send-key', { kind: 'send', jid: group, text: 'Example group message' }, () => {}, async id => ({
      key: { id, remoteJid: group, fromMe: true }, message: { conversation: 'Example group message' },
    }));
    assert.equal(result.attempt, 'sdk-returned');
    assert.equal(result.acceptance, 'unknown');
    assert.equal(result.delivery, 'unknown');
    assert.equal(result.read, 'unknown');
  } finally { store.close(); }
});

test('service notifications are not decryption gaps, and later plaintext clears a ciphertext stub', () => {
  const store = new Store(temporary());
  try {
    store.observeMessage({ ...message('service-event'), message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE });
    assert.doesNotMatch(encode(store.events(0)), /message-content-unavailable/);
    store.observeMessage({ ...message(), message: null, messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT, messageStubParameters: ['No session found to decrypt message'] });
    assert.match(encode(store.events(0)), /message-content-unavailable/);
    store.observeMessage(message());
    assert.equal(store.message(message().key)?.messageStubType, undefined);
    assert.equal(store.message(message().key)?.messageStubParameters, undefined);
    assert.equal(store.message(message().key)?.message?.conversation, 'Fictional test message');
  } finally { store.close(); }
});

test('request and message ID are durable before invocation, and repeated keys do not invoke again', async () => {
  const path = temporary();
  const store = new Store(path);
  let calls = 0;
  const operation = { kind: 'send' as const, jid: lid, text: 'Example text' };
  const result = await perform(store, 'example-key', operation, () => {}, async id => {
    calls++;
    assert.equal(store.request('example-key')?.messageId, id);
    assert.equal(store.request('example-key')?.attempt, 'uncertain');
    assert.ok(id);
    return { key: { id, remoteJid: lid, fromMe: true }, message: { conversation: operation.text } };
  });
  assert.equal(result.attempt, 'sdk-returned');
  assert.equal(result.acceptance, 'unknown');
  assert.equal(result.delivery, 'unknown');
  await assert.rejects(perform(store, 'example-key', { ...operation, text: 'Different text' }, () => {}, async () => {}), /different arguments/);
  store.close();
  const reopened = new Store(path);
  try {
    assert.deepEqual(await perform(reopened, 'example-key', operation, () => { throw new Error('No connection'); }, async () => { calls++; }), result);
    assert.equal(calls, 1);
  } finally { reopened.close(); }
});

test('network failures remain uncertain and are never automatically resent after restart', async () => {
  const path = temporary();
  const store = new Store(path);
  const operation = { kind: 'send' as const, jid: alice, text: 'Example text' };
  let calls = 0;
  const result = await perform(store, 'timeout-key', operation, () => {}, async () => { calls++; throw new Error('Timeout after write'); });
  assert.equal(result.attempt, 'uncertain');
  assert.equal(result.errorObserved, true);
  assert.equal(result.acceptance, 'unknown');
  store.close();
  const reopened = new Store(path);
  try {
    await perform(reopened, 'timeout-key', operation, () => {}, async () => { calls++; });
    assert.equal(calls, 1);
  } finally { reopened.close(); }
});

test('process exit between durable intent and completion preserves uncertainty and releases writer lock', async () => {
  const path = temporary();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Store } from './dist/src/store.js';
    import { perform } from './dist/src/operations.js';
    const store = new Store(process.argv[1]);
    await perform(store, 'crash-key', {kind:'send',jid:'${alice}',text:'Example text'}, () => {}, async () => process.exit(23));
  `, path], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  const store = new Store(path);
  try {
    assert.equal(store.request('crash-key')?.attempt, 'uncertain');
    await perform(store, 'crash-key', { kind: 'send', jid: alice, text: 'Example text' }, () => {}, async () => {
      assert.fail('A request left uncertain by process exit must not be re-executed');
    });
  } finally { store.close(); }
});

test('receipts are correlated by full recipient identity and never regress', async () => {
  const store = new Store(temporary());
  try {
    const sent = await perform(store, 'receipt-key', { kind: 'send', jid: lid, text: 'Example' }, () => {}, async id => ({
      key: { id, remoteJid: lid, fromMe: true }, message: { conversation: 'Example' },
    }));
    const key = { id: sent.messageId, remoteJid: lid, fromMe: true };
    store.receipt({ ...key, remoteJid: alice }, proto.WebMessageInfo.Status.READ);
    store.receipt({ ...key, fromMe: false }, proto.WebMessageInfo.Status.READ);
    assert.equal(store.request('receipt-key')?.read, 'unknown');
    store.receipt(key, proto.WebMessageInfo.Status.SERVER_ACK);
    assert.equal(store.request('receipt-key')?.acceptance, 'server-ack');
    assert.equal(store.request('receipt-key')?.delivery, 'unknown');
    store.receipt(key, proto.WebMessageInfo.Status.DELIVERY_ACK);
    store.receipt(key, proto.WebMessageInfo.Status.READ);
    store.receipt(key, proto.WebMessageInfo.Status.PENDING);
    store.receipt(key, proto.WebMessageInfo.Status.ERROR);
    assert.equal(store.request('receipt-key')?.read, 'read');
    assert.equal(store.request('receipt-key')?.delivery, 'delivered');
    assert.equal(store.request('receipt-key')?.errorObserved, true);
  } finally { store.close(); }
});

test('a receipt arriving before sendMessage returns survives the completion update', async () => {
  const store = new Store(temporary());
  try {
    const sent = await perform(store, 'racing-receipt', { kind: 'send', jid: alice, text: 'Example' }, () => {}, async id => {
      store.receipt({ id, remoteJid: alice, fromMe: true }, proto.WebMessageInfo.Status.DELIVERY_ACK);
      return { key: { id, remoteJid: alice, fromMe: true }, message: { conversation: 'Example' } };
    });
    assert.equal(sent.delivery, 'delivered');
    assert.equal(sent.attempt, 'sdk-returned');
  } finally { store.close(); }
});

test('archive/read calls do not optimistically overwrite observed chat state', async () => {
  const store = new Store(temporary());
  try {
    store.observeChat({ id: alice, archived: false, unreadCount: -1 });
    await perform(store, 'archive-key', { kind: 'archive', jid: alice, value: true }, () => {}, async () => {});
    await perform(store, 'read-key', { kind: 'mark-read', jid: alice, value: true }, () => {}, async () => {});
    assert.equal(store.chat(alice)?.archived, false);
    assert.equal(store.chat(alice)?.unreadCount, -1);
    store.observeChat({ id: alice, archived: true, unreadCount: 0 });
    assert.equal(store.chat(alice)?.archived, true);
  } finally { store.close(); }
});

test('failed preconditions persist no request and perform no network attempt', async () => {
  const store = new Store(temporary());
  try {
    await assert.rejects(perform(store, 'blocked-key', { kind: 'send', jid: alice, text: 'Example' }, () => {
      throw new Error('Recipient is not the approved test chat');
    }, async () => assert.fail('Must not invoke')), /approved test chat/);
    assert.equal(store.request('blocked-key'), undefined);
  } finally { store.close(); }
});

test('permissions reject public/symlinked storage and a second writer', () => {
  const path = temporary();
  const store = new Store(path);
  try {
    assert.equal(statSync(join(path, 'probe.sqlite')).mode & 0o777, 0o600);
    assert.equal(statSync(path).mode & 0o777, 0o700);
    assert.throws(() => new Store(path), /locked/);
  } finally { store.close(); }
  const publicPath = temporary();
  chmodSync(publicPath, 0o755);
  assert.throws(() => new Store(publicPath), /private path/);
  const target = temporary();
  writeFileSync(join(target, 'existing'), 'Preserve this file');
  symlinkSync(target, join(temporary(), 'linked'));
  const links = temporary();
  symlinkSync(target, join(links, 'probe.sqlite'));
  assert.throws(() => new Store(links), /private path/);
  assert.equal(readFileSync(join(target, 'existing'), 'utf8'), 'Preserve this file');
});

test('JSONL process is offline by default, reports partial coverage and refuses mutations', () => {
  const child = spawnSync(process.execPath, ['dist/src/probe.js', '--data-dir', temporary()], {
    encoding: 'utf8', input: [
      '{invalid json}',
      encode({ id: 'status-1', command: 'status' }),
      encode({ id: 'send-1', command: 'send', jid: alice, key: 'offline-key', text: 'Example' }),
      encode({ id: 'messages-1', command: 'messages', jid: alice, limit: -1 }),
      encode({ id: 'qr-1', command: 'pair-qr' }),
      encode({ id: 'drop-1', command: 'drop-connection' }),
      encode({ id: 'stop-1', command: 'stop' }),
    ].join('\n') + '\n',
  });
  assert.equal(child.status, 0, child.stderr);
  const output: { ok: boolean; connection?: string; coverage?: string; error?: string }[] = child.stdout.trim().split('\n').map(line => decode(line));
  assert.equal(output.length, 7);
  assert.equal(output[0]?.ok, false);
  assert.equal(output[1]?.connection, 'offline');
  assert.equal(output[1]?.coverage, 'partial');
  assert.equal(output[2]?.ok, false);
  assert.match(output[2]?.error ?? '', /test-jid/);
  assert.equal(output[3]?.ok, false);
  assert.equal(output[4]?.ok, false);
  assert.match(output[4]?.error ?? '', /qrAvailable/);
  assert.equal(output[5]?.ok, false);
  assert.match(output[5]?.error ?? '', /not open/);
  assert.equal(output[6]?.ok, true);
});

test('pairing QR images stay private and subsequent requests preserve existing files', async () => {
  const directory = temporary();
  const first = await savePairingQr('fictional-pairing-payload-1', directory);
  const content = readFileSync(first);
  const second = await savePairingQr('fictional-pairing-payload-2', directory);
  assert.notEqual(first, second);
  assert.equal(statSync(first).mode & 0o777, 0o600);
  assert.equal(statSync(second).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(first), content);
  assert.notDeepEqual(readFileSync(second), content);
});

test('reconnection stops on terminal errors and caps retry backoff', () => {
  for (const code of [401, 403, 411, 440, 500]) assert.equal(reconnectDelay(code, 0), undefined);
  assert.equal(reconnectDelay(515, 0), 0);
  assert.equal(reconnectDelay(408, 0), 1000);
  assert.equal(reconnectDelay(503, 7), 30000);
  assert.equal(reconnectDelay(undefined, 8), undefined);
  assert.equal(diagnosticIssue('failed to sync regular from v1, giving up'), 'app-state-sync-incomplete');
  assert.equal(diagnosticIssue('regular blocked on missing key, parking'), 'app-state-sync-incomplete');
  assert.equal(diagnosticIssue('Timeout in AwaitingInitialSync, forcing state to Online'), 'initial-sync-timed-out');
  assert.equal(diagnosticIssue('Connection is now Online'), undefined);
});

test('dependency console session objects cannot leak keys or contaminate JSON stdout', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { installConsoleDiagnostics } from './dist/src/diagnostics.js';
    installConsoleDiagnostics();
    console.info('Closing session:', {privateKey:'DO_NOT_LEAK'});
    console.warn('Session already closed', {privateKey:'DO_NOT_LEAK'});
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.doesNotMatch(child.stderr, /DO_NOT_LEAK|privateKey/);
  assert.match(child.stderr, /Closing session/);
});

test('public message/chat/event projections omit protocol secrets while private storage preserves them', () => {
  const store = new Store(temporary());
  try {
    const privateMessage: WAMessage = {
      ...message(),
      message: {
        conversation: 'Fictional readable text',
        messageContextInfo: { messageSecret: Buffer.from('PRIVATE_MESSAGE_SECRET') },
        senderKeyDistributionMessage: { groupId: group, axolotlSenderKeyDistributionMessage: Buffer.from('PRIVATE_SENDER_KEY') },
      },
    };
    store.observeMessage(privateMessage);
    const chat = { id: alice, archived: false, unreadCount: 0, messages: [{ message: privateMessage }] };
    store.observeChat(chat);
    store.event('chats.update', [chat]);
    const output = encode({ message: messageOutput(privateMessage), chat: chatOutput(chat), events: store.events(0), chats: store.chats() });
    assert.match(output, /Fictional readable text/);
    assert.doesNotMatch(output, /messageSecret|senderKeyDistributionMessage|PRIVATE_MESSAGE_SECRET|PRIVATE_SENDER_KEY/);
    assert.deepEqual(store.message(privateMessage.key)?.message?.messageContextInfo?.messageSecret, Buffer.from('PRIVATE_MESSAGE_SECRET'));
    store.observeChat({ id: alice, unreadCount: 0, markedAsUnread: true });
    assert.equal(store.chatView(alice)?.unread, true);
    store.observeChat({ id: alice, unreadCount: 0 });
    assert.equal(store.chatView(alice)?.unread, false);
  } finally { store.close(); }
});

test('mutation uncertainty hides only the affected stale field until a corresponding fresh event, across restart', async () => {
  const directory = temporary();
  const store = new Store(directory);
  store.observeChat({ id: alice, archived: false, unreadCount: 1 });
  await perform(store, 'read-pending', { kind: 'mark-read', jid: alice, value: true }, () => {}, async () => {});
  assert.equal(store.chat(alice)?.unreadCount, 1);
  assert.equal(store.chatView(alice)?.unread, null);
  assert.equal(store.chatView(alice)?.archived, false);
  store.observeChat({ id: alice, archived: true });
  assert.equal(store.chatView(alice)?.unread, null);
  store.close();
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.chatView(alice)?.unread, null);
    assert.equal(reopened.chatView(alice)?.pending.unread?.key, 'read-pending');
    reopened.observeChat({ id: alice, unreadCount: 0 });
    assert.equal(reopened.chatView(alice)?.unread, false);
    assert.deepEqual(reopened.chatView(alice)?.pending, {});
    await perform(reopened, 'archive-pending', { kind: 'archive', jid: alice, value: false }, () => {}, async () => {});
    assert.equal(reopened.chatView(alice)?.archived, null);
    assert.equal(reopened.chatView(alice)?.unread, false);
    reopened.observeChat({ id: alice, archived: false });
    assert.equal(reopened.chatView(alice)?.archived, false);
  } finally { reopened.close(); }
});
