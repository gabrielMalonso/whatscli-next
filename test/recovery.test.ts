import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { proto } from 'baileys';
import type { BaileysEventMap, WAMessage, WASocket } from 'baileys';
import type { RecoveryClock } from '../src/health.js';
import { createRuntime } from '../src/runtime.js';
import { formatResponse } from '../src/response.js';
import { encode, Store } from '../src/store.js';
import type { RequestRecord } from '../src/store.js';

type SocketOptions = Parameters<NonNullable<Parameters<typeof createRuntime>[1]>>[0];

process.umask(0o077);
mkdirSync('.tmp', { recursive: true, mode: 0o700 });
const temporary = () => mkdtempSync(join(process.cwd(), '.tmp', 'recovery-'));
const pn = '12025550101@s.whatsapp.net';
const lid = '123450001@lid';
const me = '12025550199:1@s.whatsapp.net';

class Clock implements RecoveryClock {
  time = 1700000000000;
  tasks: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  now = () => this.time;
  schedule(callback: () => void, delay: number) {
    const task = { callback, delay, cancelled: false };
    this.tasks.push(task);
    return () => { task.cancelled = true; };
  }
  pending() { return this.tasks.filter(task => !task.cancelled); }
  tick() {
    assert.equal(this.pending().length, 1, 'exactly one retry timer');
    const task = this.pending()[0]!;
    this.time += task.delay;
    task.cancelled = true;
    task.callback();
  }
}

function fixture(directory = temporary(), factoryError?: unknown) {
  const clock = new Clock();
  const sockets: { events: EventEmitter; config: SocketOptions; active: boolean; ends: number }[] = [];
  let creations = 0;
  let endWait: Promise<void> | undefined;
  let endError = false;
  let sendWait: Promise<void> | undefined;
  let sends = 0;
  let pairing = 0;
  const runtime = createRuntime({ dataDir: directory, connect: true }, config => {
    creations++;
    assert.ok(!sockets.some(socket => socket.active), 'no overlapping live sockets');
    if (factoryError) throw factoryError;
    const events = new EventEmitter();
    const entry = { events, config, active: true, ends: 0 };
    sockets.push(entry);
    // The only assertion is at the deliberately partial, injected SDK boundary.
    return {
      ev: events,
      end: async () => {
        entry.ends++;
        await endWait;
        if (endError) throw new Error('PRIVATE_END_ERROR');
        entry.active = false;
        events.emit('connection.update', { connection: 'close' });
      },
      requestPairingCode: async () => { pairing++; return 'FICTIONAL_CODE'; },
      sendMessage: async (_jid: string, _body: unknown, options: { messageId: string }) => {
        sends++;
        const intent = await runtime.execute({ command: 'request', key: 'uncertain' }) as RequestRecord;
        assert.equal(intent.messageId, options.messageId);
        assert.equal(intent.attempt, 'uncertain');
        await sendWait;
        throw new Error('PRIVATE_SEND_ERROR');
      },
    } as unknown as WASocket;
  }, clock);
  const latest = () => sockets.at(-1)!;
  const emit = <K extends keyof BaileysEventMap>(name: K, value: BaileysEventMap[K]) => { latest().events.emit(name, value); };
  const drop = (code?: number) => {
    latest().active = false; // rc14 emits close after transport/socket-end cleanup.
    emit('connection.update', { connection: 'close', lastDisconnect: {
      error: Object.assign(new Error('PRIVATE_DISCONNECT_ERROR'), { output: { statusCode: code }, data: { secret: 'PRIVATE_ERROR_DATA' } }),
      date: new Date(clock.time),
    } });
  };
  const link = () => emit('creds.update', { registered: false, me: { id: me }, account: {
    details: Buffer.from('FICTIONAL_PRIVATE_IDENTITY'), deviceSignature: Buffer.from('FICTIONAL_PRIVATE_SIGNATURE'),
  } });
  return { runtime, clock, sockets, latest, emit, drop, link, directory,
    counts: () => ({ creations, sends, pairing }),
    waitEnd(value: Promise<void> | undefined) { endWait = value; },
    failEnd(value: boolean) { endError = value; },
    waitSend(value: Promise<void>) { sendWait = value; },
  };
}

