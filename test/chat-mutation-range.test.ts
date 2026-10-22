import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  chatModificationToAppPatch,
  getChatAppStateAction,
  makeEventBuffer,
  processSyncAction,
  proto,
} from 'baileys';
import type { ChatAppStateAction, WASocket } from 'baileys';
import { pino } from 'pino';
import { createRuntime } from '../src/runtime.js';
import { object } from '../src/protocol.js';
import { Store } from '../src/store.js';

const jid = '12025550101@s.whatsapp.net';
const timestamp = 1700000100;
const logger = pino({ level: 'silent' });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mutation-range-'));
  const seed = new Store(directory);
  seed.observeChat({ id: jid, unreadCount: 0, archived: true });
  for (const [id, time] of [
    ['older', timestamp - 1],
    ['first', timestamp],
    ['second', timestamp],
  ] as const)
    seed.observeMessage({
      key: { remoteJid: jid, id, fromMe: false },
      messageTimestamp: time,
      message: { conversation: 'Fictional fixture' },
    });
  // Read updates arrive in reverse order; replacing rows changes the rowid tie break.
  for (const id of ['second', 'first'])
    seed.updateMessage({
      key: { remoteJid: jid, id, fromMe: false },
      update: { status: proto.WebMessageInfo.Status.READ },
    });
  seed.close();
  const ev = makeEventBuffer(logger);
  const actions: ChatAppStateAction[] = [];
  const runtime = createRuntime(
    { dataDir: directory, connect: true },
    () =>
      ({
        ev,
        ws: { isClosed: true },
        chatModify: async (
          ...[mod, target, options]: Parameters<WASocket['chatModify']>
        ) => {
          assert.equal(target, jid);
          const patch = chatModificationToAppPatch(mod, target);
          const value = proto.SyncActionValue.decode(
            proto.SyncActionValue.encode(patch.syncAction).finish(),
          );
          const mutation = { index: patch.index, syncAction: { value } };
          const action = getChatAppStateAction(mutation, {
            source: 'local-echo',
            collection: 'regular_low',
            version: 1,
            requestId: options!.requestId!,
          });
          assert.ok(action);
          actions.push(action);
          ev.emit('app-state.update', {
            kind: 'patch-response',
            collection: 'regular_low',
            version: 1,
            serverVersion: 1,
            status: 'version-matched',
            requestId: options!.requestId!,
          });
          ev.emit('app-state.update', action);
          processSyncAction(
            mutation,
            ev,
            { id: '12025550199@s.whatsapp.net' },
            undefined,
            logger,
          );
        },
        end: () => ev.emit('connection.update', { connection: 'close' }),
      }) as unknown as WASocket,
  );
  runtime.start();
  ev.emit('connection.update', { connection: 'open' });
  return {
    runtime,
    ev,
    actions,
    close: async () => {
      await runtime.close();
      ev.destroy();
    },
  };
}

for (const [command, value] of [
  ['archive', true],
  ['archive', false],
  ['mark-read', true],
  ['mark-read', false],
] as const) {
  test(`${command}=${value} includes every exact message at the timestamp boundary after reversed read updates`, async () => {
    const f = fixture();
    try {
      const result = object(
        await f.runtime.execute({
          command,
          value,
          jid,
          key: 'fictional-command',
        }),
      );
      assert.deepEqual(
        f.actions[0]!.messageRange?.messages?.map(({ id }) => id).sort(),
        ['first', 'second'],
      );
      assert.equal(f.actions[0]!.messageRange?.lastMessageTimestamp, timestamp);
      assert.ok(
        f.actions[0]!.messageRange?.messages?.every(
          (entry) => entry.timestamp === timestamp,
        ),
      );
      assert.equal(object(result.feedback).serverResponse, 'version-matched');
      assert.equal(object(result.feedback).stateObservation, 'pending');
      const events = (await f.runtime.execute({
        command: 'events',
        after: 0,
      })) as unknown[];
      const journal = events
        .map(object)
        .filter((event) => event.kind === 'app-state.chat-action');
      assert.equal(journal.length, 1);
      assert.deepEqual(journal[0]!.data, f.actions[0]);
    } finally {
      await f.close();
    }
  });
}

test('the public chat-action projection preserves source and range while excluding extra SDK payloads', async () => {
  const f = fixture();
  try {
    for (const representation of ['patch', 'snapshot'] as const)
      f.ev.emit('app-state.update', {
        kind: 'chat-action',
        source: 'sync',
        representation,
        collection: 'regular_low',
        version: 2,
        initialSync: representation === 'snapshot',
        macVerified: true,
        jid,
        action: {
          kind: 'mark-read',
          read: false,
          ...{ privateValue: 'SDK_PRIVATE_FIXTURE' },
        },
        timestamp: 1700000200000,
        messageRange: {
          lastMessageTimestamp: timestamp,
          lastSystemMessageTimestamp: timestamp - 1,
          messages: [
            {
              id: 'second',
              fromMe: false,
              timestamp,
              ...{ privateValue: 'SDK_PRIVATE_FIXTURE' },
            },
          ],
          ...{ privateValue: 'SDK_PRIVATE_FIXTURE' },
        },
        ...{
          privateValue: 'SDK_PRIVATE_FIXTURE',
          requestId: 'must-not-infer-sync-correlation',
        },
      });
    const events = (await f.runtime.execute({
      command: 'events',
      after: 0,
    })) as unknown[];
    const actions = events
      .map(object)
      .filter((event) => event.kind === 'app-state.chat-action')
      .map((event) => object(event.data));
    assert.equal(actions.length, 2);
    assert.equal(actions[0]!.source, 'sync');
    assert.equal(actions[0]!.representation, 'patch');
    assert.equal(actions[1]!.initialSync, true);
    assert.equal(actions[0]!.timestamp, 1700000200000);
    assert.equal(
      object(actions[0]!.messageRange).lastMessageTimestamp,
      timestamp,
    );
    assert.doesNotMatch(
      JSON.stringify(events),
      /SDK_PRIVATE_FIXTURE|must-not-infer-sync-correlation/,
    );
    assert.equal(
      object(await f.runtime.execute({ command: 'chat', jid })).unread,
      false,
    );
  } finally {
    await f.close();
  }
});
