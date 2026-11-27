import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { makeEventBuffer, proto } from 'baileys';
import type { WAMessage, WASocket } from 'baileys';
import { pino } from 'pino';
import { CommandError, errorResponse } from '../src/errors.js';
import { object, parseCommand, wireCommand } from '../src/protocol.js';
import type { Command } from '../src/protocol.js';
import { formatResponse } from '../src/response.js';
import { createRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';

process.umask(0o077);
const jid = '12025550101@s.whatsapp.net';
const logger = pino({ level: 'silent' });
const runFile = promisify(execFile);

const incoming = (id: string, at: number, text = 'Fictional reply') =>
  ({
    key: { remoteJid: jid, id, fromMe: false },
    messageTimestamp: at,
    message: { conversation: text },
  }) satisfies WAMessage;

/** Everything here is newer than in-1, yet none of it is a person's reply. */
const nonReplies: WAMessage[] = [
  {
    key: { remoteJid: jid, id: 'own-1', fromMe: true },
    messageTimestamp: 1700000010,
    message: { conversation: 'Fictional own answer' },
  },
  {
    // The text-less server stub observed shortly after the account's own sends.
    key: { remoteJid: jid, id: 'stub-1', fromMe: false },
    messageTimestamp: 1700000011,
    message: { protocolMessage: {} },
  },
  {
    key: { remoteJid: jid, id: 'ephemeral-1', fromMe: false },
    messageTimestamp: 1700000012,
    message: {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
        ephemeralExpiration: 0,
      },
    },
  },
  {
    key: { remoteJid: jid, id: 'edit-1', fromMe: false },
    messageTimestamp: 1700000013,
    message: {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        key: { remoteJid: jid, id: 'in-1', fromMe: false },
        editedMessage: { conversation: 'Fictional corrected reply' },
      },
    },
  },
  {
    key: { remoteJid: jid, id: 'reaction-1', fromMe: false },
    messageTimestamp: 1700000014,
    message: {
      reactionMessage: {
        key: { remoteJid: jid, id: 'own-1', fromMe: true },
        text: '👍',
      },
    },
  },
  {
    key: { remoteJid: jid, id: 'system-1', fromMe: false },
    messageTimestamp: 1700000015,
    messageStubType: proto.WebMessageInfo.StubType.E2E_ENCRYPTED,
  },
];

function fixture(seed: WAMessage[], duringModify?: () => void) {
  const directory = mkdtempSync(join(tmpdir(), 'incoming-guard-'));
  const store = new Store(directory);
  store.observeChat({ id: jid, unreadCount: 1, archived: false });
  for (const message of seed) store.observeMessage(message);
  store.close();
  const ev = makeEventBuffer(logger);
  const patches: unknown[] = [];
  const runtime = createRuntime({ dataDir: directory, connect: true }, () => {
    return {
      ev,
      ws: { isClosed: true },
      chatModify: async (
        ...[mod]: Parameters<WASocket['chatModify']>
      ): Promise<void> => {
        // The SDK can await a network resync before sending the patch.
        duringModify?.();
        patches.push(mod);
      },
      end: () => ev.emit('connection.update', { connection: 'close' }),
    } as unknown as WASocket;
  });
  runtime.start();
  ev.emit('connection.update', { connection: 'open' });
  return {
    directory,
    runtime,
    ev,
    patches,
    receive: (message: WAMessage) =>
      ev.emit('messages.upsert', { messages: [message], type: 'notify' }),
    close: async () => {
      await runtime.close();
      ev.destroy();
    },
  };
}

const guarded = (
  command: 'archive' | 'mark-read',
  key: string,
  ifLatestIncoming?: string | null,
): Command => ({
  command,
  jid,
  key,
  value: true,
  ...(ifLatestIncoming === undefined ? {} : { ifLatestIncoming }),
});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CommandError);
    return errorResponse(error);
  }
  assert.fail('Expected the mutation to be refused');
}

async function assertUnchanged(
  f: ReturnType<typeof fixture>,
  key: string,
): Promise<void> {
  assert.equal(f.patches.length, 0);
  assert.equal(await f.runtime.execute({ command: 'request', key }), null);
  const chat = object(await f.runtime.execute({ command: 'chat', jid }));
  assert.deepEqual(chat.pending, {});
  const events = JSON.stringify(
    await f.runtime.execute({ command: 'events', after: 0 }),
  );
  assert.doesNotMatch(events, /operation-attempt/);
}

