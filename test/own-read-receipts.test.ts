import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initAuthCreds, makeEventBuffer, proto } from 'baileys';
import type {
  ChatAppStateAction,
  WAMessage,
  WAMessageKey,
  WASocket,
} from 'baileys';
import { pino } from 'pino';
import processMessage from 'baileys/lib/Utils/process-message.js';
import { createRuntime } from '../src/runtime.js';
import { object } from '../src/protocol.js';
import { formatResponse } from '../src/response.js';
import { Store } from '../src/store.js';

const jid = '12025550101@s.whatsapp.net';
const me = '12025550199@s.whatsapp.net';
const lid = '900000000000099@lid';
const base = 1700000000;

function manualAction(
  timestamp = (base + 5) * 1000,
  version = 1,
): ChatAppStateAction {
  return {
    kind: 'chat-action',
    source: 'sync',
    collection: 'regular_low',
    version,
    representation: 'patch',
    initialSync: false,
    macVerified: false,
    jid,
    action: { kind: 'mark-read', read: false },
    timestamp,
    messageRange: {
      lastMessageTimestamp: base,
      messages: [{ id: 'previous', fromMe: false, timestamp: base }],
    },
  };
}

function fixture(initial: number | null = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'own-read-'));
  const seed = new Store(directory);
  seed.set('auth', 'creds', {
    ...initAuthCreds(),
    me: { id: me, lid, name: 'Fictional owner' },
  });
  seed.observeChat({ id: jid, unreadCount: initial, archived: true });
  seed.observeMessage({
    key: { remoteJid: jid, id: 'previous', fromMe: false },
    messageTimestamp: base,
    message: { conversation: 'Fictional earlier read message' },
  });
  seed.close();
  const ev = makeEventBuffer(pino({ level: 'silent' }));
  const runtime = createRuntime(
    { dataDir: directory, connect: true },
    () =>
      ({
        ev,
        ws: { isClosed: true },
        chatModify: async () => {},
        end: () => ev.emit('connection.update', { connection: 'close' }),
      }) as unknown as WASocket,
  );
  runtime.start();
  ev.emit('connection.update', { connection: 'open' });
  const message = (
    id = 'fictional-incoming',
    timestamp = base + 10,
  ): WAMessage => ({
    key: { remoteJid: jid, id, fromMe: false },
    messageTimestamp: timestamp,
    message: { conversation: 'Fictional fixture' },
  });
  const incoming = (msg = message(), count = 1) => {
    ev.emit('chats.update', [
      {
        id: jid,
        unreadCount: count,
        messages: [{ message: msg }],
        conversationTimestamp: msg.messageTimestamp ?? null,
      },
    ]);
    ev.emit('messages.upsert', { messages: [msg], type: 'notify' });
    return msg;
  };
  const receipt = (key: WAMessageKey, timestamp = base + 100, userJid = me) => {
    ev.emit('messages.update', [
      { key, update: { status: proto.WebMessageInfo.Status.READ } },
    ]);
    ev.emit('message-receipt.update', [
      { key, receipt: { userJid, readTimestamp: timestamp } },
    ]);
  };
  const process = (msg: WAMessage) =>
    processMessage(msg, {
      ev,
      creds: { me: { id: me }, accountSettings: {} },
      logger: pino({ level: 'silent' }),
      shouldProcessHistoryMsg: false,
      options: {},
      getMessage: async () => undefined,
    } as unknown as Parameters<typeof processMessage>[1]);
  const recover = (recovered: WAMessage) =>
    process({
      key: { remoteJid: me, id: 'fictional-pdo', fromMe: true },
      messageTimestamp: base + 30,
      message: {
        protocolMessage: {
          type: proto.Message.ProtocolMessage.Type
            .PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
          peerDataOperationRequestResponseMessage: {
            stanzaId: 'fictional-resend',
            peerDataOperationResult: [
              {
                placeholderMessageResendResponse: {
                  webMessageInfoBytes:
                    proto.WebMessageInfo.encode(recovered).finish(),
                },
              },
            ],
          },
        },
      },
    });
  return {
    directory,
    runtime,
    ev,
    message,
    incoming,
    receipt,
    process,
    recover,
    chat: async () => object(await runtime.execute({ command: 'chat', jid })),
    queue: (observedOnly = false) =>
      runtime.execute({
        command: 'chats',
        unread: true,
        observedOnly,
        limit: 100,
        offset: 0,
      }),
    close: async () => {
      await runtime.close();
      ev.destroy();
    },
  };
}

for (const source of ['notify', 'append'] as const) {
  test(`uncovered incoming ${source} content retires earlier receipt coverage`, async () => {
    const f = fixture();
    try {
      const tracked = f.incoming();
      f.ev.emit('messages.upsert', {
        messages: [f.message('uncovered', base + 20)],
        type: source,
      });
      f.receipt(tracked.key, base + 15);
      assert.equal((await f.chat()).unread, true);
      assert.equal((await f.chat()).readObservation, undefined);
      const next = f.incoming(f.message('after-uncovered', base + 30));
      f.receipt(next.key);
      assert.equal((await f.chat()).unread, true);
    } finally {
      await f.close();
    }
  });
}

test('SDK placeholder recovery without an unread increment cannot be covered by an earlier receipt', async () => {
  const f = fixture();
  try {
    const tracked = f.incoming();
    const recovered = f.message('recovered', base + 20);
    // This PDO fixture exercises the already-decoded message path, without Signal/key-store I/O.
    await processMessage(
      {
        key: { remoteJid: me, id: 'fictional-pdo', fromMe: true },
        messageTimestamp: base + 30,
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type
              .PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
            peerDataOperationRequestResponseMessage: {
              stanzaId: 'fictional-resend',
              peerDataOperationResult: [
                {
                  placeholderMessageResendResponse: {
                    webMessageInfoBytes:
                      proto.WebMessageInfo.encode(recovered).finish(),
                  },
                },
              ],
            },
          },
        },
      },
      {
        ev: f.ev,
        creds: { ...initAuthCreds(), me: { id: me, name: 'Fictional owner' } },
        shouldProcessHistoryMsg: false,
        options: {},
        getMessage: async () => undefined,
      } as unknown as Parameters<typeof processMessage>[1],
    );
    f.receipt(tracked.key, base + 15);
    assert.equal((await f.chat()).unread, true);
    assert.equal((await f.chat()).readObservation, undefined);
  } finally {
    await f.close();
  }
});

