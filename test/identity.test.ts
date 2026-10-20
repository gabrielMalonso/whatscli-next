import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { proto } from 'baileys';
import type { BaileysEventMap, WASocket } from 'baileys';
import { sqliteAuth } from '../src/auth.js';
import { internationalPhone } from '../src/identity.js';
import { parseCommand } from '../src/protocol.js';
import { createRuntime } from '../src/runtime.js';
import { encode, Store } from '../src/store.js';

process.umask(0o077);
const temporary = (): string => mkdtempSync(join(tmpdir(), 'identity-'));
const phone = '+12025550101';
const pn = '12025550101@s.whatsapp.net';
const otherPn = '12025550102@s.whatsapp.net';
const lid = '123450001@lid';
const otherLid = '123450002@lid';

function fixture(directory = temporary(), allowedJid?: string) {
  const events = new EventEmitter();
  let lookups = 0;
  let sends = 0;
  let patches = 0;
  let response: Awaited<ReturnType<WASocket['onWhatsApp']>> = [
    { jid: pn, exists: true },
  ];
  let failLookup = false;
  let failSend = false;
  let returnJid = pn;
  const fake = {
    ev: events,
    ws: { isClosed: true },
    end: async () => {
      events.emit('connection.update', { connection: 'close' });
    },
    onWhatsApp: async (...numbers: string[]) => {
      lookups++;
      assert.deepEqual(numbers, [phone]);
      if (failLookup) throw new Error('SDK_PRIVATE_SECRET');
      return response;
    },
    sendMessage: async (
      jid: string,
      _content: unknown,
      options: { messageId: string },
    ) => {
      sends++;
      assert.equal(jid, pn);
      // The intent is already queryable before network invocation.
      assert.equal(
        (
          (await runtime.execute({
            command: 'request',
            key: 'first-send',
          })) as { messageId: string }
        ).messageId,
        options.messageId,
      );
      if (failSend) throw new Error('SDK_PRIVATE_SECRET');
      return {
        key: { remoteJid: returnJid, fromMe: true, id: options.messageId },
        messageTimestamp: 10,
        message: { conversation: 'Fictional first contact' },
      };
    },
    chatModify: async () => {
      patches++;
    },
  };
  // Deliberately partial SDK boundary: no real connection or transport can be constructed.
  const runtime = createRuntime(
    {
      dataDir: directory,
      connect: true,
      ...(allowedJid ? { allowedJid } : {}),
    },
    () => fake as unknown as WASocket,
  );
  runtime.start();
  const emit = <K extends keyof BaileysEventMap>(
    name: K,
    value: BaileysEventMap[K],
  ): void => {
    events.emit(name, value);
  };
  emit('connection.update', { connection: 'open' });
  return {
    runtime,
    emit,
    directory,
    counts: () => ({ lookups, sends, patches }),
    response(value: typeof response) {
      response = value;
    },
    failLookup() {
      failLookup = true;
    },
    failSend() {
      failSend = true;
    },
    returnJid(value: string) {
      returnJid = value;
    },
  };
}

test('phone resolution requires an explicit international prefix and never accepts names or LIDs', () => {
  assert.equal(internationalPhone(phone), phone);
  assert.deepEqual(parseCommand({ command: 'resolve', phone }), {
    command: 'resolve',
    phone,
  });
  for (const invalid of [
    '',
    '12025550101',
    '02025550101',
    '+012025550101',
    '+1 (202) 555-0101',
    ' +12025550101',
    '+123',
    '+1234567890123456',
    lid,
    'Fictional Name',
  ]) {
    assert.throws(() => internationalPhone(invalid), /international/);
    assert.throws(() => parseCommand({ command: 'resolve', phone: invalid }));
  }
  assert.throws(() => parseCommand({ command: 'resolve' }), /phone/);
  assert.throws(
    () => parseCommand({ command: 'contact', jid: '120363000000000001@g.us' }),
    /PN or LID/,
  );
});