for (const command of ['mark-read', 'archive'] as const) {
  test(`${command} proceeds when the named message is still the latest incoming one`, async () => {
    const f = fixture([
      incoming('in-0', 1699999990),
      incoming('in-1', 1700000000),
    ]);
    try {
      const chat = object(await f.runtime.execute({ command: 'chat', jid }));
      assert.deepEqual(chat.latestIncoming, {
        id: 'in-1',
        timestamp: 1700000000,
        available: true,
      });
      const result = object(
        await f.runtime.execute(guarded(command, 'ok', 'in-1')),
      );
      const request = object(result.request);
      assert.equal(request.attempt, 'sdk-returned');
      assert.deepEqual(request.operation, {
        kind: command,
        jid,
        value: true,
        ifLatestIncoming: 'in-1',
      });
      assert.equal(object(result.feedback).latestIncomingChanged, false);
      assert.equal(f.patches.length, 1);
    } finally {
      await f.close();
    }
  });

  test(`${command} is refused with safe details when a newer incoming message is stored`, async () => {
    const f = fixture([incoming('in-1', 1700000000)]);
    try {
      f.receive(incoming('in-2', 1700000020, 'FICTIONAL_PRIVATE_BODY'));
      const response = await failure(
        f.runtime.execute(guarded(command, 'stale', 'in-1')),
      );
      assert.equal(response.code, 'PRECONDITION_FAILED');
      assert.deepEqual(response.details, {
        precondition: 'if-latest-incoming',
        reason: 'newer-incoming',
        expected: 'in-1',
        expectedStored: true,
        latestIncoming: { id: 'in-2', timestamp: 1700000020, available: true },
        newerIncoming: [{ id: 'in-2', timestamp: 1700000020, available: true }],
        truncated: false,
        unavailableIncoming: [],
        unavailableTruncated: false,
        coverage: 'local',
      });
      assert.doesNotMatch(JSON.stringify(response), /FICTIONAL_PRIVATE_BODY/);
      await assertUnchanged(f, 'stale');
      // The refused key was never persisted, so it is free for a fresh decision.
      await f.runtime.execute(guarded(command, 'stale', 'in-2'));
      assert.equal(f.patches.length, 1);
    } finally {
      await f.close();
    }
  });
}

test('own messages, protocol stubs, edits, reactions and system stubs do not count as incoming', async () => {
  const f = fixture([incoming('in-1', 1700000000), ...nonReplies]);
  try {
    const chat = object(await f.runtime.execute({ command: 'chat', jid }));
    assert.deepEqual(chat.latestIncoming, {
      id: 'in-1',
      timestamp: 1700000000,
      available: true,
    });
    await f.runtime.execute(guarded('mark-read', 'after-own-send', 'in-1'));
    assert.equal(f.patches.length, 1);
  } finally {
    await f.close();
  }
});

test('undecryptable incoming content counts, so the guard fails closed', async () => {
  const f = fixture([incoming('in-1', 1700000000)]);
  try {
    f.receive({
      key: { remoteJid: jid, id: 'cipher-1', fromMe: false },
      messageTimestamp: 1700000030,
      messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
    });
    const response = await failure(
      f.runtime.execute(guarded('mark-read', 'cipher', 'in-1')),
    );
    assert.deepEqual(object(response.details).latestIncoming, {
      id: 'cipher-1',
      timestamp: 1700000030,
      available: false,
    });
    await assertUnchanged(f, 'cipher');
  } finally {
    await f.close();
  }
});

test('none passes only while no incoming user message is stored for that exact chat', async () => {
  const f = fixture(nonReplies);
  try {
    const chat = object(await f.runtime.execute({ command: 'chat', jid }));
    assert.equal(chat.latestIncoming, null);
    await f.runtime.execute(guarded('archive', 'none-ok', null));
    assert.equal(f.patches.length, 1);
    f.receive(incoming('in-3', 1700000040));
    const response = await failure(
      f.runtime.execute(guarded('mark-read', 'none-stale', null)),
    );
    assert.equal(response.code, 'PRECONDITION_FAILED');
    assert.deepEqual(object(response.details).latestIncoming, {
      id: 'in-3',
      timestamp: 1700000040,
      available: true,
    });
    assert.equal(f.patches.length, 1);
    assert.equal(
      await f.runtime.execute({ command: 'request', key: 'none-stale' }),
      null,
    );
  } finally {
    await f.close();
  }
});

test('a persisted key replays without re-evaluating, and the guard is part of its intent', async () => {
  const f = fixture([incoming('in-1', 1700000000)]);
  try {
    const intent = guarded('mark-read', 'replayed', 'in-1');
    const first = object(await f.runtime.execute(intent));
    f.receive(incoming('in-2', 1700000020));
    // The mutation was already invoked; a retry returns it instead of failing now.
    assert.deepEqual(
      object(await f.runtime.execute(intent)).request,
      first.request,
    );
    for (const changed of [
      guarded('mark-read', 'replayed', 'in-2'),
      guarded('mark-read', 'replayed', null),
      guarded('mark-read', 'replayed'),
    ]) {
      const response = await failure(f.runtime.execute(changed));
      assert.equal(response.code, 'KEY_CONFLICT');
    }
    // An unguarded key stays unguarded on replay.
    const plain = guarded('archive', 'plain');
    const recorded = object(await f.runtime.execute(plain)).request;
    assert.deepEqual(object(await f.runtime.execute(plain)).request, recorded);
    assert.equal(
      (await failure(f.runtime.execute(guarded('archive', 'plain', 'in-2'))))
        .code,
      'KEY_CONFLICT',
    );
    assert.equal(f.patches.length, 2);
  } finally {
    await f.close();
  }
  const offline = createRuntime({ dataDir: f.directory, connect: false });
  try {
    const replay = object(
      await offline.execute(guarded('mark-read', 'replayed', 'in-1')),
    );
    assert.equal(object(replay.request).key, 'replayed');
  } finally {
    await offline.close();
  }
});

