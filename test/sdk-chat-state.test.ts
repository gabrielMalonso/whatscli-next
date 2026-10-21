import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  chatModificationToAppPatch,
  makeEventBuffer,
  processSyncAction,
} from 'baileys';
import type { WASocket, WAMessage } from 'baileys';
import { pino } from 'pino';
import { createRuntime } from '../src/runtime.js';
import { object } from '../src/protocol.js';
import { formatResponse } from '../src/response.js';
import { Store } from '../src/store.js';

process.umask(0o077);
const jid = '12025550101@s.whatsapp.net';
const other = '12025550102@s.whatsapp.net';
const me = { id: '12025550199@s.whatsapp.net', name: 'Fictional owner' };
const logger = pino({ level: 'silent' });
type Modification = Parameters<WASocket['chatModify']>[0];

function fixture(modify?: (mod: Modification, call: number) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-chat-state-'));
  const seed = new Store(directory);
  seed.observeChat({ id: jid, archived: false, unreadCount: 0 });
  seed.observeChat({ id: other, archived: false, unreadCount: 0 });
  seed.observeMessage({
    key: { remoteJid: jid, id: 'fictional-last', fromMe: false },
    messageTimestamp: 1700000000,
    message: { conversation: 'Fictional text' },
  });
  seed.close();
  const ev = makeEventBuffer(logger);
  let calls = 0;
  const apply = (mod: Modification, target = jid) => {
    const patch = chatModificationToAppPatch(mod, target);
    processSyncAction(
      { index: patch.index, syncAction: { value: patch.syncAction } },
      ev,
      me,
      undefined,
      logger,
    );
  };
  const runtime = createRuntime(
    { dataDir: directory, connect: true },
    (config) => {
      assert.equal(config.emitOwnEvents, true);
      return {
        ev,
        ws: { isClosed: true },
        chatModify: async (mod: Modification) => {
          calls++;
          if (modify) await modify(mod, calls);
          else apply(mod);
        },
        sendMessage: async (
          ...[target, _content, options]: Parameters<WASocket['sendMessage']>
        ) => {
          const messageId = options?.messageId;
          assert.ok(messageId);
          const message: WAMessage = {
            key: { remoteJid: target, id: messageId, fromMe: true },
            messageTimestamp: 1900000000,
            message: { conversation: 'Fictional outgoing text' },
          };
          // rc14 schedules the synthetic upsert after sendMessage returns.
          process.nextTick(() => {
            ev.emit('messages.upsert', { type: 'append', messages: [message] });
            ev.emit('chats.update', [
              {
                id: target,
                archived: false,
                conversationTimestamp: 1900000000,
              },
            ]);
          });
          return message;
        },
        end: () => ev.emit('connection.update', { connection: 'close' }),
      } as unknown as WASocket;
    },
  );
  runtime.start();
  ev.emit('connection.update', { connection: 'open' });
  return {
    directory,
    runtime,
    ev,
    apply,
    calls: () => calls,
    view: async () => object(await runtime.execute({ command: 'chat', jid })),
    close: async () => {
      await runtime.close();
      ev.destroy();
    },
  };
}

for (const [command, value, field, expected] of [
  ['archive', true, 'archived', true],
  ['archive', false, 'archived', false],
  ['mark-read', true, 'unread', false],
  ['mark-read', false, 'unread', true],
] as const) {
  test(`${command}=${value} captures the rc14 echo before buffering without turning it into independent state`, async () => {
    const f = fixture();
    const intent = { command, jid, value, key: 'fictional-action' };
    try {
      f.ev.buffer();
      const result = object(await f.runtime.execute(intent));
      f.ev.flush();
      assert.equal(object(result.request).attempt, 'sdk-returned');
      assert.equal(result.verification, 'unknown');
      const chat = await f.view();
      assert.equal(chat[field], null);
      assert.deepEqual(object(chat.pending)[field], {
        key: intent.key,
        value: expected,
      });
      const report = object(object(chat.sdkReported)[field]);
      assert.equal(report.value, expected);
      assert.equal(report.source, 'sdk-event-during-request');
      assert.equal(report.requestKey, intent.key);
      assert.equal(typeof report.reportedAt, 'number');
      const compact = object(
        formatResponse(command, { ok: true, data: result }, 'compact').data,
      );
      assert.deepEqual(object(compact.localChat).sdkReported, chat.sdkReported);
      assert.deepEqual(object(await f.runtime.execute(intent)).localChat, chat);
      assert.equal(f.calls(), 1);
    } finally {
      await f.close();
    }
    const reopened = createRuntime({ dataDir: f.directory, connect: false });
    try {
      const replay = object(await reopened.execute(intent));
      assert.equal(
        object(object(object(replay.localChat).sdkReported)[field]).value,
        expected,
      );
      assert.equal(f.calls(), 1);
    } finally {
      await reopened.close();
    }
  });
}

