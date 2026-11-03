import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initAuthCreds, makeEventBuffer, processSyncAction } from 'baileys';
import type { AuthenticationCreds, WAMessage, WASocket } from 'baileys';
import processMessage from 'baileys/lib/Utils/process-message.js';
import { pino } from 'pino';
import { createRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';

process.umask(0o077);
const jid = '12025550101@s.whatsapp.net';
const lid = '900000000000101@lid';
const logger = pino({ level: 'silent' });

for (const remoteJid of [jid, lid]) {
  for (const type of ['notify', 'append'] as const) {
    for (const existing of [false, true]) {
      for (const unarchiveChats of [true, false]) {
        test(`incoming ${type} respects unarchiveChats=${unarchiveChats} for ${existing ? 'an archived' : 'a new'} ${remoteJid.endsWith('@lid') ? 'LID' : 'PN'} chat`, async () => {
          const directory = mkdtempSync(join(tmpdir(), 'receive-archive-'));
          const seed = new Store(directory);
          const initial = initAuthCreds();
          initial.me = {
            id: '12025550199:1@s.whatsapp.net',
            name: 'Fictional owner',
          };
          initial.accountSettings.unarchiveChats = !unarchiveChats;
          seed.set('auth', 'creds', initial);
          if (existing)
            seed.observeChat({ id: remoteJid, archived: true, unreadCount: 0 });
          seed.close();
          const ev = makeEventBuffer(logger);
          let creds: AuthenticationCreds | undefined;
          const runtime = createRuntime(
            { dataDir: directory, connect: true },
            (config) => {
              creds = config.auth!.creds;
              ev.on('creds.update', (update) => Object.assign(creds!, update));
              return {
                ev,
                ws: { isClosed: true },
                end: () =>
                  ev.emit('connection.update', { connection: 'close' }),
              } as unknown as WASocket;
            },
          );
          try {
            runtime.start();
            ev.emit('connection.update', { connection: 'open' });
            assert.equal(
              creds?.accountSettings.unarchiveChats,
              !unarchiveChats,
            );
            // Use the SDK's real preference-sync path, in both directions.
            processSyncAction(
              {
                index: ['setting_unarchiveChats'],
                syncAction: {
                  value: { unarchiveChatsSetting: { unarchiveChats } },
                },
              },
              ev,
              initial.me,
              undefined,
              logger,
            );
            const message: WAMessage = {
              key: { remoteJid, id: 'fictional-incoming', fromMe: false },
              messageTimestamp: 1700000100,
              message: { conversation: 'Fictional first contact' },
            };
            ev.buffer();
            ev.emit('messages.upsert', { type, messages: [message] });
            await processMessage(message, {
              ev,
              creds,
              logger,
              shouldProcessHistoryMsg: false,
            } as unknown as Parameters<typeof processMessage>[1]);
            ev.flush();
            const chat = (await runtime.execute({
              command: 'chat',
              jid: remoteJid,
            })) as ReturnType<Store['chatView']>;
            assert.ok(chat);
            assert.equal(chat.unread, true);
            assert.equal(
              chat.archived,
              unarchiveChats ? false : existing ? true : null,
            );
            const queue = (await runtime.execute({
              command: 'chats',
              unread: true,
              archived: false,
              observedOnly: true,
              limit: 100,
              offset: 0,
            })) as ReturnType<Store['chats']>;
            assert.deepEqual(
              queue.map((entry) => entry.jid),
              unarchiveChats ? [remoteJid] : [],
            );
            const unread = (await runtime.execute({
              command: 'chats',
              unread: true,
              observedOnly: true,
              limit: 100,
              offset: 0,
            })) as ReturnType<Store['chats']>;
            assert.deepEqual(
              unread.map((entry) => entry.jid),
              [remoteJid],
            );
            // An archive received after the message still wins; missing fields
            // and historical snapshots must not reopen it.
            ev.emit('chats.update', [{ id: remoteJid, archived: true }]);
            ev.emit('chats.update', [
              { id: remoteJid, name: 'Fictional name' },
            ]);
            ev.emit('messaging-history.set', {
              chats: [],
              contacts: [],
              messages: [message],
              isLatest: false,
            });
            const archived = (await runtime.execute({
              command: 'chat',
              jid: remoteJid,
            })) as ReturnType<Store['chatView']>;
            assert.equal(archived?.archived, true);
          } finally {
            await runtime.close();
            ev.destroy();
          }
          const reopened = new Store(directory);
          try {
            // The synced preference and later explicit archive survive restart.
            assert.equal(
              reopened.get<AuthenticationCreds>('auth', 'creds')
                ?.accountSettings.unarchiveChats,
              unarchiveChats,
            );
            assert.equal(reopened.chatView(remoteJid)?.archived, true);
          } finally {
            reopened.close();
          }
        });
      }
    }
  }
}