test('equal-second replies keep their arrival order across rewrites and re-deliveries', async () => {
  const f = fixture([incoming('in-b', 1700000100)]);
  try {
    // Seen B; C arrives in the same second; then B's row is rewritten twice.
    f.receive(incoming('in-c', 1700000100, 'Fictional unseen reply'));
    f.ev.emit('messages.update', [
      {
        key: { remoteJid: jid, id: 'in-b', fromMe: false },
        update: { status: proto.WebMessageInfo.Status.READ },
      },
    ]);
    f.receive(incoming('in-b', 1700000100));
    const chat = object(await f.runtime.execute({ command: 'chat', jid }));
    assert.deepEqual(chat.latestIncoming, {
      id: 'in-c',
      timestamp: 1700000100,
      available: true,
    });
    const response = await failure(
      f.runtime.execute(guarded('mark-read', 'tie', 'in-b')),
    );
    assert.deepEqual(object(response.details).latestIncoming, {
      id: 'in-c',
      timestamp: 1700000100,
      available: true,
    });
    await assertUnchanged(f, 'tie');
    await f.runtime.execute(guarded('mark-read', 'tie', 'in-c'));
    assert.equal(f.patches.length, 1);
  } finally {
    await f.close();
  }
});

for (const [name, late] of [
  ['an earlier sender timestamp', incoming('in-late', 1700000099)],
  [
    'no sender timestamp',
    {
      key: { remoteJid: jid, id: 'in-late', fromMe: false },
      message: { conversation: 'Fictional undated reply' },
    } satisfies WAMessage,
  ],
  [
    'a missed call',
    {
      key: { remoteJid: jid, id: 'in-late', fromMe: false },
      messageTimestamp: 1700000200,
      messageStubType: proto.WebMessageInfo.StubType.CALL_MISSED_VOICE,
    } satisfies WAMessage,
  ],
  [
    'a call log',
    {
      key: { remoteJid: jid, id: 'in-late', fromMe: false },
      messageTimestamp: 1700000200,
      message: { callLogMesssage: { isVideo: false } },
    } satisfies WAMessage,
  ],
  [
    'an unrecognized content type',
    {
      key: { remoteJid: jid, id: 'in-late', fromMe: false },
      messageTimestamp: 1700000200,
      message: { messageContextInfo: {} },
    } satisfies WAMessage,
  ],
  [
    'an empty view-once wrapper',
    {
      key: { remoteJid: jid, id: 'in-late', fromMe: false },
      messageTimestamp: 1700000200,
      message: { viewOnceMessage: { message: {} } },
    } satisfies WAMessage,
  ],
  [
    'stub type UNKNOWN (0)',
    {
      key: { remoteJid: jid, id: 'in-late', fromMe: false },
      messageTimestamp: 1700000200,
      messageStubType: proto.WebMessageInfo.StubType.UNKNOWN,
      message: { conversation: 'Fictional reply' },
    } satisfies WAMessage,
  ],
] as const)
  test(`a later arrival with ${name} blocks the guard`, async () => {
    const f = fixture([incoming('in-b', 1700000100)]);
    try {
      f.receive(late);
      const response = await failure(
        f.runtime.execute(guarded('archive', 'late', 'in-b')),
      );
      assert.equal(response.code, 'PRECONDITION_FAILED');
      assert.equal(
        object(object(response.details).latestIncoming).id,
        'in-late',
      );
      await assertUnchanged(f, 'late');
    } finally {
      await f.close();
    }
  });

test('existing rows without arrivals are backfilled by timestamp, after recorded ones', () => {
  const directory = mkdtempSync(join(tmpdir(), 'incoming-guard-legacy-'));
  let store = new Store(directory);
  store.observeChat({ id: jid });
  store.observeMessage(incoming('old-2', 1700000002));
  store.observeMessage(incoming('old-1', 1700000001));
  store.observeMessage({
    key: { remoteJid: jid, id: 'old-undated', fromMe: false },
    message: { conversation: 'Fictional undated' },
  });
  // As if written by a build that did not record arrivals.
  store.db.exec('DELETE FROM message_arrivals');
  store.close();
  store = new Store(directory);
  try {
    // Undated rows are placed after dated ones, never as the oldest.
    assert.deepEqual(store.latestIncoming(jid), {
      id: 'old-undated',
      timestamp: null,
      available: true,
    });
    store.observeMessage(incoming('new-0', 1700000000));
    assert.equal(store.latestIncoming(jid)?.id, 'new-0');
  } finally {
    store.close();
  }
  store = new Store(directory);
  try {
    // Reopening does not reorder recorded arrivals.
    assert.equal(store.latestIncoming(jid)?.id, 'new-0');
  } finally {
    store.close();
  }
});

test('in groups only call offers and content-free envelopes are skipped', () => {
  const group = '120363000000000001@g.us';
  const member = '12025550199@s.whatsapp.net';
  const store = new Store(mkdtempSync(join(tmpdir(), 'incoming-guard-group-')));
  const from = (
    id: string,
    message: NonNullable<WAMessage['message']>,
  ): WAMessage => ({
    key: { remoteJid: group, id, fromMe: false, participant: member },
    messageTimestamp: 1700000300,
    message,
  });
  try {
    store.observeChat({ id: group });
    store.observeMessage(from('g-1', { conversation: 'Fictional member' }));
    store.observeMessage(
      from('g-offer', { call: { callKey: Buffer.from('x') } }),
    );
    store.observeMessage(from('g-empty', {}));
    store.observeMessage(from('g-context', { messageContextInfo: {} }));
    assert.equal(store.latestIncoming(group)?.id, 'g-1');
    store.observeMessage(from('g-log', { callLogMesssage: { isVideo: true } }));
    assert.equal(store.latestIncoming(group)?.id, 'g-log');
  } finally {
    store.close();
  }
});