for (const type of ['notify', 'append'] as const) {
  test(`an absorbed own receipt cannot establish zero before uncovered ${type} content in the buffered window`, async () => {
    const f = fixture();
    try {
      f.ev.buffer();
      const tracked = f.incoming();
      f.receipt(tracked.key, base + 15);
      f.ev.emit('messages.upsert', {
        messages: [f.message('uncovered-in-batch', base + 20)],
        type,
      });
      f.ev.flush();
      assert.notEqual((await f.chat()).unread, false);
      assert.equal((await f.chat()).readObservation, undefined);
    } finally {
      await f.close();
    }
  });
}

for (const manual of [false, true]) {
  test(`SDK upsert-before-increment order preserves complete two-message coverage (manual=${manual})`, async () => {
    const f = fixture();
    try {
      if (manual) {
        f.ev.emit('app-state.update', manualAction());
        f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      }
      const first = f.message('upsert-first-A', base + 10);
      const second = f.message('upsert-first-B', base + 20);
      for (const message of [first, second]) {
        f.ev.buffer();
        f.ev.emit('messages.upsert', { messages: [message], type: 'notify' });
        f.ev.emit('chats.update', [
          { id: jid, unreadCount: 1, messages: [{ message }] },
        ]);
        f.ev.flush();
      }
      f.receipt(first.key);
      assert.equal((await f.chat()).unread, true);
      f.receipt(second.key);
      assert.equal((await f.chat()).unread, false);
      assert.deepEqual(object((await f.chat()).readObservation).messages, [
        { id: first.key.id, timestamp: base + 10 },
        { id: second.key.id, timestamp: base + 20 },
      ]);
    } finally {
      await f.close();
    }
  });
}

test('a paired append after a type-switch flush keeps earlier receipt coverage until both IDs are read', async () => {
  const f = fixture();
  try {
    f.ev.buffer();
    const first = f.incoming(f.message('type-switch-A', base + 10));
    f.receipt(first.key, base + 15);
    const second = f.message('type-switch-B', base + 20);
    f.ev.emit('messages.upsert', { messages: [second], type: 'append' });
    f.ev.emit('chats.update', [
      { id: jid, unreadCount: 1, messages: [{ message: second }] },
    ]);
    f.ev.flush();
    assert.equal((await f.chat()).unread, true);
    f.receipt(second.key);
    assert.equal((await f.chat()).unread, false);
    assert.deepEqual(object((await f.chat()).readObservation).messages, [
      { id: first.key.id, timestamp: base + 10 },
      { id: second.key.id, timestamp: base + 20 },
    ]);
  } finally {
    await f.close();
  }
});

test('an unmatched buffered upsert blocks zero across restart until its coverage is resolved', async () => {
  const f = fixture();
  const first = f.incoming();
  f.ev.buffer();
  const unmatched = f.message('buffered-unmatched', base + 20);
  f.ev.emit('messages.upsert', { messages: [unmatched], type: 'append' });
  await f.close();
  const store = new Store(f.directory);
  try {
    store.observeOwnReadReceipt(first.key, base + 15);
    assert.equal(store.chatView(jid)?.unread, true);
    assert.equal(store.chatView(jid)?.readObservation, undefined);
    store.observeMessage(unmatched, true, 'append');
    store.observeOwnReadReceipt(first.key, base + 15);
    assert.equal(store.chatView(jid)?.unread, true);
    assert.equal(store.chatView(jid)?.readObservation, undefined);
  } finally {
    store.close();
  }
});

for (const source of ['notify', 'append'] as const) {
  test(`an unpaired key before the first range prevents zero after a later paired ${source}`, async () => {
    const f = fixture();
    try {
      f.ev.buffer();
      await f.recover(f.message('unpaired-before-range', base + 20));
      const tracked = f.message('tracked-after-unpaired', base + 10);
      f.ev.emit('messages.upsert', { messages: [tracked], type: source });
      await f.process(tracked);
      f.receipt(tracked.key, base + 15);
      f.ev.flush();
      assert.notEqual((await f.chat()).unread, false);
      assert.equal((await f.chat()).readObservation, undefined);
    } finally {
      await f.close();
    }
  });
}

test('an unpaired key captured before the first range blocks zero across restart', async () => {
  const f = fixture();
  const tracked = f.message('tracked-after-unpaired', base + 10);
  f.ev.buffer();
  await f.recover(f.message('unpaired-before-range', base + 20));
  f.ev.emit('messages.upsert', { messages: [tracked], type: 'notify' });
  await f.process(tracked);
  await f.close();
  const store = new Store(f.directory);
  try {
    store.observeMessage(tracked, true, 'notify');
    store.observeOwnReadReceipt(tracked.key, base + 15);
    assert.notEqual(store.chatView(jid)?.unread, false);
    assert.equal(store.chatView(jid)?.readObservation, undefined);
  } finally {
    store.close();
  }
});

