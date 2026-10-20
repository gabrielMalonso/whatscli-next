import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { generateWAMessage, proto } from 'baileys';
import type { BaileysEventMap, WAMessage, WASocket } from 'baileys';
import { sqliteAuth } from '../src/auth.js';
import { CommandError, errorResponse } from '../src/errors.js';
import { perform } from '../src/operations.js';
import { messageOutput } from '../src/output.js';
import { parseCommand, parseRequest } from '../src/protocol.js';
import { formatResponse } from '../src/response.js';
import { rpc, RpcError } from '../src/rpc.js';
import { createRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { RequestRecord } from '../src/store.js';

process.umask(0o077);
const temporary = () => realpathSync(mkdtempSync(join(tmpdir(), 'wcn-quote-')));
const runFile = promisify(execFile);
const pn = '12025550101@s.whatsapp.net';
const lid = '123450001@lid';
const other = '12025550102@s.whatsapp.net';
const me = '12025550199@s.whatsapp.net';
const myLid = '123450099@lid';
const group = '120363000000000001@g.us';
const command = {
  command: 'send' as const,
  jid: lid,
  key: 'reply',
  text: 'Fictional reply 😀',
  quote: { id: 'original', fromMe: false },
};
const original = (
  key: WAMessage['key'] = { remoteJid: lid, id: 'original', fromMe: false },
): WAMessage => ({
  key,
  messageTimestamp: 1700000000,
  message: { conversation: 'Fictional original body' },
});
const gate = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof CommandError);
  assert.equal(error.code, expected);
  assert.doesNotMatch(
    JSON.stringify(errorResponse(error)),
    /PRIVATE_|audit_json|SQLITE|probe.sqlite/,
  );
  return true;
};

function fixture(
  messages: WAMessage[] = [original()],
  options: {
    self?: string | null;
    route?: string;
    seed?: (store: Store) => void;
  } = {},
) {
  const directory = temporary();
  const seed = new Store(directory);
  const auth = sqliteAuth(seed);
  if (options.self !== null)
    auth.save({
      me: { id: options.self ?? me.replace('@', ':2@'), lid: myLid },
    });
  for (const message of messages) {
    seed.observeChat({
      id: message.key.remoteJid!,
      unreadCount: 0,
      archived: false,
      conversationTimestamp: 100,
    });
    seed.observeMessage(message);
  }
  options.seed?.(seed);
  seed.close();
  const events = new EventEmitter();
  const sends: Parameters<WASocket['sendMessage']>[] = [];
  const generated: WAMessage[] = [];
  let queryWait: Promise<void> | undefined;
  let sendWait: Promise<void> | undefined;
  let sendFailure = false;
  let queries = 0;
  const sendStarted = gate();
  const runtime = createRuntime(
    { dataDir: directory, connect: true },
    (config) =>
      ({
        ev: events,
        ws: { isClosed: true },
        end: async () => {
          events.emit('connection.update', { connection: 'close' });
        },
        executeUSyncQuery: async () => {
          queries++;
          await queryWait;
          return {
            list: options.route ? [{ id: pn, lid: options.route }] : [],
            sideList: [],
          };
        },
        sendMessage: async (...args: Parameters<WASocket['sendMessage']>) => {
          sends.push(args);
          const intent = (await runtime.execute({
            command: 'request',
            key: 'reply',
          })) as RequestRecord;
          assert.equal(intent.messageId, args[2]?.messageId);
          assert.equal(intent.attempt, 'uncertain');
          assert.ok(
            intent.quote,
            'safe snapshot persisted before the only invocation',
          );
          sendStarted.release();
          await sendWait;
          if (sendFailure) throw new Error('PRIVATE_SDK_ERROR');
          const message = await generateWAMessage(args[0], args[1], {
            userJid: config.auth!.creds.me!.id,
            ...args[2],
            upload: async () => assert.fail('No uploads'),
          });
          // Exercise rc14 generation AND the actual protobuf wire round trip, without makeWASocket.
          const wire = proto.WebMessageInfo.decode(
            proto.WebMessageInfo.encode(message).finish(),
          );
          assert.ok(wire.key);
          const decoded: WAMessage = { ...wire, key: wire.key };
          generated.push(decoded);
          return decoded;
        },
      }) as unknown as WASocket,
  ); // Partial, deliberately injected SDK I/O boundary.
  runtime.start();
  const emit = <K extends keyof BaileysEventMap>(
    name: K,
    value: BaileysEventMap[K],
  ) => {
    events.emit(name, value);
  };
  emit('connection.update', { connection: 'open' });
  return {
    runtime,
    directory,
    sends,
    generated,
    emit,
    queries: () => queries,
    sendStarted: sendStarted.promise,
    waitQuery(value: Promise<void>) {
      queryWait = value;
    },
    waitSend(value: Promise<void>) {
      sendWait = value;
    },
    failSend() {
      sendFailure = true;
    },
    request: async () =>
      (await runtime.execute({
        command: 'request',
        key: 'reply',
      })) as RequestRecord,
  };
}

