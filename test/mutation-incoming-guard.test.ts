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

function fixture(seed: WAMessage[]) {
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
        latestIncoming: { id: 'in-2', timestamp: 1700000020 },
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