const gate = () => {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

const incoming: WAMessage = { key: { id: 'INCOMING', remoteJid: pn, fromMe: false }, messageTimestamp: 1700000000,
  message: { conversation: 'Fictional incoming text', messageContextInfo: { messageSecret: Buffer.from('PRIVATE_MESSAGE_SECRET') } } };

test('runtime recovers after over an hour and 160 offline failures using the same linked session', async () => {
  const f = fixture();
  try {
    f.runtime.start(); f.link();
    const auth = f.latest().config.auth!;
    await auth.keys.set({ session: { fictional: Buffer.from('FICTIONAL_SIGNAL_KEY') } });
    const began = f.clock.time;
    for (let i = 0; i < 160; i++) {
      f.drop([408, 428, 503][i % 3]);
      const state = f.runtime.snapshot().recovery;
      assert.equal(state.state, 'waiting-retry');
      assert.equal(state.attempt, i + 1);
      const delay = Math.min(1000 * 2 ** Math.min(i, 5), 30000);
      assert.equal(state.nextRetryAt, f.clock.time + delay);
      assert.equal(f.clock.pending()[0]?.delay, delay);
      assert.deepEqual(await f.runtime.execute({ command: 'chats', limit: 10, offset: 0 }), []);
      f.clock.tick();
      assert.equal(f.runtime.snapshot().recovery.state, 'connecting');
      assert.equal(f.latest().config.auth?.creds, auth.creds);
    }
    assert.ok(f.clock.time - began > 3600000);
    f.emit('connection.update', { connection: 'open', receivedPendingNotifications: true });
    assert.deepEqual(f.runtime.snapshot().recovery, { state: 'open', reason: null, code: null, attempt: 0, nextRetryAt: null });
    assert.equal(f.runtime.snapshot().receiveContinuity.status, 'unproven');
    assert.equal(f.runtime.snapshot().coverage, 'partial');
    assert.equal(f.runtime.snapshot().appState, 'unknown');
    assert.deepEqual(await f.latest().config.auth!.keys.get('session', ['fictional']), { fictional: Buffer.from('FICTIONAL_SIGNAL_KEY') });
    assert.deepEqual(f.counts(), { creations: 161, sends: 0, pairing: 0 });
    assert.equal(f.clock.pending().length, 0);
  } finally { await f.runtime.close(); }
});

test('515 supports linked pairing restart and repeated restarts always wait, including brief opens', async () => {
  const f = fixture();
  try {
    f.runtime.start(); f.link();
    for (let i = 0; i < 20; i++) {
      f.drop(515);
      assert.equal(f.runtime.snapshot().recovery.reason, 'restart-required');
      assert.ok(f.clock.pending()[0]!.delay >= 1000);
      f.clock.tick();
      if (i >= 10) f.emit('connection.update', { connection: 'open' });
    }
    assert.deepEqual(f.counts(), { creations: 21, sends: 0, pairing: 0 });
    assert.equal((await f.runtime.execute({ command: 'status' }) as { hasLinkedCredentials: boolean }).hasLinkedCredentials, true);
  } finally { await f.runtime.close(); }
});

test('all rc14 terminal reasons and unknown errors stop retries with safe actionable current evidence', async () => {
  const cases = [[401, 'logged-out'], [403, 'forbidden'], [411, 'multidevice-mismatch'], [440, 'session-replaced'],
    [500, 'bad-session'], [499, 'unknown-disconnect'], [undefined, 'unknown-disconnect']] as const;
  for (const [code, reason] of cases) {
    const f = fixture();
    try {
      f.runtime.start(); f.emit('chats.upsert', [{ id: pn, archived: true }]); f.drop(code);
      const snapshot = f.runtime.snapshot();
      assert.deepEqual(snapshot.recovery, { state: 'intervention-required', reason, code: code ?? null, attempt: 0, nextRetryAt: null });
      assert.equal(f.clock.pending().length, 0);
      assert.equal((await f.runtime.execute({ command: 'chat', jid: pn }) as { archived: boolean }).archived, true);
      assert.ok(snapshot.issues.includes('connection-stopped-review-required'));
      const response = { ok: true, data: await f.runtime.execute({ command: 'status' }), ...snapshot };
      for (const mode of ['full', 'compact'] as const) {
        const publicResult = formatResponse('status', response, mode);
        assert.deepEqual(publicResult.recovery, snapshot.recovery);
        assert.deepEqual(publicResult.receiveContinuity, snapshot.receiveContinuity);
        assert.doesNotMatch(encode(publicResult), /PRIVATE_|lastDisconnect|output|secret|stack/);
      }
      await f.runtime.execute({ command: 'reconnect' });
      f.emit('connection.update', { connection: 'open' });
      assert.equal(f.runtime.snapshot().recovery.state, 'open');
      assert.ok(f.runtime.snapshot().issues.includes('connection-stopped-review-required'), 'history is distinct from current recovery');
    } finally { await f.runtime.close(); }
  }
});

test('duplicates and stale socket events cannot reschedule, persist credentials or reopen after stop', async () => {
  const f = fixture();
  f.runtime.start();
  const old = f.latest();
  f.drop(408);
  const snapshot = f.runtime.snapshot();
  for (const connection of ['close', 'open'] as const) old.events.emit('connection.update', { connection });
  old.events.emit('creds.update', { me: { id: 'STALE_ACCOUNT' } });
  old.events.emit('messages.upsert', { messages: [incoming], type: 'notify' });
  assert.deepEqual(f.runtime.snapshot(), snapshot);
  assert.throws(() => old.config.auth!.keys.set({ session: { stale: Buffer.from('stale') } }), /no longer owns/);
  f.clock.tick();
  old.events.emit('connection.update', { connection: 'close' });
  assert.equal(f.clock.pending().length, 0);
  assert.equal(f.counts().creations, 2);
  assert.deepEqual(await f.runtime.execute({ command: 'messages', jid: pn, limit: 10, offset: 0 }), []);
  await f.runtime.stop();
  for (const task of f.clock.tasks) task.callback(); // Simulate an already queued, cancelled callback.
  f.runtime.start();
  await assert.rejects(f.runtime.execute({ command: 'reconnect' }), /stopping/);
  assert.equal(f.counts().creations, 2);
  assert.equal(f.runtime.snapshot().recovery.state, 'stopping');
  await Promise.all([f.runtime.close(), f.runtime.close()]);
});

test('manual reconnect cancels a pending timer and concurrent reconnects share one replacement', async () => {
  const f = fixture();
  try {
    f.runtime.start(); f.drop(428);
    const cancelled = f.clock.pending()[0]!;
    await Promise.all([f.runtime.execute({ command: 'reconnect' }), f.runtime.execute({ command: 'reconnect' })]);
    cancelled.callback();
    assert.equal(f.counts().creations, 2);
    assert.equal(f.clock.pending().length, 0);
    const previous = f.latest();
    const wait = gate(); f.waitEnd(wait.promise);
    const first = f.runtime.execute({ command: 'reconnect' });
    const second = f.runtime.execute({ command: 'reconnect' });
    assert.equal(previous.ends, 1);
    assert.equal(f.counts().creations, 2);
    previous.events.emit('connection.update', { connection: 'close' });
    assert.equal(f.clock.pending().length, 0);
    wait.release();
    await Promise.all([first, second]);
    assert.equal(f.counts().creations, 3);
  } finally { await f.runtime.close(); }
});

test('stop during an awaited reconnect prevents replacement and preserves exclusive database ownership', async () => {
  const f = fixture();
  f.runtime.start(); f.emit('connection.update', { connection: 'open' });
  const wait = gate(); f.waitEnd(wait.promise);
  const reconnect = f.runtime.execute({ command: 'reconnect' });
  const stop = f.runtime.stop();
  assert.equal(f.runtime.snapshot().recovery.state, 'stopping');
  assert.throws(() => new Store(f.directory), /locked/);
  wait.release();
  await Promise.all([reconnect, stop, f.runtime.close()]);
  assert.equal(f.counts().creations, 1);
  const reopened = new Store(f.directory);
  reopened.close();
});

test('stop while connecting or waiting cancels recovery and ignores every late event', async () => {
  for (const waiting of [false, true]) {
    const f = fixture();
    f.runtime.start();
    if (waiting) f.drop(503);
    await f.runtime.stop();
    const stopped = f.runtime.snapshot();
    f.emit('connection.update', { connection: 'open', receivedPendingNotifications: true });
    f.emit('connection.update', { connection: 'close' });
    for (const task of f.clock.tasks) task.callback();
    assert.deepEqual(f.runtime.snapshot(), stopped);
    assert.equal(f.counts().creations, 1);
    await f.runtime.close();
  }
});

test('synchronous factory errors require intervention, including failures on an automatic retry', async () => {
  for (const code of [undefined, 401, 408, 500]) {
    const f = fixture(undefined, Object.assign(new Error('PRIVATE_FACTORY_ERROR'), { output: { statusCode: code } }));
    try {
      f.runtime.start(); f.runtime.start();
      assert.equal(f.runtime.snapshot().recovery.reason, 'socket-creation-failed');
      assert.equal(f.runtime.snapshot().recovery.state, 'intervention-required');
      assert.equal(f.clock.pending().length, 0);
      assert.deepEqual(await f.runtime.execute({ command: 'chats', limit: 10, offset: 0 }), []);
      await assert.rejects(f.runtime.execute({ command: 'reconnect' }), /investigate and restart/);
      assert.equal(f.counts().creations, 1);
    } finally { await f.runtime.close(); }
  }
  const clock = new Clock();
  const events = new EventEmitter();
  let calls = 0;
  const runtime = createRuntime({ dataDir: temporary(), connect: true }, () => {
    if (++calls > 1) throw new Error('PRIVATE_FACTORY_ERROR');
    return { ev: events, end: async () => {} } as unknown as WASocket;
  }, clock);
  try {
    runtime.start(); events.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    clock.tick();
    assert.equal(runtime.snapshot().recovery.reason, 'socket-creation-failed');
    assert.equal(runtime.snapshot().recovery.attempt, 1);
    assert.equal(clock.pending().length, 0);
  } finally { await runtime.close(); }
});

test('failed socket cleanup never authorizes an overlapping replacement', async () => {
  const f = fixture();
  try {
    f.runtime.start(); f.failEnd(true);
    await assert.rejects(f.runtime.execute({ command: 'reconnect' }), /cleanup failed/);
    assert.equal(f.runtime.snapshot().recovery.reason, 'socket-end-failed');
    await assert.rejects(f.runtime.execute({ command: 'reconnect' }), /investigate and restart/);
    assert.equal(f.counts().creations, 1);
    f.failEnd(false);
  } finally { await f.runtime.close(); }
  assert.equal(f.latest().active, false);
});

test('same-directory restart retains linked credentials, local observations and unproven receive continuity', async () => {
  const f = fixture();
  f.runtime.start(); f.link();
  f.emit('messages.upsert', { messages: [incoming], type: 'notify' });
  f.drop(503);
  const outage = f.runtime.snapshot().receiveContinuity;
  assert.equal(outage.lastInterruption?.reason, 'connection-closed');
  await f.runtime.close();
  const offline = createRuntime({ dataDir: f.directory, connect: false }, () => assert.fail('offline must never create a socket'));
  offline.start();
  const persisted = offline.snapshot().receiveContinuity;
  assert.equal(persisted.lastInterruption?.reason, 'runtime-stop');
  assert.equal(persisted.status, 'unproven');
  assert.equal(offline.snapshot().recovery.state, 'offline');
  assert.equal((await offline.execute({ command: 'messages', jid: pn, limit: 10, offset: 0 }) as unknown[]).length, 1);
  await assert.rejects(offline.execute({ command: 'reconnect' }), /Network access is disabled/);
  await offline.close();
  const restored = fixture(f.directory);
  try {
    assert.deepEqual(restored.runtime.snapshot().receiveContinuity, persisted);
    restored.runtime.start();
    assert.equal(restored.latest().config.auth!.creds.me?.id, me);
    assert.equal(restored.latest().config.auth!.creds.registered, false);
    assert.deepEqual(restored.latest().config.auth!.creds.account?.details, Buffer.from('FICTIONAL_PRIVATE_IDENTITY'));
    restored.emit('connection.update', { connection: 'open', receivedPendingNotifications: true });
    assert.equal(restored.runtime.snapshot().receiveContinuity.status, 'unproven');
    assert.equal(restored.runtime.snapshot().receiveContinuity.lastInterruption?.reason, 'runtime-start');
    assert.equal(statSync(join(f.directory, 'probe.sqlite')).mode & 0o777, 0o600);
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
    assert.equal(restored.counts().pairing, 0);
  } finally { await restored.runtime.close(); }
});

test('crash leaves a durable receive-risk observation available even on an offline restart', async () => {
  const directory = temporary();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { EventEmitter } from 'node:events';
    import { createRuntime } from './dist/src/runtime.js';
    const runtime = createRuntime({dataDir:process.argv[1],connect:true}, () => ({ev:new EventEmitter(),end:async()=>{}}));
    runtime.start(); process.exit(23);
  `, directory], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  const offline = createRuntime({ dataDir: directory, connect: false });
  try {
    assert.equal(offline.snapshot().receiveContinuity.lastInterruption?.reason, 'runtime-start');
    assert.equal(offline.snapshot().receiveContinuity.status, 'unproven');
  } finally { await offline.close(); }
});

test('uncertain concurrent intents survive outage/restart with exact late receipts and no resend', async () => {
  const f = fixture();
  f.runtime.start(); f.link();
  f.emit('connection.update', { connection: 'open' });
  f.emit('chats.upsert', [{ id: pn }]);
  f.emit('messages.upsert', { messages: [incoming], type: 'notify' });
  const wait = gate(); f.waitSend(wait.promise);
  const command = { command: 'send' as const, jid: pn, key: 'uncertain', text: 'Fictional outgoing text' };
  const sending = f.runtime.execute(command);
  const duplicate = await f.runtime.execute(command) as RequestRecord;
  assert.equal(duplicate.attempt, 'uncertain');
  f.drop(408);
  assert.deepEqual(await f.runtime.execute(command), duplicate);
  await assert.rejects(f.runtime.execute({ ...command, key: 'new-offline-key' }), /not open/);
  assert.equal(await f.runtime.execute({ command: 'request', key: 'new-offline-key' }), null);
  f.clock.tick(); f.emit('connection.update', { connection: 'open' });
  wait.release();
  const result = await sending as RequestRecord;
  assert.equal(result.attempt, 'uncertain');
  assert.equal(result.errorObserved, true);
  assert.equal(f.counts().sends, 1);
  assert.equal(f.latest().config.enableRecentMessageCache, false);
  const getMessage = f.latest().config.getMessage;
  assert.ok(getMessage);
  assert.equal(await getMessage({ remoteJid: pn, id: result.messageId!, fromMe: true }), undefined);
  f.emit('messages.delete', { keys: [incoming.key] });
  f.emit('messages.upsert', { messages: [incoming, { ...incoming, key: { ...incoming.key, remoteJid: lid } }], type: 'notify' });
  await f.runtime.close();
  const restored = fixture(f.directory);
  try {
    restored.runtime.start();
    assert.deepEqual(await restored.runtime.execute(command), result, 'retry original key even while connecting');
    restored.emit('connection.update', { connection: 'open' });
    const key = { id: result.messageId!, remoteJid: pn, fromMe: true };
    for (const wrong of [{ ...key, remoteJid: lid }, { ...key, fromMe: false }]) {
      restored.emit('messages.update', [{ key: wrong, update: { status: proto.WebMessageInfo.Status.READ } }]);
    }
    assert.equal((await restored.runtime.execute({ command: 'request', key: command.key }) as RequestRecord).read, 'unknown');
    for (const status of [proto.WebMessageInfo.Status.READ, proto.WebMessageInfo.Status.SERVER_ACK, proto.WebMessageInfo.Status.ERROR]) {
      restored.emit('messages.update', [{ key, update: { status } }]);
    }
    const receipt = await restored.runtime.execute(command) as RequestRecord;
    assert.equal(receipt.read, 'read'); assert.equal(receipt.delivery, 'delivered'); assert.equal(receipt.acceptance, 'server-ack');
    assert.equal(receipt.attempt, 'uncertain'); assert.equal(receipt.messageId, result.messageId);
    restored.emit('messages.upsert', { messages: [incoming, incoming], type: 'notify' });
    const messages = await restored.runtime.execute({ command: 'messages', jid: pn, limit: 10, offset: 0 }) as { id: string; text: string | null }[];
    const original = messages.filter(message => message.id === incoming.key.id);
    assert.equal(original.length, 1); assert.equal(original[0]!.text, null);
    const aliases = await restored.runtime.execute({ command: 'messages', jid: lid, limit: 10, offset: 0 }) as { text: string }[];
    assert.equal(aliases[0]?.text, 'Fictional incoming text');
    assert.equal(restored.counts().sends, 0);
    const events = await restored.runtime.execute({ command: 'events', after: 0 });
    assert.doesNotMatch(encode({ events, messages, status: restored.runtime.snapshot() }), /PRIVATE_|deviceSignature|messageSecret|lastDisconnect/);
  } finally { await restored.runtime.close(); }
});

test('credential/key persistence failures fail closed rather than entering transient recovery', () => {
  for (const boundary of ['factory-key', 'credential-event']) {
    const directory = temporary();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { EventEmitter } from 'node:events';
      import { createRuntime } from './dist/src/runtime.js';
      import { Store } from './dist/src/store.js';
      const events = new EventEmitter();
      const runtime = createRuntime({dataDir:process.argv[1],connect:true}, config => {
        if (process.argv[2] === 'factory-key') config.auth.keys.set({session:{fictional:Buffer.from('key')}});
        return {ev:events,end:async()=>{}};
      });
      Store.prototype.set = () => { throw new Error('PRIVATE_PERSISTENCE_ERROR'); };
      // Startup observation also persists. Permit only that write to reach the intended boundary.
      const fail = Store.prototype.set;
      Store.prototype.set = function(category) { if(category !== 'runtime') return fail(); };
      runtime.start();
      events.emit('creds.update', {registered:true});
      process.exit(42);
    `, directory, boundary], { encoding: 'utf8' });
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /Fatal persistence failure/);
    assert.doesNotMatch(child.stderr, /PRIVATE_/);
  }
});