for (const changedTime of [false, true]) {
  test(`an older flushed key/time cannot consume a newer raw barrier (changedTime=${changedTime})`, async () => {
    const f = fixture();
    try {
      const tracked = f.message('corrected-time', base + 10);
      f.ev.buffer();
      f.ev.emit('messages.upsert', { messages: [tracked], type: 'append' });
      await f.process(tracked);
      f.receipt(tracked.key, base + 15);
      await f.recover(
        f.message('corrected-time', base + (changedTime ? 20 : 10)),
      );
      f.ev.flush();
      if (changedTime) {
        assert.notEqual((await f.chat()).unread, false);
        assert.equal((await f.chat()).readObservation, undefined);
      } else {
        assert.equal((await f.chat()).unread, false);
      }
    } finally {
      await f.close();
    }
  });
}

test('an exact cached replay after observed read does not block the next complete range', async () => {
  const f = fixture();
  try {
    const previous = f.incoming();
    f.receipt(previous.key);
    f.ev.emit('messages.upsert', { messages: [previous], type: 'notify' });
    const next = f.incoming(f.message('after-cached-replay', base + 20));
    f.receipt(next.key);
    assert.equal((await f.chat()).unread, false);
    assert.deepEqual(object((await f.chat()).readObservation).messages, [
      { id: next.key.id, timestamp: base + 20 },
    ]);
  } finally {
    await f.close();
  }
});

for (const incomingFirst of [false, true]) {
  test(`a newer snapshot retires the older patch qualification before its deduplicated counter (incomingFirst=${incomingFirst})`, async () => {
    const f = fixture();
    try {
      const msg = f.message();
      if (incomingFirst) f.incoming(msg);
      f.ev.emit('app-state.update', manualAction());
      f.ev.emit('app-state.update', {
        ...manualAction((base + 200) * 1000, 4),
        source: 'sync',
        initialSync: false,
        macVerified: true,
        representation: 'snapshot',
        messageRange: {
          lastMessageTimestamp: base + 10,
          messages: [{ id: msg.key.id!, fromMe: false, timestamp: base + 10 }],
        },
      });
      f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      if (!incomingFirst) f.incoming(msg);
      f.receipt(msg.key, base + 100);
      assert.equal((await f.chat()).unread, true);
      assert.equal((await f.chat()).readObservation, undefined);
    } finally {
      await f.close();
    }
  });
}

test('uncovered incoming content also retires a qualified marker before its first paired increment', async () => {
  const f = fixture();
  try {
    f.ev.emit('app-state.update', manualAction());
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    f.ev.emit('messages.upsert', {
      messages: [f.message('uncovered', base + 10)],
      type: 'notify',
    });
    const msg = f.incoming(f.message('tracked', base + 20));
    f.receipt(msg.key);
    assert.equal((await f.chat()).unread, true);
    assert.equal((await f.chat()).readObservation, undefined);
  } finally {
    await f.close();
  }
});

for (const order of ['separate', 'upsert-first', 'receipt-first'] as const) {
  test(`own read receipts clear a fully tracked unread range (${order}), preserving archive and message time`, async () => {
    const f = fixture();
    try {
      const msg = f.message();
      if (order !== 'separate') f.ev.buffer();
      if (order === 'receipt-first') {
        f.receipt(msg.key);
        f.incoming(msg);
      } else {
        f.incoming(msg);
        f.receipt(msg.key);
      }
      f.ev.flush();
      const chat = await f.chat();
      assert.equal(chat.unread, false);
      assert.equal(chat.unreadCount, 0);
      assert.equal(chat.archived, true);
      if (order !== 'upsert-first') {
        assert.equal(
          object(chat.readObservation).source,
          'own-device-receipts',
        );
        assert.equal(
          object(chat.readObservation).scope,
          'tracked-incoming-messages',
        );
      }
      assert.deepEqual(await f.queue(), []);
      assert.deepEqual(await f.queue(true), []);
      const messages = await f.runtime.execute({
        command: 'messages',
        jid,
        limit: 10,
        offset: 0,
      });
      assert.equal(object((messages as unknown[])[0]).timestamp, base + 10);
    } finally {
      await f.close();
    }
    const store = new Store(f.directory);
    try {
      assert.equal(store.chatView(jid)?.unread, false);
    } finally {
      store.close();
    }
  });
}

test('a partial or duplicate receipt cannot clear a newer unread message; all tracked keys must be read', async () => {
  const f = fixture();
  try {
    const first = f.incoming(f.message('first', base + 10));
    const second = f.incoming(f.message('second', base + 20));
    f.receipt(first.key);
    f.receipt(first.key);
    assert.equal((await f.chat()).unread, true);
    assert.equal(((await f.queue(true)) as unknown[]).length, 1);
    f.receipt(second.key, base + 110, lid);
    assert.equal((await f.chat()).unread, false);
    const third = f.incoming(f.message('third', base + 30));
    f.receipt(second.key);
    assert.equal((await f.chat()).unread, true);
    f.receipt(third.key);
    assert.equal((await f.chat()).unread, false);
  } finally {
    await f.close();
  }
});

test('a partially read range and its baseline survive runtime restart', async () => {
  const f = fixture();
  const first = f.incoming(f.message('first', base + 10));
  const second = f.incoming(f.message('second', base + 20));
  f.receipt(first.key);
  await f.close();
  const ev = makeEventBuffer(pino({ level: 'silent' }));
  const runtime = createRuntime(
    { dataDir: f.directory, connect: true },
    () =>
      ({
        ev,
        ws: { isClosed: true },
        end: () => ev.emit('connection.update', { connection: 'close' }),
      }) as unknown as WASocket,
  );
  runtime.start();
  try {
    ev.emit('message-receipt.update', [
      { key: second.key, receipt: { userJid: me, readTimestamp: base + 100 } },
    ]);
    assert.equal(
      object(await runtime.execute({ command: 'chat', jid })).unread,
      false,
    );
  } finally {
    await runtime.close();
    ev.destroy();
  }
});