test('a refusal lists every reply stored after the named one, even behind later history', async () => {
  const f = fixture([incoming('in-a', 1700000100)]);
  try {
    f.receive(incoming('in-live', 1700000200, 'Fictional live reply'));
    // History sync stores an older message after the live reply.
    f.ev.emit('messages.upsert', {
      messages: [incoming('in-history', 1700000050)],
      type: 'append',
    });
    const response = await failure(
      f.runtime.execute(guarded('mark-read', 'history', 'in-a')),
    );
    const details = object(response.details);
    assert.deepEqual(details.latestIncoming, {
      id: 'in-history',
      timestamp: 1700000050,
      available: true,
    });
    assert.deepEqual(details.newerIncoming, [
      { id: 'in-live', timestamp: 1700000200, available: true },
      { id: 'in-history', timestamp: 1700000050, available: true },
    ]);
    assert.equal(details.expectedStored, true);
    assert.equal(details.truncated, false);
    await assertUnchanged(f, 'history');
  } finally {
    await f.close();
  }
});

test('the refusal list is bounded and reports an expected ID that is not stored', async () => {
  const f = fixture(
    Array.from({ length: 22 }, (_, index) =>
      incoming(`in-${index}`, 1700000000 + index),
    ),
  );
  try {
    const response = await failure(
      f.runtime.execute(guarded('archive', 'bounded', 'never-stored')),
    );
    const details = object(response.details);
    // Without a stored anchor, listing starts from the first stored message.
    assert.equal((details.newerIncoming as unknown[]).length, 20);
    assert.deepEqual((details.newerIncoming as unknown[])[0], {
      id: 'in-0',
      timestamp: 1700000000,
      available: true,
    });
    assert.equal(details.truncated, true);
    assert.equal(details.expectedStored, false);
  } finally {
    await f.close();
  }
});

test('paging refusals from the named message reaches a live reply hidden behind history', async () => {
  const f = fixture([incoming('in-w', 1700000100)]);
  try {
    f.receive(incoming('in-r', 1700000200, 'Fictional live reply'));
    f.ev.emit('messages.upsert', {
      messages: Array.from({ length: 25 }, (_, index) =>
        incoming(`in-h${index}`, 1700000000 + index),
      ),
      type: 'append',
    });
    const seen: string[] = [];
    let expected = 'in-w';
    for (;;) {
      const details = object(
        (
          await failure(
            f.runtime.execute(guarded('mark-read', 'paged', expected)),
          )
        ).details,
      );
      assert.equal(details.expectedStored, true);
      assert.deepEqual(details.latestIncoming, {
        id: 'in-h24',
        timestamp: 1700000024,
        available: true,
      });
      const page = (details.newerIncoming as { id: string }[]).map(
        ({ id }) => id,
      );
      assert.ok(page.length > 0 && page.length <= 20);
      seen.push(...page);
      expected = page.at(-1)!;
      if (details.truncated === false) break;
    }
    // The live reply comes first, and every page continues where the last ended.
    assert.deepEqual(seen, [
      'in-r',
      ...Array.from({ length: 25 }, (_, index) => `in-h${index}`),
    ]);
    await assertUnchanged(f, 'paged');
    await f.runtime.execute(guarded('mark-read', 'paged', expected));
    assert.equal(f.patches.length, 1);
  } finally {
    await f.close();
  }
});

test('a key first stored as a protocol stub counts once it carries real content', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'incoming-guard-noise-')));
  try {
    store.observeChat({ id: jid });
    store.observeMessage(incoming('in-a', 1700000100));
    store.observeMessage({
      key: { remoteJid: jid, id: 'in-x', fromMe: false },
      messageTimestamp: 1700000200,
      message: { protocolMessage: {} },
    });
    assert.equal(store.latestIncoming(jid)?.id, 'in-a');
    store.observeMessage(incoming('in-x', 1700000200, 'Fictional real text'));
    assert.equal(store.latestIncoming(jid)?.id, 'in-x');
  } finally {
    store.close();
  }
});

