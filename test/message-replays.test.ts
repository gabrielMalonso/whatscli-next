import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { proto } from 'baileys';
import type { WAMessage, WAMessageKey } from 'baileys';
import { perform } from '../src/operations.js';
import { Store } from '../src/store.js';

const jid = '12025550101@s.whatsapp.net';
const other = '12025550102@s.whatsapp.net';
const lid = '900000000000101@lid';
const base = 1700000000;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'message-replay-'));
  const store = new Store(directory);
  store.observeChat({ id: jid, unreadCount: 0, archived: true });
  return { directory, store };
}

function knownMessage(): WAMessage {
  return {
    key: { remoteJid: jid, id: 'fictional-known-message', fromMe: false },
    messageTimestamp: base,
    message: { conversation: 'Fictional retained content' },
  };
}

function failedMessage(key: WAMessageKey): WAMessage {
  return {
    key,
    messageTimestamp: base + 100,
    messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
    messageStubParameters: ['FICTIONAL_PRIVATE_DECRYPTION_ERROR'],
  };
}

test('failed replays preserve decoded content, search, original time and read state across restart', () => {
  const f = fixture();
  let store = f.store;
  const message = knownMessage();
  try {
    store.observeMessage(message);
    const before = store.message(message.key);
    const chat = store.chatView(jid);
    store.close();
    store = new Store(f.directory);
    for (const key of [message.key, { ...message.key, participant: '' }]) {
      const failure = failedMessage(key);
      store.captureMessageRange(failure);
      store.observeMessage(failure, true, 'notify');
      assert.deepEqual(store.message(message.key), before);
      assert.deepEqual(store.chatView(jid), chat);
      assert.deepEqual(
        store.search('retained', 10, 0, jid).map((row) => row.key.id),
        [message.key.id],
      );
    }
    const failures = store.events(0) as {
      kind: string;
      data: Record<string, unknown>;
    }[];
    assert.deepEqual(
      failures
        .filter((event) => event.kind === 'message-content-unavailable')
        .map((event) => event.data),
      [1, 2].map(() => ({
        jid,
        id: message.key.id,
        stubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
        retainedContent: true,
      })),
    );
    assert.doesNotMatch(
      JSON.stringify(failures),
      /FICTIONAL_PRIVATE_DECRYPTION_ERROR/,
    );
  } finally {
    store.close();
  }
});

test('a failed message cannot borrow decoded content from another exact identity', () => {
  for (const change of [
    'id',
    'conversation',
    'direction',
    'participant',
    'lid',
  ] as const) {
    const { store } = fixture();
    try {
      const known = knownMessage();
      store.observeMessage(known);
      store.observeMapping(jid, lid, 'message-key');
      const key = { ...known.key };
      if (change === 'id') key.id = 'fictional-new-message';
      if (change === 'conversation') key.remoteJid = other;
      if (change === 'direction') key.fromMe = true;
      if (change === 'participant') key.participant = other;
      if (change === 'lid') key.remoteJid = lid;
      const failure = failedMessage(key);
      store.captureMessageRange(failure);
      store.observeMessage(failure, true, 'notify');
      assert.equal(
        store.message(key)?.messageStubType,
        proto.WebMessageInfo.StubType.CIPHERTEXT,
        change,
      );
      assert.equal(
        store.message(known.key)?.message?.conversation,
        'Fictional retained content',
        change,
      );
      const events = store.events(0);
      assert.doesNotMatch(JSON.stringify(events), /retainedContent/, change);
      if (change === 'id') assert.equal(store.chatView(jid)?.unread, null);
    } finally {
      store.close();
    }
  }
});

test('previous ciphertext with a partial reaction payload cannot qualify a replay as decoded', () => {
  const { store } = fixture();
  try {
    const failure = failedMessage(knownMessage().key);
    store.observeMessage({
      ...failure,
      message: { reactionMessage: { key: knownMessage().key, text: '👍' } },
    });
    store.observeChat({ id: jid, unreadCount: 0 });
    const replay = { ...failure, messageTimestamp: base + 200 };
    store.captureMessageRange(replay);
    store.observeMessage(replay, true, 'notify');
    assert.equal(store.chatView(jid)?.unread, null);
    assert.doesNotMatch(JSON.stringify(store.events(0)), /retainedContent/);
  } finally {
    store.close();
  }
});

