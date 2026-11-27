import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { generateWAMessage, generateWAMessageFromContent } from 'baileys';
import type { BaileysEventMap, WASocket } from 'baileys';
import { createRuntime } from '../src/runtime.js';
import type { AckWait } from '../src/runtime.js';
import { parseCommand } from '../src/protocol.js';
import type { Command } from '../src/protocol.js';
import type { RecoveryClock } from '../src/health.js';
import { Store } from '../src/store.js';
import type { RequestRecord } from '../src/store.js';
import { publicResponse, uncertain } from './fixtures/responses.js';

process.umask(0o077);
const temporary = () => mkdtempSync(join(tmpdir(), 'wait-ack-'));
const runFile = promisify(execFile);
const group = '120363000000000001@g.us';
const me = '12025550199@s.whatsapp.net';
type Waited = RequestRecord & { wait: AckWait };

/** Deterministic injected clock: timers fire only when a test advances time. */
function manualClock() {
  let now = 1700000000000;
  const timers = new Set<{ at: number; callback: () => void }>();
  let notify: (() => void) | undefined;
  const clock: RecoveryClock = {
    now: () => now,
    schedule(callback, delay) {
      const timer = { at: now + delay, callback };
      timers.add(timer);
      notify?.();
      notify = undefined;
      return () => timers.delete(timer);
    },
  };
  return {
    clock,
    pending: () => timers.size,
    /** Resolves when the next timer is registered, i.e. a wait has begun. */
    scheduled: () =>
      new Promise<void>((resolve) => {
        notify = resolve;
      }),
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers])
        if (timer.at <= now) {
          timers.delete(timer);
          timer.callback();
        }
    },
  };
}

function fixture() {
  const directory = temporary();
  const seed = new Store(directory);
  seed.observeChat({ id: group });
  seed.close();
  const time = manualClock();
  const events = new EventEmitter();
  const sends: Parameters<WASocket['sendMessage']>[] = [];
  let sendError = false;
  let hold: Promise<void> | undefined;
  let onSend: (() => void) | undefined;
  const runtime = createRuntime(
    { dataDir: directory, connect: true },
    () =>
      ({
        ev: events,
        ws: { isClosed: true },
        end: async () => {
          events.emit('connection.update', { connection: 'close' });
        },
        sendMessage: async (...args: Parameters<WASocket['sendMessage']>) => {
          sends.push(args);
          onSend?.();
          onSend = undefined;
          if (hold) await hold;
          if (sendError) throw new Error('Fictional SDK failure');
          const [destination, content, config] = args;
          if ('document' in content)
            return generateWAMessageFromContent(
              destination,
              { documentMessage: { fileName: content.fileName ?? null } },
              { userJid: me, ...config },
            );
          return generateWAMessage(destination, content, {
            userJid: me,
            ...config,
            upload: async () => {
              throw new Error('No real uploads');
            },
          });
        },
      }) as unknown as WASocket,
    time.clock,
  );
  runtime.start();
  const emit = <K extends keyof BaileysEventMap>(
    name: K,
    value: BaileysEventMap[K],
  ) => {
    events.emit(name, value);
  };
  emit('connection.update', { connection: 'open' });
  const request = async (key = 'k') =>
    (await runtime.execute({ command: 'request', key })) as RequestRecord;
  return {
    runtime,
    directory,
    sends,
    emit,
    time,
    request,
    failSend() {
      sendError = true;
    },
    /** Holds the next SDK send until released; `started` resolves once it is invoked. */
    holdSend() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        onSend = resolve;
      });
      return { release, started };
    },
    receipt(id: string, status: number) {
      emit('messages.update', [
        { key: { remoteJid: group, id, fromMe: true }, update: { status } },
      ]);
    },
    close: () => runtime.close(),
  };
}

const text = (
  waitAckMs?: number,
  key = 'k',
): Extract<Command, { command: 'send' }> => ({
  command: 'send',
  key,
  jid: group,
  text: 'Fictional wait test',
  ...(waitAckMs === undefined ? {} : { waitAckMs }),
});

test('default send responds at SDK return without a wait field or timer', async () => {
  const f = fixture();
  try {
    const result = (await f.runtime.execute(text())) as RequestRecord;
    assert.equal(result.attempt, 'sdk-returned');
    assert.equal(result.acceptance, 'unknown');
    assert.equal('wait' in result, false);
    assert.deepEqual(result, await f.request());
    assert.equal(f.time.pending(), 0);
    assert.equal(f.sends.length, 1);
  } finally {
    await f.close();
  }
});