test('quote wire selector keeps target ID separate from correlation and requires explicit direction', () => {
  assert.deepEqual(
    parseRequest(JSON.stringify({ id: 'correlation', ...command })),
    { id: 'correlation', command },
  );
  for (const quote of [
    null,
    [],
    {},
    { id: 'original' },
    { id: 'original', fromMe: 'false' },
    { id: '', fromMe: false },
    { id: 'original', fromMe: false, participant: group },
    { id: 'original', fromMe: false, jid: pn },
  ]) {
    assert.throws(
      () => parseCommand({ ...command, quote }),
      code('INVALID_ARGUMENT'),
    );
  }
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({
          id: 'original',
          ...command,
          quote: { fromMe: false },
        }),
      ),
    /quote.id/,
  );
});

test('rc14 quoted generation preserves exact direct/group direction and PN/LID authors offline', async () => {
  for (const [jid, fromMe, participant, author] of [
    [pn, false, undefined, pn],
    [lid, false, undefined, lid],
    [pn, true, undefined, me],
    [group, false, pn, pn],
    [group, false, lid, lid],
    [group, true, me, me],
  ] as const) {
    const target = original({
      remoteJid: jid,
      id: 'original',
      fromMe,
      ...(participant ? { participant } : {}),
    });
    const input = {
      ...command,
      jid,
      quote: {
        id: 'original',
        fromMe,
        ...(participant ? { participant } : {}),
      },
    };
    const f = fixture([target]);
    try {
      const result = (await f.runtime.execute(input)) as RequestRecord;
      const generated = f.generated[0]!;
      const context = generated.message?.extendedTextMessage?.contextInfo;
      assert.equal(context?.stanzaId, 'original');
      assert.equal(context?.participant, author);
      assert.equal(
        context?.remoteJid,
        null,
        'same conversation must not create a cross-chat quote',
      );
      assert.equal(
        context?.quotedMessage?.conversation,
        'Fictional original body',
      );
      assert.equal(generated.message?.extendedTextMessage?.text, command.text);
      assert.equal(generated.key.id, result.messageId);
      assert.deepEqual(result.operation, {
        kind: 'send',
        jid,
        text: command.text,
        quote: input.quote,
      });
      assert.deepEqual(result.quote?.reference, {
        jid,
        id: 'original',
        fromMe,
        participant: participant ?? null,
      });
      assert.equal(result.quote?.author, author);
      assert.equal(result.attempt, 'sdk-returned');
      assert.equal(result.acceptance, 'unknown');
      assert.equal(result.delivery, 'unknown');
      assert.equal(result.read, 'unknown');
      assert.equal(f.queries(), jid === pn ? 1 : 0);
      for (const action of ['send', 'request'])
        for (const mode of ['full', 'compact'] as const) {
          assert.deepEqual(
            formatResponse(action, { ok: true, data: result }, mode).data,
            result,
          );
        }
      const view = messageOutput(generated);
      assert.equal(view.quote?.reference.participant, author);
      assert.equal(view.quote?.text, result.quote?.text);
      const before = await f.runtime.execute({ command: 'chat', jid });
      assert.equal(
        (before as { activity: { timestamp: number } }).activity.timestamp,
        1700000000,
      );
    } finally {
      await f.runtime.close();
    }
  }
});