test('a reply stored during the mutation stays visible when history follows it', async () => {
  let during = () => {};
  const f = fixture([incoming('in-a', 1700000100)], () => during());
  during = () => {
    f.receive(incoming('in-live', 1700000200, 'Fictional live reply'));
    f.ev.emit('messages.upsert', {
      messages: [incoming('in-history', 1700000050)],
      type: 'append',
    });
  };
  try {
    const result = object(
      await f.runtime.execute(guarded('mark-read', 'window', 'in-a')),
    );
    const feedback = object(result.feedback);
    assert.equal(feedback.latestIncomingChanged, true);
    assert.equal(
      object(object(result.localChat).latestIncoming).id,
      'in-history',
    );
    assert.deepEqual(feedback.newerIncoming, [
      { id: 'in-live', timestamp: 1700000200, available: true },
      { id: 'in-history', timestamp: 1700000050, available: true },
    ]);
    assert.equal(feedback.truncated, false);
    // Read-only follow-up: full projections, oldest first, without another mutation.
    const listing = object(
      await f.runtime.execute({
        command: 'incoming',
        jid,
        afterId: 'in-a',
        limit: 1,
      }),
    );
    assert.equal(listing.afterStored, true);
    assert.equal(listing.truncated, true);
    const [first] = listing.messages as Record<string, unknown>[];
    assert.equal(first?.id, 'in-live');
    assert.equal(first?.text, 'Fictional live reply');
    assert.equal(first?.available, true);
    const next = object(
      await f.runtime.execute({
        command: 'incoming',
        jid,
        afterId: 'in-live',
        limit: 1,
      }),
    );
    assert.deepEqual(
      (next.messages as Record<string, unknown>[]).map(({ id }) => id),
      ['in-history'],
    );
    assert.equal(next.truncated, false);
    const compact = object(
      formatResponse('incoming', { ok: true, data: next }, 'compact').data,
    );
    // Same compact row shape as messages and search: each row keeps its jid.
    assert.equal(object((compact.messages as unknown[])[0]).jid, jid);
    assert.equal(f.patches.length, 1);
  } finally {
    await f.close();
  }
});

test('a guard naming a message without readable content is refused while it is unavailable', async () => {
  const f = fixture([incoming('in-a', 1700000100)]);
  try {
    f.receive({
      key: { remoteJid: jid, id: 'cipher-1', fromMe: false },
      messageTimestamp: 1700000150,
      messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
    });
    const chat = object(await f.runtime.execute({ command: 'chat', jid }));
    const pending = { id: 'cipher-1', timestamp: 1700000150, available: false };
    assert.deepEqual(chat.latestIncoming, pending);
    const response = await failure(
      f.runtime.execute(guarded('mark-read', 'unavailable', 'cipher-1')),
    );
    assert.equal(response.code, 'PRECONDITION_FAILED');
    const details = object(response.details);
    assert.equal(details.reason, 'unavailable-incoming');
    assert.deepEqual(details.newerIncoming, []);
    assert.deepEqual(details.unavailableIncoming, [pending]);
    await assertUnchanged(f, 'unavailable');
    f.receive(incoming('cipher-1', 1700000150, 'Fictional decrypted reply'));
    assert.deepEqual(
      object(await f.runtime.execute({ command: 'chat', jid })).latestIncoming,
      { id: 'cipher-1', timestamp: 1700000150, available: true },
    );
    await f.runtime.execute(guarded('mark-read', 'unavailable', 'cipher-1'));
    assert.equal(f.patches.length, 1);
  } finally {
    await f.close();
  }
});

const cipher = (id: string, at: number): WAMessage => ({
  key: { remoteJid: jid, id, fromMe: false },
  messageTimestamp: at,
  messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
});

async function listIds(
  f: ReturnType<typeof fixture>,
  afterId: string | null,
  limit = 20,
) {
  const listing = object(
    await f.runtime.execute({ command: 'incoming', jid, afterId, limit }),
  );
  return {
    ids: (listing.messages as Record<string, unknown>[]).map(({ id }) => id),
    truncated: listing.truncated,
  };
}

test('listing after a message that later moved still covers what was stored in between', async () => {
  const f = fixture([incoming('in-0', 1700000100)]);
  try {
    f.receive(cipher('x', 1700000110));
    // Named while unavailable (against the docs): refused, nothing changes.
    assert.equal(
      object(
        (await failure(f.runtime.execute(guarded('mark-read', 'p11', 'x'))))
          .details,
      ).reason,
      'unavailable-incoming',
    );
    f.receive(incoming('b', 1700000120, 'Fictional reply B'));
    f.receive(incoming('x', 1700000110, 'Fictional decrypted X'));
    // X moved after B, but the listing anchors where X was first stored.
    assert.deepEqual(await listIds(f, 'x'), {
      ids: ['b', 'x'],
      truncated: false,
    });
    assert.deepEqual(await listIds(f, 'in-0'), {
      ids: ['b', 'x'],
      truncated: false,
    });
    const details = object(
      (await failure(f.runtime.execute(guarded('mark-read', 'p11', 'in-0'))))
        .details,
    );
    assert.deepEqual(
      (details.newerIncoming as { id: string }[]).map(({ id }) => id),
      ['b', 'x'],
    );
    await assertUnchanged(f, 'p11');
    await f.runtime.execute(guarded('mark-read', 'p11', 'x'));
    assert.equal(f.patches.length, 1);
  } finally {
    await f.close();
  }
});

