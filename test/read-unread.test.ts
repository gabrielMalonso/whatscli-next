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
          chatModificationToAppPatch(mod, jid);
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
    incoming: () =>
      processMessage(
        {
          ...last,
          key: { ...last.key, id: 'fictional-new' },
          messageTimestamp: 1700000001,
          message: { conversation: 'Fictional incoming text' },
        },
        {
          ev,
          creds: { ...initAuthCreds(), me },
          logger,
          shouldProcessHistoryMsg: false,
        } as unknown as Parameters<typeof processMessage>[1],
      ), // Only the partial SDK context is erased; this text path needs no I/O.
    close: async () => {
      await runtime.close();
      ev.destroy();
    },
  };
}

test('rc14 incoming increments and positive history counters cannot discharge a read/unread intent, including restart and replay', async () => {
  for (const value of [true, false]) {
    const f = fixture();
    const command = {
      command: 'mark-read',
      jid: pn,
      key: `fictional-${value}`,
      value,
    } as const;
    try {
      await f.runtime.execute(command);
      await f.incoming();
      await f.incoming(); // Duplicate increments cannot manufacture confirmation.
      f.ev.emit('messaging-history.set', {
        chats: [{ id: pn, unreadCount: 12 }],
        contacts: [],
        messages: [],
      });
      f.ev.emit('chats.update', [{ id: pn, markedAsUnread: false }]);
      const chat = await f.view();
      assert.equal(chat.unread, null);
      assert.equal(chat.unreadCount, null);
      assert.deepEqual(chat.pending.unread, {
        key: command.key,
        value: !value,
      });
    } finally {
      await f.close();
    }
    const reopened = createRuntime({ dataDir: f.directory, connect: false });
    try {
      await reopened.execute(command);
      const chat = (await reopened.execute({
        command: 'chat',
        jid: pn,
      })) as ReturnType<Store['chatView']>;
      assert.equal(chat?.unread, null);
      assert.equal(chat?.pending.unread?.key, command.key);
      assert.equal(f.calls(), 1);
    } finally {
      await reopened.close();
    }
  }
});

test('rc14 buffered read then incoming yields an increment and retains pending; a later explicit state replaces it without proving request causality', async () => {
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
    assert.equal((await f.view()).unread, null);
    assert.equal((await f.view()).pending.unread?.key, 'read');
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

test('rc14 buffered incoming then read also retains a positive aggregate until a separate explicit state arrives', async () => {
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
    assert.equal((await f.view()).unread, null);
    assert.equal((await f.view()).pending.unread?.key, 'read');
    f.action(true);
    assert.equal((await f.view()).unread, false);
    assert.equal((await f.view()).unreadCount, 0);
    assert.deepEqual((await f.view()).pending, {});
  } finally {
    await f.close();
  }
});
