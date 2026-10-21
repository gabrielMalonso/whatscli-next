import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  chatModificationToAppPatch,
  initAuthCreds,
  makeEventBuffer,
  processSyncAction,
} from 'baileys';
import type { WASocket } from 'baileys';
import processMessage from 'baileys/lib/Utils/process-message.js';
import { pino } from 'pino';
import { object } from '../src/protocol.js';
import { createRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';

process.umask(0o077);
const pn = '12025550101@s.whatsapp.net';
const me = { id: '12025550199@s.whatsapp.net', name: 'Fictional owner' };
const logger = pino({ level: 'silent' });
const last = {
  key: { remoteJid: pn, id: 'fictional-last', fromMe: false },
  messageTimestamp: 1700000000,
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'read-unread-'));
  const seed = new Store(directory);
  seed.observeChat({ id: pn, archived: false, unreadCount: 0 });
  seed.observeMessage({ ...last, message: { conversation: 'Fictional text' } });
  seed.close();
  const ev = makeEventBuffer(logger);
  let calls = 0;
  const runtime = createRuntime(
    { dataDir: directory, connect: true, allowedJid: pn },
    (config) => {
      assert.equal(config.emitOwnEvents, true);
      return {
        ev,
        ws: { isClosed: true },
        chatModify: async (
          ...[mod, jid]: Parameters<WASocket['chatModify']>
        ) => {
          calls++;
          assert.equal(jid, pn);
          assert.ok('markRead' in mod);
          assert.deepEqual(mod.lastMessages, [last]);
          const patch = chatModificationToAppPatch(mod, jid);
          processSyncAction(
            { index: patch.index, syncAction: { value: patch.syncAction } },
            ev,
            me,
            undefined,
            logger,
          );
        },
        end: () => ev.emit('connection.update', { connection: 'close' }),
      } as unknown as WASocket;
    },
  );
  runtime.start();
  ev.emit('connection.update', { connection: 'open' });
  const view = async () => {
    const chat = (await runtime.execute({
      command: 'chat',
      jid: pn,
    })) as ReturnType<Store['chatView']>;
    assert.ok(chat);
    return chat;
  };
  const action = (read: boolean) => {
    const patch = chatModificationToAppPatch(
      { markRead: read, lastMessages: [last] },
      pn,
    );
    processSyncAction(
      { index: patch.index, syncAction: { value: patch.syncAction } },
      ev,
      me,
      undefined,
      logger,
    );
  };
  return {
    directory,
    runtime,
    ev,
    view,
    action,
    calls: () => calls,
    incoming: async (type: 'notify' | 'append' = 'notify') => {
      const message = {
        ...last,
        key: { ...last.key, id: 'fictional-new' },
        messageTimestamp: 1700000001,
        message: { conversation: 'Fictional incoming text' },
      };
      ev.emit('messages.upsert', { type, messages: [message] });
      await processMessage(message, {
        ev,
        creds: { ...initAuthCreds(), me },
        logger,
        shouldProcessHistoryMsg: false,
      } as unknown as Parameters<typeof processMessage>[1]); // Only the partial SDK context is erased; this text path needs no I/O.
    },
    close: async () => {
      await runtime.close();
      ev.destroy();
    },
  };
}