for (const invalid of [
  'other-user',
  'outgoing',
  'unknown-key',
  'old-time',
  'invalid-time',
  'other-chat',
  'group',
] as const) {
  test(`${invalid} receipt cannot turn the conversation read`, async () => {
    const f = fixture();
    try {
      const msg = f.incoming();
      const key = {
        ...msg.key,
        ...(invalid === 'outgoing' ? { fromMe: true } : {}),
        ...(invalid === 'unknown-key' ? { id: 'unknown' } : {}),
        ...(invalid === 'other-chat'
          ? { remoteJid: '12025550102@s.whatsapp.net' }
          : {}),
        ...(invalid === 'group'
          ? { remoteJid: '120363000000000001@g.us', participant: jid }
          : {}),
      };
      f.receipt(
        key,
        invalid === 'old-time'
          ? base
          : invalid === 'invalid-time'
            ? 0
            : base + 100,
        invalid === 'other-user' ? jid : me,
      );
      assert.equal((await f.chat()).unread, true);
    } finally {
      await f.close();
    }
  });
}

test('a delayed own receipt cannot recreate a deleted chat from retired coverage', async () => {
  const f = fixture();
  try {
    const msg = f.incoming();
    f.ev.emit('chats.delete', [jid]);
    assert.equal(await f.runtime.execute({ command: 'chat', jid }), null);
    f.receipt(msg.key);
    assert.equal(await f.runtime.execute({ command: 'chat', jid }), null);
  } finally {
    await f.close();
  }
});

test("reintroduced chat metadata cannot reuse a deleted chat's unread range", async () => {
  const f = fixture();
  try {
    const msg = f.incoming();
    f.ev.emit('chats.delete', [jid]);
    f.ev.emit('chats.upsert', [{ id: jid, archived: true }]);
    f.receipt(msg.key);
    assert.equal((await f.chat()).unread, null);
    assert.equal((await f.chat()).readObservation, undefined);
  } finally {
    await f.close();
  }
});

test('deleted chats retire read diagnostics without discarding stored message history', async () => {
  const f = fixture(-1);
  try {
    const msg = f.incoming();
    f.receipt(msg.key);
    assert.ok((await f.chat()).readReconciliation);
    f.ev.emit('chats.delete', [jid]);
    f.ev.emit('chats.upsert', [{ id: jid, archived: true }]);
    const chat = await f.chat();
    assert.equal(chat.unread, null);
    assert.equal(chat.readReconciliation, undefined);
    const messages = await f.runtime.execute({
      command: 'messages',
      jid,
      limit: 10,
      offset: 0,
    });
    assert.ok(
      (messages as unknown[])
        .map(object)
        .some((message) => message.id === msg.key.id),
    );
  } finally {
    await f.close();
  }
});

for (const initial of [null, 2, -1]) {
  test(`receipt cannot resolve an unknown, untracked or manually unread baseline (${initial})`, async () => {
    const f = fixture(initial);
    try {
      const msg = f.incoming();
      f.receipt(msg.key);
      assert.notEqual((await f.chat()).unread, false);
    } finally {
      await f.close();
    }
  });
}

test('manual unread and newer pending intents invalidate the range instead of reusing old receipts', async () => {
  const f = fixture();
  try {
    const msg = f.incoming();
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    f.receipt(msg.key);
    assert.equal((await f.chat()).unread, true);
    await f.runtime.execute({
      command: 'mark-read',
      jid,
      value: false,
      key: 'new-intent',
    });
    f.receipt(msg.key);
    assert.equal((await f.chat()).unread, null);
    assert.equal(
      object(object((await f.chat()).pending).unread).key,
      'new-intent',
    );
  } finally {
    await f.close();
  }
});

test('an aggregate increment without a complete matching message range stays unread', async () => {
  const f = fixture();
  try {
    const msg = f.incoming(f.message(), 2);
    f.receipt(msg.key);
    assert.equal((await f.chat()).unread, true);
  } finally {
    await f.close();
  }
});

test('manual unread before a new message remains unresolved by its receipt, independently of archive', async () => {
  const f = fixture();
  try {
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    f.ev.emit('chats.update', [{ id: jid, archived: true }]);
    const msg = f.incoming();
    f.ev.emit('chats.update', [{ id: jid, archived: false }]);
    f.ev.emit('chats.update', [{ id: jid, archived: true }]);
    f.receipt(msg.key);
    const chat = await f.chat();
    assert.equal(chat.unread, true);
    assert.equal(chat.archived, true);
    assert.equal(chat.readObservation, undefined);
    const reconciliation = object(chat.readReconciliation);
    assert.equal(reconciliation.status, 'insufficient-evidence');
    assert.equal(reconciliation.reason, 'manual-unread-marker-unconfirmed');
    assert.equal(reconciliation.source, 'own-device-receipt');
    assert.equal(reconciliation.scope, 'message');
    assert.deepEqual(reconciliation.message, {
      id: msg.key.id,
      timestamp: base + 10,
    });
    assert.equal(reconciliation.readAt, base + 100);
    assert.equal(typeof reconciliation.receivedAt, 'number');
    for (const mode of ['full', 'compact'] as const)
      assert.deepEqual(
        object(formatResponse('chat', { ok: true, data: chat }, mode).data)
          .readReconciliation,
        reconciliation,
      );
    for (const observedOnly of [false, true])
      assert.deepEqual(
        object(((await f.queue(observedOnly)) as unknown[])[0])
          .readReconciliation,
        reconciliation,
      );
    assert.equal(((await f.queue(true)) as unknown[]).length, 1);
    f.ev.emit('chats.update', [{ id: jid, unreadCount: 0 }]);
    assert.equal((await f.chat()).unread, false);
    assert.equal((await f.chat()).archived, true);
    assert.equal((await f.chat()).readReconciliation, undefined);
  } finally {
    await f.close();
  }
});