test('mapping lookup preserves unknown, known, forward and reverse conflicts across restart', () => {
  const directory = temporary();
  const store = new Store(directory);
  assert.equal(store.contactView(lid).phone, null);
  assert.equal(store.contactView(lid).mapping.status, 'unknown');
  store.observeMapping(pn, lid, 'lid-mapping.update', 100);
  assert.equal(store.contactView(lid).phone, phone);
  assert.equal(store.contactView(pn).mapping.lid, lid);
  store.observeMapping(otherPn, lid, 'contacts.update', 200);
  assert.equal(store.contactView(pn).mapping.status, 'conflict');
  assert.equal(store.contactView(lid).phone, null);
  assert.equal(store.contactView(lid).mapping.status, 'conflict');
  store.observeMapping(otherPn, otherLid, 'messaging-history.set', 300);
  assert.equal(store.contactView(otherLid).mapping.status, 'conflict');
  store.close();
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.contactView(lid).mapping.status, 'conflict');
    assert.equal(reopened.contactView(pn).mapping.evidence[0]?.observedAt, 100);
    assert.equal(reopened.contactView(pn).source, 'local');
    assert.equal(reopened.contactView(pn).historical, true);
  } finally {
    reopened.close();
  }
});

test('SDK history, contacts, mappings and alternate message keys retain provenance with safe metadata', async () => {
  const f = fixture();
  try {
    const contact = {
      id: lid,
      phoneNumber: pn,
      name: 'Fictional Contact',
      secretKey: 'SDK_PRIVATE_SECRET',
    };
    f.emit('messaging-history.set', {
      chats: [],
      messages: [],
      contacts: [contact],
      lidPnMappings: [{ pn, lid }],
    });
    f.emit('contacts.upsert', [{ id: pn, username: 'fictional-user' }]);
    f.emit('contacts.update', [{ id: lid, notify: 'Fictional Display' }]);
    f.emit('lid-mapping.update', { pn, lid });
    f.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: lid,
            remoteJidAlt: pn,
            id: 'fictional',
            fromMe: false,
          },
          message: { conversation: 'Example' },
        },
      ],
    });
    const result = await f.runtime.execute({ command: 'contact', jid: lid });
    const json = JSON.stringify(result);
    assert.match(json, /Fictional Contact/);
    assert.match(json, /Fictional Display/);
    assert.match(json, /fictional-user/);
    for (const source of [
      'messaging-history.set',
      'contacts.update',
      'lid-mapping.update',
      'message-key',
    ])
      assert.ok(json.includes(source));
    assert.doesNotMatch(json, /SDK_PRIVATE_SECRET|secretKey/);
    assert.doesNotMatch(
      JSON.stringify(await f.runtime.execute({ command: 'events', after: 0 })),
      /SDK_PRIVATE_SECRET|secretKey/,
    );
  } finally {
    await f.runtime.close();
  }
});

test('legacy mapping events and SDK key-store entries migrate without inventing timestamps', async () => {
  const directory = temporary();
  const store = new Store(directory);
  store.set('migration', 'contact-identity-v1', null);
  store.event('lid-mapping', { pn, lid });
  store.set('lid-mapping', '12025550101', '123450001');
  store.set('lid-mapping', '123450001_reverse', '12025550102');
  store.close();
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.contactView(lid).mapping.status, 'conflict');
    assert.ok(
      reopened
        .contactView(lid)
        .mapping.evidence.some(
          (row) =>
            row.source === 'baileys.key-store' && row.observedAt === null,
        ),
    );
    const auth = sqliteAuth(reopened);
    await auth.state.keys.set({
      'lid-mapping': { '12025550102': '123450002' },
    });
    assert.equal(reopened.contactView(otherLid).mapping.status, 'conflict');
    assert.ok(
      reopened
        .contactView(otherLid)
        .mapping.evidence.some((row) => row.observedAt !== null),
    );
  } finally {
    reopened.close();
  }
});

