import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  chatModificationToAppPatch,
  getChatAppStateAction,
  initAuthCreds,
  makeEventBuffer,
  proto,
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

function fixture(
  modify?: (
    mod: Modification,
    call: number,
    requestId: string,
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-chat-state-'));
  const seed = new Store(directory);
  seed.set('auth', 'creds', { ...initAuthCreds(), me });
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
  const echo = (mod: Modification, requestId: string, target = jid) => {
    const patch = chatModificationToAppPatch(mod, target);
    const action = getChatAppStateAction(
      { index: patch.index, syncAction: { value: patch.syncAction } },
      {
        source: 'local-echo',
        collection: 'regular_low',
        version: calls,
        requestId,
      },
    );
    assert.ok(action);
    ev.emit('app-state.update', action);
  };
  const runtime = createRuntime(
    { dataDir: directory, connect: true },
    (config) => {
      assert.equal(config.emitOwnEvents, false);
      return {
        ev,
        ws: { isClosed: true },
        chatModify: async (
          ...[mod, , options]: Parameters<WASocket['chatModify']>
        ) => {
          calls++;
          assert.ok(options?.requestId);
          if (modify) await modify(mod, calls, options.requestId);
          else echo(mod, options.requestId);
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
          if (config.emitOwnEvents)
            process.nextTick(() => {
              ev.emit('messages.upsert', {
                type: 'append',
                messages: [message],
              });
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
    echo,
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
  test(`${command}=${value} captures the typed local echo before buffering without turning it into independent state`, async () => {
    const f = fixture();
    const intent = { command, jid, value, key: 'fictional-action' };
    try {
      f.ev.buffer();
      const result = object(await f.runtime.execute(intent));
      f.ev.flush();
      assert.equal(object(result.request).attempt, 'sdk-returned');
      assert.equal('verification' in result, false);
      const chat = await f.view();
      assert.equal(chat[field], null);
      assert.deepEqual(object(chat.pending)[field], {
        key: intent.key,
        value: expected,
      });
      const report = object(object(chat.sdkReported)[field]);
      assert.equal(report.value, expected);
      assert.equal(report.source, 'sdk-local-echo');
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

test('independent positive unread events inside a command resolve its pending observation', async () => {
  for (const value of [true, false]) {
    const f = fixture(async () => {
      f.ev.emit('chats.update', [{ id: jid, unreadCount: 1 }]);
    });
    try {
      f.ev.buffer();
      const result = object(
        await f.runtime.execute({
          command: 'mark-read',
          jid,
          value,
          key: 'positive-during-call',
        }),
      );
      f.ev.flush();
      const chat = await f.view();
      assert.equal(chat.unread, true);
      assert.equal(chat.unreadCount, null);
      assert.deepEqual(chat.pending, {});
      assert.equal('sdkReported' in chat, false);
      assert.deepEqual(result.feedback, {
        serverResponse: 'unknown',
        stateObservation: 'available',
      });
      const replay = object(
        await f.runtime.execute({
          command: 'mark-read',
          jid,
          value,
          key: 'positive-during-call',
        }),
      );
      assert.deepEqual(replay.request, result.request);
      assert.equal(f.calls(), 1);
    } finally {
      await f.close();
    }
  }
});

for (const value of [true, false]) {
  test(`an independent increment resolves pending before READ absorption (markRead=${value})`, async () => {
    const f = fixture();
    try {
      await f.runtime.execute({
        command: 'mark-read',
        jid,
        value,
        key: 'before-absorption',
      });
      const message: WAMessage = {
        key: { remoteJid: jid, id: 'independent-incoming', fromMe: false },
        messageTimestamp: 1700000010,
        message: { conversation: 'Fictional independent incoming' },
      };
      f.ev.buffer();
      f.ev.emit('messages.upsert', { type: 'notify', messages: [message] });
      f.ev.emit('chats.update', [
        { id: jid, unreadCount: 1, messages: [{ message }] },
      ]);
      const captured = await f.view();
      assert.equal(captured.unread, true);
      assert.deepEqual(captured.pending, {});
      assert.equal('sdkReported' in captured, false);
      f.ev.emit('messages.update', [
        {
          key: message.key,
          update: { status: proto.WebMessageInfo.Status.READ },
        },
      ]);
      f.ev.emit('message-receipt.update', [
        {
          key: message.key,
          receipt: { userJid: me.id, readTimestamp: 1700000020 },
        },
      ]);
      f.ev.flush();
      const chat = await f.view();
      assert.deepEqual(chat.pending, {});
      // The unread intent retired coverage; a receipt cannot qualify it again.
      assert.equal(chat.unread, !value);
      assert.equal(Boolean(chat.readObservation), value);
      assert.equal(
        object(
          await f.runtime.execute({
            command: 'request',
            key: 'before-absorption',
          }),
        ).attempt,
        'sdk-returned',
      );
    } finally {
      await f.close();
    }
  });
}

test('uncorrelated or mismatched typed echoes cannot manufacture an SDK report', async () => {
  const f = fixture(async () => {});
  try {
    await f.runtime.execute({
      command: 'archive',
      jid,
      value: true,
      key: 'target',
    });
    const echo = {
      kind: 'chat-action',
      source: 'local-echo',
      collection: 'regular_low',
      version: 1,
      requestId: 'target',
      jid,
      action: { kind: 'archive', archived: true },
    } as const;
    for (const invalid of [
      { ...echo, requestId: undefined },
      { ...echo, requestId: 'unknown' },
      { ...echo, jid: other },
      { ...echo, collection: 'regular' as const },
      { ...echo, version: 0 },
      { ...echo, action: { kind: 'mark-read', read: true } as const },
    ]) {
      const { requestId, ...action } = invalid;
      f.ev.emit('app-state.update', {
        ...action,
        ...(requestId === undefined ? {} : { requestId }),
      });
      assert.equal('sdkReported' in (await f.view()), false);
    }
    assert.equal((await f.view()).archived, null);
  } finally {
    await f.close();
  }
});

test('legacy invocation-context reports remain readable without acquiring stronger provenance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-sdk-report-'));
  const seed = new Store(directory);
  seed.observeChat({ id: jid, archived: false });
  const report = {
    value: true,
    source: 'sdk-event-during-request',
    requestKey: 'historical-command',
    reportedAt: 1700000000000,
  };
  seed.set('sdk-chat-state', jid, { archived: report });
  seed.close();
  const runtime = createRuntime({ dataDir: directory, connect: false });
  try {
    const chat = object(await runtime.execute({ command: 'chat', jid }));
    assert.deepEqual(chat.sdkReported, { archived: report });
  } finally {
    await runtime.close();
  }
});

for (const [command, value, field, observed] of [
  ['archive', true, 'archived', false],
  ['archive', false, 'archived', true],
  ['mark-read', true, 'unread', true],
  ['mark-read', false, 'unread', false],
] as const) {
  test(`${command}=${value} preserves independent preflight state separately from the later local echo`, async () => {
    const f = fixture(async (mod, _call, requestId) => {
      f.ev.emit('app-state.update', {
        kind: 'chat-action',
        source: 'sync',
        collection: 'regular_low',
        version: 1,
        initialSync: false,
        representation: 'patch',
        macVerified: false,
        jid,
        action:
          field === 'archived'
            ? { kind: 'archive', archived: observed }
            : { kind: 'mark-read', read: !observed },
      });
      f.ev.emit('chats.update', [
        {
          id: jid,
          name: 'Fictional rename',
          ...(field === 'archived'
            ? { archived: observed }
            : { unreadCount: observed ? -1 : 0 }),
        },
        { id: other, archived: true },
      ]);
      f.echo(mod, requestId);
    });
    try {
      f.ev.buffer();
      const result = object(
        await f.runtime.execute({
          command,
          jid,
          value,
          key: 'preflight',
        }),
      );
      f.ev.flush();
      const chat = await f.view();
      assert.equal(chat[field], observed);
      assert.equal(chat.name, 'Fictional rename');
      assert.deepEqual(chat.pending, {});
      assert.equal('sdkReported' in chat, false);
      assert.equal(object(result.feedback).stateObservation, 'available');
      assert.equal(
        object(await f.runtime.execute({ command: 'chat', jid: other }))
          .archived,
        true,
      );
    } finally {
      await f.close();
    }
  });
}

test('late echoes cannot replace a newer request or an independent observation', async () => {
  for (const independent of [false, true]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(async (mod, call, requestId) => {
      if (call === 1) await gate;
      f.echo(mod, requestId);
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
  const f = fixture(async (mod, _call, requestId) => {
    f.echo(mod, requestId);
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
    assert.equal('verification' in result, false);
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

test('disabling legacy own events prevents synthetic outgoing history or activity', async () => {
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

for (const interrupted of ['archive', 'send'] as const) {
  test(
    `recovery created during ${interrupted} keeps replacement socket observations outside the old invocation`,
    { timeout: 5000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'sdk-socket-context-'));
      const seed = new Store(directory);
      seed.observeChat({
        id: jid,
        archived: interrupted === 'send',
        unreadCount: 0,
      });
      seed.observeMessage({
        key: { remoteJid: jid, id: 'fictional-last', fromMe: false },
        messageTimestamp: 1700000000,
        message: { conversation: 'Fictional previous message' },
      });
      seed.close();
      const events: ReturnType<typeof makeEventBuffer>[] = [];
      let replaced!: () => void;
      const replacementReady = new Promise<void>((resolve) => {
        replaced = resolve;
      });
      let messageId: string | undefined;
      let attempts = 0;
      const runtime = createRuntime(
        { dataDir: directory, connect: true },
        () => {
          const first = events.length === 0;
          const ev = makeEventBuffer(logger);
          const ws = Object.assign(new EventEmitter(), { isClosed: false });
          events.push(ev);
          const fail = () => {
            attempts++;
            ws.isClosed = true;
            ws.emit('close');
            ev.emit('connection.update', {
              connection: 'close',
              lastDisconnect: {
                error: Object.assign(new Error('Fictional transport failure'), {
                  output: { statusCode: 408 },
                }),
                date: new Date(),
              },
            });
            throw new Error('Fictional interrupted SDK invocation');
          };
          // Like WebSocket callbacks, this resource inherits its factory's async context.
          if (!first)
            setImmediate(() => {
              ev.emit('connection.update', { connection: 'open' });
              ev.emit('chats.update', [{ id: jid, archived: false }]);
              if (messageId)
                ev.emit('messages.upsert', {
                  type: 'notify',
                  messages: [
                    {
                      key: { remoteJid: jid, id: messageId, fromMe: true },
                      messageTimestamp: 1700000010,
                      message: {
                        conversation: 'Fictional independent outgoing echo',
                      },
                    },
                  ],
                });
              replaced();
            });
          return {
            ev,
            ws,
            executeUSyncQuery: async () => ({ list: [] }),
            chatModify: async (
              ...[mod, target, options]: Parameters<WASocket['chatModify']>
            ) => {
              if (first) fail();
              const patch = chatModificationToAppPatch(mod, target);
              const action = getChatAppStateAction(
                { index: patch.index, syncAction: { value: patch.syncAction } },
                {
                  source: 'local-echo',
                  collection: 'regular_low',
                  version: 1,
                  requestId: options!.requestId!,
                },
              );
              assert.ok(action);
              ev.emit('app-state.update', action);
            },
            sendMessage: async (
              ...[, , options]: Parameters<WASocket['sendMessage']>
            ) => {
              messageId = options?.messageId;
              assert.ok(messageId);
              fail();
            },
            end: () => {
              ws.isClosed = true;
              ws.emit('close');
              ev.emit('connection.update', { connection: 'close' });
            },
          } as unknown as WASocket;
        },
        {
          now: Date.now,
          schedule(callback) {
            const timer = setTimeout(callback, 0);
            return () => clearTimeout(timer);
          },
        },
      );
      runtime.start();
      events[0]!.emit('connection.update', { connection: 'open' });
      const intent =
        interrupted === 'archive'
          ? {
              command: 'archive' as const,
              jid,
              value: true,
              key: 'interrupted',
            }
          : {
              command: 'send' as const,
              jid,
              text: 'Fictional outgoing text',
              key: 'interrupted',
            };
      try {
        const result = object(await runtime.execute(intent));
        const request =
          interrupted === 'archive' ? object(result.request) : result;
        assert.equal(request.attempt, 'uncertain');
        await replacementReady;
        assert.equal(events.length, 2);
        const chat = object(await runtime.execute({ command: 'chat', jid }));
        assert.equal(chat.archived, false);
        assert.deepEqual(chat.pending, {});
        assert.equal('sdkReported' in chat, false);
        if (interrupted === 'send')
          assert.equal(object(chat.activity).timestamp, 1700000010);
        await runtime.execute(intent);
        assert.equal(attempts, 1);
        const next = object(
          await runtime.execute({
            command: 'archive',
            jid,
            value: true,
            key: 'new-socket',
          }),
        );
        assert.equal(object(next.request).attempt, 'sdk-returned');
        assert.equal(object(next.localChat).archived, null);
        assert.equal(
          object(object(object(next.localChat).sdkReported).archived)
            .requestKey,
          'new-socket',
        );
      } finally {
        await runtime.close();
        for (const ev of events) ev.destroy();
      }
    },
  );
}