test('insufficient read evidence persists across restart, archive changes and duplicate receipts', async () => {
  const f = fixture(-1);
  let expected: unknown;
  try {
    const msg = f.incoming();
    f.receipt(msg.key);
    expected = (await f.chat()).readReconciliation;
    assert.equal(object(expected).status, 'insufficient-evidence');
    const archive = object(
      await f.runtime.execute({
        command: 'archive',
        jid,
        value: false,
        key: 'archive-only',
      }),
    );
    assert.deepEqual(object(archive.localChat).readReconciliation, expected);
    assert.equal(
      object(object(object(archive.localChat).pending).archived).key,
      'archive-only',
    );
    f.ev.emit('chats.update', [{ id: jid, archived: false }]);
    f.ev.emit('chats.update', [{ id: jid, unreadCount: null }]);
    f.receipt(msg.key);
    assert.deepEqual((await f.chat()).readReconciliation, expected);
    const events = (await f.runtime.execute({
      command: 'events',
      after: 0,
    })) as unknown[];
    const diagnoses = events
      .map(object)
      .filter((event) => event.kind === 'chat-read-insufficient');
    assert.equal(diagnoses.length, 1);
    assert.doesNotMatch(JSON.stringify(diagnoses), /Fictional fixture/);
  } finally {
    await f.close();
  }
  const offline = createRuntime({ dataDir: f.directory, connect: false });
  try {
    const chat = object(await offline.execute({ command: 'chat', jid }));
    assert.deepEqual(chat.readReconciliation, expected);
    assert.equal(chat.archived, false);
    assert.equal(chat.unread, true);
  } finally {
    await offline.close();
  }
});

test('new unread observations and both read intents retire old diagnostic evidence without fabricating confirmation', async () => {
  const f = fixture(-1);
  try {
    let previous = f.incoming(f.message('first'));
    f.receipt(previous.key);
    assert.ok((await f.chat()).readReconciliation);
    const next = f.incoming(f.message('second', base + 20));
    assert.equal((await f.chat()).readReconciliation, undefined);
    f.receipt(previous.key);
    assert.equal((await f.chat()).readReconciliation, undefined);
    f.receipt(next.key);
    assert.equal(
      object(object((await f.chat()).readReconciliation).message).id,
      'second',
    );
    for (const value of [true, false]) {
      await f.runtime.execute({
        command: 'mark-read',
        jid,
        value,
        key: 'new-intent-' + value,
      });
      const pending = await f.chat();
      assert.equal(pending.readReconciliation, undefined);
      assert.equal(pending.unread, null);
      assert.equal(object(object(pending.pending).unread).value, !value);
      f.receipt(next.key);
      assert.equal((await f.chat()).readReconciliation, undefined);
      f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      assert.equal((await f.chat()).readReconciliation, undefined);
      f.receipt(next.key);
      assert.equal((await f.chat()).readReconciliation, undefined);
      previous = f.incoming(f.message('after-intent-' + value, base + 30));
      f.receipt(previous.key);
      assert.ok((await f.chat()).readReconciliation);
    }
    f.ev.emit('chats.update', [{ id: jid, unreadCount: 0 }]);
    assert.equal((await f.chat()).readReconciliation, undefined);
    const fresh = f.incoming(f.message('normal', base + 40));
    f.receipt(fresh.key);
    const read = await f.chat();
    assert.equal(read.unread, false);
    assert.equal(read.readReconciliation, undefined);
    assert.ok(read.readObservation);
  } finally {
    await f.close();
  }
});

test('foreign, unknown, outgoing or invalid-time receipts cannot create a manual-marker diagnosis', async () => {
  const f = fixture(-1);
  try {
    const msg = f.incoming();
    f.receipt(msg.key, base + 100, jid);
    f.receipt({ ...msg.key, id: 'unknown' });
    f.receipt({ ...msg.key, fromMe: true });
    f.receipt(msg.key, base);
    assert.equal((await f.chat()).readReconciliation, undefined);
    assert.equal((await f.chat()).unread, true);
  } finally {
    await f.close();
  }
});

for (const order of [
  'separate',
  'marker-buffered',
  'read-buffered',
  'all-buffered',
  'receipt-first',
] as const) {
  test(`a marker over observed zero is replaced by a complete later incoming range (${order})`, async () => {
    const f = fixture();
    try {
      if (order === 'marker-buffered' || order === 'all-buffered')
        f.ev.buffer();
      f.ev.emit('app-state.update', manualAction());
      f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      f.ev.emit('chats.update', [{ id: jid, archived: true }]);
      if (order === 'read-buffered' || order === 'receipt-first') f.ev.buffer();
      const msg = f.message();
      if (order === 'receipt-first') f.receipt(msg.key);
      f.incoming(msg);
      if (order === 'read-buffered' || order === 'all-buffered')
        f.receipt(msg.key);
      f.ev.flush();
      if (order === 'separate' || order === 'marker-buffered') {
        assert.equal((await f.chat()).unread, true);
        f.receipt(msg.key);
      }
      const chat = await f.chat();
      assert.equal(chat.unread, false);
      assert.equal(chat.unreadCount, 0);
      assert.equal(chat.archived, true);
      assert.equal(chat.readReconciliation, undefined);
      assert.equal(object(chat.readObservation).source, 'own-device-receipts');
      assert.deepEqual(await f.queue(), []);
      assert.deepEqual(await f.queue(true), []);
    } finally {
      await f.close();
    }
  });
}

test('qualified manual-marker replacement still requires every newer incoming key and rejects old receipts', async () => {
  const f = fixture();
  try {
    f.ev.emit('app-state.update', manualAction());
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    f.ev.buffer();
    const first = f.incoming(f.message('first', base + 10));
    const second = f.incoming(f.message('second', base + 20));
    f.receipt(first.key);
    f.ev.flush();
    f.receipt(first.key);
    assert.equal((await f.chat()).unread, true);
    f.receipt(second.key);
    assert.equal((await f.chat()).unread, false);
    const third = f.incoming(f.message('third', base + 30));
    f.receipt(first.key);
    f.receipt(second.key);
    assert.equal((await f.chat()).unread, true);
    f.receipt(third.key);
    assert.equal((await f.chat()).unread, false);
  } finally {
    await f.close();
  }
});