test('safe text/caption snapshots exclude SDK secrets, media payloads and nested quotes in intent and generation', async () => {
  const contents: proto.IMessage[] = [
    {
      extendedTextMessage: {
        text: 'Eligible snapshot',
        contextInfo: {
          quotedMessage: { conversation: 'PRIVATE_NESTED' },
          ephemeralSharedSecret: Buffer.from('PRIVATE_SECRET'),
        },
      },
    },
    {
      imageMessage: {
        caption: 'Eligible snapshot',
        mediaKey: Buffer.from('PRIVATE_MEDIA'),
        jpegThumbnail: Buffer.from('PRIVATE_THUMB'),
      },
    },
    {
      videoMessage: {
        caption: 'Eligible snapshot',
        directPath: '/PRIVATE_PATH',
        mediaKey: Buffer.from('PRIVATE_MEDIA'),
      },
    },
    {
      documentMessage: {
        caption: 'Eligible snapshot',
        fileName: 'PRIVATE_FILENAME',
        thumbnailDirectPath: '/PRIVATE_PATH',
        mediaKey: Buffer.from('PRIVATE_MEDIA'),
      },
    },
  ];
  for (const content of contents) {
    const f = fixture([
      {
        ...original(),
        message: {
          ephemeralMessage: {
            message: {
              ...content,
              messageContextInfo: {
                messageSecret: Buffer.from('PRIVATE_MESSAGE_SECRET'),
              },
              senderKeyDistributionMessage: {
                axolotlSenderKeyDistributionMessage: Buffer.from('PRIVATE_KEY'),
              },
            },
          },
        },
      },
    ]);
    try {
      const result = (await f.runtime.execute(command)) as RequestRecord;
      assert.equal(result.quote?.text, 'Eligible snapshot');
      const context = f.generated[0]?.message?.extendedTextMessage?.contextInfo;
      assert.ok(context?.quotedMessage);
      assert.doesNotMatch(
        JSON.stringify([
          result,
          f.sends[0]?.[2]?.quoted,
          context,
          messageOutput(f.generated[0]!),
        ]),
        /PRIVATE_|mediaKey|fileName|senderKey|messageSecret|directPath|thumbnail/,
      );
      assert.equal(
        messageOutput(f.generated[0]!).quote?.text,
        'Eligible snapshot',
      );
      f.emit('messages.delete', { keys: [original().key] });
      const history = (await f.runtime.execute({
        command: 'messages',
        jid: lid,
        limit: 100,
        offset: 0,
      })) as ReturnType<typeof messageOutput>[];
      assert.equal(
        history.find((row) => row.id === result.messageId)?.quote?.text,
        null,
      );
      assert.deepEqual(
        await f.runtime.execute({
          command: 'search',
          jid: lid,
          query: 'Eligible snapshot',
          limit: 100,
          offset: 0,
        }),
        [],
      );
      assert.equal(
        (
          (await f.runtime.execute({
            command: 'search',
            jid: lid,
            query: command.text,
            limit: 100,
            offset: 0,
          })) as unknown[]
        ).length,
        1,
      );
      assert.equal(
        (await f.request()).quote?.text,
        'Eligible snapshot',
        'immutable intent remains intent evidence after deletion',
      );
    } finally {
      await f.runtime.close();
    }
  }
});

