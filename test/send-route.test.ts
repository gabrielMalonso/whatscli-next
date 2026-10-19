import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { areJidsSameUser, generateWAMessage, generateWAMessageFromContent, getBinaryNodeChild, getBinaryNodeChildren,
  getStatusFromReceiptType, isJidGroup, isJidStatusBroadcast, jidNormalizedUser, proto, toNumber, USyncQuery } from 'baileys';
import type { BaileysEventMap, BinaryNode, WAMessageKey, WASocket } from 'baileys';
import { createRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { RequestRecord } from '../src/store.js';
import { formatResponse } from '../src/response.js';

process.umask(0o077);
mkdirSync('.tmp', { recursive: true, mode: 0o700 });
const temporary = () => mkdtempSync(join(process.cwd(), '.tmp', 'send-route-'));
const pn = '12025550101@s.whatsapp.net';
const lid = '123450001@lid';
const otherPn = '12025550102@s.whatsapp.net';
const otherLid = '123450002@lid';
const group = '120363000000000001@g.us';
const me = '12025550199@s.whatsapp.net';
const command = { command: 'send' as const, key: 'k', jid: pn, text: 'Fictional route test' };
const gate = () => {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

function fixture(options: { directory?: string; allowedJid?: string; observed?: boolean } = {}) {
  const directory = options.directory ?? temporary();
  const seed = new Store(directory);
  if (options.observed !== false) seed.observeChat({ id: pn });
  seed.close();
  const events = new EventEmitter();
  let result: unknown = { list: [{ id: pn, lid }], sideList: [] };
  let queryWait: Promise<void> | undefined;
  let sendWait: Promise<void> | undefined;
  let queryError = false;
  let sendError = false;
  let queries = 0;
  const queryStarted = gate();
  const sendStarted = gate();
  const sends: Parameters<WASocket['sendMessage']>[] = [];
  const runtime = createRuntime({ dataDir: directory, connect: true, ...(options.allowedJid ? { allowedJid: options.allowedJid } : {}) }, () => ({
    ev: events, ws: { isClosed: true },
    end: async () => { events.emit('connection.update', { connection: 'close' }); },
    onWhatsApp: async () => [{ jid: pn, exists: true }],
    signalRepository: { lidMapping: { getLIDForPN: () => assert.fail('Historical SDK cache is not route proof') } },
    executeUSyncQuery: async (query: USyncQuery) => {
      queries++;
      queryStarted.release();
      assert.deepEqual(query.users.map(user => user.id), [pn]);
      assert.deepEqual(query.protocols.map(protocol => protocol.name), ['lid']);
      assert.equal(query.context, 'background');
      await queryWait;
      if (queryError) throw new Error('PRIVATE_QUERY_SECRET');
      return result;
    },
    sendMessage: async (...args: Parameters<WASocket['sendMessage']>) => {
      sends.push(args);
      sendStarted.release();
      await sendWait;
      if (sendError) throw new Error('PRIVATE_SEND_SECRET');
      const [destination, content, config] = args;
      if ('document' in content) return generateWAMessageFromContent(destination, { documentMessage: { fileName: content.fileName ?? null } }, { userJid: me, ...config });
      return generateWAMessage(destination, content, { userJid: me, ...config, upload: async () => { throw new Error('No real uploads'); } });
    },
  }) as unknown as WASocket); // Only the deliberately partial injected SDK boundary is erased.
  runtime.start();
  const emit = <K extends keyof BaileysEventMap>(name: K, value: BaileysEventMap[K]) => { events.emit(name, value); };
  emit('connection.update', { connection: 'open' });
  return { runtime, directory, events, sends, emit, queryStarted: queryStarted.promise, sendStarted: sendStarted.promise,
    queries: () => queries, response(value: unknown) { result = value; },
    waitQuery(value: Promise<void>) { queryWait = value; }, waitSend(value: Promise<void>) { sendWait = value; },
    failQuery() { queryError = true; }, failSend() { sendError = true; },
    request: async () => await runtime.execute({ command: 'request', key: 'k' }) as RequestRecord,
  };
}

const source = readFileSync(new URL(import.meta.resolve('baileys/lib/Socket/messages-recv.js')), 'utf8');
function installedReceipt(events: EventEmitter): (node: BinaryNode) => Promise<void> {
  const start = source.indexOf('    const handleReceipt = async (node) => {');
  const end = source.indexOf('    const handleNotification', start);
  assert.ok(start > 0 && end > start);
  return runInNewContext(`(() => { ${source.slice(start, end)} return handleReceipt; })()`, {
    areJidsSameUser, isJidGroup, isJidStatusBroadcast, getBinaryNodeChildren, getBinaryNodeChild, getStatusFromReceiptType,
    jidNormalizedUser, toNumber, proto, ev: events, authState: { creds: { me: { id: me, lid: '123450099@lid' } } },
    receiptMutex: { mutex: (work: () => Promise<void>) => work() }, sendMessageAck: async () => {},
  }) as (node: BinaryNode) => Promise<void>;
}

test('new PN text/file/card sends persist server route before invocation, preserving original intent and native history', async () => {
  for (const kind of ['send', 'send-file', 'send-contact'] as const) {
    const f = fixture({ observed: false, allowedJid: pn });
    const wait = gate();
    f.waitSend(wait.promise);
    const path = join(f.directory, 'fictional.txt');
    writeFileSync(path, 'Fictional bytes');
    const input = kind === 'send' ? command : kind === 'send-file'
      ? { command: kind, key: 'k', jid: pn, path, mime: 'text/plain', caption: 'Fictional file' }
      : { command: kind, key: 'k', jid: pn, name: 'Fictional Card', phone: '+12025550103' };
    let sending: Promise<unknown> | undefined;
    try {
      assert.equal((await f.runtime.execute({ command: 'resolve', phone: '+12025550101' }) as { status: string }).status, 'confirmed');
      sending = f.runtime.execute(input);
      await f.sendStarted;
      const pending = await f.request();
      assert.equal(pending.attempt, 'uncertain');
      assert.equal(pending.operation.jid, pn);
      assert.equal(pending.route?.status, 'proven');
      assert.equal(pending.route?.jid, lid);
      assert.equal(pending.route?.source, 'baileys.executeUSyncQuery/lid');
      assert.equal(pending.route?.limit, 'server-association-at-query-time');
      assert.ok(pending.route && Number.isSafeInteger(pending.route.observedAt));
      assert.equal(f.sends[0]?.[0], lid);
      assert.equal(f.sends[0]?.[2]?.messageId, pending.messageId);
      assert.equal(f.queries(), 1);
      if (kind === 'send-file') {
        const content = f.sends[0]![1];
        assert.ok('document' in content);
        assert.deepEqual(content.document, Buffer.from('Fictional bytes'));
      }
      for (const mode of ['full', 'compact'] as const) {
        assert.deepEqual(formatResponse('request', { ok: true, data: pending }, mode).data, pending);
      }
      wait.release();
      const final = await sending as RequestRecord;
      assert.equal(final.attempt, 'sdk-returned');
      assert.equal(final.acceptance, 'unknown');
      assert.deepEqual(final.route, pending.route);
      assert.deepEqual(await f.runtime.execute({ command: 'messages', jid: pn, limit: 20, offset: 0 }), []);
      const history = await f.runtime.execute({ command: 'messages', jid: lid, limit: 20, offset: 0 }) as { jid: string; id: string }[];
      assert.equal(history.length, 1);
      assert.equal(history[0]?.jid, lid);
      assert.equal(history[0]?.id, pending.messageId);
      assert.deepEqual(await f.runtime.execute({ command: 'chats', limit: 100, offset: 0 }), []);
    } finally { wait.release(); await sending; await f.runtime.close(); }
  }
});

test('rc14 USync result parsing accepts one exact pair; missing, malformed, ambiguous and failed queries fall back visibly', async () => {
  const query = new USyncQuery().withLIDProtocol();
  const parsed = query.parseUSyncQueryResult({ tag: 'iq', attrs: { type: 'result' }, content: [{ tag: 'usync', attrs: {}, content: [{
    tag: 'list', attrs: {}, content: [{ tag: 'user', attrs: { jid: pn }, content: [{ tag: 'lid', attrs: { val: lid } }] }],
  }] }] });
  for (const response of [parsed, undefined, {}, { list: [] }, { list: [null] }, { list: [{ id: otherPn, lid }] },
    { list: [{ id: pn }] }, { list: [{ id: pn, lid: 123 }] }, { list: [{ id: pn, lid: `${lid.split('@')[0]}:29@lid` }] },
    { list: [{ id: pn, lid: '123450001@hosted.lid' }] }, { list: [{ id: pn, lid }, { id: pn, lid }] }, 'throw']) {
    const f = fixture();
    f.response(response);
    if (response === 'throw') f.failQuery();
    try {
      const result = await f.runtime.execute(command) as RequestRecord;
      assert.equal(result.route?.status, response === parsed ? 'proven' : 'unproven');
      assert.equal(f.sends[0]?.[0], response === parsed ? lid : pn);
      assert.equal(result.route?.jid, f.sends[0]?.[0]);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_QUERY_SECRET/);
      if (result.route?.status === 'unproven') assert.equal(result.route.limit, 'exact-original-destination-only');
    } finally { await f.runtime.close(); }
  }
});

test('forward/reverse conflicts, including an edge arriving during lookup, never authorize an alternative route', async () => {
  for (const mapping of [{ pn, lid: otherLid }, { pn: otherPn, lid }]) {
    const f = fixture();
    const wait = gate();
    f.waitQuery(wait.promise);
    try {
      const sending = f.runtime.execute(command);
      f.emit('lid-mapping.update', mapping);
      wait.release();
      const result = await sending as RequestRecord;
      assert.equal(result.route?.status, 'unproven');
      assert.equal(result.route?.status === 'unproven' && result.route.reason, 'conflicting-identities');
      assert.equal(f.sends[0]?.[0], pn);
      f.emit('messages.update', [{ key: { remoteJid: lid, id: result.messageId, fromMe: true }, update: { status: 4 } }]);
      assert.equal((await f.request()).read, 'unknown');
    } finally { wait.release(); await f.runtime.close(); }
  }
});

test('allowed recipient is the original PN; SDK cache cannot authorize a PN/LID substitution', async () => {
  const f = fixture({ allowedJid: lid });
  try {
    await assert.rejects(f.runtime.execute(command), /exact/);
    assert.equal(f.queries(), 0);
    assert.equal(f.sends.length, 0);
  } finally { await f.runtime.close(); }
  const cached = fixture();
  cached.emit('lid-mapping.update', { pn, lid });
  cached.response({ list: [] });
  try {
    const result = await cached.runtime.execute(command) as RequestRecord;
    assert.equal(result.route?.status, 'unproven');
    assert.equal(cached.sends[0]?.[0], pn);
  } finally { await cached.runtime.close(); }
});

test('installed rc14 direct receipts correlate the pinned route before/after SDK return and remain monotonic', async () => {
  const f = fixture();
  const wait = gate();
  f.waitSend(wait.promise);
  try {
    const sending = f.runtime.execute(command);
    await f.sendStarted;
    const pending = await f.request();
    const receipt = installedReceipt(f.events);
    await receipt({ tag: 'receipt', attrs: { from: lid, id: pending.messageId!, t: '1700000000' } });
    assert.equal((await f.request()).delivery, 'delivered');
    assert.equal((await f.request()).attempt, 'uncertain');
    wait.release();
    await sending;
    await receipt({ tag: 'receipt', attrs: { from: lid.replace('@', ':29@'), id: pending.messageId!, type: 'read', t: '1700000001' } });
    const read = await f.request();
    assert.equal(read.acceptance, 'server-ack');
    assert.equal(read.delivery, 'delivered');
    assert.equal(read.read, 'read');
    f.emit('lid-mapping.update', { pn, lid: otherLid });
    f.emit('messages.update', [{ key: { remoteJid: lid, id: pending.messageId, fromMe: true }, update: { status: 2 } }]);
    assert.deepEqual(await f.request(), read, 'later mapping changes and old statuses cannot retract observed receipts');
  } finally { wait.release(); await f.runtime.close(); }
});

test('route receipts reject other IDs, domains, users, participants and directions without alias merging', async () => {
  const f = fixture();
  try {
    const result = await f.runtime.execute(command) as RequestRecord;
    const key = { remoteJid: lid, id: result.messageId, fromMe: true };
    const wrong: WAMessageKey[] = [
      { ...key, id: 'other-id' }, { ...key, remoteJid: pn }, { ...key, remoteJid: otherLid },
      { ...key, remoteJid: '123450001@s.whatsapp.net' }, { ...key, remoteJid: '123450001@hosted.lid' },
      { ...key, remoteJid: '123450001:garbage@lid' }, { ...key, remoteJid: '123450001:99@lid' },
      { ...key, fromMe: false }, { remoteJid: lid, id: key.id }, { ...key, participant: otherLid },
    ];
    for (const identity of wrong) f.emit('messages.update', [{ key: identity, update: { status: 4 } }]);
    assert.deepEqual(await f.request(), result);
    f.emit('messages.update', [{ key: { ...key, remoteJid: '123450001:29@lid' }, update: { status: 2 } }]);
    assert.equal((await f.request()).acceptance, 'server-ack');
    assert.equal((await f.request()).delivery, 'unknown');
    assert.equal((await f.request()).read, 'unknown');
  } finally { await f.runtime.close(); }
});

test('same-key concurrency performs one lookup/send, conflicting arguments fail, and uncertainty survives offline restart', async () => {
  const f = fixture();
  const queryWait = gate();
  const sendWait = gate();
  f.waitQuery(queryWait.promise);
  f.waitSend(sendWait.promise);
  f.failSend();
  let a: Promise<unknown> | undefined;
  try {
    a = f.runtime.execute(command);
    const b = f.runtime.execute(command);
    const conflict = assert.rejects(f.runtime.execute({ ...command, text: 'Different' }), /different arguments/);
    const wrongKind = assert.rejects(f.runtime.execute({ command: 'archive', key: 'k', jid: pn, value: true }), /different arguments/);
    const wrongTarget = assert.rejects(f.runtime.execute({ ...command, jid: group }), /different arguments/);
    assert.equal(f.queries(), 1);
    queryWait.release();
    const pending = await b as RequestRecord;
    assert.equal(pending.attempt, 'uncertain');
    assert.equal(f.sends.length, 1);
    assert.deepEqual(await f.runtime.execute(command), pending);
    await conflict;
    await wrongKind;
    await wrongTarget;
    sendWait.release();
    const uncertain = await a as RequestRecord;
    assert.equal(uncertain.errorObserved, true);
    assert.equal(f.queries(), 1);
    await f.runtime.close();
    const offline = createRuntime({ dataDir: f.directory, connect: false });
    try {
      assert.deepEqual(await offline.execute(command), uncertain);
      const original = new Store(temporary());
      try {
        original.saveRequest(uncertain);
        original.receipt({ remoteJid: lid, fromMe: true, id: uncertain.messageId }, 4);
        assert.equal(original.request('k')?.read, 'read');
      } finally { original.close(); }
    } finally { await offline.close(); }
  } finally { queryWait.release(); sendWait.release(); await a; await f.runtime.close(); }
});

test('legacy intents are never backfilled and groups/explicit LIDs do not acquire PN route lookups', async () => {
  const directory = temporary();
  const seed = new Store(directory);
  const old: RequestRecord = { key: 'k', operation: { kind: 'send', jid: pn, text: command.text }, messageId: 'LEGACY_TEST',
    attempt: 'sdk-returned', acceptance: 'unknown', delivery: 'unknown', read: 'unknown', errorObserved: false };
  seed.saveRequest(old);
  seed.observeMapping(pn, lid, 'baileys.key-store', null);
  seed.close();
  const f = fixture({ directory });
  try {
    assert.deepEqual(await f.runtime.execute(command), old);
    f.emit('lid-mapping.update', { pn, lid });
    f.emit('messages.update', [{ key: { remoteJid: lid, id: old.messageId, fromMe: true, remoteJidAlt: pn }, update: { status: 4 } }]);
    assert.deepEqual(await f.request(), old);
    assert.equal(f.queries(), 0);
    assert.equal(f.sends.length, 0);
  } finally { await f.runtime.close(); }
  for (const jid of [group, lid]) {
    const directory = temporary();
    const seed = new Store(directory);
    seed.observeChat({ id: jid });
    seed.close();
    const f = fixture({ directory });
    try {
      const result = await f.runtime.execute({ ...command, jid }) as RequestRecord;
      assert.equal(result.route, undefined);
      assert.equal(f.queries(), 0);
      f.emit('message-receipt.update', [{ key: { remoteJid: jid, id: result.messageId, fromMe: true }, receipt: { userJid: otherLid, readTimestamp: 123 } }]);
      assert.equal((await f.request()).read, 'unknown');
    } finally { await f.runtime.close(); }
  }
});

test('a crash inside the only invocation retains the pinned route and uncertain intent without a retry', async () => {
  // Real local Unix transport tests need a short path even in long worktrees.
  const directory = mkdtempSync(join(tmpdir(), 'whatscli-route-crash-'));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { EventEmitter } from 'node:events';
    import { createRuntime } from './dist/src/runtime.js';
    import { Store } from './dist/src/store.js';
    const directory = process.argv[1];
    const pn = '12025550101@s.whatsapp.net'; const lid = '123450001@lid';
    const store = new Store(directory); store.observeChat({id:pn}); store.close();
    const events = new EventEmitter();
    const runtime = createRuntime({dataDir:directory,connect:true}, () => ({
      ev:events, ws:{isClosed:true},
      executeUSyncQuery:async () => ({list:[{id:pn,lid}],sideList:[]}),
      sendMessage:async (jid, _content, options) => {
        const intent = await runtime.execute({command:'request',key:'k'});
        if(jid !== lid || intent.route.jid !== lid || intent.messageId !== options.messageId) process.exit(32);
        process.exit(31);
      }
    }));
    runtime.start(); events.emit('connection.update',{connection:'open'});
    await runtime.execute({command:'send',key:'k',jid:pn,text:'Fictional route test'});
  `, directory], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 31, child.stderr);
  const offline = createRuntime({ dataDir: directory, connect: false }, () => assert.fail('No socket after crash'));
  let prior: RequestRecord;
  try {
    prior = await offline.execute(command) as RequestRecord;
    assert.equal(prior.attempt, 'uncertain');
    assert.equal(prior.errorObserved, false);
    assert.equal(prior.route?.jid, lid);
    assert.equal(prior.operation.jid, pn);
  } finally { await offline.close(); }
  const reopened = new Store(directory);
  try {
    reopened.receipt({ remoteJid: lid, fromMe: true, id: prior.messageId }, 4);
    assert.equal(reopened.request('k')?.read, 'read');
    assert.deepEqual(reopened.request('k')?.route, prior.route);
    assert.equal(reopened.events(0).filter(event => (event as { kind: string }).kind === 'operation-attempt').length, 1);
  } finally { reopened.close(); }
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['dist/src/cli.js', '--data-dir', directory, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout) as { data: RequestRecord };
  };
  try {
    cli('start', '--offline');
    for (const output of ['full', 'compact']) {
      const record = cli('request', '--key', 'k', '--output', output).data;
      assert.deepEqual(record.route, prior.route);
      assert.equal(record.messageId, prior.messageId);
      assert.equal(record.operation.jid, pn);
      assert.equal(record.read, 'read');
    }
  } finally { cli('stop'); }
});

test('concurrent file keys keep the original manifest even if the input path changes while route lookup is pending', async () => {
  const f = fixture();
  const wait = gate();
  const path = join(f.directory, 'fictional.txt');
  writeFileSync(path, 'Original bytes');
  f.waitQuery(wait.promise);
  const input = { command: 'send-file' as const, jid: pn, key: 'k', path, mime: 'text/plain', caption: '' };
  let first: Promise<unknown> | undefined;
  try {
    first = f.runtime.execute(input);
    await f.queryStarted;
    assert.equal(f.queries(), 1);
    writeFileSync(path, 'Changed bytes');
    const second = f.runtime.execute(input);
    renameSync(path, path + '.moved');
    const third = f.runtime.execute(input);
    wait.release();
    const original = await first as RequestRecord;
    const repeated = await second as RequestRecord;
    assert.equal(original.messageId, repeated.messageId);
    assert.deepEqual(original.operation, repeated.operation);
    assert.deepEqual((await third as RequestRecord).operation, original.operation);
    assert.equal(f.queries(), 1);
    assert.equal(f.sends.length, 1);
    assert.deepEqual(await f.runtime.execute(input), original);
  } finally { wait.release(); await first; await f.runtime.close(); }
});