test('a newly decoded manual action retires coverage before its buffered legacy counter arrives', async () => {
  const f = fixture();
  try {
    const first = f.incoming();
    f.ev.emit('app-state.update', manualAction((base + 20) * 1000));
    f.receipt(first.key, base + 15);
    assert.equal((await f.chat()).unread, true);
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    f.receipt(first.key);
    assert.equal((await f.chat()).unread, true);
    f.incoming(first);
    f.receipt(first.key);
    assert.equal((await f.chat()).unread, true);
  } finally {
    await f.close();
  }
});

for (const initial of [null, 2, -1]) {
  test(`a manual action over an unknown or nonzero baseline cannot qualify replacement (${initial})`, async () => {
    const f = fixture(initial);
    try {
      f.ev.emit('app-state.update', manualAction());
      f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      const msg = f.incoming();
      f.receipt(msg.key);
      assert.equal((await f.chat()).unread, true);
      assert.equal((await f.chat()).readObservation, undefined);
    } finally {
      await f.close();
    }
  });
}

for (const invalid of [
  'same-second',
  'clock-ahead',
  'snapshot',
  'replay',
  'incomplete',
  'new-intent',
] as const) {
  test(`manual replacement rejects ${invalid} evidence`, async () => {
    const f = fixture();
    try {
      if (invalid === 'replay' || invalid === 'new-intent')
        f.ev.emit('messages.upsert', {
          messages: [f.message('previous', base)],
          type: 'append',
        });
      f.ev.emit(
        'app-state.update',
        manualAction(
          invalid === 'same-second'
            ? (base + 10) * 1000
            : invalid === 'clock-ahead'
              ? (base + 20) * 1000
              : undefined,
        ),
      );
      f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      if (invalid === 'snapshot')
        f.ev.emit('chats.upsert', [{ id: jid, unreadCount: -1 }]);
      if (invalid === 'new-intent')
        await f.runtime.execute({
          command: 'mark-read',
          jid,
          value: true,
          key: 'intervening-read',
        });
      const msg = f.incoming(
        invalid === 'replay' ? f.message('previous') : undefined,
        invalid === 'incomplete' ? 2 : 1,
      );
      f.receipt(msg.key);
      assert.equal((await f.chat()).unread, true);
      assert.equal((await f.chat()).readObservation, undefined);
    } finally {
      await f.close();
    }
  });
}

test('qualified manual replacement and partial coverage persist across restart', async () => {
  const f = fixture();
  f.ev.emit('app-state.update', manualAction());
  f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
  const first = f.incoming(f.message('first', base + 10));
  const second = f.incoming(f.message('second', base + 20));
  f.receipt(first.key);
  await f.close();
  const store = new Store(f.directory);
  try {
    assert.equal(store.chatView(jid)?.unread, true);
    store.observeOwnReadReceipt(second.key, base + 100);
    assert.equal(store.chatView(jid)?.unread, false);
  } finally {
    store.close();
  }
});

for (const invalid of [
  'missing-time',
  'local-echo',
  'initial-sync',
  'snapshot',
  'old-frontier',
] as const) {
  test(`a manual marker with ${invalid} metadata cannot qualify a read baseline`, async () => {
    const f = fixture();
    try {
      const action = manualAction();
      if (invalid === 'missing-time') delete action.timestamp;
      if (invalid === 'local-echo') action.source = 'local-echo';
      if (action.source === 'sync') {
        if (invalid === 'initial-sync') action.initialSync = true;
        if (invalid === 'snapshot') action.representation = 'snapshot';
      }
      if (invalid === 'old-frontier')
        f.ev.emit('messages.upsert', {
          messages: [f.message('uncovered', base + 1)],
          type: 'append',
        });
      f.ev.emit('app-state.update', action);
      f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      const msg = f.incoming();
      f.receipt(msg.key);
      assert.equal((await f.chat()).unread, true);
      assert.equal((await f.chat()).readObservation, undefined);
    } finally {
      await f.close();
    }
  });
}

test('an ambiguous first arrival or later replay cannot regain manual-marker qualification', async () => {
  for (const ambiguous of ['same-second', 'incomplete', 'replay'] as const) {
    const f = fixture();
    try {
      f.ev.emit('app-state.update', manualAction());
      f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      const first = f.incoming(
        f.message('first', ambiguous === 'same-second' ? base + 5 : base + 10),
        ambiguous === 'incomplete' ? 2 : 1,
      );
      if (ambiguous === 'replay') f.incoming(first);
      f.receipt(first.key);
      if (ambiguous !== 'replay') assert.equal((await f.chat()).unread, true);
      const next = f.incoming(f.message('later', base + 30));
      f.receipt(next.key);
      assert.equal((await f.chat()).unread, true);
      assert.equal((await f.chat()).readObservation, undefined);
    } finally {
      await f.close();
    }
  }
});

for (const value of [false, true]) {
  test(`a new read=${value} intent retires qualified manual coverage`, async () => {
    const f = fixture();
    try {
      f.ev.emit('app-state.update', manualAction());
      f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      const first = f.incoming();
      await f.runtime.execute({
        command: 'mark-read',
        jid,
        value,
        key: 'replace-qualified-range',
      });
      f.receipt(first.key);
      assert.equal((await f.chat()).unread, null);
      const next = f.incoming(f.message('after-intent', base + 20));
      f.receipt(next.key);
      assert.equal((await f.chat()).unread, true);
      assert.equal((await f.chat()).readObservation, undefined);
    } finally {
      await f.close();
    }
  });
}