test('quoted snapshots retain only the text of the SDK-selected content field', async () => {
  for (const [content, contentType, expected] of [
    [
      {
        imageMessage: { caption: 'Observed image caption' },
        extendedTextMessage: { text: 'Other text' },
      },
      'imageMessage',
      'Observed image caption',
    ],
    [
      {
        documentMessage: { caption: 'Observed document caption' },
        imageMessage: { caption: 'Other caption' },
      },
      'documentMessage',
      'Observed document caption',
    ],
    [
      {
        videoMessage: { caption: 'Observed video caption' },
        extendedTextMessage: { text: 'Other text' },
      },
      'videoMessage',
      'Observed video caption',
    ],
  ] as const) {
    const f = fixture([{ ...original(), message: content }]);
    try {
      const result = (await f.runtime.execute(command)) as RequestRecord;
      assert.equal(result.quote?.contentType, contentType);
      assert.equal(result.quote?.text, expected);
      assert.equal(result.attempt, 'sdk-returned');
      const quote =
        f.generated[0]?.message?.extendedTextMessage?.contextInfo
          ?.quotedMessage;
      assert.ok(quote);
      const selected = quote[contentType];
      assert.equal(selected?.caption, expected);
      assert.equal(Object.keys(quote).length, 1);
      assert.doesNotMatch(
        JSON.stringify([result.quote, f.sends[0]?.[2]?.quoted, quote]),
        /Other text|Other caption/,
      );
    } finally {
      await f.runtime.close();
    }
  }
  // A missing selected caption must not borrow eligible text from a secondary field.
  const f = fixture([
    {
      ...original(),
      message: {
        imageMessage: {},
        extendedTextMessage: { text: 'Other text' },
      },
    },
  ]);
  try {
    await assert.rejects(
      f.runtime.execute(command),
      code('PRECONDITION_FAILED'),
    );
    assert.equal(f.sends.length, 0);
    assert.equal(await f.request(), null);
  } finally {
    await f.runtime.close();
  }
});

test('missing, deleted, boundary, unsupported, empty and oversized targets fail before route/intent/invoke', async () => {
  const target = original({ remoteJid: pn, id: 'original', fromMe: false });
  const variants: { messages: WAMessage[]; seed?: (store: Store) => void }[] = [
    { messages: [] },
    {
      messages: [target],
      seed: (store) => store.deleteMessages({ keys: [target.key] }),
    },
    {
      messages: [target],
      seed: (store) => store.deleteMessages({ jid: pn, all: true }),
    },
    ...[
      null,
      { audioMessage: { seconds: 1 } },
      { contactMessage: { vcard: 'PRIVATE_CARD' } },
      { imageMessage: {} },
      { conversation: '' },
      { conversation: 'x'.repeat(65537) },
      {
        extendedTextMessage: {
          contextInfo: { quotedMessage: { conversation: 'PRIVATE_NESTED' } },
        },
      },
    ].map((message) => ({ messages: [{ ...target, message }] })),
  ];
  for (const variant of variants) {
    const f = fixture(variant.messages, {
      ...(variant.seed ? { seed: variant.seed } : {}),
      // Missing target still has a valid recipient; failure must originate at quote selection.
      ...(!variant.messages.length
        ? { seed: (store: Store) => store.observeChat({ id: pn }) }
        : {}),
    });
    try {
      await assert.rejects(
        f.runtime.execute({ ...command, jid: pn }),
        code('PRECONDITION_FAILED'),
      );
      assert.equal(f.queries(), 0);
      assert.equal(f.sends.length, 0);
      assert.equal(await f.request(), null);
    } finally {
      await f.runtime.close();
    }
  }
});

test('colliding IDs never select the first author/direction/chat and group participant is explicit', async () => {
  const targets = [
    original({
      remoteJid: group,
      id: 'original',
      fromMe: false,
      participant: pn,
    }),
    original({
      remoteJid: group,
      id: 'original',
      fromMe: false,
      participant: lid,
    }),
    original({
      remoteJid: group,
      id: 'original',
      fromMe: true,
      participant: me,
    }),
    original(),
  ];
  const f = fixture(targets);
  try {
    for (const input of [
      { ...command, jid: group },
      {
        ...command,
        jid: group,
        quote: { ...command.quote, participant: other },
      },
      {
        ...command,
        jid: group,
        quote: { id: 'missing', fromMe: true, participant: me },
      },
      {
        ...command,
        jid: group,
        quote: { id: 'original', fromMe: true, participant: lid },
      },
    ])
      await assert.rejects(
        f.runtime.execute(input),
        code('PRECONDITION_FAILED'),
      );
    assert.equal(f.sends.length, 0);
    const result = (await f.runtime.execute({
      ...command,
      jid: group,
      quote: { ...command.quote, participant: lid },
    })) as RequestRecord;
    assert.equal(result.quote?.author, lid);
  } finally {
    await f.runtime.close();
  }
  const collision = fixture([
    original(),
    original({
      remoteJid: lid,
      id: 'original',
      fromMe: false,
      participant: lid,
    }),
  ]);
  try {
    await assert.rejects(collision.runtime.execute(command), /Ambiguous/);
    assert.equal(collision.sends.length, 0);
  } finally {
    await collision.runtime.close();
  }
});