test('SDK return without an event and SDK failure do not manufacture a reported state', async () => {
  for (const failure of [false, true]) {
    const f = fixture(async () => {
      if (failure) throw new Error('Fictional SDK failure');
    });
    try {
      const result = object(
        await f.runtime.execute({
          command: 'archive',
          jid,
          value: true,
          key: 'absent',
        }),
      );
      assert.equal(
        object(result.request).attempt,
        failure ? 'uncertain' : 'sdk-returned',
      );
      assert.equal('sdkReported' in object(result.localChat), false);
      assert.equal(object(result.localChat).archived, null);
    } finally {
      await f.close();
    }
  }
});

test('preflight SDK events stay local; an outside observation supersedes the report without claiming request causality', async () => {
  const f = fixture(async (mod) => {
    f.ev.emit('chats.update', [
      { id: jid, archived: false, name: 'Fictional rename', unreadCount: 1 },
      { id: other, archived: true },
    ]);
    f.apply(mod);
  });
  try {
    await f.runtime.execute({
      command: 'archive',
      jid,
      value: true,
      key: 'preflight',
    });
    f.ev.flush();
    assert.equal((await f.view()).archived, null);
    assert.equal((await f.view()).name, 'Fictional rename');
    assert.equal((await f.view()).unread, true);
    assert.equal(
      object(object((await f.view()).sdkReported).archived).value,
      true,
    );
    assert.equal(
      object(await f.runtime.execute({ command: 'chat', jid: other })).archived,
      true,
    );
    f.ev.emit('chats.update', [{ id: jid, unreadCount: 1 }]);
    assert.equal(
      object(object((await f.view()).sdkReported).archived).value,
      true,
    );
    f.ev.emit('chats.update', [{ id: jid, archived: false }]);
    const chat = await f.view();
    assert.equal(chat.archived, false);
    assert.deepEqual(chat.pending, {});
    assert.equal('sdkReported' in chat, false);
  } finally {
    await f.close();
  }
});

test('late echoes cannot replace a newer request or an independent observation', async () => {
  for (const independent of [false, true]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(async (mod, call) => {
      if (call === 1) await gate;
      f.apply(mod);
    });
    try {
      const first = f.runtime.execute({
        command: 'archive',
        jid,
        value: true,
        key: 'old',
      });
      if (independent)
        f.ev.emit('chats.update', [{ id: jid, archived: false }]);
      else
        await f.runtime.execute({
          command: 'archive',
          jid,
          value: false,
          key: 'new',
        });
      release();
      await first;
      const chat = await f.view();
      if (independent) {
        assert.equal(chat.archived, false);
        assert.deepEqual(chat.pending, {});
        assert.equal('sdkReported' in chat, false);
      } else {
        assert.equal(chat.archived, null);
        assert.equal(object(object(chat.sdkReported).archived).value, false);
        assert.equal(
          object(object(chat.sdkReported).archived).requestKey,
          'new',
        );
      }
    } finally {
      release();
      await f.close();
    }
  }
});

test('an event before SDK failure remains local evidence alongside an uncertain attempt', async () => {
  const f = fixture(async (mod) => {
    f.apply(mod);
    throw new Error('Fictional failure after echo');
  });
  try {
    const result = object(
      await f.runtime.execute({
        command: 'archive',
        jid,
        value: true,
        key: 'interrupted',
      }),
    );
    assert.equal(object(result.request).attempt, 'uncertain');
    assert.equal(object(result.request).errorObserved, true);
    assert.equal(result.verification, 'unknown');
    assert.equal(
      object(object(object(result.localChat).sdkReported).archived).value,
      true,
    );
    assert.equal(object(result.localChat).archived, null);
    assert.equal(
      object(object(object(result.localChat).pending).archived).key,
      'interrupted',
    );
  } finally {
    await f.close();
  }
});

test('enabling own events cannot create observed outgoing history or activity', async () => {
  const f = fixture();
  try {
    const before = await f.view();
    const sent = object(
      await f.runtime.execute({
        command: 'send',
        jid,
        key: 'send',
        text: 'Fictional outgoing text',
      }),
    );
    assert.equal(sent.attempt, 'sdk-returned');
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.ev.flush();
    const chat = await f.view();
    assert.equal(chat.archived, before.archived);
    assert.deepEqual(chat.activity, before.activity);
    assert.equal('sdkReported' in chat, false);
    // A separate echo from the network still establishes activity.
    f.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: jid, id: String(sent.messageId), fromMe: true },
          messageTimestamp: 1900000000,
          message: { conversation: 'Fictional outgoing text' },
        },
      ],
    });
    assert.equal(object((await f.view()).activity).timestamp, 1900000000);
  } finally {
    await f.close();
  }
});