test('a manual action cannot qualify against a stale stored zero while an incoming increment is buffered', async () => {
  const f = fixture();
  try {
    f.ev.buffer();
    const first = f.incoming(f.message('before-marker', base + 1), 2);
    f.ev.emit('app-state.update', manualAction());
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    const next = f.incoming(f.message('after-marker', base + 10));
    f.ev.flush();
    f.receipt(first.key);
    f.receipt(next.key);
    assert.equal((await f.chat()).unread, true);
    assert.equal((await f.chat()).readObservation, undefined);
  } finally {
    await f.close();
  }
});

test('older, duplicate and local-echo actions are neutral to newer qualified coverage', async () => {
  const f = fixture();
  try {
    f.ev.emit('app-state.update', manualAction(undefined, 2));
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    const msg = f.incoming();
    f.ev.emit('app-state.update', manualAction((base + 1) * 1000, 1));
    f.ev.emit('app-state.update', manualAction(undefined, 2));
    f.ev.emit('app-state.update', {
      ...manualAction(undefined, 3),
      source: 'local-echo',
    });
    f.receipt(msg.key);
    assert.equal((await f.chat()).unread, false);
    assert.ok(object((await f.chat()).readObservation).replacedManualMarker);
  } finally {
    await f.close();
  }
});

test('append history cannot qualify a manual-marker range even when buffered with a matching increment', async () => {
  const f = fixture();
  try {
    f.ev.emit('app-state.update', manualAction());
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    f.ev.buffer();
    const msg = f.message();
    f.ev.emit('messages.upsert', { messages: [msg], type: 'append' });
    f.ev.emit('chats.update', [
      { id: jid, unreadCount: 1, messages: [{ message: msg }] },
    ]);
    f.receipt(msg.key);
    f.ev.flush();
    assert.equal((await f.chat()).unread, true);
    assert.equal((await f.chat()).readObservation, undefined);
  } finally {
    await f.close();
  }
});

test('crashing before an incomplete increment flush cannot restore a stale zero baseline', async () => {
  const f = fixture();
  await f.close();
  const first = new Store(f.directory);
  first.captureChatUpdate({
    id: jid,
    unreadCount: 2,
    messages: [{ message: f.message('uncovered', base + 1) }],
  });
  assert.equal(first.chatView(jid)?.unread, false);
  first.close();
  const reopened = new Store(f.directory);
  try {
    reopened.recordAppStateChatAction(manualAction());
    reopened.captureChatUpdate({ id: jid, unreadCount: -1 });
    reopened.observeChat({ id: jid, unreadCount: -1 }, 'buffered-update');
    const next = f.message('new', base + 20);
    const update = { id: jid, unreadCount: 1, messages: [{ message: next }] };
    reopened.captureChatUpdate(update);
    reopened.observeChat(update, 'buffered-update');
    reopened.observeMessage(next, true, 'notify');
    reopened.observeOwnReadReceipt(next.key, base + 100);
    assert.equal(reopened.chatView(jid)?.unread, true);
    assert.equal(reopened.chatView(jid)?.readObservation, undefined);
  } finally {
    reopened.close();
  }
});

test('pending archive remains independent of marker qualification from observed read', async () => {
  const f = fixture();
  try {
    f.ev.emit('messages.upsert', {
      messages: [f.message('previous', base)],
      type: 'notify',
    });
    await f.runtime.execute({
      command: 'archive',
      jid,
      value: false,
      key: 'archive-pending',
    });
    f.ev.emit('app-state.update', manualAction());
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    const msg = f.incoming();
    f.receipt(msg.key);
    const chat = await f.chat();
    assert.equal(chat.unread, false);
    assert.equal(chat.archived, null);
    assert.equal(object(object(chat.pending).archived).key, 'archive-pending');
  } finally {
    await f.close();
  }
});

test('a late echo from an older read intent cannot retire the newer incoming range', async () => {
  const f = fixture();
  try {
    f.ev.emit('messages.upsert', {
      messages: [f.message('previous', base)],
      type: 'notify',
    });
    await f.runtime.execute({
      command: 'mark-read',
      jid,
      value: true,
      key: 'older-read',
    });
    const msg = f.incoming();
    f.ev.emit('app-state.update', {
      ...manualAction(),
      source: 'local-echo',
      requestId: 'older-read',
      action: { kind: 'mark-read', read: true },
    });
    f.receipt(msg.key);
    assert.equal((await f.chat()).unread, false);
  } finally {
    await f.close();
  }
});

test('an ambiguous same-second marker with absorbed READ cannot turn missing delta into total zero', async () => {
  const f = fixture();
  try {
    f.ev.buffer();
    f.ev.emit('app-state.update', manualAction((base + 10) * 1000));
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    const msg = f.incoming();
    f.receipt(msg.key);
    f.ev.flush();
    assert.notEqual((await f.chat()).unread, false);
    assert.equal((await f.chat()).readObservation, undefined);
    assert.ok((await f.chat()).readReconciliation);
  } finally {
    await f.close();
  }
});

test('an anchored marker need not list every previously read ID sharing its timestamp', async () => {
  const f = fixture();
  try {
    f.ev.emit('messages.upsert', {
      messages: [f.message('other-already-read', base)],
      type: 'notify',
    });
    f.ev.emit('chats.update', [{ id: jid, unreadCount: 0 }]);
    f.ev.emit('app-state.update', manualAction());
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    const msg = f.incoming();
    f.receipt(msg.key);
    assert.equal((await f.chat()).unread, false);
  } finally {
    await f.close();
  }
});