test('insufficient/contradictory authors and own LID quotes refuse explicitly', async () => {
  for (const [jid, participant, self, fromMe] of [
    [lid, undefined, me, true],
    [group, myLid, me, true],
    [group, other, me, true],
    [pn, undefined, null, true],
    [pn, undefined, myLid, true],
    [lid, pn, me, false],
    [group, undefined, me, false],
  ] as const) {
    const f = fixture(
      [
        original({
          remoteJid: jid,
          id: 'original',
          fromMe,
          ...(participant ? { participant } : {}),
        }),
      ],
      { self },
    );
    try {
      await assert.rejects(
        f.runtime.execute({
          ...command,
          jid,
          quote: {
            id: 'original',
            fromMe,
            ...(participant ? { participant } : {}),
          },
        }),
        code('PRECONDITION_FAILED'),
      );
      assert.equal(f.queries(), 0);
      assert.equal(f.sends.length, 0);
      assert.equal(await f.request(), null);
    } finally {
      await f.runtime.close();
    }
  }
});

test('PN→LID transport cannot select another conversation or generate a cross-chat quote', async () => {
  const targets = [
    original({ remoteJid: pn, id: 'original', fromMe: false }),
    { ...original(), message: { conversation: 'PRIVATE_OTHER_CONVERSATION' } },
  ];
  const f = fixture(targets, { route: lid });
  try {
    await assert.rejects(
      f.runtime.execute({ ...command, jid: pn }),
      /transport route differs/,
    );
    assert.equal(f.queries(), 1);
    assert.equal(f.sends.length, 0);
    assert.equal(await f.request(), null);
    await f.runtime.execute(command);
    assert.equal((await f.request()).quote?.reference.jid, lid);
    assert.equal(
      f.queries(),
      1,
      'explicit LID selected only its own stored target',
    );
  } finally {
    await f.runtime.close();
  }
});

test('target edits/deletions/revokes during asynchronous route preparation abort before intent and invoke', async () => {
  for (const change of ['edit', 'delete', 'revoke', 'boundary'] as const) {
    const target = original({ remoteJid: pn, id: 'original', fromMe: false });
    const f = fixture([target]);
    const wait = gate();
    f.waitQuery(wait.promise);
    const sending = f.runtime.execute({ ...command, jid: pn });
    const rejected = assert.rejects(sending, code('PRECONDITION_FAILED'));
    try {
      assert.equal(f.queries(), 1);
      if (change === 'delete')
        f.emit('messages.delete', { keys: [target.key] });
      else if (change === 'boundary')
        f.emit('messages.delete', { jid: pn, all: true });
      else
        f.emit('messages.update', [
          {
            key: target.key,
            update:
              change === 'edit'
                ? { message: { conversation: 'Changed body' } }
                : { messageStubType: proto.WebMessageInfo.StubType.REVOKE },
          },
        ]);
      wait.release();
      await rejected;
      assert.equal(f.sends.length, 0);
      assert.equal(await f.request(), null);
    } finally {
      wait.release();
      await rejected;
      await f.runtime.close();
    }
  }
});