test('rc14 online and offline incoming messages supersede read/unread pending and SDK reports, including restart and replay', async () => {
  for (const value of [true, false]) {
    for (const type of ['notify', 'append'] as const) {
      const f = fixture();
      const command = {
        command: 'mark-read',
        jid: pn,
        key: `fictional-${value}`,
        value,
      } as const;
      try {
        const result = object(await f.runtime.execute(command));
        const before = await f.view();
        assert.equal(before.unread, null);
        assert.deepEqual(before.pending.unread, {
          key: command.key,
          value: !value,
        });
        assert.equal(before.sdkReported?.unread?.value, !value);
        await f.incoming(type);
        f.ev.emit('chats.update', [{ id: pn, markedAsUnread: false }]);
        const chat = await f.view();
        assert.equal(chat.unread, true);
        assert.equal(chat.unreadCount, null);
        assert.deepEqual(chat.pending, {});
        assert.equal('sdkReported' in chat, false);
        assert.equal(chat.activity.timestamp, 1700000001);
        const messages = await f.runtime.execute({
          command: 'messages',
          jid: pn,
          limit: 10,
          offset: 0,
        });
        assert.ok(Array.isArray(messages));
        assert.equal(object(messages[0]).id, 'fictional-new');
        const chats = await f.runtime.execute({
          command: 'chats',
          unread: true,
          archived: false,
          limit: 100,
          offset: 0,
        });
        assert.ok(Array.isArray(chats));
        assert.deepEqual(
          chats.map((item) => object(item).jid),
          [pn],
        );
        const replay = object(await f.runtime.execute(command));
        assert.deepEqual(replay.request, result.request);
        assert.equal(object(replay.localChat).unread, true);
        assert.equal(f.calls(), 1);
      } finally {
        await f.close();
      }
      const reopened = createRuntime({ dataDir: f.directory, connect: false });
      try {
        const replay = object(await reopened.execute(command));
        assert.equal(object(replay.request).attempt, 'sdk-returned');
        assert.equal(object(replay.request).read, 'unknown');
        const chat = (await reopened.execute({
          command: 'chat',
          jid: pn,
        })) as ReturnType<Store['chatView']>;
        assert.equal(chat?.unread, true);
        assert.deepEqual(chat?.pending, {});
        assert.equal('sdkReported' in object(chat), false);
        assert.equal(f.calls(), 1);
      } finally {
        await reopened.close();
      }
    }
  }
});

test('rc14 buffered read then incoming establishes unread without proving request causality; a later explicit state replaces it', async () => {
  const f = fixture();
  try {
    await f.runtime.execute({
      command: 'mark-read',
      jid: pn,
      key: 'read',
      value: true,
    });
    f.ev.buffer();
    f.action(true);
    await f.incoming();
    f.ev.flush();
    assert.equal((await f.view()).unread, true);
    assert.deepEqual((await f.view()).pending, {});
    f.action(false); // An independent, contrary observation is still chat state.
    f.action(false);
    assert.equal((await f.view()).unread, true);
    assert.equal((await f.view()).unreadCount, -1);
    assert.deepEqual((await f.view()).pending, {});
    f.action(true);
    assert.equal((await f.view()).unread, false);
    assert.equal((await f.view()).unreadCount, 0);
    await f.incoming();
    assert.equal((await f.view()).unread, true);
    assert.equal((await f.view()).unreadCount, null);
  } finally {
    await f.close();
  }
});

test('rc14 buffered incoming then read also establishes unread until a separate explicit read arrives', async () => {
  const f = fixture();
  try {
    await f.runtime.execute({
      command: 'mark-read',
      jid: pn,
      key: 'read',
      value: true,
    });
    f.ev.buffer();
    await f.incoming();
    f.action(true);
    f.ev.flush();
    assert.equal((await f.view()).unread, true);
    assert.deepEqual((await f.view()).pending, {});
    f.action(true);
    assert.equal((await f.view()).unread, false);
    assert.equal((await f.view()).unreadCount, 0);
    assert.deepEqual((await f.view()).pending, {});
  } finally {
    await f.close();
  }
});

test('positive history supersedes pending and repeated incoming increments can reopen unread after an explicit read', async () => {
  const f = fixture();
  try {
    await f.runtime.execute({
      command: 'mark-read',
      jid: pn,
      key: 'read',
      value: true,
    });
    f.ev.emit('messaging-history.set', {
      chats: [{ id: pn, unreadCount: 12 }],
      contacts: [],
      messages: [],
    });
    assert.equal((await f.view()).unread, true);
    assert.equal((await f.view()).unreadCount, null);
    assert.deepEqual((await f.view()).pending, {});
    assert.equal('sdkReported' in (await f.view()), false);
    await f.incoming();
    f.action(true);
    assert.equal((await f.view()).unread, false);
    await f.incoming(); // The same key can produce another SDK increment; it is not phone confirmation.
    assert.equal((await f.view()).unread, true);
    assert.equal((await f.view()).unreadCount, null);
  } finally {
    await f.close();
  }
});