test('a failed replay cannot use deleted content or reconstruct a lost read baseline', () => {
  for (const deleted of [false, true]) {
    const { store } = fixture();
    try {
      const known = knownMessage();
      store.observeMessage(known);
      if (deleted) store.deleteMessages({ keys: [known.key] });
      else store.observeChat({ id: jid, unreadCount: 5 });
      const failure = failedMessage(known.key);
      store.captureMessageRange(failure);
      store.observeMessage(failure, true, 'notify');
      if (deleted) {
        assert.equal(store.message(known.key)?.message, null);
        assert.deepEqual(store.search('retained', 10, 0, jid), []);
        assert.doesNotMatch(JSON.stringify(store.events(0)), /retainedContent/);
      } else assert.equal(store.chatView(jid)?.unread, true);
    } finally {
      store.close();
    }
  }
});

test('a later decoded recovery still replaces ciphertext and remains eligible for content updates', () => {
  const { store } = fixture();
  try {
    const known = knownMessage();
    store.observeMessage(failedMessage(known.key));
    store.observeMessage(known);
    assert.equal(store.message(known.key)?.messageStubType, undefined);
    assert.equal(
      store.message(known.key)?.message?.conversation,
      'Fictional retained content',
    );
    store.observeMessage({
      ...known,
      message: { conversation: 'Fictional updated content' },
    });
    assert.equal(
      store.message(known.key)?.message?.conversation,
      'Fictional updated content',
    );
  } finally {
    store.close();
  }
});

test('retaining an outgoing body still records independent send receipts without another invocation', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'outgoing-replay-')));
  const operation = {
    kind: 'send',
    jid,
    text: 'Fictional outgoing content',
  } as const;
  try {
    const original = await perform(
      store,
      'fictional-send',
      operation,
      () => {},
      async (id) => ({
        key: { remoteJid: jid, id, fromMe: true },
        messageTimestamp: base,
        message: { conversation: operation.text },
      }),
    );
    const key = { remoteJid: jid, id: original.messageId, fromMe: true };
    const before = store.message(key);
    assert.equal(store.chatView(jid), null);
    store.observeMessage(
      {
        ...failedMessage(key),
        status: proto.WebMessageInfo.Status.DELIVERY_ACK,
      },
      true,
      'notify',
    );
    const latest = store.request('fictional-send');
    assert.equal(latest?.acceptance, 'server-ack');
    assert.equal(latest?.delivery, 'delivered');
    assert.deepEqual(latest?.operation, original.operation);
    assert.equal(latest?.messageId, original.messageId);
    assert.deepEqual(store.message(key), {
      ...before,
      status: proto.WebMessageInfo.Status.DELIVERY_ACK,
    });
    const chat = store.chatView(jid);
    assert.ok(chat);
    assert.equal(chat.unread, null);
    assert.equal(chat.archived, null);
    assert.equal(chat.activity.timestamp, null);
    assert.deepEqual(
      await perform(
        store,
        'fictional-send',
        operation,
        () => assert.fail('Replay must not validate or invoke again'),
        async () => assert.fail('Replay must not send again'),
      ),
      latest,
    );
  } finally {
    store.close();
  }
});

test('retained content does not discard new or contradictory identity evidence', () => {
  const { store } = fixture();
  try {
    const known = knownMessage();
    store.observeMessage(known);
    for (const [remoteJidAlt, expected] of [
      [lid, 'known'],
      ['900000000000102@lid', 'conflict'],
    ] as const) {
      const failure = failedMessage({ ...known.key, remoteJidAlt });
      store.captureMessageRange(failure);
      store.observeMessage(failure, true, 'notify');
      assert.equal(store.contactView(jid).mapping.status, expected);
      assert.equal(store.message(known.key)?.messageTimestamp, base);
      assert.equal(store.message(known.key)?.messageStubType, undefined);
      assert.equal(store.chatView(jid)?.unread, false);
    }
  } finally {
    store.close();
  }
});