test('same-key replay precedes every quote/route/state lookup; legacy sends never become replies', async () => {
  const f = fixture();
  let result: RequestRecord;
  try {
    result = (await f.runtime.execute(command)) as RequestRecord;
    f.emit('messages.update', [
      {
        key: original().key,
        update: { message: { conversation: 'Changed body' } },
      },
    ]);
    assert.deepEqual(await f.runtime.execute(command), result);
    f.emit('messages.delete', { keys: [original().key] });
    assert.deepEqual(await f.runtime.execute(command), result);
    f.emit('chats.delete', [lid]);
    assert.deepEqual(await f.runtime.execute(command), result);
    assert.equal(f.sends.length, 1);
    assert.equal(f.queries(), 0);
  } finally {
    await f.runtime.close();
  }
  const offline = createRuntime({
    dataDir: f.directory,
    connect: false,
    allowedJid: pn,
  });
  try {
    assert.deepEqual(await offline.execute(command), result!);
    for (const input of [
      { ...command, text: 'Changed' },
      { ...command, jid: pn },
      { ...command, quote: { ...command.quote, id: 'other' } },
      { ...command, quote: { ...command.quote, fromMe: true } },
      { ...command, quote: { ...command.quote, participant: lid } },
      { command: 'send' as const, key: 'reply', jid: lid, text: command.text },
      {
        command: 'send-file' as const,
        key: 'reply',
        jid: lid,
        path: '/PRIVATE_MISSING',
        mime: 'text/plain',
        caption: '',
      },
      {
        command: 'send-contact' as const,
        key: 'reply',
        jid: lid,
        name: 'Fictional',
        phone: '+12025550103',
      },
    ])
      await assert.rejects(offline.execute(input), code('KEY_CONFLICT'));
  } finally {
    await offline.close();
  }
  const legacy = new Store(temporary());
  try {
    const op = { kind: 'send' as const, jid: lid, text: command.text };
    const prior = await perform(
      legacy,
      'reply',
      op,
      () => {},
      async () => {
        throw new Error('uncertain');
      },
    );
    await assert.rejects(
      perform(
        legacy,
        'reply',
        { ...op, quote: command.quote },
        () => assert.fail('No validation'),
        async () => assert.fail('No SDK'),
      ),
      code('KEY_CONFLICT'),
    );
    assert.deepEqual(
      await perform(
        legacy,
        'reply',
        op,
        () => assert.fail('No validation'),
        async () => assert.fail('No SDK'),
      ),
      prior,
    );
  } finally {
    legacy.close();
  }
});

test('concurrent quote/simple/file/card keys keep one preparation/invoke and pending uncertainty', async () => {
  const f = fixture([
    original({ remoteJid: pn, id: 'original', fromMe: false }),
  ]);
  const route = gate();
  const invoke = gate();
  f.waitQuery(route.promise);
  f.waitSend(invoke.promise);
  f.failSend();
  const input = { ...command, jid: pn };
  const first = f.runtime.execute(input);
  const repeated = f.runtime.execute(input);
  const conflicts = [
    { ...input, quote: { ...input.quote, fromMe: true } },
    { command: 'send' as const, key: 'reply', jid: pn, text: command.text },
    {
      command: 'send-file' as const,
      key: 'reply',
      jid: pn,
      path: '/PRIVATE_MISSING',
      mime: 'text/plain',
      caption: '',
    },
    {
      command: 'send-contact' as const,
      key: 'reply',
      jid: pn,
      name: 'Fictional',
      phone: '+12025550103',
    },
  ].map((value) =>
    assert.rejects(f.runtime.execute(value), code('KEY_CONFLICT')),
  );
  try {
    assert.equal(f.queries(), 1);
    route.release();
    const pending = (await repeated) as RequestRecord;
    assert.equal(pending.attempt, 'uncertain');
    assert.ok(pending.quote);
    assert.equal(f.sends.length, 1);
    await Promise.all(conflicts);
    assert.deepEqual(await f.runtime.execute(input), pending);
    invoke.release();
    const result = (await first) as RequestRecord;
    assert.equal(result.errorObserved, true);
    assert.equal(result.attempt, 'uncertain');
    await f.runtime.close();
    const offline = createRuntime({ dataDir: f.directory, connect: false });
    try {
      assert.deepEqual(await offline.execute(input), result);
    } finally {
      await offline.close();
    }
  } finally {
    route.release();
    invoke.release();
    await first;
    await f.runtime.close();
  }
});

