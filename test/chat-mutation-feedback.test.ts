import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  chatModificationToAppPatch,
  makeEventBuffer,
  getChatAppStateAction,
} from 'baileys';
import type { AppStatePatchResponse, WASocket } from 'baileys';
import { pino } from 'pino';
import { createRuntime } from '../src/runtime.js';
import { object } from '../src/protocol.js';
import { formatResponse } from '../src/response.js';
import { Store } from '../src/store.js';

process.umask(0o077);
const jid = '12025550101@s.whatsapp.net';
const logger = pino({ level: 'silent' });
type Modification = Parameters<WASocket['chatModify']>[0];
type Reply =
  'matched' | 'bare' | 'mismatch' | 'missing' | 'error' | 'commit-error';

function fixture(reply: Reply = 'matched', includeSend = false) {
  const directory = mkdtempSync(join(tmpdir(), 'chat-feedback-'));
  const seed = new Store(directory);
  seed.observeChat({ id: jid, unreadCount: 0, archived: false });
  seed.observeMessage({
    key: { remoteJid: jid, id: 'fictional-last', fromMe: false },
    messageTimestamp: 1700000000,
    message: { conversation: 'Fictional fixture' },
  });
  if (includeSend)
    seed.saveRequest({
      key: 'send-fixture',
      operation: { kind: 'send', jid, text: 'Fictional send' },
      messageId: 'fictional-sent',
      attempt: 'sdk-returned',
      acceptance: 'unknown',
      delivery: 'unknown',
      read: 'unknown',
      errorObserved: false,
    });
  seed.close();
  const ev = makeEventBuffer(logger);
  let calls = 0;
  const apply = (mod: Modification, requestId: string) => {
    const patch = chatModificationToAppPatch(mod, jid);
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
  const runtime = createRuntime({ dataDir: directory, connect: true }, () => {
    return {
      ev,
      ws: { isClosed: true },
      chatModify: async (
        ...[mod, target, options]: Parameters<WASocket['chatModify']>
      ) => {
        calls++;
        assert.equal(target, jid);
        assert.ok(options?.requestId);
        if (reply === 'error') throw new Error('SDK_PRIVATE_FIXTURE');
        if (reply !== 'missing') {
          const response: AppStatePatchResponse = {
            kind: 'patch-response',
            collection: 'regular_low',
            version: calls,
            requestId: options.requestId,
            ...(reply === 'bare'
              ? { status: 'response-received' }
              : reply === 'mismatch'
                ? { status: 'response-received', serverVersion: calls + 10 }
                : { status: 'version-matched', serverVersion: calls }),
          };
          ev.emit('app-state.update', {
            ...response,
            ...{ privatePayload: 'SDK_PRIVATE_FIXTURE' },
          });
        }
        if (reply === 'commit-error') throw new Error('SDK_PRIVATE_FIXTURE');
        apply(mod, options.requestId);
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
    calls: () => calls,
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
  test(`${command}=${value} persists server response separately from pending observation, replay and restart`, async () => {
    const f = fixture();
    const intent = { command, jid, value, key: 'fictional-intent' };
    let request: Record<string, unknown>;
    try {
      f.ev.buffer();
      const result = object(await f.runtime.execute(intent));
      f.ev.flush();
      request = object(result.request);
      assert.equal(request.attempt, 'sdk-returned');
      assert.equal(request.acceptance, 'unknown');
      assert.equal(object(request.appStateResponse).status, 'version-matched');
      assert.equal(object(request.appStateResponse).version, 1);
      assert.deepEqual(result.feedback, {
        serverResponse: 'version-matched',
        stateObservation: 'pending',
      });
      const chat = object(result.localChat);
      assert.equal(chat[field], null);
      assert.deepEqual(object(chat.pending)[field], {
        key: intent.key,
        value: expected,
      });
      const compact = object(
        formatResponse(command, { ok: true, data: result }, 'compact').data,
      );
      assert.deepEqual(compact.feedback, result.feedback);
      assert.deepEqual(compact.request, request);
      assert.deepEqual(object(compact.localChat).pending, chat.pending);
      assert.doesNotMatch(
        JSON.stringify([
          result,
          await f.runtime.execute({ command: 'events', after: 0 }),
        ]),
        /SDK_PRIVATE_FIXTURE/,
      );
      assert.deepEqual(
        object(await f.runtime.execute(intent)).request,
        request,
      );
      assert.equal(f.calls(), 1);
    } finally {
      await f.close();
    }
    const offline = createRuntime({ dataDir: f.directory, connect: false });
    try {
      assert.deepEqual(
        await offline.execute({ command: 'request', key: intent.key }),
        request,
      );
      const replay = object(await offline.execute(intent));
      assert.deepEqual(replay.request, request);
      assert.deepEqual(replay.feedback, {
        serverResponse: 'version-matched',
        stateObservation: 'pending',
      });
    } finally {
      await offline.close();
    }
  });
}

for (const reply of [
  'bare',
  'mismatch',
  'missing',
  'error',
  'commit-error',
] as const) {
  test(`${reply} retains exactly the server evidence available without claiming observed state or retrying`, async () => {
    const f = fixture(reply);
    try {
      const command = {
        command: 'mark-read',
        jid,
        value: false,
        key: 'uncertain',
      } as const;
      const result = object(await f.runtime.execute(command));
      const request = object(result.request);
      const serverResponse =
        reply === 'bare' || reply === 'mismatch'
          ? 'response-received'
          : reply === 'commit-error'
            ? 'version-matched'
            : 'unknown';
      assert.deepEqual(result.feedback, {
        serverResponse,
        stateObservation: 'pending',
      });
      assert.equal(
        request.errorObserved,
        reply === 'error' || reply === 'commit-error',
      );
      assert.equal(
        request.attempt,
        reply === 'error' || reply === 'commit-error'
          ? 'uncertain'
          : 'sdk-returned',
      );
      assert.equal(object(result.localChat).unread, null);
      if (reply === 'error' || reply === 'missing')
        assert.equal('appStateResponse' in request, false);
      await f.runtime.execute(command);
      assert.equal(f.calls(), 1);
    } finally {
      await f.close();
    }
  });
}

test('late responses update their own request without undoing newer intent or contrary observation', async () => {
  const f = fixture('missing');
  try {
    const older = { command: 'archive', jid, value: true, key: 'old' } as const;
    const newer = {
      command: 'archive',
      jid,
      value: false,
      key: 'new',
    } as const;
    await f.runtime.execute(older);
    await f.runtime.execute(newer);
    f.ev.emit('app-state.update', {
      kind: 'patch-response',
      requestId: 'old',
      collection: 'regular_low',
      version: 1,
      serverVersion: 1,
      status: 'version-matched',
    });
    let replay = object(await f.runtime.execute(older));
    assert.deepEqual(replay.feedback, {
      serverResponse: 'version-matched',
      stateObservation: 'superseded',
    });
    assert.deepEqual(object(object(replay.localChat).pending).archived, {
      key: 'new',
      value: false,
    });
    f.ev.emit('chats.update', [{ id: jid, archived: false }]);
    replay = object(await f.runtime.execute(older));
    assert.deepEqual(replay.feedback, {
      serverResponse: 'version-matched',
      stateObservation: 'available',
    });
    assert.equal(object(replay.localChat).archived, false);
    assert.deepEqual(object(replay.localChat).pending, {});
    f.ev.emit('app-state.update', {
      kind: 'patch-response',
      requestId: 'old',
      collection: 'regular_low',
      version: 1,
      status: 'response-received',
    });
    assert.equal(
      object(
        object(await f.runtime.execute({ command: 'request', key: 'old' }))
          .appStateResponse,
      ).status,
      'version-matched',
    );
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});

test('unmatched IDs, invalid matching versions and unrelated collections do not manufacture response evidence', async () => {
  const f = fixture('missing', true);
  try {
    await f.runtime.execute({
      command: 'mark-read',
      jid,
      value: false,
      key: 'target',
    });
    for (const response of [
      {
        requestId: 'send-fixture',
        collection: 'regular_low',
        version: 1,
        serverVersion: 1,
      },
      {
        requestId: 'unknown',
        collection: 'regular_low',
        version: 1,
        serverVersion: 1,
      },
      {
        requestId: 'target',
        collection: 'regular_high',
        version: 1,
        serverVersion: 1,
      },
      {
        requestId: 'target',
        collection: 'regular_low',
        version: 1,
        serverVersion: 2,
      },
    ] as const)
      f.ev.emit('app-state.update', {
        kind: 'patch-response',
        status: 'version-matched',
        ...response,
      });
    assert.equal(
      'appStateResponse' in
        object(await f.runtime.execute({ command: 'request', key: 'target' })),
      false,
    );
    assert.equal(
      'appStateResponse' in
        object(
          await f.runtime.execute({ command: 'request', key: 'send-fixture' }),
        ),
      false,
    );
    assert.equal(
      await f.runtime.execute({ command: 'request', key: 'unknown' }),
      null,
    );
  } finally {
    await f.close();
  }
});

test('pending-intent queue membership is explicit and paginated before projection; observed-only preserves strict queries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chat-queue-'));
  let store = new Store(directory);
  try {
    for (const [id, timestamp] of [
      [jid, 100],
      ['12025550102@s.whatsapp.net', 200],
      ['12025550103@s.whatsapp.net', 300],
    ] as const) {
      store.observeChat({
        id,
        unreadCount: id === jid ? 1 : 0,
        archived: false,
        conversationTimestamp: timestamp,
      });
      if (id !== jid)
        store.invalidateChatState(`unread-${timestamp}`, {
          kind: 'mark-read',
          jid: id,
          value: false,
        });
    }
    const filter = { unread: true, archived: false } as const;
    const queue = store.chats(2, 0, filter);
    assert.deepEqual(
      queue.map((chat) => chat.jid),
      ['12025550103@s.whatsapp.net', '12025550102@s.whatsapp.net'],
    );
    for (const item of queue) {
      const chat = object(item);
      assert.equal(chat.unread, null);
      assert.deepEqual(chat.matchedBy, { unread: 'pending-intent' });
    }
    assert.deepEqual(
      store.chats(2, 2, filter).map((chat) => chat.jid),
      [jid],
    );
    assert.deepEqual(
      store
        .chats(100, 0, { ...filter, observedOnly: true })
        .map((chat) => chat.jid),
      [jid],
    );
    assert.equal(store.chats(100, 0, { unread: 'unknown' }).length, 2);
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.chats(2, 0, filter), queue);
    store.observeChat({ id: '12025550103@s.whatsapp.net', unreadCount: 0 });
    assert.deepEqual(
      store.chats(100, 0, filter).map((chat) => chat.jid),
      ['12025550102@s.whatsapp.net', jid],
    );
  } finally {
    store.close();
  }
});