test('an ack observed within the window settles the same persisted message without resending', async () => {
  const file = join(temporary(), 'fictional.txt');
  writeFileSync(file, 'Fictional bytes');
  const inputs: Command[] = [
    text(5000),
    {
      command: 'send-file',
      key: 'k',
      jid: group,
      path: file,
      mime: 'text/plain',
      caption: 'Fictional file',
      waitAckMs: 5000,
    },
    {
      command: 'send-contact',
      key: 'k',
      jid: group,
      name: 'Fictional Card',
      phone: '+12025550103',
      waitAckMs: 5000,
    },
  ];
  for (const input of inputs) {
    const f = fixture();
    try {
      const waiting = f.time.scheduled();
      const sending = f.runtime.execute(input) as Promise<Waited>;
      await waiting;
      const pending = await f.request();
      assert.equal(pending.attempt, 'sdk-returned');
      assert.equal(pending.acceptance, 'unknown');
      f.time.advance(420);
      // Unrelated and pending-only receipts do not end the wait.
      f.receipt('FICTIONAL_OTHER_ID', 2);
      f.receipt(pending.messageId!, 1);
      f.receipt(pending.messageId!, 2);
      const result = await sending;
      assert.equal(result.acceptance, 'server-ack');
      assert.equal(result.delivery, 'unknown');
      assert.deepEqual(result.wait, {
        requestedMs: 5000,
        waitedMs: 420,
        outcome: 'accepted',
      });
      const { wait: _wait, ...projection } = result;
      assert.deepEqual(projection, await f.request());
      assert.equal(f.sends.length, 1, input.command);
      assert.equal(f.sends[0]?.[2]?.messageId, pending.messageId);
      assert.equal(f.time.pending(), 0, 'the timeout is cancelled');
    } finally {
      await f.close();
    }
  }
});

test('a timeout returns unknown acceptance unchanged; a later ack is only visible through request', async () => {
  const f = fixture();
  try {
    const waiting = f.time.scheduled();
    const sending = f.runtime.execute(text(800)) as Promise<Waited>;
    await waiting;
    const before = await f.request();
    f.time.advance(799);
    f.time.advance(1);
    const result = await sending;
    assert.deepEqual(result.wait, {
      requestedMs: 800,
      waitedMs: 800,
      outcome: 'timeout',
    });
    assert.equal(result.attempt, 'sdk-returned');
    assert.equal(result.acceptance, 'unknown');
    assert.equal(result.errorObserved, false);
    const { wait: _wait, ...projection } = result;
    assert.deepEqual(projection, before, 'a timeout changes no state');
    assert.deepEqual(projection, await f.request());
    f.receipt(result.messageId!, 3);
    const later = await f.request();
    assert.equal(later.acceptance, 'server-ack');
    assert.equal(later.delivery, 'delivered');
    assert.equal(f.sends.length, 1);
  } finally {
    await f.close();
  }
});

test('an observed error receipt or SDK failure ends the wait as error without retrying', async () => {
  const f = fixture();
  try {
    const waiting = f.time.scheduled();
    const sending = f.runtime.execute(text(5000)) as Promise<Waited>;
    await waiting;
    const pending = await f.request();
    f.receipt(pending.messageId!, 0);
    const result = await sending;
    assert.equal(result.wait.outcome, 'error');
    assert.equal(result.errorObserved, true);
    assert.equal(result.acceptance, 'unknown');
    assert.equal(f.time.pending(), 0);

    f.failSend();
    const failed = (await f.runtime.execute(text(5000, 'k2'))) as Waited;
    assert.equal(failed.attempt, 'uncertain');
    assert.equal(failed.errorObserved, true);
    assert.deepEqual(failed.wait, {
      requestedMs: 5000,
      waitedMs: 0,
      outcome: 'error',
    });
    assert.equal(f.sends.length, 2, 'each key is invoked exactly once');
  } finally {
    await f.close();
  }
});

test('a same-key wait settles as soon as the in-flight call records an SDK failure', async () => {
  const f = fixture();
  try {
    f.failSend();
    const held = f.holdSend();
    const first = f.runtime.execute(text()) as Promise<RequestRecord>;
    await held.started;
    const waiting = f.time.scheduled();
    const replay = f.runtime.execute(text(5000)) as Promise<Waited>;
    await waiting;
    held.release();
    assert.equal((await first).errorObserved, true);
    const result = await replay;
    assert.deepEqual(result.wait, {
      requestedMs: 5000,
      waitedMs: 0,
      outcome: 'error',
    });
    assert.equal(f.time.pending(), 0);
    assert.equal(f.sends.length, 1, 'the replay never invokes the SDK');
  } finally {
    await f.close();
  }
});

test('an idempotent replay waits for the existing message and never sends again', async () => {
  const f = fixture();
  try {
    const first = (await f.runtime.execute(text())) as RequestRecord;
    const waiting = f.time.scheduled();
    const replay = f.runtime.execute(text(3000)) as Promise<Waited>;
    await waiting;
    f.time.advance(150);
    f.receipt(first.messageId!, 2);
    const result = await replay;
    assert.equal(result.messageId, first.messageId);
    assert.equal(result.acceptance, 'server-ack');
    assert.deepEqual(result.wait, {
      requestedMs: 3000,
      waitedMs: 150,
      outcome: 'accepted',
    });
    // Already accepted: settles immediately from the persisted record.
    const again = (await f.runtime.execute(text(3000))) as Waited;
    assert.deepEqual(again.wait, {
      requestedMs: 3000,
      waitedMs: 0,
      outcome: 'accepted',
    });
    assert.equal(f.time.pending(), 0);
    assert.equal(f.sends.length, 1);
    // Changed content still conflicts; the wait option is not part of the intent.
    await assert.rejects(
      f.runtime.execute({ ...text(3000), text: 'Different' }),
      /Idempotency key already used/,
    );
  } finally {
    await f.close();
  }
});