test('paging through a message that moves mid-listing reaches every later reply', async () => {
  const f = fixture([incoming('in-0', 1700000100)]);
  try {
    f.receive(incoming('a', 1700000110));
    f.receive(cipher('p', 1700000120));
    f.receive(incoming('b', 1700000130));
    f.receive(incoming('c', 1700000140));
    const pages: unknown[] = [await listIds(f, 'in-0', 2)];
    assert.deepEqual(pages[0], { ids: ['a', 'p'], truncated: true });
    f.receive(incoming('p', 1700000120, 'Fictional decrypted P'));
    let after = 'p';
    for (;;) {
      const page = await listIds(f, after, 2);
      pages.push(page);
      if (!page.truncated) break;
      after = String(page.ids.at(-1));
    }
    assert.deepEqual(pages, [
      { ids: ['a', 'p'], truncated: true },
      { ids: ['b', 'c'], truncated: true },
      { ids: ['p'], truncated: false },
    ]);
    await f.runtime.execute(guarded('archive', 'p12', 'p'));
    assert.equal(f.patches.length, 1);
  } finally {
    await f.close();
  }
});

test('content delivered by message update replaces a placeholder and moves it', async () => {
  const f = fixture([cipher('u', 1700000110), incoming('in-1', 1700000120)]);
  try {
    f.ev.emit('messages.update', [
      {
        key: { remoteJid: jid, id: 'u', fromMe: false },
        update: { message: { conversation: 'Fictional updated content' } },
      },
    ]);
    assert.deepEqual(
      object(await f.runtime.execute({ command: 'chat', jid })).latestIncoming,
      { id: 'u', timestamp: 1700000110, available: true },
    );
    assert.deepEqual(await listIds(f, 'in-1'), {
      ids: ['u'],
      truncated: false,
    });
  } finally {
    await f.close();
  }
});

test('a direct message without content keys is unavailable until content arrives', async () => {
  const f = fixture([incoming('in-0', 1700000100)]);
  try {
    f.receive({
      key: { remoteJid: jid, id: 'empty', fromMe: false },
      messageTimestamp: 1700000110,
      message: { messageContextInfo: {} },
    });
    f.receive(incoming('in-2', 1700000120));
    assert.equal(
      object(
        (await failure(f.runtime.execute(guarded('mark-read', 'e', 'in-2'))))
          .details,
      ).reason,
      'unavailable-incoming',
    );
    f.receive(incoming('empty', 1700000110, 'Fictional late body'));
    assert.equal(
      object(
        object(await f.runtime.execute({ command: 'chat', jid }))
          .latestIncoming,
      ).id,
      'empty',
    );
    assert.equal(f.patches.length, 0);
  } finally {
    await f.close();
  }
});

test('an earlier undecryptable reply blocks the guard and surfaces as newest once it decrypts', async () => {
  const f = fixture([incoming('in-0', 1700000100)]);
  try {
    f.receive({
      key: { remoteJid: jid, id: 'c-1', fromMe: false },
      messageTimestamp: 1700000110,
      messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
    });
    f.receive(incoming('in-2', 1700000120));
    assert.deepEqual(
      object(await f.runtime.execute({ command: 'chat', jid })).latestIncoming,
      { id: 'in-2', timestamp: 1700000120, available: true },
    );
    // Naming the newest readable message is not enough while c-1 is pending.
    let details = object(
      (await failure(f.runtime.execute(guarded('mark-read', 'ad', 'in-2'))))
        .details,
    );
    assert.equal(details.reason, 'unavailable-incoming');
    assert.deepEqual(details.unavailableIncoming, [
      { id: 'c-1', timestamp: 1700000110, available: false },
    ]);
    await assertUnchanged(f, 'ad');
    // Its content arrives later under the same ID and moves after in-2.
    f.receive(incoming('c-1', 1700000110, 'Fictional late content'));
    details = object(
      (await failure(f.runtime.execute(guarded('mark-read', 'ad', 'in-2'))))
        .details,
    );
    assert.equal(details.reason, 'newer-incoming');
    assert.deepEqual(details.newerIncoming, [
      { id: 'c-1', timestamp: 1700000110, available: true },
    ]);
    const listing = object(
      await f.runtime.execute({
        command: 'incoming',
        jid,
        afterId: 'in-2',
        limit: 20,
      }),
    );
    assert.deepEqual(
      (listing.messages as Record<string, unknown>[]).map(({ id, text }) => [
        id,
        text,
      ]),
      [['c-1', 'Fictional late content']],
    );
    await f.runtime.execute(guarded('mark-read', 'ad', 'c-1'));
    assert.equal(f.patches.length, 1);
  } finally {
    await f.close();
  }
});

test('a reply decrypted while the SDK sends the patch is reported as changed', async () => {
  let during = () => {};
  const f = fixture(
    [
      incoming('in-0', 1700000100),
      {
        // Deleted while undecryptable: final, so it does not block the guard.
        key: { remoteJid: jid, id: 'c-del', fromMe: false },
        messageTimestamp: 1700000105,
        messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
      },
      incoming('in-2', 1700000120),
    ],
    () => during(),
  );
  try {
    f.ev.emit('messages.delete', {
      keys: [{ remoteJid: jid, id: 'c-del', fromMe: false }],
    });
    during = () =>
      f.receive(incoming('in-0', 1700000100, 'Fictional re-delivery'));
    let result = object(
      await f.runtime.execute(guarded('mark-read', 'quiet', 'in-2')),
    );
    // A re-delivery of already readable content keeps its position.
    assert.equal(object(result.feedback).latestIncomingChanged, false);
    during = () =>
      f.receive({
        key: { remoteJid: jid, id: 'c-late', fromMe: false },
        messageTimestamp: 1700000130,
        message: { conversation: 'Fictional decrypted during the call' },
      });
    result = object(
      await f.runtime.execute(guarded('archive', 'changed', 'in-2')),
    );
    assert.equal(object(result.feedback).latestIncomingChanged, true);
    assert.deepEqual(object(result.feedback).newerIncoming, [
      { id: 'c-late', timestamp: 1700000130, available: true },
    ]);
  } finally {
    await f.close();
  }
});

