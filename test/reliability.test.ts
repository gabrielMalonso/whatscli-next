import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { proto } from 'baileys';
import { perform } from '../src/operations.js';
import { Store } from '../src/store.js';
import type { RequestRecord } from '../src/store.js';

process.umask(0o077);
mkdirSync('.tmp', { recursive: true, mode: 0o700 });
const temporary = () => mkdtempSync(join(process.cwd(), '.tmp', 'reliability-'));
const pn = '12025550101@s.whatsapp.net';
const lid = '123450001@lid';
const operation = { kind: 'send' as const, jid: lid, text: 'Fictional durable intent' };

for (const boundary of ['message_text', 'operation-sdk-returned'] as const) {
  test(`local ${boundary} failure rolls back send completion without erasing independent evidence or resending`, async () => {
    const directory = temporary();
    let store = new Store(directory);
    let calls = 0;
    let release = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    let before: RequestRecord | undefined;
    try {
      store.db.exec(boundary === 'message_text'
        ? "CREATE TRIGGER fail_completion BEFORE INSERT ON message_text BEGIN SELECT RAISE(ABORT,'fictional local failure'); END"
        : "CREATE TRIGGER fail_completion BEFORE INSERT ON events WHEN NEW.kind='operation-sdk-returned' BEGIN SELECT RAISE(ABORT,'fictional local failure'); END");
      const sending = perform(store, 'send-key', operation, () => {}, async id => {
        calls++;
        // A separately committed receipt must survive failure of the later SDK return.
        store.receipt({ remoteJid: lid, id, fromMe: true }, proto.WebMessageInfo.Status.DELIVERY_ACK);
        before = store.request('send-key');
        await pending;
        return { key: { remoteJid: lid, id, fromMe: true }, message: { conversation: operation.text } };
      });
      assert.ok(before?.messageId);
      const duplicate = await perform(store, 'send-key', operation, () => assert.fail('No second validation'), async () => assert.fail('No second send'));
      assert.deepEqual(duplicate, before);
      const rejected = assert.rejects(sending, /fictional local failure/);
      release();
      await rejected;
      assert.deepEqual(store.request('send-key'), before);
      assert.deepEqual(store.messages(lid), []);
      assert.deepEqual(store.search('durable intent', 100, 0), []);
      assert.deepEqual(store.events(0).map(event => (event as { kind: string }).kind), ['operation-attempt']);
      store.close();
      store = new Store(directory);
      assert.deepEqual(await perform(store, 'send-key', operation, () => assert.fail('Offline replay'), async () => { calls++; }), before);
      await assert.rejects(perform(store, 'send-key', { ...operation, text: 'Different intent' }, () => {}, async () => { calls++; }), /different arguments/);
      assert.equal(calls, 1);
      assert.deepEqual(store.messages(lid), []);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM message_text').get()?.n, 0);
    } finally { release(); store.close(); }
  });
}

test('failed uncertainty journal rolls back the outcome while retaining pending chat state and immutable intent', async () => {
  const directory = temporary();
  let store = new Store(directory);
  const archive = { kind: 'archive' as const, jid: pn, value: true };
  let before: RequestRecord | undefined;
  let calls = 0;
  try {
    store.observeChat({ id: pn, archived: false, unreadCount: 0 });
    store.db.exec("CREATE TRIGGER fail_uncertainty BEFORE INSERT ON events WHEN NEW.kind='operation-uncertain' BEGIN SELECT RAISE(ABORT,'fictional local failure'); END");
    await assert.rejects(perform(store, 'archive-key', archive, () => {}, async () => {
      calls++;
      before = store.request('archive-key');
      throw new Error('Fictional SDK timeout');
    }), /fictional local failure/);
    assert.ok(before);
    assert.deepEqual(store.request('archive-key'), before);
    const chat = store.chatView(pn);
    assert.equal(chat?.archived, null);
    assert.deepEqual(chat?.pending, { archived: { key: 'archive-key', value: true } });
    assert.equal(chat?.unread, false);
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.chatView(pn), chat);
    assert.deepEqual(await perform(store, 'archive-key', archive, () => assert.fail('Offline replay'), async () => { calls++; }), before);
    assert.equal(calls, 1);
    assert.deepEqual(store.events(0).map(event => (event as { kind: string }).kind), ['operation-attempt']);
  } finally { store.close(); }
});

for (const boundary of ['second-chat', 'journal'] as const) {
  test(`failed chats.delete at ${boundary} leaves the whole observation unchanged after fail-closed restart`, () => {
    const directory = temporary();
    const seed = new Store(directory);
    for (const jid of [pn, lid]) {
      seed.observeChat({ id: jid, archived: false, unreadCount: 0 });
      seed.observeMessage({ key: { remoteJid: jid, id: 'retained', fromMe: false }, messageTimestamp: 100,
        message: { conversation: 'Fictional retained history' } });
    }
    const before = seed.chats();
    const messages = [seed.messages(pn), seed.messages(lid)];
    seed.db.exec(boundary === 'second-chat'
      ? `CREATE TRIGGER fail_delete BEFORE DELETE ON chats WHEN OLD.jid='${lid}' BEGIN SELECT RAISE(ABORT,'FICTIONAL_PRIVATE_FAILURE'); END`
      : "CREATE TRIGGER fail_delete BEFORE INSERT ON events WHEN NEW.kind='chats.delete' BEGIN SELECT RAISE(ABORT,'FICTIONAL_PRIVATE_FAILURE'); END");
    seed.close();
    const emitDeletes = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { EventEmitter } from 'node:events';
      import { createRuntime } from './dist/src/runtime.js';
      const events = new EventEmitter();
      const runtime = createRuntime({dataDir:process.argv[1],connect:true}, () => ({
        ev:events,ws:{isClosed:true},end:async()=>{events.emit('connection.update',{connection:'close'})}
      }));
      runtime.start();
      events.emit('chats.delete', ['${pn}', '${lid}']);
      events.emit('chats.delete', ['${pn}', '${lid}']);
      await runtime.close();
    `, directory], { encoding: 'utf8', timeout: 5000 });
    const child = emitDeletes();
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /Fatal persistence failure/);
    assert.doesNotMatch(child.stderr, /FICTIONAL_PRIVATE_FAILURE/);
    const reopened = new Store(directory);
    try {
      assert.deepEqual(reopened.chats(), before);
      assert.deepEqual([reopened.messages(pn), reopened.messages(lid)], messages);
      assert.equal(reopened.events(0).some(event => (event as { kind: string }).kind === 'chats.delete'), false);
      reopened.db.exec('DROP TRIGGER fail_delete');
    } finally { reopened.close(); }
    const replay = emitDeletes();
    assert.equal(replay.status, 0, replay.stderr);
    const completed = new Store(directory);
    try {
      assert.deepEqual(completed.chats(), []);
      assert.deepEqual([completed.messages(pn), completed.messages(lid)], messages);
      assert.equal(completed.events(0).filter(event => (event as { kind: string }).kind === 'chats.delete').length, 2);
    } finally { completed.close(); }
  });
}
