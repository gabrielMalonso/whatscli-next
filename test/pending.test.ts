import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { proto } from 'baileys';
import type { BaileysEventMap, ChatUpdate, WASocket } from 'baileys';
import { perform } from '../src/operations.js';
import { parseCommand } from '../src/protocol.js';
import { createRuntime } from '../src/runtime.js';
import { encode, Store } from '../src/store.js';

process.umask(0o077);
const temporary = (): string => mkdtempSync(join(tmpdir(), 'pending-'));
const pn = '12025550101@s.whatsapp.net';
const lid = '123450001@lid';
const ids = (
  store: Store,
  unread?: boolean | 'unknown',
  archived?: boolean | 'unknown',
) =>
  store
    .chats(100, 0, {
      ...(unread === undefined ? {} : { unread }),
      ...(archived === undefined ? {} : { archived }),
    })
    .map((chat) => chat.jid);

test('chat filters validate tri-state values and preserve existing command defaults', () => {
  assert.deepEqual(parseCommand({ command: 'chats' }), {
    command: 'chats',
    limit: 100,
    offset: 0,
  });
  for (const unread of [true, false, 'unknown'])
    for (const archived of [true, false, 'unknown']) {
      assert.deepEqual(
        parseCommand({
          command: 'chats',
          unread,
          archived,
          limit: 2,
          offset: 3,
        }),
        { command: 'chats', unread, archived, limit: 2, offset: 3 },
      );
    }
  for (const field of ['unread', 'archived'])
    for (const value of [null, 0, 1, '', 'true', 'false', 'pending', []]) {
      assert.throws(
        () => parseCommand({ command: 'chats', [field]: value }),
        /true, false or unknown/,
      );
    }
  for (const pagination of [
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { offset: 1.5 },
  ])
    assert.throws(
      () => parseCommand({ command: 'chats', ...pagination }),
      /integer/,
    );
});

test('all filter combinations include exactly the effective observed states, including unknown', () => {
  const store = new Store(temporary());
  try {
    const states = [true, false, 'unknown'] as const;
    for (const [u, unread] of states.entries())
      for (const [a, archived] of states.entries()) {
        store.observeChat({
          id: `12025550${u}${a}00@s.whatsapp.net`,
          ...(unread === 'unknown' ? {} : { unreadCount: unread ? 3 : 0 }),
          ...(archived === 'unknown' ? {} : { archived }),
        });
      }
    assert.equal(store.chats().length, 9);
    for (const [u, unread] of states.entries())
      for (const [a, archived] of states.entries()) {
        assert.deepEqual(ids(store, unread, archived), [
          `12025550${u}${a}00@s.whatsapp.net`,
        ]);
      }
    for (const state of states) {
      assert.equal(ids(store, state).length, 3);
      assert.equal(ids(store, undefined, state).length, 3);
    }
    assert.equal(
      store
        .chats()
        .filter((chat) => chat.unread === true)
        .every((chat) => chat.unreadCount === null),
      true,
    );
  } finally {
    store.close();
  }
});

test('counter and manual unread precedence survives partial updates without treating increments as totals', () => {
  const store = new Store(temporary());
  try {
    const steps: {
      update: ChatUpdate;
      unread: boolean | null;
      count: number | null;
    }[] = [
      { update: { id: pn }, unread: null, count: null },
      { update: { id: pn, markedAsUnread: false }, unread: null, count: null },
      { update: { id: pn, unreadCount: -1 }, unread: true, count: -1 },
      { update: { id: pn, markedAsUnread: false }, unread: null, count: null },
      { update: { id: pn, unreadCount: 3 }, unread: true, count: null },
      { update: { id: pn, markedAsUnread: false }, unread: true, count: null },
      {
        update: { id: pn, unreadCount: 0, markedAsUnread: true },
        unread: true,
        count: 0,
      },
      { update: { id: pn, unreadCount: 0 }, unread: false, count: 0 },
      {
        update: { id: pn, unreadCount: -1, markedAsUnread: false },
        unread: true,
        count: -1,
      },
      {
        update: {
          id: pn,
          name: 'Metadata only',
          unreadCount: null,
          markedAsUnread: null,
        },
        unread: true,
        count: -1,
      },
      { update: { id: pn, unreadCount: 1 }, unread: true, count: null },
      { update: { id: pn, unreadCount: 0 }, unread: false, count: 0 },
    ];
    for (const step of steps) {
      store.observeChat(step.update);
      assert.equal(
        store.chatView(pn)?.unread,
        step.unread,
        encode(step.update),
      );
      assert.equal(
        store.chatView(pn)?.unreadCount,
        step.count,
        encode(step.update),
      );
      assert.deepEqual(ids(store, step.unread ?? 'unknown'), [pn]);
    }
  } finally {
    store.close();
  }
});