test('a connection drop or shutdown during the wait returns promptly with what is known', async () => {
  const dropped = fixture();
  try {
    const waiting = dropped.time.scheduled();
    const sending = dropped.runtime.execute(text(30000)) as Promise<Waited>;
    await waiting;
    dropped.emit('connection.update', { connection: 'close' });
    const result = await sending;
    assert.equal(result.wait.outcome, 'interrupted');
    assert.equal(result.wait.waitedMs, 0);
    assert.equal(result.acceptance, 'unknown');
    // A replay while disconnected does not wait for a connection that cannot deliver acks.
    const replay = (await dropped.runtime.execute(text(30000))) as Waited;
    assert.equal(replay.wait.outcome, 'interrupted');
    assert.equal(dropped.sends.length, 1);
  } finally {
    await dropped.close();
  }

  const stopping = fixture();
  try {
    const waiting = stopping.time.scheduled();
    const sending = stopping.runtime.execute(text(30000)) as Promise<Waited>;
    await waiting;
    await stopping.runtime.stop();
    const result = await sending;
    assert.equal(result.wait.outcome, 'interrupted');
    assert.equal(result.attempt, 'sdk-returned');
    assert.equal(stopping.sends.length, 1);
  } finally {
    await stopping.close();
  }
});

test('waitAckMs is validated on the wire and zero forwards no wait', () => {
  const base = { command: 'send', key: 'k', jid: group, text: 'Example' };
  for (const waitAckMs of [-1, 30001, 1.5, '5000', null, Number.NaN])
    assert.throws(
      () => parseCommand({ ...base, waitAckMs }),
      /waitAckMs must be an integer from 0 to 30000/,
    );
  assert.equal('waitAckMs' in parseCommand({ ...base, waitAckMs: 0 }), false);
  assert.equal('waitAckMs' in parseCommand(base), false);
  assert.deepEqual(parseCommand({ ...base, waitAckMs: 30000 }), {
    ...base,
    waitAckMs: 30000,
  });
  assert.equal(
    (
      parseCommand({
        command: 'send-contact',
        key: 'k',
        jid: group,
        name: 'Fictional',
        phone: '+12025550103',
        waitAckMs: 1,
      }) as { waitAckMs?: number }
    ).waitAckMs,
    1,
  );
});

test('CLI forwards --wait-ack-ms only when positive and rejects invalid values before I/O', async (t) => {
  const directory = temporary();
  const commands: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const command = JSON.parse(buffer.trim()) as Record<string, unknown>;
      commands.push(command);
      socket.end(
        JSON.stringify({ ...publicResponse(uncertain), id: command.id }) + '\n',
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, 'control.sock'), resolve),
  );
  t.after(() => server.close());
  const cli = async (...args: string[]) => {
    try {
      const { stdout } = await runFile(
        process.execPath,
        ['dist/src/cli.js', '--data-dir', directory, ...args],
        { timeout: 15000 },
      );
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch (error) {
      if (error && typeof error === 'object' && 'stdout' in error)
        return JSON.parse(String(error.stdout)) as Record<string, unknown>;
      throw error;
    }
  };
  const send = ['send', '--jid', group, '--key', 'k', '--text', 'Example'];
  assert.equal((await cli(...send, '--wait-ack-ms', '5000')).ok, true);
  assert.equal(commands.at(-1)?.waitAckMs, 5000);
  assert.equal((await cli(...send, '--wait-ack-ms', '0')).ok, true);
  assert.equal('waitAckMs' in commands.at(-1)!, false);
  assert.equal((await cli(...send)).ok, true);
  assert.equal('waitAckMs' in commands.at(-1)!, false);
  const count = commands.length;
  for (const value of ['-1', '30001', '1.5', 'abc', '', '1e3', '0x10']) {
    const result = await cli(...send, `--wait-ack-ms=${value}`);
    assert.equal(result.ok, false, value);
    assert.equal(result.code, 'INVALID_ARGUMENT', value);
  }
  const card = await cli(
    'send-contact',
    '--jid',
    group,
    '--key',
    'card',
    '--name',
    'Fictional',
    '--phone',
    '+12025550103',
    '--wait-ack-ms',
    '1',
  );
  assert.equal(card.ok, true);
  assert.equal(commands.at(-1)?.waitAckMs, 1);
  assert.equal(
    (await cli('request', '--key', 'k', '--wait-ack-ms', '5')).ok,
    false,
    'only send-like commands accept the option',
  );
  assert.equal(commands.length, count + 1, 'invalid options never reach I/O');
  const help = (await cli('help')).data as {
    commands: Record<string, string>;
    waitAckOption: string;
  };
  for (const name of ['send', 'send-file', 'send-contact'])
    assert.match(help.commands[name]!, /--wait-ack-ms MS/);
  assert.match(help.waitAckOption, /request --key/);
});
