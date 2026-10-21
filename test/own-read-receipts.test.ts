import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initAuthCreds, makeEventBuffer, proto } from 'baileys';
import type { WAMessage, WAMessageKey, WASocket } from 'baileys';
import { pino } from 'pino';
import { createRuntime } from '../src/runtime.js';
import { object } from '../src/protocol.js';
import { formatResponse } from '../src/response.js';
import { Store } from '../src/store.js';

const jid = '12025550101@s.whatsapp.net';
const me = '12025550199@s.whatsapp.net';
const lid = '900000000000099@lid';
const base = 1700000000;

function fixture(initial: number | null = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'own-read-'));
  const seed = new Store(directory);
  seed.set('auth', 'creds', {
    ...initAuthCreds(),
    me: { id: me, lid, name: 'Fictional owner' },
  });
  seed.observeChat({ id: jid, unreadCount: initial, archived: true });
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
  return {
    directory,
    runtime,
    ev,
    message,
    incoming,
    receipt,
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