test('out-of-order exact receipts survive completion and deletion without advancing observed chat state', async () => {
  const f = fixture();
  const wait = gate();
  f.waitSend(wait.promise);
  const before = await f.runtime.execute({ command: 'chat', jid: lid });
  const sending = f.runtime.execute(command);
  try {
    await f.sendStarted;
    const pending = await f.request();
    const key = { remoteJid: lid, id: pending.messageId!, fromMe: true };
    for (const wrong of [
      { ...key, remoteJid: pn },
      { ...key, id: 'original' },
      { ...key, fromMe: false },
    ]) {
      f.emit('messages.update', [{ key: wrong, update: { status: 4 } }]);
    }
    assert.equal((await f.request()).read, 'unknown');
    f.emit('messages.update', [{ key, update: { status: 4 } }]);
    f.emit('messages.delete', { keys: [original().key] });
    wait.release();
    const result = (await sending) as RequestRecord;
    assert.equal(result.attempt, 'sdk-returned');
    assert.equal(result.read, 'read');
    assert.equal(result.delivery, 'delivered');
    f.emit('messages.update', [{ key, update: { status: 2 } }]);
    assert.equal((await f.request()).read, 'read');
    assert.deepEqual(
      await f.runtime.execute({ command: 'chat', jid: lid }),
      before,
    );
    const history = (await f.runtime.execute({
      command: 'messages',
      jid: lid,
      limit: 100,
      offset: 0,
    })) as ReturnType<typeof messageOutput>[];
    assert.equal(
      history.find((message) => message.id === result.messageId)?.quote?.text,
      null,
    );
  } finally {
    wait.release();
    await sending;
    await f.runtime.close();
  }
});

test('quote intent rollback prevents invocation; completion failure keeps original snapshot and never resends', async () => {
  for (const failure of ['operation-attempt', 'operation-sdk-returned']) {
    const f = fixture([original()], {
      seed: (store) =>
        store.db.exec(
          `CREATE TRIGGER fail_reply BEFORE INSERT ON events WHEN NEW.kind='${failure}' BEGIN SELECT RAISE(ABORT,'PRIVATE_SQL'); END`,
        ),
    });
    try {
      await assert.rejects(f.runtime.execute(command), code('LOCAL_STATE'));
      assert.equal(f.sends.length, failure === 'operation-attempt' ? 0 : 1);
      const pending = await f.request();
      if (failure === 'operation-attempt') assert.equal(pending, null);
      else {
        assert.equal(pending.attempt, 'uncertain');
        assert.equal(pending.quote?.text, 'Fictional original body');
        assert.deepEqual(await f.runtime.execute(command), pending);
        const history = (await f.runtime.execute({
          command: 'messages',
          jid: lid,
          limit: 100,
          offset: 0,
        })) as ReturnType<typeof messageOutput>[];
        assert.equal(history.length, 1);
        await f.runtime.close();
        const offline = createRuntime({ dataDir: f.directory, connect: false });
        try {
          assert.deepEqual(await offline.execute(command), pending);
        } finally {
          await offline.close();
        }
      }
    } finally {
      await f.runtime.close();
    }
  }
});