test('pending state is filtered as unknown across restart until matching fresh fields replace stale evidence', async () => {
  const directory = temporary();
  let store = new Store(directory);
  try {
    store.observeChat({
      id: pn,
      archived: false,
      unreadCount: 7,
      markedAsUnread: true,
    });
    await perform(
      store,
      'read',
      { kind: 'mark-read', jid: pn, value: true },
      () => {},
      async () => {},
    );
    await perform(
      store,
      'archive',
      { kind: 'archive', jid: pn, value: true },
      () => {},
      async () => {},
    );
    store.observeChat({
      id: pn,
      name: 'Unrelated',
      unreadCount: null,
      archived: null,
      markedAsUnread: null,
    });
    assert.deepEqual(ids(store, 'unknown', 'unknown'), [pn]);
    assert.deepEqual(ids(store, false, false), []);
    store.close();
    store = new Store(directory);
    assert.deepEqual(ids(store, 'unknown', 'unknown'), [pn]);
    store.observeChat({ id: pn, archived: true });
    assert.deepEqual(ids(store, 'unknown', true), [pn]);
    assert.equal(store.chatView(pn)?.pending.unread?.key, 'read');
    store.observeChat({ id: pn, markedAsUnread: false });
    assert.equal(store.chatView(pn)?.unread, null);
    assert.equal(store.chatView(pn)?.unreadCount, null);
    assert.equal(store.chatView(pn)?.pending.unread?.key, 'read');
    store.observeChat({ id: pn, unreadCount: 0 });
    assert.equal(store.chatView(pn)?.unread, false);
    assert.deepEqual(store.chatView(pn)?.pending, {});
    await perform(
      store,
      'unread',
      { kind: 'mark-read', jid: pn, value: false },
      () => {},
      async () => {},
    );
    store.observeChat({ id: pn, unreadCount: 2 });
    assert.equal(store.chatView(pn)?.unread, true);
    assert.equal(store.chatView(pn)?.unreadCount, null);
    await perform(
      store,
      'unarchive',
      { kind: 'archive', jid: pn, value: false },
      () => {},
      async () => {},
    );
    store.observeChat({ id: pn, unreadCount: 0 });
    assert.deepEqual(ids(store, false, 'unknown'), [pn]);
    assert.equal(store.chatView(pn)?.pending.archived?.key, 'unarchive');
    store.observeChat({ id: pn, archived: false });
    assert.deepEqual(ids(store, false, false), [pn]);
  } finally {
    store.close();
  }
});