test('migration recovers legacy message-key identities offline without rewriting history or requests', () => {
  const directory = temporary();
  const store = new Store(directory);
  store.set('migration', 'contact-identity-v1', null);
  const group = '120363000000000001@g.us';
  const keys = [
    {
      remoteJid: group,
      id: 'legacy-group',
      fromMe: false,
      participant: lid,
      participantAlt: pn,
    },
    {
      remoteJid: otherPn,
      remoteJidAlt: otherLid,
      id: 'legacy-direct',
      fromMe: true,
    },
    {
      remoteJid: '123450003@lid',
      remoteJidAlt: '12025550103:2@s.whatsapp.net',
      id: 'legacy-device',
      fromMe: false,
    },
  ];
  for (const key of keys) {
    store.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(
      key.remoteJid,
      key.id,
      Number(key.fromMe),
      'participant' in key ? key.participant : '',
      10,
      encode({
        key,
        messageTimestamp: 10,
        message: {
          conversation: 'Fictional legacy message',
          messageContextInfo: {
            messageSecret: Buffer.from('SDK_PRIVATE_SECRET'),
          },
        },
      }),
    );
  }
  store.saveRequest({
    key: 'legacy-send',
    operation: { kind: 'send', jid: otherPn, text: 'Example' },
    messageId: 'legacy-direct',
    attempt: 'uncertain',
    acceptance: 'unknown',
    delivery: 'unknown',
    read: 'unknown',
    errorObserved: false,
  });
  const originalMessages = store.db
    .prepare('SELECT * FROM messages ORDER BY id')
    .all();
  const originalRequest = store.request('legacy-send');
  store.close();
  const reopened = new Store(directory);
  try {
    for (const [jid, expectedPn] of [
      [lid, pn],
      [otherLid, otherPn],
    ] as const) {
      const contact = reopened.contactView(jid);
      assert.equal(contact.mapping.status, 'known');
      assert.equal(contact.mapping.pn, expectedPn);
      assert.equal(contact.mapping.evidence[0]?.source, 'message-key');
      assert.equal(contact.mapping.evidence[0]?.observedAt, null);
      assert.doesNotMatch(
        JSON.stringify(contact),
        /SDK_PRIVATE_SECRET|messageSecret/,
      );
    }
    assert.equal(reopened.contactView('123450003@lid').phone, null);
    assert.deepEqual(
      reopened.db.prepare('SELECT * FROM messages ORDER BY id').all(),
      originalMessages,
    );
    assert.deepEqual(reopened.request('legacy-send'), originalRequest);
  } finally {
    reopened.close();
  }
});

test('resolve persists exact verification; first send has no invented chat or alias authorization', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.runtime.execute({
        command: 'send',
        jid: pn,
        key: 'first-send',
        text: 'Example',
      }),
      /verification/,
    );
    const resolved = await f.runtime.execute({ command: 'resolve', phone });
    assert.equal((resolved as { jid: string }).jid, pn);
    assert.equal(await f.runtime.execute({ command: 'chat', jid: pn }), null);
    assert.deepEqual(
      await f.runtime.execute({ command: 'chats', limit: 100, offset: 0 }),
      [],
    );
    f.emit('lid-mapping.update', { pn, lid });
    await assert.rejects(
      f.runtime.execute({
        command: 'send',
        jid: lid,
        key: 'lid-send',
        text: 'Example',
      }),
      /verification/,
    );
    const sent = await f.runtime.execute({
      command: 'send',
      jid: pn,
      key: 'first-send',
      text: 'Example',
    });
    assert.equal((sent as { attempt: string }).attempt, 'sdk-returned');
    assert.equal(await f.runtime.execute({ command: 'chat', jid: pn }), null);
    assert.deepEqual(
      await f.runtime.execute({
        command: 'chats',
        unread: 'unknown',
        limit: 100,
        offset: 0,
      }),
      [],
    );
    await assert.rejects(
      f.runtime.execute({
        command: 'archive',
        jid: pn,
        key: 'archive',
        value: true,
      }),
      /observed conversation/,
    );
    await assert.rejects(
      f.runtime.execute({
        command: 'mark-read',
        jid: pn,
        key: 'read',
        value: true,
      }),
      /observed conversation/,
    );
    assert.deepEqual(f.counts(), { lookups: 1, sends: 1, patches: 0 });
    // A later independently observed phone echo can establish the conversation.
    f.emit('messages.upsert', {
      type: 'append',
      messages: [
        {
          key: {
            remoteJid: pn,
            fromMe: true,
            id: (sent as { messageId: string }).messageId,
          },
          messageTimestamp: 10,
          message: { conversation: 'Example' },
        },
      ],
    });
    await f.runtime.execute({
      command: 'archive',
      jid: pn,
      key: 'archive',
      value: true,
    });
    assert.equal(f.counts().patches, 1);
  } finally {
    await f.runtime.close();
  }
});

