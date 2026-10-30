import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initAuthCreds, makeEventBuffer, proto } from 'baileys';
import type { WAMessage, WAMessageKey, WASocket } from 'baileys';
import { pino } from 'pino';
import processMessage from 'baileys/lib/Utils/process-message.js';
import { createRuntime } from '../src/runtime.js';
import { messageOutput } from '../src/output.js';
import { Store, encode } from '../src/store.js';

const peer = '900000000000101@lid';
const me = '12025550199@s.whatsapp.net';
const meLid = '900000000000199@lid';
const base = 1700000000;
const secret = Buffer.alloc(32, 7);
const context = { messageSecret: secret };

function original(
  key: WAMessageKey = {
    remoteJid: peer,
    id: 'fictional-original',
    fromMe: false,
    participant: '',
  },
): WAMessage {
  return {
    key,
    messageTimestamp: base,
    message: proto.Message.fromObject({
      conversation: 'Fictional typo',
      messageContextInfo: context,
    }),
  };
}

function edit(
  message: WAMessage,
  seconds = 14,
  text = 'Fictional correction',
  legacy = false,
): WAMessage {
  const author = message.key.fromMe
    ? meLid
    : message.key.participant || message.key.remoteJid!;
  const target = {
    ...message.key,
    remoteJid:
      message.key.fromMe || message.key.participant
        ? (message.key.remoteJid ?? null)
        : meLid,
    fromMe: true,
  };
  const protocolMessage = {
    key: target,
    type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
    editedMessage: { conversation: text },
    timestampMs: (base + seconds) * 1000,
  };
  const encIv = Buffer.alloc(12, seconds);
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      Buffer.alloc(32),
      Buffer.from(message.key.id + author + author + 'Message Edit'),
      32,
    ),
  );
  const cipher = createCipheriv('aes-256-gcm', key, encIv);
  const encPayload = Buffer.concat([
    cipher.update(proto.Message.encode({ protocolMessage }).finish()),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const envelope = proto.WebMessageInfo.fromObject({
    key: {
      ...message.key,
      participant: message.key.participant || null,
      id: `fictional-edit-${seconds}`,
    },
    messageTimestamp: base + seconds,
    message: legacy
      ? { protocolMessage }
      : {
          secretEncryptedMessage: {
            targetMessageKey: target,
            secretEncType:
              proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
            encIv,
            encPayload,
          },
        },
  });
  assert.ok(envelope.key);
  return { ...envelope, key: envelope.key };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'message-edits-'));
  const store = new Store(directory);
  store.set('auth', 'creds', {
    ...initAuthCreds(),
    me: { id: me, lid: meLid, name: 'Fictional owner' },
  });
  return { directory, store };
}

function runtimeFixture(messages: WAMessage[] = []) {
  const f = fixture();
  for (const message of messages) f.store.observeMessage(message, false);
  f.store.close();
  const ev = makeEventBuffer(pino({ level: 'silent' }));
  let lookup:
    ((key: WAMessageKey) => Promise<proto.IMessage | undefined>) | undefined;
  const runtime = createRuntime(
    { dataDir: f.directory, connect: true },
    (config) => {
      lookup = config.getMessage;
      return {
        ev,
        ws: { isClosed: true },
        end: () => ev.emit('connection.update', { connection: 'close' }),
      } as unknown as WASocket;
    },
  );
  runtime.start();
  assert.ok(lookup);
  return { runtime, ev, lookup };
}

function text(store: Store, key: WAMessageKey) {
  const message = store.message(key);
  assert.ok(message);
  return messageOutput(message).text;
}