test('activity uses event timestamps, deterministic ties and nulls, never metadata or SDK return time', () => {
  const store = new Store(temporary());
  try {
    store.observeChat({
      id: pn,
      conversationTimestamp: 200,
      lastMsgTimestamp: 180,
      lastMessageRecvTimestamp: 190,
    });
    store.observeChat({ id: lid, conversationTimestamp: 100 });
    store.observeChat({
      id: pn,
      name: 'Renamed',
      timestamp: 999999,
      conversationTimestamp: 20,
    });
    assert.deepEqual(store.chatView(pn)?.activity, {
      timestamp: 200,
      source: 'chat.conversationTimestamp',
    });
    store.observeMessage({
      key: { remoteJid: lid, id: 'new', fromMe: false },
      messageTimestamp: 300,
    });
    store.observeMessage({
      key: { remoteJid: lid, id: 'old', fromMe: false },
      messageTimestamp: 5,
    });
    assert.deepEqual(
      store.chats().map((chat) => chat.jid),
      [lid, pn],
    );
    store.observeMessage(
      {
        key: { remoteJid: pn, id: 'sdk-return', fromMe: true },
        messageTimestamp: 900,
      },
      false,
    );
    store.updateMessage({
      key: { remoteJid: pn, id: 'sdk-return', fromMe: true },
      update: { status: proto.WebMessageInfo.Status.SERVER_ACK },
    });
    assert.equal(store.chatView(pn)?.activity.timestamp, 200);
    store.observeMessage({
      key: { remoteJid: pn, id: 'echo', fromMe: true },
      messageTimestamp: 300,
    });
    store.observeChat({ id: lid, conversationTimestamp: 300 });
    store.observeChat({ id: pn, conversationTimestamp: 300 });
    assert.deepEqual(
      store.chats().map((chat) => chat.jid),
      [pn, lid],
    );
    for (const jid of [
      '12025550103@s.whatsapp.net',
      '12025550102@s.whatsapp.net',
    ])
      store.observeChat({
        id: jid,
        conversationTimestamp: 0,
        lastMsgTimestamp: -1,
      });
    assert.deepEqual(
      store
        .chats()
        .slice(2)
        .map((chat) => chat.activity),
      [
        { timestamp: null, source: null },
        { timestamp: null, source: null },
      ],
    );
    assert.deepEqual(
      store
        .chats()
        .slice(2)
        .map((chat) => chat.jid),
      ['12025550102@s.whatsapp.net', '12025550103@s.whatsapp.net'],
    );
    assert.deepEqual(
      store
        .chats()
        .slice(0, 2)
        .map((chat) => chat.activity),
      [
        { timestamp: 300, source: 'chat.conversationTimestamp' },
        { timestamp: 300, source: 'chat.conversationTimestamp' },
      ],
    );
  } finally {
    store.close();
  }
});

test('filters run before pagination beyond 100 results; stable ties and missing activity survive restart', () => {
  const directory = temporary();
  let store = new Store(directory);
  try {
    store.transaction(() => {
      for (let index = 0; index < 270; index++)
        store.observeChat({
          id: `1202555${String(index).padStart(4, '0')}@s.whatsapp.net`,
          unreadCount: index % 2 ? 0 : 1,
          archived: false,
          ...(index < 220 ? { conversationTimestamp: 100 } : {}),
        });
    });
    const pages = (current: Store) =>
      [0, 50, 100, 135].map((offset) =>
        current.chats(50, offset, { unread: true, archived: false }),
      );
    const before = pages(store);
    assert.deepEqual(
      before.map((page) => page.length),
      [50, 50, 35, 0],
    );
    assert.equal(new Set(before.flat().map((chat) => chat.jid)).size, 135);
    assert.equal(
      before
        .flat()
        .slice(110)
        .every((chat) => chat.activity.timestamp === null),
      true,
    );
    store.close();
    store = new Store(directory);
    assert.deepEqual(pages(store), before);
  } finally {
    store.close();
  }
});