test('missing, partial, ambiguous, alternate and negative SDK replies cannot authorize a first send', async () => {
  const f = fixture();
  try {
    for (const response of [
      undefined,
      [],
      [{ jid: lid, exists: true }],
      [{ jid: otherPn, exists: true }],
      [
        { jid: pn, exists: true },
        { jid: pn, exists: false },
      ],
      [{ jid: pn, exists: false }],
    ]) {
      f.response(response);
      const result = (await f.runtime.execute({
        command: 'resolve',
        phone,
      })) as { jid: string | null; status: string };
      assert.equal(result.jid, null);
      assert.notEqual(result.status, 'confirmed');
      await assert.rejects(
        f.runtime.execute({
          command: 'send',
          jid: pn,
          key: 'first-send',
          text: 'Example',
        }),
        /verification/,
      );
    }
    f.failLookup();
    assert.doesNotMatch(
      JSON.stringify(await f.runtime.execute({ command: 'resolve', phone })),
      /SDK_PRIVATE_SECRET/,
    );
    assert.equal(f.counts().sends, 0);
  } finally {
    await f.runtime.close();
  }
});

test('fresh inconclusive resolution invalidates old verification and conflicts block first contact', async () => {
  const f = fixture();
  try {
    await f.runtime.execute({ command: 'resolve', phone });
    f.response(undefined);
    await f.runtime.execute({ command: 'resolve', phone });
    await assert.rejects(
      f.runtime.execute({
        command: 'send',
        jid: pn,
        key: 'first-send',
        text: 'Example',
      }),
      /verification/,
    );
    f.response([{ jid: pn, exists: true }]);
    f.emit('lid-mapping.update', { pn, lid });
    f.emit('lid-mapping.update', { pn: otherPn, lid });
    const result = (await f.runtime.execute({ command: 'resolve', phone })) as {
      jid: string | null;
      status: string;
    };
    assert.equal(result.status, 'unknown');
    assert.equal(result.jid, null);
    await assert.rejects(
      f.runtime.execute({
        command: 'send',
        jid: pn,
        key: 'first-send',
        text: 'Example',
      }),
      /conflicting/,
    );
  } finally {
    await f.runtime.close();
  }
});

test('verification survives restart; local queries work offline, network operations fail explicitly', async () => {
  const f = fixture();
  await f.runtime.execute({ command: 'resolve', phone });
  await f.runtime.close();
  const offline = createRuntime({ dataDir: f.directory, connect: false });
  try {
    const result = (await offline.execute({ command: 'contact', jid: pn })) as {
      source: string;
      historical: boolean;
      verification: { status: string };
    };
    assert.equal(result.verification.status, 'confirmed');
    assert.equal(result.source, 'local');
    assert.equal(result.historical, true);
    await assert.rejects(
      offline.execute({ command: 'resolve', phone }),
      /not open/,
    );
    await assert.rejects(
      offline.execute({
        command: 'send',
        jid: pn,
        key: 'first-send',
        text: 'Example',
      }),
      /not open/,
    );
  } finally {
    await offline.close();
  }
  const restored = fixture(f.directory);
  try {
    await restored.runtime.execute({
      command: 'send',
      jid: pn,
      key: 'first-send',
      text: 'Example',
    });
    assert.deepEqual(restored.counts(), { lookups: 0, sends: 1, patches: 0 });
  } finally {
    await restored.runtime.close();
  }
});