test('in groups a key that starts counting moves after messages stored meanwhile', () => {
  const group = '120363000000000001@g.us';
  const member = '12025550199@s.whatsapp.net';
  const store = new Store(mkdtempSync(join(tmpdir(), 'incoming-guard-gmove-')));
  const from = (
    id: string,
    message: NonNullable<WAMessage['message']>,
  ): WAMessage => ({
    key: { remoteJid: group, id, fromMe: false, participant: member },
    messageTimestamp: 1700000300,
    message,
  });
  try {
    store.observeChat({ id: group });
    store.observeMessage(from('g-late', {}));
    store.observeMessage(from('g-1', { conversation: 'Fictional member' }));
    assert.equal(store.latestIncoming(group)?.id, 'g-1');
    store.observeMessage(from('g-late', { conversation: 'Fictional content' }));
    assert.equal(store.latestIncoming(group)?.id, 'g-late');
    assert.deepEqual(
      store.newerIncoming(group, 'g-1').messages.map(({ id }) => id),
      ['g-late'],
    );
  } finally {
    store.close();
  }
});

test('a reply stored while the SDK sends the patch is reported, not hidden', async () => {
  let receive = (_message: WAMessage) => {};
  const f = fixture([incoming('in-a', 1700000100)], () =>
    receive(incoming('in-during', 1700000150)),
  );
  receive = f.receive;
  try {
    const intent = guarded('mark-read', 'during', 'in-a');
    const result = object(await f.runtime.execute(intent));
    assert.equal(object(result.request).attempt, 'sdk-returned');
    assert.equal(object(result.feedback).latestIncomingChanged, true);
    assert.deepEqual(object(result.localChat).latestIncoming, {
      id: 'in-during',
      timestamp: 1700000150,
      available: true,
    });
    assert.equal(f.patches.length, 1);
    const replay = object(await f.runtime.execute(intent));
    assert.deepEqual(replay.request, result.request);
    assert.equal(object(replay.feedback).latestIncomingChanged, true);
    assert.equal(f.patches.length, 1);
  } finally {
    await f.close();
  }
});

test('rows written by an older build after arrivals exist are placed after them and classified', () => {
  const directory = mkdtempSync(join(tmpdir(), 'incoming-guard-downgrade-'));
  let store = new Store(directory);
  store.observeChat({ id: jid });
  store.observeMessage(incoming('current', 1700000010));
  store.observeMessage(incoming('old-build', 1700000001));
  store.observeMessage({
    key: { remoteJid: jid, id: 'old-reaction', fromMe: false },
    messageTimestamp: 1700000020,
    message: {
      reactionMessage: {
        key: { remoteJid: jid, id: 'current', fromMe: false },
        text: '👍',
      },
    },
  });
  // The current build flags reactions on write, so lookups skip them cheaply.
  assert.equal(
    store.db
      .prepare("SELECT excluded FROM message_arrivals WHERE id='old-reaction'")
      .get()?.excluded,
    1,
  );
  // As if both rows were written by a build that did not record arrivals.
  store.db.exec(
    "DELETE FROM message_arrivals WHERE id IN ('old-build','old-reaction')",
  );
  store.close();
  store = new Store(directory);
  try {
    assert.equal(store.latestIncoming(jid)?.id, 'old-build');
    assert.deepEqual(
      store.db
        .prepare('SELECT id,excluded FROM message_arrivals ORDER BY sequence')
        .all()
        .map((row) => [row.id, row.excluded]),
      [
        ['current', 0],
        ['old-build', 0],
        ['old-reaction', 1],
      ],
    );
  } finally {
    store.close();
  }
});

test('the guard travels only under guarded command names, as a message ID or null', () => {
  const base = { command: 'mark-read', jid, key: 'k', value: true };
  assert.deepEqual(parseCommand(base), base, 'unguarded stays unguarded');
  for (const [wire, command] of [
    ['guarded-mark-read', 'mark-read'],
    ['guarded-archive', 'archive'],
  ] as const) {
    for (const ifLatestIncoming of [null, 'in-1'])
      assert.deepEqual(
        parseCommand({ ...base, command: wire, ifLatestIncoming }),
        { ...base, command, ifLatestIncoming },
      );
    assert.deepEqual(
      wireCommand({ ...base, command, ifLatestIncoming: 'in-1' }),
      { ...base, command: wire, ifLatestIncoming: 'in-1' },
    );
  }
  assert.deepEqual(wireCommand(base as Command), base);
  const invalid = [
    // A plain name with a guard would be silently dropped by an older daemon.
    { ...base, ifLatestIncoming: 'in-1' },
    { ...base, ifLatestIncoming: null },
    { ...base, command: 'guarded-mark-read' },
    ...['', 7, false, {}, 'x'.repeat(201)].map((ifLatestIncoming) => ({
      ...base,
      command: 'guarded-mark-read',
      ifLatestIncoming,
    })),
  ];
  for (const value of invalid)
    assert.throws(
      () => parseCommand(value),
      (error) =>
        error instanceof CommandError && error.code === 'INVALID_ARGUMENT',
    );
  assert.deepEqual(parseCommand({ command: 'incoming', jid }), {
    command: 'incoming',
    jid,
    afterId: null,
    limit: 20,
  });
});