test('upgrade recovers timestamp fields and incoming history only for observed chats, without reading deleted bodies', () => {
  const directory = temporary();
  const db = new DatabaseSync(join(directory, 'probe.sqlite'));
  db.exec(`CREATE TABLE chats (jid TEXT PRIMARY KEY,json TEXT NOT NULL,observed_at INTEGER NOT NULL);
    CREATE TABLE messages (jid TEXT,id TEXT,from_me INTEGER,participant TEXT,timestamp INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(jid,id,from_me,participant));`);
  const legacy = proto.Conversation.fromObject({
    id: pn,
    conversationTimestamp: '200',
  });
  db.prepare('INSERT INTO chats VALUES (?,?,?)').run(
    pn,
    encode(legacy),
    999999,
  );
  db.prepare('INSERT INTO chats VALUES (?,?,?)').run(
    lid,
    encode({ id: lid }),
    999999,
  );
  const legacyLong = proto.Conversation.fromObject({
    id: '12025550103@s.whatsapp.net',
    lastMsgTimestamp: '400',
  });
  db.prepare('INSERT INTO chats VALUES (?,?,?)').run(
    '12025550103@s.whatsapp.net',
    encode(legacyLong),
    999999,
  );
  for (const [jid, timestamp] of [
    ['12025550104@s.whatsapp.net', '2147483648'],
    ['12025550105@s.whatsapp.net', '4294967496'],
  ] as const) {
    // The old observeChat spread loses the protobuf toJSON method and stores Long words.
    const legacyPlain = {
      ...proto.Conversation.fromObject({
        id: jid,
        conversationTimestamp: timestamp,
      }),
    };
    db.prepare('INSERT INTO chats VALUES (?,?,?)').run(
      jid,
      encode(legacyPlain),
      999999,
    );
  }
  for (const [jid, id, fromMe, timestamp] of [
    [pn, 'received', false, 300],
    [pn, 'returned', true, 900],
    ['12025550102@s.whatsapp.net', 'unobserved', true, 999],
  ] as const) {
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(
      jid,
      id,
      Number(fromMe),
      '',
      timestamp,
      encode({
        key: { remoteJid: jid, id, fromMe },
        messageTimestamp: timestamp,
        message: null,
      }),
    );
  }
  db.close();
  const store = new Store(directory);
  try {
    assert.deepEqual(
      store.chats().map((chat) => chat.jid),
      [
        '12025550105@s.whatsapp.net',
        '12025550104@s.whatsapp.net',
        '12025550103@s.whatsapp.net',
        pn,
        lid,
      ],
    );
    assert.deepEqual(store.chatView('12025550104@s.whatsapp.net')?.activity, {
      timestamp: 2147483648,
      source: 'chat.conversationTimestamp',
    });
    assert.deepEqual(store.chatView('12025550105@s.whatsapp.net')?.activity, {
      timestamp: 4294967496,
      source: 'chat.conversationTimestamp',
    });
    assert.deepEqual(store.chatView('12025550103@s.whatsapp.net')?.activity, {
      timestamp: 400,
      source: 'chat.lastMsgTimestamp',
    });
    assert.deepEqual(store.chatView(pn)?.activity, {
      timestamp: 300,
      source: 'message.messageTimestamp',
    });
    assert.deepEqual(store.chatView(lid)?.activity, {
      timestamp: null,
      source: null,
    });
  } finally {
    store.close();
  }
});

test('runtime event queries isolate exact PN/LID identities and perform no SDK I/O or read-state mutation', async () => {
  const events = new EventEmitter();
  const runtime = createRuntime(
    { dataDir: temporary(), connect: true },
    () =>
      new Proxy(
        {
          ev: events,
          ws: { isClosed: true },
          end: async () => {
            events.emit('connection.update', { connection: 'close' });
          },
        },
        {
          get(target, property, receiver) {
            if (!(property in target))
              throw new Error(`Unexpected SDK I/O: ${String(property)}`);
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as WASocket,
  );
  runtime.start();
  const emit = <K extends keyof BaileysEventMap>(
    name: K,
    value: BaileysEventMap[K],
  ) => events.emit(name, value);
  try {
    emit('lid-mapping.update', { pn, lid });
    emit('messaging-history.set', {
      chats: [
        { id: pn, archived: false, unreadCount: 1, conversationTimestamp: 200 },
      ],
      contacts: [],
      messages: [],
    });
    emit('chats.upsert', [
      { id: lid, archived: true, unreadCount: 0, conversationTimestamp: 100 },
    ]);
    emit('messaging-history.set', {
      chats: [{ id: pn, conversationTimestamp: 20, name: 'Old chunk' }],
      contacts: [],
      messages: [],
    });
    const before = await runtime.execute({ command: 'chat', jid: pn });
    const query = {
      command: 'chats',
      unread: true,
      archived: false,
      limit: 100,
      offset: 0,
    } as const;
    assert.deepEqual(await runtime.execute(query), [before]);
    assert.equal(
      (
        (await runtime.execute({ command: 'chat', jid: lid })) as {
          archived: boolean;
        }
      ).archived,
      true,
    );
    assert.deepEqual(
      await runtime.execute({ command: 'chat', jid: pn }),
      before,
    );
    assert.equal(runtime.snapshot().source, 'local');
    assert.equal(runtime.snapshot().coverage, 'partial');
  } finally {
    await runtime.close();
  }
});