test('encrypted edits replace current text/search, preserve send time and secrets, and survive stale events and restart', () => {
  const f = fixture();
  let store = f.store;
  const message = original();
  try {
    store.observeChat({ id: peer, unreadCount: 0, archived: true });
    store.observeMessage(message, false);
    const chat = store.chatView(peer);
    store.captureMessageRange(edit(message));
    store.observeMessage(edit(message), true, 'notify');
    assert.equal(text(store, message.key), 'Fictional correction');
    assert.equal(store.search('typo', 10, 0).length, 0);
    assert.equal(store.search('correction', 10, 0)[0]?.key.id, message.key.id);
    assert.equal(store.message(message.key)?.messageTimestamp, base);
    assert.deepEqual(store.chatView(peer), chat);
    assert.deepEqual(
      Buffer.from(
        store.message(message.key)!.message!.messageContextInfo!.messageSecret!,
      ),
      secret,
    );
    store.close();
    store = new Store(f.directory);
    store.observeMessage(edit(message, 25, 'Fictional latest'));
    store.observeMessage(edit(message));
    store.observeMessage(message);
    store.updateMessage({
      key: message.key,
      update: {
        message: {
          editedMessage: { message: { conversation: 'Stale SDK edit' } },
        },
        messageTimestamp: base + 14,
      },
    });
    assert.equal(text(store, message.key), 'Fictional latest');
    assert.equal(store.message(message.key)?.messageTimestamp, base);
    assert.doesNotMatch(
      JSON.stringify(store.messageView(store.message(message.key)!)),
      /messageSecret|encPayload|encIv/,
    );
  } finally {
    store.close();
  }
});

test('edits arriving before the original or its secret are recovered without a network connection', () => {
  for (const missing of ['original', 'secret'] as const) {
    const f = fixture();
    let store = f.store;
    const message = original();
    try {
      if (missing === 'secret')
        store.observeMessage({
          ...message,
          message: { conversation: 'Fictional typo' },
        });
      store.observeMessage(edit(message, 25, 'Fictional latest'));
      store.observeMessage(edit(message));
      store.close();
      store = new Store(f.directory);
      store.observeMessage(message);
      assert.equal(text(store, message.key), 'Fictional latest');
      assert.equal(store.search('latest', 10, 0).length, 1);
    } finally {
      store.close();
    }
  }
});

test('upgrade recovers already persisted opaque edits transactionally and only once', () => {
  const f = fixture();
  const message = original();
  f.store.observeMessage(message);
  const envelope = edit(message);
  f.store.db
    .prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)')
    .run(peer, envelope.key.id!, 0, '', base + 14, encode(envelope));
  f.store.set('migration', 'message-edits-v1', false);
  f.store.close();
  let store = new Store(f.directory);
  try {
    assert.equal(text(store, message.key), 'Fictional correction');
    const events = store.events(0);
    store.close();
    store = new Store(f.directory);
    assert.deepEqual(store.events(0), events);
    assert.equal(text(store, message.key), 'Fictional correction');
  } finally {
    store.close();
  }
});

test('same-author edits work for incoming groups and our own linked-device messages without SDK resend lookup', () => {
  for (const key of [
    {
      remoteJid: '120363000000000001@g.us',
      id: 'fictional-group',
      fromMe: false,
      participant: peer,
    },
    { remoteJid: peer, id: 'fictional-own', fromMe: true },
  ]) {
    const { store } = fixture();
    const message = original(key);
    try {
      store.observeMessage(message);
      store.observeMessage(edit(message));
      assert.equal(text(store, message.key), 'Fictional correction');
    } finally {
      store.close();
    }
  }
});

test('invalid authentication, foreign targets, direction and participant collisions cannot replace a body', () => {
  for (const change of [
    'payload',
    'iv',
    'chat',
    'direction',
    'participant',
    'inner-target',
  ] as const) {
    const { store } = fixture();
    const message = original();
    const envelope = edit(message);
    const encrypted = envelope.message!.secretEncryptedMessage!;
    try {
      store.observeMessage(message);
      if (change === 'payload') encrypted.encPayload = Buffer.alloc(48, 1);
      if (change === 'iv') encrypted.encIv = Buffer.alloc(11);
      if (change === 'chat')
        encrypted.targetMessageKey!.remoteJid = '12025550102@s.whatsapp.net';
      if (change === 'direction') encrypted.targetMessageKey!.fromMe = false;
      if (change === 'participant')
        envelope.key.participant = '900000000000102@lid';
      if (change === 'inner-target') {
        const wrong = edit({
          ...message,
          key: { ...message.key, id: 'fictional-other-target' },
        });
        encrypted.encPayload =
          wrong.message!.secretEncryptedMessage!.encPayload ?? null;
      }
      store.observeMessage(envelope);
      assert.equal(text(store, message.key), 'Fictional typo', change);
      assert.doesNotMatch(
        JSON.stringify(store.events(0)),
        /messageSecret|encPayload|encIv|Fictional typo/,
      );
    } finally {
      store.close();
    }
  }
});