test('CLI/socket/full/compact and JSONL preserve quote intent and safe classified errors offline', async () => {
  const f = fixture();
  let intent: RequestRecord;
  try {
    intent = (await f.runtime.execute(command)) as RequestRecord;
  } finally {
    await f.runtime.close();
  }
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = parseRequest(buffer.slice(0, buffer.indexOf('\n')));
      assert.notEqual(request.id, 'original');
      assert.deepEqual(request.command, command);
      socket.end(
        JSON.stringify({ id: request.id, ok: true, data: intent! }) + '\n',
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(f.directory, 'control.sock'), resolve),
  );
  try {
    for (const mode of ['full', 'compact']) {
      const { stdout } = await runFile(process.execPath, [
        'dist/src/cli.js',
        '--data-dir',
        f.directory,
        '--output',
        mode,
        'send',
        '--jid',
        lid,
        '--key',
        'reply',
        '--text',
        command.text,
        '--quote-id',
        'original',
        '--quote-from-me',
        'false',
      ]);
      assert.deepEqual(JSON.parse(stdout).data, intent!);
    }
    for (const args of [
      ['--quote-id', 'original'],
      ['--quote-from-me', 'false'],
      ['--quote-id', 'original', '--quote-from-me', '0'],
    ]) {
      await assert.rejects(
        runFile(process.execPath, [
          'dist/src/cli.js',
          '--data-dir',
          f.directory,
          'send',
          '--jid',
          lid,
          '--key',
          'reply',
          '--text',
          command.text,
          ...args,
        ]),
        (error) => {
          assert.ok(error && typeof error === 'object' && 'stdout' in error);
          assert.equal(
            JSON.parse(String(error.stdout)).code,
            'INVALID_ARGUMENT',
          );
          return true;
        },
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const requests: Record<string, unknown>[] = [
    { id: 'replay', ...command },
    { id: 'inspect', command: 'request', key: 'reply' },
    { id: 'conflict', ...command, quote: { id: 'original', fromMe: true } },
    { id: 'original', ...command, quote: { fromMe: false } },
    { id: 'stop', command: 'stop' },
  ];
  const child = spawnSync(
    process.execPath,
    ['dist/src/probe.js', '--data-dir', f.directory],
    {
      encoding: 'utf8',
      input: requests.map((value) => JSON.stringify(value)).join('\n') + '\n',
      timeout: 5000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(responses[0].data, intent!);
  assert.deepEqual(responses[1].data, intent!);
  assert.equal(responses[2].code, 'KEY_CONFLICT');
  assert.equal(responses[3].id, 'original');
  assert.equal(responses[3].code, 'INVALID_ARGUMENT');
  assert.equal(responses[4].ok, true);
});

test('real offline daemon replays a stored group reply through CLI/socket after target deletion', async () => {
  const input = {
    ...command,
    jid: group,
    quote: { ...command.quote, participant: lid },
  };
  const target = original({
    remoteJid: group,
    id: 'original',
    fromMe: false,
    participant: lid,
  });
  const f = fixture([target]);
  let intent: RequestRecord;
  try {
    intent = (await f.runtime.execute(input)) as RequestRecord;
    f.emit('messages.delete', { keys: [target.key] });
  } finally {
    await f.runtime.close();
  }
  const child = spawn(
    process.execPath,
    ['dist/src/daemon.js', '--offline', '--data-dir', f.directory],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let diagnostics = '';
  child.stderr.on('data', (chunk) => {
    diagnostics += String(chunk);
  });
  const exited = once(child, 'exit');
  let ready = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const status = await rpc(f.directory, { command: 'status' });
        assert.equal(status.pid, child.pid);
        assert.equal(status.connection, 'offline');
        ready = true;
        break;
      } catch (error) {
        if (!(error instanceof RpcError && error.code === 'NOT_RUNNING'))
          throw error;
      }
      assert.equal(child.exitCode, null, diagnostics);
      await delay(20);
    }
    assert.equal(ready, true);
    for (const mode of ['full', 'compact']) {
      const args = [
        'dist/src/cli.js',
        '--data-dir',
        f.directory,
        '--output',
        mode,
        'send',
        '--jid',
        group,
        '--key',
        'reply',
        '--text',
        command.text,
        '--quote-id',
        'original',
        '--quote-from-me',
        'false',
        '--quote-participant',
        lid,
      ];
      const { stdout } = await runFile(process.execPath, args);
      assert.deepEqual(JSON.parse(stdout).data, intent!);
      assert.deepEqual(
        (await rpc(f.directory, { command: 'request', key: 'reply' })).data,
        intent!,
      );
      await assert.rejects(
        runFile(
          process.execPath,
          args.map((arg) => (arg === lid ? pn : arg)),
        ),
        (error) => {
          assert.ok(error && typeof error === 'object' && 'stdout' in error);
          assert.equal(JSON.parse(String(error.stdout)).code, 'KEY_CONFLICT');
          return true;
        },
      );
    }
  } finally {
    if (ready)
      assert.equal((await rpc(f.directory, { command: 'stop' })).ok, true);
    const [status, signal] = await exited;
    assert.equal(status, 0, diagnostics);
    assert.equal(signal, null);
  }
});
