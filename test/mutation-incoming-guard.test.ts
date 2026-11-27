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
import { object, parseCommand } from '../src/protocol.js';
import type { Command } from '../src/protocol.js';
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
        expected: 'in-1',
        expectedStored: true,
        latestIncoming: { id: 'in-2', timestamp: 1700000020 },
        newerIncoming: [{ id: 'in-2', timestamp: 1700000020 }],
        truncated: false,
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
    });
    const response = await failure(
      f.runtime.execute(guarded('mark-read', 'tie', 'in-b')),
    );
    assert.deepEqual(object(response.details).latestIncoming, {
      id: 'in-c',
      timestamp: 1700000100,
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
  // As if written by a build that did not record arrivals.
  store.db.exec('DELETE FROM message_arrivals');
  store.close();
  store = new Store(directory);
  try {
    assert.deepEqual(store.latestIncoming(jid), {
      id: 'old-2',
      timestamp: 1700000002,
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
    });
    assert.deepEqual(details.newerIncoming, [
      { id: 'in-live', timestamp: 1700000200 },
      { id: 'in-history', timestamp: 1700000050 },
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
      .prepare("SELECT noise FROM message_arrivals WHERE id='old-reaction'")
      .get()?.noise,
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
        .prepare('SELECT id,noise FROM message_arrivals ORDER BY sequence')
        .all()
        .map((row) => [row.id, row.noise]),
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

test('the wire precondition accepts a message ID or null only', () => {
  const base = { command: 'mark-read', jid, key: 'k', value: true };
  assert.equal(
    'ifLatestIncoming' in parseCommand(base),
    false,
    'absent stays unguarded',
  );
  assert.deepEqual(parseCommand({ ...base, ifLatestIncoming: null }), {
    ...base,
    ifLatestIncoming: null,
  });
  assert.deepEqual(parseCommand({ ...base, ifLatestIncoming: 'in-1' }), {
    ...base,
    ifLatestIncoming: 'in-1',
  });
  for (const ifLatestIncoming of ['', 7, false, {}, 'x'.repeat(201)])
    assert.throws(
      () => parseCommand({ ...base, ifLatestIncoming }),
      (error) =>
        error instanceof CommandError && error.code === 'INVALID_ARGUMENT',
    );
});

test('CLI maps --if-latest-incoming (none as null) and passes refusal details through', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'incoming-guard-cli-'));
  const commands: Record<string, unknown>[] = [];
  const details = {
    precondition: 'if-latest-incoming',
    expected: null,
    latestIncoming: { id: 'in-9', timestamp: 1700000090 },
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
        command: 'mark-read',
        jid,
        key: 'k1',
        value: true,
        ifLatestIncoming: null,
      },
      {
        command: 'archive',
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