test('deletion and chat boundaries remain authoritative over edits and upgrade recovery', () => {
  for (const before of [true, false]) {
    const f = fixture();
    const message = original();
    let store = f.store;
    try {
      store.observeMessage(message);
      if (before) store.deleteMessages({ keys: [message.key] });
      store.observeMessage(edit(message));
      if (!before) store.deleteMessages({ keys: [message.key] });
      store.close();
      store = new Store(f.directory);
      store.observeMessage(edit(message, 25));
      store.observeMessage(message);
      assert.equal(text(store, message.key), null);
      assert.equal(store.search('correction', 10, 0).length, 0);
    } finally {
      store.close();
    }
  }
});

test('legacy envelopes preserve the secret and derived SDK updates cannot supply edit authority', () => {
  for (const sdk of [false, true]) {
    const { store } = fixture();
    const message = original();
    try {
      store.observeMessage(message);
      if (sdk)
        store.updateMessage({
          key: message.key,
          update: {
            message: {
              editedMessage: { message: { conversation: 'Legacy corrected' } },
            },
          },
        });
      assert.equal(text(store, message.key), 'Fictional typo');
      store.observeMessage(edit(message, 10, 'Legacy corrected', true));
      assert.equal(text(store, message.key), 'Legacy corrected');
      store.observeMessage(edit(message, 20, 'Encrypted latest'));
      assert.equal(text(store, message.key), 'Encrypted latest');
    } finally {
      store.close();
    }
  }
});

for (const foreignTarget of [false, true]) {
  test(`buffered original and legacy edit preserve original evidence (foreign target=${foreignTarget})`, async () => {
    const { runtime, ev } = runtimeFixture();
    const message = original();
    const envelope = edit(message, 14, 'Legacy corrected', true);
    if (foreignTarget)
      envelope.message!.protocolMessage!.key!.remoteJid =
        '12025550102@s.whatsapp.net';
    try {
      ev.buffer();
      ev.emit('messages.upsert', {
        type: 'notify',
        messages: [message, envelope],
      });
      const creds = initAuthCreds();
      creds.me = { id: me, lid: meLid };
      await processMessage(envelope, {
        ev,
        creds,
        shouldProcessHistoryMsg: false,
        options: {},
        getMessage: async () => undefined,
      } as unknown as Parameters<typeof processMessage>[1]);
      ev.flush();
      const rows = (await runtime.execute({
        command: 'messages',
        jid: peer,
        limit: 10,
        offset: 0,
      })) as { id: string; text: string; timestamp: number }[];
      const current = rows.find(({ id }) => id === message.key.id);
      assert.equal(
        current?.text,
        foreignTarget ? 'Fictional typo' : 'Legacy corrected',
      );
      assert.equal(current?.timestamp, base);
      ev.emit('messages.upsert', {
        type: 'notify',
        messages: [edit(message, 25, 'Encrypted latest')],
      });
      const updated = (await runtime.execute({
        command: 'search',
        query: 'Encrypted latest',
        limit: 10,
        offset: 0,
      })) as { text: string; timestamp: number }[];
      assert.equal(updated[0]?.text, 'Encrypted latest');
      assert.equal(updated[0]?.timestamp, base);
    } finally {
      await runtime.close();
    }
  });
}

test('runtime projects buffered encrypted upserts and keeps automatic resend content withheld', async () => {
  const message = original();
  const { runtime, ev, lookup } = runtimeFixture([message]);
  try {
    ev.buffer();
    ev.emit('messages.upsert', { type: 'notify', messages: [edit(message)] });
    ev.flush();
    const result = await runtime.execute({
      command: 'search',
      query: 'correction',
      limit: 10,
      offset: 0,
    });
    assert.equal(
      (result as { text: string }[])[0]?.text,
      'Fictional correction',
    );
    assert.ok(lookup);
    assert.equal(await lookup({ ...message.key, fromMe: true }), undefined);
    ev.emit('chats.update', [
      {
        id: peer,
        messages: [
          { message: edit(message, 25, 'Fictional chat update correction') },
        ],
      },
    ]);
    const later = await runtime.execute({
      command: 'search',
      query: 'chat update correction',
      limit: 10,
      offset: 0,
    });
    assert.equal(
      (later as { text: string }[])[0]?.text,
      'Fictional chat update correction',
    );
  } finally {
    await runtime.close();
  }
});