/**
 * The archive/read parser of a daemon built before the guard existed. It
 * mirrors origin/main's parseCommand for these commands: no unknown-field
 * check, a boolean value, and Unknown command for any other name.
 */
function preGuardParse(value: Record<string, unknown>) {
  if (value.command !== 'archive' && value.command !== 'mark-read')
    return { ok: false, error: 'Unknown command', code: 'INVALID_ARGUMENT' };
  if (typeof value.value !== 'boolean')
    return {
      ok: false,
      error: 'value must be a boolean',
      code: 'INVALID_ARGUMENT',
    };
  return {
    ok: true,
    data: {
      request: { key: value.key, attempt: 'sdk-returned' },
      feedback: { serverResponse: 'unknown', stateObservation: 'pending' },
    },
  };
}

test('a guarded command fails closed against a daemon without the guard', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'incoming-guard-old-'));
  const applied: unknown[] = [];
  let legacyReply = false;
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const command = JSON.parse(buffer.trim()) as Record<string, unknown>;
      // Optionally pretend a daemon accepted the guarded name without honoring it.
      const response = legacyReply
        ? preGuardParse({ ...command, command: 'mark-read' })
        : preGuardParse(command);
      if (response.ok) applied.push(command);
      socket.end(JSON.stringify({ ...response, id: command.id }) + '\n');
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, 'control.sock'), resolve),
  );
  t.after(() => server.close());
  const run = async (...args: string[]) => {
    try {
      const { stdout } = await runFile(
        process.execPath,
        ['dist/src/cli.js', '--data-dir', directory, ...args],
        { timeout: 5000 },
      );
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch (error) {
      assert.ok(error && typeof error === 'object' && 'stdout' in error);
      return JSON.parse(String(error.stdout)) as Record<string, unknown>;
    }
  };
  const guardedRead = [
    'read',
    '--jid',
    jid,
    '--key',
    'k1',
    '--if-latest-incoming',
    'in-1',
  ];
  const refused = await run(...guardedRead);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'INVALID_ARGUMENT');
  assert.deepEqual(applied, []);
  // Unguarded commands keep working against the same daemon.
  assert.equal((await run('archive', '--jid', jid, '--key', 'k2')).ok, true);
  legacyReply = true;
  const unconfirmed = await run(...guardedRead);
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.code, 'PROTOCOL');
  assert.match(String(unconfirmed.error), /request --key/);
});

test('CLI maps --if-latest-incoming (none as null) and passes refusal details through', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'incoming-guard-cli-'));
  const commands: Record<string, unknown>[] = [];
  const details = {
    precondition: 'if-latest-incoming',
    expected: null,
    latestIncoming: { id: 'in-9', timestamp: 1700000090, available: true },
    coverage: 'local',
  };
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const command = JSON.parse(buffer.trim()) as Record<string, unknown>;
      commands.push(command);
      socket.end(
        JSON.stringify({
          id: command.id,
          ok: false,
          error: 'Fictional refusal',
          code: 'PRECONDITION_FAILED',
          details,
        }) + '\n',
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, 'control.sock'), resolve),
  );
  t.after(() => server.close());
  const run = async (...args: string[]) => {
    try {
      await runFile(
        process.execPath,
        ['dist/src/cli.js', '--data-dir', directory, ...args],
        { timeout: 5000 },
      );
      assert.fail('Expected a nonzero exit');
    } catch (error) {
      assert.ok(error && typeof error === 'object' && 'stdout' in error);
      return JSON.parse(String(error.stdout)) as Record<string, unknown>;
    }
  };
  const none = await run(
    'read',
    '--jid',
    jid,
    '--key',
    'k1',
    '--if-latest-incoming',
    'none',
  );
  assert.deepEqual(none, {
    id: commands[0]?.id,
    ok: false,
    error: 'Fictional refusal',
    code: 'PRECONDITION_FAILED',
    details,
  });
  await run(
    'unarchive',
    '--jid',
    jid,
    '--key',
    'k2',
    '--if-latest-incoming',
    'in-1',
    '--output',
    'compact',
  );
  await run('archive', '--jid', jid, '--key', 'k3');
  assert.deepEqual(
    commands.map(({ id: _id, ...command }) => command),
    [
      {
        command: 'guarded-mark-read',
        jid,
        key: 'k1',
        value: true,
        ifLatestIncoming: null,
      },
      {
        command: 'guarded-archive',
        jid,
        key: 'k2',
        value: false,
        ifLatestIncoming: 'in-1',
      },
      { command: 'archive', jid, key: 'k3', value: true },
    ],
  );
  const empty = await run(
    'read',
    '--jid',
    jid,
    '--key',
    'k4',
    '--if-latest-incoming=',
  );
  assert.equal(empty.code, 'INVALID_ARGUMENT');
  assert.equal(commands.length, 3);
});
