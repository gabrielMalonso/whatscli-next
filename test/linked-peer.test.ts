import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { generateWAMessage } from 'baileys';
import type { WAMessage, WASocket } from 'baileys';
import { perform } from '../src/operations.js';
import { formatResponse } from '../src/response.js';
import { createRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { LinkedPeer, RequestRecord } from '../src/store.js';

process.umask(0o077);
const temporary = () => mkdtempSync(join(tmpdir(), 'linked-peer-'));
const runFile = promisify(execFile);

// Fictional identities only.
const pn = '12025550101@s.whatsapp.net';
const lid = '123450001@lid';
const otherPn = '12025550102@s.whatsapp.net';
const otherLid = '123450002@lid';
const group = '120363000000000001@g.us';
const me = '12025550199@s.whatsapp.net';

const message = (
  jid: string,
  id: string,
  timestamp: number,
  fromMe = false,
): WAMessage => ({
  key: { remoteJid: jid, id, fromMe },
  messageTimestamp: timestamp,
  message: { conversation: `FICTIONAL_BODY_${id}` },
});

/** A runtime whose only network boundary is a fictional USync/send socket. */
function sendFixture(directory: string, usync: unknown) {
  const events = new EventEmitter();
  const sends: string[] = [];
  const runtime = createRuntime({ dataDir: directory, connect: true }, () => {
    return {
      ev: events,
      ws: { isClosed: true },
      end: async () => {
        events.emit('connection.update', { connection: 'close' });
      },
      executeUSyncQuery: async () => usync,
      sendMessage: async (
        ...[destination, content, config]: Parameters<WASocket['sendMessage']>
      ) => {
        sends.push(destination);
        return generateWAMessage(destination, content, {
          userJid: me,
          ...config,
          upload: async () => {
            throw new Error('No real uploads');
          },
        });
      },
    } as unknown as WASocket;
  });
  runtime.start();
  events.emit('connection.update', { connection: 'open' });
  return { runtime, events, sends };
}

async function withEnvelope(
  runtime: ReturnType<typeof createRuntime>,
  command: Parameters<ReturnType<typeof createRuntime>['execute']>[0],
) {
  const envelope: Record<string, unknown> = {};
  const data = await runtime.execute(command, {}, envelope);
  return { data, envelope };
}

test('a proven send route is persisted as mapping evidence with its exact source and time', async () => {
  const directory = temporary();
  const seed = new Store(directory);
  seed.observeChat({ id: pn });
  // Before the route, nothing links the PN and the LID, and LID digits are no phone.
  assert.equal(seed.contactView(lid).mapping.status, 'unknown');
  assert.equal(seed.contactView(lid).phone, null);
  seed.close();
  const f = sendFixture(directory, { list: [{ id: pn, lid }], sideList: [] });
  try {
    const before = Date.now();
    const result = (await f.runtime.execute({
      command: 'send',
      key: 'route-1',
      jid: pn,
      text: 'Fictional route test',
    })) as RequestRecord;
    assert.equal(result.route?.status, 'proven');
    assert.equal(f.sends[0], lid);
    const contact = (await f.runtime.execute({
      command: 'contact',
      jid: lid,
    })) as ReturnType<Store['contactView']>;
    assert.equal(contact.mapping.status, 'known');
    assert.equal(contact.mapping.pn, pn);
    assert.equal(contact.phone, '+12025550101');
    assert.deepEqual(
      contact.mapping.evidence.map(({ pn, lid, source }) => ({
        pn,
        lid,
        source,
      })),
      [{ pn, lid, source: 'baileys.executeUSyncQuery/lid' }],
    );
    // The evidence time is the route's observation time.
    assert.equal(
      contact.mapping.evidence[0]?.observedAt,
      result.route?.observedAt,
    );
    assert.ok(Number(result.route?.observedAt) >= before);
    const events = JSON.stringify(
      await f.runtime.execute({ command: 'events', after: 0 }),
    );
    assert.match(events, /route-mapping/);

    // Empty-history trap: the PN history is empty, the send lives under the
    // LID, and the hint says so without merging anything.
    const messages = await withEnvelope(f.runtime, {
      command: 'messages',
      jid: pn,
      limit: 20,
      offset: 0,
    });
    assert.deepEqual(messages.data, []);
    const peer = messages.envelope.linkedPeer as LinkedPeer;
    assert.equal(peer.mapping, 'known');
    assert.equal(peer.jid, lid);
    assert.equal(peer.mapping === 'known' && peer.hasMessages, true);
    // The SDK return does not create an observed LID conversation.
    assert.equal(peer.mapping === 'known' && peer.observedChat, false);
    assert.equal(peer.mapping === 'known' && peer.unread, null);
    const lidHistory = (await f.runtime.execute({
      command: 'messages',
      jid: lid,
      limit: 20,
      offset: 0,
    })) as { jid: string; id: string }[];
    assert.deepEqual(
      lidHistory.map((row) => [row.jid, row.id]),
      [[lid, result.messageId]],
    );

    // Lookup by phone now reaches the LID through the known mapping.
    const lookup = (await f.runtime.execute({
      command: 'contacts',
      query: '+1 202 555 0101',
      limit: 20,
      offset: 0,
    })) as { jid: string; contact: { phone: string; mapping: string } }[];
    assert.deepEqual(lookup.map((row) => row.jid).sort(), [lid, pn].sort());
    for (const row of lookup) {
      assert.equal(row.contact.mapping, 'known');
      assert.equal(row.contact.phone, '+12025550101');
    }
  } finally {
    await f.runtime.close();
  }
});

test('unproven routes record nothing; a conflicting server answer is retained as conflict evidence', async () => {
  for (const usync of [{ list: [] }, { list: [{ id: otherPn, lid }] }]) {
    const directory = temporary();
    const seed = new Store(directory);
    seed.observeChat({ id: pn });
    seed.close();
    const f = sendFixture(directory, usync);
    try {
      const result = (await f.runtime.execute({
        command: 'send',
        key: 'route-1',
        jid: pn,
        text: 'Fictional route test',
      })) as RequestRecord;
      assert.equal(result.route?.status, 'unproven');
      const contact = (await f.runtime.execute({
        command: 'contact',
        jid: pn,
      })) as ReturnType<Store['contactView']>;
      assert.equal(contact.mapping.status, 'unknown');
      assert.deepEqual(contact.mapping.evidence, []);
      const { envelope } = await withEnvelope(f.runtime, {
        command: 'chat',
        jid: pn,
      });
      assert.deepEqual(envelope.linkedPeer, { mapping: 'unknown', jid: null });
    } finally {
      await f.runtime.close();
    }
  }

  const directory = temporary();
  const seed = new Store(directory);
  seed.observeChat({ id: pn });
  seed.observeMapping(pn, otherLid, 'lid-mapping.update', 100);
  seed.close();
  const f = sendFixture(directory, { list: [{ id: pn, lid }] });
  try {
    const result = (await f.runtime.execute({
      command: 'send',
      key: 'route-1',
      jid: pn,
      text: 'Fictional route test',
    })) as RequestRecord;
    // The exact original destination is still used.
    assert.equal(result.route?.status, 'unproven');
    assert.equal(f.sends[0], pn);
    const contact = (await f.runtime.execute({
      command: 'contact',
      jid: pn,
    })) as ReturnType<Store['contactView']>;
    assert.equal(contact.mapping.status, 'conflict');
    assert.deepEqual(
      contact.mapping.evidence.map(({ lid, source }) => [lid, source]),
      [
        [lid, 'baileys.executeUSyncQuery/lid'],
        [otherLid, 'lid-mapping.update'],
      ],
    );
    const { envelope } = await withEnvelope(f.runtime, {
      command: 'messages',
      jid: pn,
      limit: 20,
      offset: 0,
    });
    assert.deepEqual(envelope.linkedPeer, { mapping: 'conflict', jid: null });
  } finally {
    await f.runtime.close();
  }
});

test('linkedPeer exposes only the known peer’s own local values and never merges histories', () => {
  const store = new Store(temporary());
  try {
    store.observeChat({
      id: lid,
      unreadCount: 1,
      archived: false,
      conversationTimestamp: 500,
    });
    store.observeMessage(message(lid, 'in-lid', 500));
    store.observeMessage(message(pn, 'in-pn', 100));
    // Unknown: status only.
    assert.deepEqual(store.linkedPeer(pn), { mapping: 'unknown', jid: null });
    assert.deepEqual(store.linkedPeer(lid), { mapping: 'unknown', jid: null });
    assert.equal(store.linkedPeer(group), undefined);

    store.observeMapping(pn, lid, 'lid-mapping.update', 100);
    assert.deepEqual(store.linkedPeer(pn), {
      mapping: 'known',
      jid: lid,
      observedChat: true,
      hasMessages: true,
      activity: { timestamp: 500, source: 'chat.conversationTimestamp' },
      unread: true,
      archived: false,
      latestIncoming: { id: 'in-lid', timestamp: 500, available: true },
    });
    // The other direction: the PN's own chat, with no observed read state.
    assert.deepEqual(store.linkedPeer(lid), {
      mapping: 'known',
      jid: pn,
      observedChat: true,
      hasMessages: true,
      activity: { timestamp: 100, source: 'message.messageTimestamp' },
      unread: null,
      archived: null,
      latestIncoming: { id: 'in-pn', timestamp: 100, available: true },
    });
    // Histories and guards stay under their own exact JIDs.
    assert.deepEqual(
      store.messages(pn).map((row) => row.key.id),
      ['in-pn'],
    );
    assert.deepEqual(store.latestIncoming(pn)?.id, 'in-pn');
    assert.equal(store.chatView(pn)?.activity.timestamp, 100);
    assert.equal(store.chatView(lid)?.activity.timestamp, 500);

    // A contradictory edge removes every peer value.
    store.observeMapping(otherPn, lid, 'message-key', 200);
    assert.deepEqual(store.linkedPeer(pn), { mapping: 'conflict', jid: null });
    assert.deepEqual(store.linkedPeer(lid), { mapping: 'conflict', jid: null });
  } finally {
    store.close();
  }
});

/** A PN chat with an old pending intent per field, as a ghost in triage queues. */
async function ghost(store: Store) {
  store.observeChat({
    id: pn,
    unreadCount: 0,
    archived: false,
    conversationTimestamp: 100,
  });
  await perform(
    store,
    'pn-unread',
    { kind: 'mark-read', jid: pn, value: false },
    () => {},
    async () => {},
  );
  await perform(
    store,
    'pn-unarchive',
    { kind: 'archive', jid: pn, value: false },
    () => {},
    async () => {},
  );
  store.observeChat({ id: lid, conversationTimestamp: 200 });
}

const queue = (store: Store, observedOnly = false) =>
  store
    .chats(100, 0, { unread: true, archived: 'not-true', observedOnly })
    .map((row) => row.jid);

test('an independent LID observation supersedes the known PN peer’s pending intent without inventing PN state', async () => {
  const store = new Store(temporary());
  try {
    await ghost(store);
    store.observeMapping(pn, lid, 'lid-mapping.update', 100);
    const requests = [
      store.request('pn-unread'),
      store.request('pn-unarchive'),
    ];
    assert.deepEqual(queue(store), [pn]);

    // Metadata alone is not a read/archive observation.
    store.observeChat({ id: lid, name: 'Fictional name' });
    assert.equal(store.chatView(pn)?.pending.unread?.superseded, undefined);
    assert.deepEqual(queue(store), [pn]);

    // The LID's own read state, observed independently.
    store.observeChat({ id: lid, unreadCount: 0 });
    const chat = store.chatView(pn)!;
    assert.deepEqual(chat.pending.unread, {
      key: 'pn-unread',
      value: true,
      superseded: {
        jid: lid,
        source: 'linked-peer-observation',
        mapping: 'known',
        observedAt: chat.pending.unread?.superseded?.observedAt,
      },
    });
    assert.ok(
      Number.isSafeInteger(chat.pending.unread?.superseded?.observedAt),
    );
    // Archive was not observed on the LID, so that intent stays pending.
    assert.deepEqual(chat.pending.archived, {
      key: 'pn-unarchive',
      value: false,
    });
    // The PN's own state stays unknown; nothing was copied from the LID.
    assert.equal(chat.unread, null);
    assert.equal(chat.unreadCount, null);
    assert.deepEqual(queue(store), []);
    assert.ok(
      store.chats(100, 0, { unread: 'unknown' }).some((row) => row.jid === pn),
    );
    assert.equal(
      store.chats(100, 0, { archived: false }).find((row) => row.jid === pn)
        ?.matchedBy?.archived,
      'pending-intent',
    );
    // Requests keep their exact evidence; no server response was faked.
    assert.deepEqual(
      [store.request('pn-unread'), store.request('pn-unarchive')],
      requests,
    );
    assert.equal(store.request('pn-unread')?.appStateResponse, undefined);
    assert.match(JSON.stringify(store.events(0)), /chat-pending-superseded/);

    store.observeChat({ id: lid, archived: false });
    assert.equal(store.chatView(pn)?.pending.archived?.superseded?.jid, lid);
    assert.equal(
      store.chats(100, 0, { archived: false }).some((row) => row.jid === pn),
      false,
    );

    // A later contradictory edge returns both intents to ordinary pending.
    store.observeMapping(pn, otherLid, 'message-key', 300);
    assert.deepEqual(store.chatView(pn)?.pending, {
      unread: { key: 'pn-unread', value: true },
      archived: { key: 'pn-unarchive', value: false },
    });
    assert.deepEqual(queue(store), [pn]);
  } finally {
    store.close();
  }
});

test('unknown and conflicting mappings never supersede; new PN intents and PN observations behave as before', async () => {
  for (const mapping of ['unknown', 'conflict'] as const) {
    const store = new Store(temporary());
    try {
      await ghost(store);
      if (mapping === 'conflict') {
        store.observeMapping(pn, lid, 'lid-mapping.update', 100);
        store.observeMapping(otherPn, lid, 'message-key', 200);
      }
      store.observeChat({ id: lid, unreadCount: 0, archived: false });
      assert.deepEqual(store.chatView(pn)?.pending, {
        unread: { key: 'pn-unread', value: true },
        archived: { key: 'pn-unarchive', value: false },
      });
      assert.deepEqual(queue(store), [pn]);
    } finally {
      store.close();
    }
  }

  const store = new Store(temporary());
  try {
    await ghost(store);
    store.observeMapping(pn, lid, 'lid-mapping.update', 100);
    // The LID's own intent is still resolved by its own observation.
    store.observeMessage(message(lid, 'in-lid', 200));
    await perform(
      store,
      'lid-read',
      { kind: 'mark-read', jid: lid, value: true },
      () => {},
      async () => {},
    );
    store.observeChat({ id: lid, unreadCount: 0 });
    assert.equal(store.chatView(pn)?.pending.unread?.superseded?.jid, lid);
    // The LID's own pending read was resolved by its own observation.
    assert.deepEqual(store.chatView(lid)?.pending, {});

    // A new PN intent replaces the superseded one and is pending again.
    await perform(
      store,
      'pn-unread-2',
      { kind: 'mark-read', jid: pn, value: false },
      () => {},
      async () => {},
    );
    assert.deepEqual(store.chatView(pn)?.pending.unread, {
      key: 'pn-unread-2',
      value: true,
    });
    assert.deepEqual(queue(store), [pn]);

    // An observation captured before that intent cannot supersede it.
    store.observeChat(
      { id: lid, unreadCount: 0 },
      'update',
      undefined,
      undefined,
      {
        jid: pn,
        unread: 'pn-unread',
        archived: 'pn-unarchive',
      },
    );
    assert.equal(store.chatView(pn)?.pending.unread?.superseded, undefined);
    // Nor can one captured while no PN peer was known.
    store.observeChat(
      { id: lid, unreadCount: 0 },
      'update',
      undefined,
      undefined,
      null,
    );
    assert.equal(store.chatView(pn)?.pending.unread?.superseded, undefined);

    // The PN's own observation resolves it, as before.
    store.observeChat({ id: pn, unreadCount: 0 });
    assert.equal(store.chatView(pn)?.pending.unread, undefined);
    assert.equal(store.chatView(pn)?.unread, false);
  } finally {
    store.close();
  }
});

test('runtime chat updates for a LID supersede the PN peer intent captured with them', async () => {
  const directory = temporary();
  const seed = new Store(directory);
  await ghost(seed);
  seed.observeMapping(pn, lid, 'lid-mapping.update', 100);
  seed.close();
  const f = sendFixture(directory, { list: [] });
  try {
    f.events.emit('chats.update', [{ id: lid, unreadCount: 0 }]);
    const chat = (await f.runtime.execute({ command: 'chat', jid: pn })) as {
      pending: Record<string, { superseded?: { jid: string } }>;
      unread: unknown;
    };
    assert.equal(chat.pending.unread?.superseded?.jid, lid);
    assert.equal(chat.unread, null);
    const rows = (await f.runtime.execute({
      command: 'chats',
      unread: true,
      archived: 'not-true',
      limit: 100,
      offset: 0,
    })) as { jid: string }[];
    assert.deepEqual(rows, []);
    const request = (await f.runtime.execute({
      command: 'request',
      key: 'pn-unread',
    })) as RequestRecord;
    assert.equal(request.attempt, 'sdk-returned');
    assert.equal(request.appStateResponse, undefined);
  } finally {
    await f.runtime.close();
  }
});

test('compact output keeps linkedPeer and the superseded marker unchanged', () => {
  const linkedPeer = {
    mapping: 'known',
    jid: lid,
    observedChat: true,
    hasMessages: true,
    activity: { timestamp: 500, source: 'chat.conversationTimestamp' },
    unread: null,
    archived: null,
    latestIncoming: null,
  };
  for (const action of ['messages', 'incoming', 'chat']) {
    const compact = formatResponse(
      action,
      {
        ok: true,
        data: action === 'messages' ? [] : null,
        linkedPeer,
        source: 'local',
      },
      'compact',
    );
    assert.deepEqual(compact.linkedPeer, linkedPeer);
  }
  const superseded = {
    jid: lid,
    source: 'linked-peer-observation',
    mapping: 'known',
    observedAt: 1700000000000,
  };
  const compact = formatResponse(
    'chat',
    {
      ok: true,
      data: {
        jid: pn,
        name: null,
        unread: null,
        pending: { unread: { key: 'k', value: true, superseded } },
        observedAt: 1,
      },
    },
    'compact',
  );
  assert.deepEqual((compact.data as { pending: unknown }).pending, {
    unread: { key: 'k', value: true, superseded },
  });
});

async function cli(directory: string, ...args: string[]) {
  try {
    const { stdout } = await runFile(
      process.execPath,
      ['dist/src/cli.js', '--data-dir', directory, ...args],
      { timeout: 15000 },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error)
      return JSON.parse(String(error.stdout)) as Record<string, unknown>;
    throw error;
  }
}

test('offline daemon: linkedPeer on chat, messages and incoming; the guard stays exact', async (t) => {
  const directory = temporary();
  const store = new Store(directory);
  store.observeChat({ id: pn, unreadCount: 0, conversationTimestamp: 100 });
  store.observeMessage(message(pn, 'in-pn', 100));
  store.observeChat({ id: lid, unreadCount: 1, conversationTimestamp: 300 });
  store.observeMessage(message(lid, 'in-lid', 300));
  store.observeMapping(pn, lid, 'baileys.executeUSyncQuery/lid', 250);
  store.observeChat({ id: group, unreadCount: 1 });
  store.close();
  t.after(async () => {
    await cli(directory, 'stop');
  });
  assert.equal((await cli(directory, 'start', '--offline')).ok, true);
  const expected = {
    mapping: 'known',
    jid: lid,
    observedChat: true,
    hasMessages: true,
    activity: { timestamp: 300, source: 'chat.conversationTimestamp' },
    unread: true,
    archived: null,
    latestIncoming: { id: 'in-lid', timestamp: 300, available: true },
  };
  for (const mode of ['full', 'compact'])
    for (const args of [
      ['chat', '--jid', pn],
      ['messages', '--jid', pn],
      ['incoming', '--jid', pn],
    ]) {
      const response = await cli(directory, '--output', mode, ...args);
      assert.equal(response.ok, true, args.join(' '));
      assert.deepEqual(response.linkedPeer, expected, args.join(' '));
    }
  const messages = await cli(directory, 'messages', '--jid', pn);
  assert.deepEqual(
    (messages.data as { id: string }[]).map((row) => row.id),
    ['in-pn'],
  );
  const groupChat = await cli(directory, 'chat', '--jid', group);
  assert.equal(groupChat.ok, true);
  assert.equal('linkedPeer' in groupChat, false);
  const chats = await cli(directory, 'chats');
  assert.equal('linkedPeer' in chats, false);
  // The guard compares only the exact PN chat: the newer LID reply does not
  // block it, and linkedPeer.latestIncoming is how a caller sees that reply.
  const incoming = await cli(
    directory,
    'incoming',
    '--jid',
    pn,
    '--after',
    'in-pn',
  );
  assert.deepEqual((incoming.data as { messages: unknown[] }).messages, []);
  const lidIncoming = await cli(
    directory,
    'incoming',
    '--jid',
    lid,
    '--after',
    'none',
  );
  assert.deepEqual(
    (lidIncoming.data as { messages: { id: string }[] }).messages.map(
      (row) => row.id,
    ),
    ['in-lid'],
  );
  assert.deepEqual(lidIncoming.linkedPeer, {
    mapping: 'known',
    jid: pn,
    observedChat: true,
    hasMessages: true,
    activity: { timestamp: 100, source: 'chat.conversationTimestamp' },
    unread: false,
    archived: null,
    latestIncoming: { id: 'in-pn', timestamp: 100, available: true },
  });
  const help = (await cli(directory, 'help')).data as {
    commands: Record<string, string>;
    linkedPeerField?: string;
  };
  assert.match(help.linkedPeerField ?? '', /never merged/);
});