test('a marker referencing unseen content cannot qualify a locally stale zero', async () => {
  const f = fixture();
  try {
    const action = manualAction();
    action.messageRange = {
      lastMessageTimestamp: base + 1,
      messages: [
        { id: 'not-observed-locally', fromMe: false, timestamp: base + 1 },
      ],
    };
    f.ev.emit('app-state.update', action);
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    const msg = f.incoming();
    f.receipt(msg.key);
    assert.equal((await f.chat()).unread, true);
    assert.equal((await f.chat()).readObservation, undefined);
  } finally {
    await f.close();
  }
});

test('a discarded conditional SDK update cannot retire newer qualified coverage', async () => {
  const f = fixture();
  try {
    f.ev.emit('app-state.update', manualAction());
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    const msg = f.incoming();
    f.ev.buffer();
    f.ev.emit('chats.update', [
      { id: jid, unreadCount: -1, conditional: () => false },
    ]);
    f.ev.flush();
    f.receipt(msg.key);
    assert.equal((await f.chat()).unread, false);
  } finally {
    await f.close();
  }
});

for (const buffered of [false, true]) {
  test(`a remotely earlier manual action arriving after the increment rebases its observed-zero range (buffered=${buffered})`, async () => {
    const f = fixture();
    try {
      if (buffered) f.ev.buffer();
      const msg = f.incoming();
      f.ev.emit('app-state.update', manualAction());
      f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      if (buffered) f.receipt(msg.key);
      f.ev.flush();
      if (!buffered) f.receipt(msg.key);
      const chat = await f.chat();
      assert.equal(chat.unread, false);
      assert.equal(chat.unreadCount, 0);
      assert.equal(chat.readReconciliation, undefined);
      assert.deepEqual(object(chat.readObservation).replacedManualMarker, {
        timestamp: (base + 5) * 1000,
        frontier: base,
        version: 1,
      });
      assert.deepEqual(await f.queue(), []);
      assert.deepEqual(await f.queue(true), []);
    } finally {
      await f.close();
    }
  });
}

test('rebasing retains all incoming IDs and still requires full own-receipt coverage', async () => {
  const f = fixture();
  try {
    const first = f.incoming(f.message('first', base + 10));
    const second = f.incoming(f.message('second', base + 20));
    f.receipt(first.key);
    f.ev.emit('app-state.update', manualAction());
    f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
    f.receipt(first.key);
    assert.equal((await f.chat()).unread, true);
    f.receipt(second.key);
    assert.equal((await f.chat()).unread, false);
    assert.deepEqual(object((await f.chat()).readObservation).messages, [
      { id: 'first', timestamp: base + 10 },
      { id: 'second', timestamp: base + 20 },
    ]);
  } finally {
    await f.close();
  }
});

test('the observed-zero frontier survives restart before the delayed action arrives', async () => {
  const f = fixture();
  const msg = f.incoming();
  await f.close();
  const store = new Store(f.directory);
  try {
    store.recordAppStateChatAction(manualAction());
    store.captureChatUpdate({ id: jid, unreadCount: -1 });
    store.observeChat({ id: jid, unreadCount: -1 }, 'buffered-update');
    store.observeOwnReadReceipt(msg.key, base + 100);
    assert.equal(store.chatView(jid)?.unread, false);
  } finally {
    store.close();
  }
});

for (const initial of [null, 2, -1]) {
  test(`a delayed action cannot rebase an unknown/nonzero origin (${initial})`, async () => {
    const f = fixture(initial);
    try {
      const msg = f.incoming();
      f.ev.emit('app-state.update', manualAction());
      f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      f.receipt(msg.key);
      assert.equal((await f.chat()).unread, true);
      assert.equal((await f.chat()).readObservation, undefined);
    } finally {
      await f.close();
    }
  });
}

for (const invalid of [
  'posterior-action',
  'same-second',
  'unpaired-marker',
  'read-intent',
  'unread-intent',
  'late-intent',
  'incomplete',
  'append',
  'replay',
  'untracked-notify',
  'untracked-history',
  'unknown-frontier',
  'prior-read-after-action',
] as const) {
  test(`a delayed manual action cannot rebase ${invalid} evidence`, async () => {
    const f = fixture();
    try {
      if (invalid === 'prior-read-after-action') {
        const earlier = f.incoming(f.message('earlier-covered', base - 1));
        f.receipt(earlier.key, base + 7);
      }
      if (invalid === 'read-intent' || invalid === 'unread-intent')
        await f.runtime.execute({
          command: 'mark-read',
          jid,
          value: invalid === 'read-intent',
          key: 'intervening-intent',
        });
      const msg = f.incoming(undefined, invalid === 'incomplete' ? 2 : 1);
      if (invalid === 'late-intent')
        await f.runtime.execute({
          command: 'mark-read',
          jid,
          value: true,
          key: 'late-intent',
        });
      if (invalid === 'append')
        f.ev.emit('messages.upsert', { messages: [msg], type: 'append' });
      if (invalid === 'replay') f.incoming(msg);
      if (invalid === 'untracked-notify' || invalid === 'untracked-history')
        f.ev.emit('messages.upsert', {
          messages: [f.message('untracked', base + 20)],
          type: invalid === 'untracked-notify' ? 'notify' : 'append',
        });
      const action = manualAction(
        invalid === 'posterior-action'
          ? (base + 20) * 1000
          : invalid === 'same-second'
            ? (base + 10) * 1000
            : undefined,
      );
      if (invalid === 'unknown-frontier' && action.messageRange)
        action.messageRange.messages = [
          { id: 'not-stored', fromMe: false, timestamp: base },
        ];
      f.ev.emit('app-state.update', action);
      f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      if (invalid === 'unpaired-marker')
        f.ev.emit('chats.update', [{ id: jid, unreadCount: -1 }]);
      f.receipt(msg.key);
      assert.equal((await f.chat()).unread, true);
      assert.equal((await f.chat()).readObservation, undefined);
    } finally {
      await f.close();
    }
  });
}