test('allowed recipient remains exact even when an alias is known and the PN is verified', async () => {
  const f = fixture(temporary(), lid);
  try {
    f.emit('lid-mapping.update', { pn, lid });
    await f.runtime.execute({ command: 'resolve', phone });
    await assert.rejects(
      f.runtime.execute({
        command: 'send',
        jid: pn,
        key: 'first-send',
        text: 'Example',
      }),
      /allowed recipient/,
    );
    assert.equal(f.counts().sends, 0);
  } finally {
    await f.runtime.close();
  }
});

test('repeated uncertain keys bypass resolution and validation without merging identities or receipts', async () => {
  const f = fixture();
  await f.runtime.execute({ command: 'resolve', phone });
  f.failSend();
  const send = {
    command: 'send' as const,
    jid: pn,
    key: 'first-send',
    text: 'Example',
  };
  const original = await f.runtime.execute(send);
  f.emit('lid-mapping.update', { pn, lid });
  f.emit('messages.update', [
    {
      key: {
        remoteJid: lid,
        fromMe: true,
        id: (original as { messageId: string }).messageId,
      },
      update: { status: proto.WebMessageInfo.Status.READ },
    },
  ]);
  f.response(undefined);
  await f.runtime.execute({ command: 'resolve', phone });
  assert.deepEqual(await f.runtime.execute(send), original);
  await assert.rejects(
    f.runtime.execute({ ...send, jid: lid }),
    /different arguments/,
  );
  await assert.rejects(
    f.runtime.execute({ ...send, text: 'Changed' }),
    /different arguments/,
  );
  assert.deepEqual(f.counts(), { lookups: 2, sends: 1, patches: 0 });
  await f.runtime.close();
  const offline = createRuntime({
    dataDir: f.directory,
    connect: false,
    allowedJid: otherPn,
  });
  try {
    assert.deepEqual(await offline.execute(send), original);
  } finally {
    await offline.close();
  }
});

test('file first contact also requires exact persisted verification and repeated keys ignore file changes', async () => {
  const f = fixture();
  const path = join(f.directory, 'fictional.txt');
  writeFileSync(path, 'Fictional attachment');
  const send = {
    command: 'send-file' as const,
    jid: pn,
    key: 'first-send',
    path,
    mime: 'text/plain',
    caption: '',
  };
  try {
    await assert.rejects(f.runtime.execute(send), /verification/);
    await f.runtime.execute({ command: 'resolve', phone });
    const original = await f.runtime.execute(send);
    writeFileSync(path, 'Changed');
    assert.deepEqual(await f.runtime.execute(send), original);
    assert.equal(await f.runtime.execute({ command: 'chat', jid: pn }), null);
    await assert.rejects(
      f.runtime.execute({ ...send, jid: lid }),
      /different arguments/,
    );
    assert.deepEqual(f.counts(), { lookups: 1, sends: 1, patches: 0 });
  } finally {
    await f.runtime.close();
  }
});

test('an SDK send return using another identity stays uncertain and creates no history under that alias', async () => {
  const f = fixture();
  try {
    await f.runtime.execute({ command: 'resolve', phone });
    f.returnJid(lid);
    const result = (await f.runtime.execute({
      command: 'send',
      jid: pn,
      key: 'first-send',
      text: 'Example',
    })) as { attempt: string };
    assert.equal(result.attempt, 'uncertain');
    assert.equal(await f.runtime.execute({ command: 'chat', jid: lid }), null);
    assert.deepEqual(
      await f.runtime.execute({
        command: 'messages',
        jid: lid,
        limit: 20,
        offset: 0,
      }),
      [],
    );
  } finally {
    await f.runtime.close();
  }
});
