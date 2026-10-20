import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { proto } from 'baileys';
import { sqliteAuth } from '../src/auth.js';
import { createBackup } from '../src/backup.js';
import { CommandError, errorResponse } from '../src/errors.js';
import { parseRequest, object } from '../src/protocol.js';
import { createRuntime } from '../src/runtime.js';
import { rpc, RpcError } from '../src/rpc.js';
import { Store } from '../src/store.js';
import type { RequestRecord } from '../src/store.js';

process.umask(0o077);
mkdirSync('.tmp', { recursive: true, mode: 0o700 });
const temporary = () => mkdtempSync(join(tmpdir(), 'wcn-backup-fixture-'));
const shortTemporary = () => mkdtempSync(join(tmpdir(), 'wcn-backup-'));
const runFile = promisify(execFile);
const pn = '12025550101@s.whatsapp.net';
const lid = '123450001@lid';
const group = '120363000000000001@g.us';
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const hasCode = (code: string) => (error: unknown) => error instanceof CommandError && error.code === code;

function logical(db: DatabaseSync) {
  const tables = ['values_store', 'chats', 'messages', 'message_deletions', 'events', 'requests', 'identity_mappings', 'message_text'];
  return {
    version: db.prepare('PRAGMA user_version').get(),
    schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
    tables: tables.map(table => {
      const statement = db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`);
      statement.setReadBigInts(true);
      return { table, rows: statement.all() };
    }),
  };
}

function seed(store: Store): RequestRecord {
  const auth = sqliteAuth(store);
  auth.save({ me: { id: pn, name: 'Fictional account' }, registered: false });
  auth.state.keys.set({ 'app-state-sync-key': { fixture: { keyData: Buffer.from('FICTIONAL_AUTH_KEY') } } });
  store.set('session', pn, Buffer.from('FICTIONAL_SESSION_BYTES'));
  store.set('runtime', 'receive-interruption', { at: 123, reason: 'connection-closed' });
  store.observeChat({ id: pn, unreadCount: 0, archived: false, conversationTimestamp: 100 });
  store.observeContact({ id: pn, name: 'Fictional contact', lid }, 'contacts.upsert');
  store.observeMapping(pn, lid, 'lid-mapping.update', 100);
  store.set('recipient-check', pn, { status: 'confirmed', source: 'baileys.onWhatsApp', observedAt: 100 });
  const key = { remoteJid: group, id: 'deleted', fromMe: false, participant: pn };
  store.observeMessage({ key, messageTimestamp: 100, message: { conversation: 'PRIVATE_AUDIT_BODY' } });
  store.deleteMessages({ keys: [key] });
  store.observeMessage({ key: { remoteJid: pn, id: 'long', fromMe: false },
    messageTimestamp: proto.WebMessageInfo.fromObject({ messageTimestamp: '4294967312' }).messageTimestamp ?? null,
    message: { conversation: 'Ｓnapshot searchable São' } });
  store.observeMessage({ key: { remoteJid: lid, id: 'old', fromMe: false }, messageTimestamp: 1, message: { conversation: 'Old boundary' } });
  store.deleteMessages({ jid: lid, all: true });
  const record: RequestRecord = {
    key: 'uncertain', operation: { kind: 'send', jid: pn, text: 'PRIVATE_INTENT_BODY' }, messageId: 'IMMUTABLE_ID',
    route: { status: 'proven', jid: lid, source: 'baileys.executeUSyncQuery/lid', observedAt: 123, limit: 'server-association-at-query-time' },
    attempt: 'uncertain', acceptance: 'unknown', delivery: 'unknown', read: 'unknown', errorObserved: true,
  };
  store.saveRequest(record);
  store.saveRequest({ ...record, key: 'quoted-reply', messageId: 'IMMUTABLE_QUOTED_ID', operation: { kind: 'send', jid: lid, text: 'Fictional reply',
    quote: { id: 'original', fromMe: false } }, quote: {
    reference: { jid: lid, id: 'original', fromMe: false, participant: null },
    author: lid, contentType: 'conversation', text: 'Fictional quoted snapshot',
  } });
  store.receipt({ remoteJid: lid, id: record.messageId, fromMe: true }, proto.WebMessageInfo.Status.DELIVERY_ACK);
  const pending: RequestRecord = { ...record, key: 'pending', operation: { kind: 'archive', jid: pn, value: true }, messageId: null };
  store.saveRequest(pending); store.invalidateChatState(pending.key, pending.operation);
  store.saveRequest({ ...record, key: 'file', operation: { kind: 'send-file', jid: pn, path: '/fictional/unavailable.txt',
    mime: 'text/plain', caption: '', bytes: 17, sha256: 'fictional-manifest' } });
  store.event('fixture-private-audit', { marker: 'PRIVATE_EVENT_BODY' });
  return store.request(record.key)!;
}

test('online backup preserves WAL commits, every logical row/rowid, auth, uncertainty and offline recovery in a NEW directory', async () => {
  const root = temporary();
  const store = new Store(join(root, 'source'));
  const record = seed(store);
  let expected = logical(store.db);
  let during = false;
  try {
    store.db.exec('PRAGMA wal_autocheckpoint=0');
    store.transaction(() => { for (let i = 0; i < 300; i++) store.set('fictional-volume', String(i), 'x'.repeat(4096)); });
    assert.ok(statSync(join(store.directory, 'probe.sqlite-wal')).size > 0);
    const result = await createBackup(store.db, join(root, 'snapshot'), async (source, path) => {
      const pages = await backup(source, path, { rate: 1, progress({ remainingPages }) {
        if (!during && remainingPages > 0) {
          during = true;
          store.transaction(() => {
            store.observeMessage({ key: { remoteJid: pn, id: 'during', fromMe: false }, messageTimestamp: 200, message: { conversation: 'During snapshot' } });
            store.event('during-backup', {});
          });
        }
      } });
      expected = logical(source);
      store.set('after-snapshot', 'late', true); // Must not enter artifact metadata or logical snapshot.
      return pages;
    });
    assert.equal(during, true);
    assert.equal(result.scope, 'sqlite-only'); assert.equal(result.sensitive, true);
    assert.equal(result.sha256, digest(result.path)); assert.equal(result.bytes, statSync(result.path).size);
    assert.deepEqual(JSON.parse(readFileSync(result.manifestPath, 'utf8')), result);
    assert.equal(lstatSync(result.manifestPath).ino, lstatSync(join(result.directory, 'backup.pending.json')).ino);
    assert.deepEqual(readdirSync(result.directory).sort(), ['backup.json', 'backup.pending.json', 'probe.sqlite']);
    assert.equal(statSync(result.directory).mode & 0o777, 0o700);
    for (const file of readdirSync(result.directory)) assert.equal(statSync(join(result.directory, file)).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|FICTIONAL_AUTH|FICTIONAL_SESSION|IMMUTABLE_ID|SELECT|1202555/);
    const artifact = new DatabaseSync(result.path, { readOnly: true });
    try {
      assert.deepEqual(logical(artifact), expected);
      assert.equal(artifact.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.equal(artifact.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
    } finally { artifact.close(); }
    const recoveredDirectory = join(root, 'recovered');
    mkdirSync(recoveredDirectory, { mode: 0o700 });
    copyFileSync(result.path, join(recoveredDirectory, 'probe.sqlite'), constants.COPYFILE_EXCL);
    const recovered = new Store(recoveredDirectory);
    try {
      assert.deepEqual(logical(recovered.db), expected);
      assert.deepEqual(recovered.request(record.key), record);
      assert.equal(recovered.chatView(pn)?.archived, null);
      assert.equal(recovered.search('snapshot searchable são', 100, 0).length, 1);
      assert.equal(recovered.search('PRIVATE_AUDIT_BODY', 100, 0).length, 0);
      assert.equal(recovered.search('During snapshot', 100, 0).length, 1);
      assert.equal(recovered.get('after-snapshot', 'late'), undefined);
      const auth = sqliteAuth(recovered);
      assert.deepEqual((await auth.state.keys.get('app-state-sync-key', ['fixture'])).fixture?.keyData, Buffer.from('FICTIONAL_AUTH_KEY'));
      recovered.observeMessage({ key: { remoteJid: group, id: 'deleted', fromMe: false, participant: pn }, message: { conversation: 'Resurrection' } });
      assert.equal(recovered.search('Resurrection', 100, 0).length, 0);
    } finally { recovered.close(); }
    for (let restart = 0; restart < 2; restart++) {
      const runtime = createRuntime({ dataDir: recoveredDirectory, connect: false }, () => { throw new Error('Network factory must never run'); });
      try {
        runtime.start();
        assert.deepEqual(await runtime.execute({ command: 'send', key: record.key, jid: pn, text: 'PRIVATE_INTENT_BODY' }), record);
        const file = object(await runtime.execute({ command: 'send-file', key: 'file', jid: pn, path: '/fictional/unavailable.txt', mime: 'text/plain', caption: '' }));
        assert.equal(file.messageId, 'IMMUTABLE_ID');
        const reply = await runtime.execute({ command: 'send', key: 'quoted-reply', jid: lid, text: 'Fictional reply', quote: { id: 'original', fromMe: false } }) as RequestRecord;
        assert.equal(reply.quote?.text, 'Fictional quoted snapshot');
        assert.deepEqual(reply.quote?.reference, { jid: lid, id: 'original', fromMe: false, participant: null });
        assert.equal(reply.attempt, 'uncertain');
        await assert.rejects(runtime.execute({ command: 'send', key: record.key, jid: pn, text: 'Different' }), hasCode('KEY_CONFLICT'));
        assert.equal(runtime.snapshot().receiveContinuity.status, 'unproven');
      } finally { await runtime.close(); }
    }
    assert.equal(digest(result.path), result.sha256, 'recovery never changes the original backup');
    assert.throws(() => new Store(store.directory), /locked/, 'original runtime retains ownership');
  } finally { store.close(); }
});

test('backup rejects existing output, symlinks and insecure parents without overwriting or repairing anything', async () => {
  const root = temporary();
  const store = new Store(join(root, 'source'));
  try {
    const existing = join(root, 'existing'); mkdirSync(existing, { mode: 0o700 });
    const file = join(root, 'file'); writeFileSync(file, 'PRESERVE', { mode: 0o600 });
    const linked = join(root, 'linked'); symlinkSync(existing, linked);
    const dangling = join(root, 'dangling'); symlinkSync(join(root, 'missing'), dangling);
    for (const path of [existing, file, linked, dangling, join(linked, 'nested')]) {
      await assert.rejects(createBackup(store.db, path), hasCode('PRECONDITION_FAILED'));
    }
    assert.equal(readFileSync(file, 'utf8'), 'PRESERVE'); assert.deepEqual(readdirSync(existing), []);
    assert.ok(lstatSync(linked).isSymbolicLink()); assert.ok(lstatSync(dangling).isSymbolicLink());
    for (const mode of [0o755, 0o770]) {
      chmodSync(existing, mode);
      await assert.rejects(createBackup(store.db, join(existing, 'new')), hasCode('PRECONDITION_FAILED'));
      assert.equal(statSync(existing).mode & 0o777, mode);
    }
    const unsafe = join(root, 'unsafe'); mkdirSync(unsafe, { mode: 0o700 }); chmodSync(unsafe, 0o777);
    const privateLeaf = join(unsafe, 'private'); mkdirSync(privateLeaf, { mode: 0o700 });
    await assert.rejects(createBackup(store.db, join(privateLeaf, 'new')), hasCode('PRECONDITION_FAILED'));
    for (const path of ['relative', join(root, 'nul') + '\0', root + '/a/../new']) await assert.rejects(createBackup(store.db, path), hasCode('INVALID_ARGUMENT'));
    await assert.rejects(createBackup(store.db, join(root, 'missing', 'new')), hasCode('LOCAL_STATE'));
    const first = await createBackup(store.db, join(root, 'once'));
    await assert.rejects(createBackup(store.db, first.directory), hasCode('PRECONDITION_FAILED'));
    assert.equal(digest(first.path), first.sha256);
    assert.equal((await createBackup(store.db, join(root, 'twice'))).state, 'complete');
  } finally { store.close(); }
});

test('backup rejects a foreign-owned 0755 ancestor before reserving output or invoking the copy', async () => {
  const root = temporary();
  const store = new Store(join(root, 'source'));
  const parent = join(root, 'parent'); mkdirSync(parent, { mode: 0o700 });
  const output = join(parent, 'snapshot');
  let copied = false;
  try {
    await assert.rejects(createBackup(store.db, output, async () => {
      copied = true; throw new Error('Copy must not run');
    }, path => {
      const stat = lstatSync(path);
      // Inject only ownership metadata; no chown, other account or multi-user attack.
      return path === root ? Object.assign(stat, { uid: 999999, mode: (stat.mode & ~0o777) | 0o755 }) : stat;
    }), hasCode('PRECONDITION_FAILED'));
    assert.equal(copied, false);
    assert.equal(existsSync(output), false);
    assert.deepEqual(readdirSync(parent), []);
    assert.equal(lstatSync(root).uid, process.getuid?.());
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
  } finally { store.close(); }
});

test('copy, verification and publication failures preserve partials, source and writer lock with safe errors', async () => {
  const root = temporary();
  const store = new Store(join(root, 'source'));
  seed(store);
  const before = logical(store.db);
  try {
    for (const failure of ['copy', 'verification', 'publication', 'permissions']) {
      const directory = join(root, failure);
      await assert.rejects(createBackup(store.db, directory, async (source, path) => {
        if (failure === 'copy') { writeFileSync(path, 'FICTIONAL_PARTIAL'); throw new Error('PRIVATE_FAILURE_SQL'); }
        const pages = await backup(source, path);
        if (failure === 'verification') writeFileSync(path, 'FICTIONAL_CORRUPTION');
        if (failure === 'publication') writeFileSync(join(directory, 'backup.pending.json'), 'PRESERVE_UNKNOWN', { mode: 0o600 });
        if (failure === 'permissions') chmodSync(path, 0o644);
        return pages;
      }), error => {
        assert.ok(hasCode('LOCAL_STATE')(error));
        assert.doesNotMatch(JSON.stringify(errorResponse(error)), /PRIVATE_FAILURE|FICTIONAL_|SELECT|source|1202555/);
        return true;
      });
      assert.equal(existsSync(join(directory, 'backup.json')), false);
      assert.equal(existsSync(join(directory, 'probe.sqlite')), true);
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      if (failure === 'publication') assert.equal(readFileSync(join(directory, 'backup.pending.json'), 'utf8'), 'PRESERVE_UNKNOWN');
      if (failure === 'permissions') assert.equal(statSync(join(directory, 'probe.sqlite')).mode & 0o777, 0o644);
      await assert.rejects(createBackup(store.db, directory), hasCode('PRECONDITION_FAILED'));
      assert.deepEqual(logical(store.db), before);
      assert.throws(() => new Store(store.directory), /locked/);
    }
    store.db.exec('BEGIN IMMEDIATE');
    try { await assert.rejects(createBackup(store.db, join(root, 'transaction')), hasCode('PRECONDITION_FAILED')); }
    finally { store.db.exec('ROLLBACK'); }
    assert.equal(existsSync(join(root, 'transaction')), false);
    assert.equal((await createBackup(store.db, join(root, 'after-failures'))).state, 'complete');
  } finally { store.close(); }
});

test('runtime serializes backup admission and waits for success/failure before closing SQLite and releasing ownership', { timeout: 10000 }, async () => {
  for (const fails of [false, true]) {
    const root = temporary();
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; });
    const runtime = createRuntime({ dataDir: join(root, 'source'), connect: false }, undefined, undefined,
      (source, directory) => createBackup(source, directory, async (db, path) => {
        entered(); await gate;
        if (fails) throw new Error('Injected copy failure');
        return backup(db, path);
      }));
    runtime.start();
    const work = runtime.execute({ command: 'backup', path: join(root, 'snapshot') });
    const observed = work.then(() => true, () => false);
    await started;
    await assert.rejects(runtime.execute({ command: 'backup', path: join(root, 'parallel') }), hasCode('PRECONDITION_FAILED'));
    assert.equal(existsSync(join(root, 'parallel')), false);
    assert.equal(object(await runtime.execute({ command: 'status' })).networkEnabled, false);
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    try {
      await assert.rejects(runtime.execute({ command: 'backup', path: join(root, 'stopping') }), hasCode('PRECONDITION_FAILED'));
      assert.equal(closed, false);
      assert.throws(() => new Store(runtime.directory), /locked/);
    } finally { release(); await closing; }
    assert.equal(await observed, !fails);
    assert.equal(existsSync(join(root, 'snapshot', 'backup.json')), !fails);
    const reopened = new Store(runtime.directory); reopened.close();
  }
});

async function cli(directory: string, ...args: string[]) {
  const { stdout, stderr } = await runFile(process.execPath, ['dist/src/cli.js', '--data-dir', directory, ...args], { timeout: 10000 });
  assert.equal(stderr, ''); assert.equal(stdout.trim().split('\n').length, 1);
  return object(JSON.parse(stdout));
}

test('offline CLI/socket backup has correlated safe full/compact JSON, errors, and NEW offline daemon recovery', async () => {
  const root = shortTemporary();
  const source = join(root, 's');
  const store = new Store(source); const record = seed(store); store.close();
  try {
    assert.equal((await cli(source, 'start', '--offline')).ok, true);
    for (const output of ['full', 'compact']) {
      const directory = join(root, output);
      const response = await cli(source, 'backup', '--out', directory, '--output', output);
      assert.equal(response.ok, true); assert.equal(typeof response.id, 'string');
      assert.equal(response.source, 'local'); assert.equal(response.coverage, 'partial'); assert.equal(response.appState, 'unknown');
      const data = object(response.data);
      assert.equal(data.sensitive, true); assert.equal(data.scope, 'sqlite-only');
      assert.deepEqual(data, JSON.parse(readFileSync(join(directory, 'backup.json'), 'utf8')));
      assert.doesNotMatch(JSON.stringify(response), /PRIVATE_|FICTIONAL_AUTH|FICTIONAL_SESSION|IMMUTABLE_ID/);
      await assert.rejects(cli(source, 'backup', '--out', directory, '--output', output), error => {
        assert.ok(error && typeof error === 'object' && 'stdout' in error && 'code' in error);
        const response = object(JSON.parse(String(error.stdout)));
        assert.equal(error.code, 1); assert.equal(response.code, 'PRECONDITION_FAILED'); assert.equal(typeof response.id, 'string');
        return true;
      });
    }
    const restored = join(root, 'restored'); mkdirSync(restored, { mode: 0o700 });
    const original = join(root, 'full', 'probe.sqlite'); const hash = digest(original);
    copyFileSync(original, join(restored, 'probe.sqlite'), constants.COPYFILE_EXCL);
    try {
      const started = await cli(restored, 'start', '--offline');
      assert.equal(object(started.data).networkEnabled, false);
      assert.equal((await cli(restored, 'search', '--query', 'snapshot searchable são')).ok, true);
      assert.deepEqual((await cli(restored, 'send', '--key', record.key, '--jid', pn, '--text', 'PRIVATE_INTENT_BODY')).data, record);
    } finally { await cli(restored, 'stop'); }
    assert.equal(digest(original), hash);
  } finally { await cli(source, 'stop'); }
});

test('JSONL backup preserves correlation and request validation, without a connection or raw state', () => {
  const root = shortTemporary();
  const directory = join(root, 'snapshot');
  const requests = [
    { id: 'invalid-path', command: 'backup' },
    { id: 'relative', command: 'backup', path: 'relative' },
    { id: 'backup-correlation', command: 'backup', path: directory },
    { id: 'repeat', command: 'backup', path: directory },
    { id: 'stop', command: 'stop' },
  ];
  const child = spawnSync(process.execPath, ['dist/src/probe.js', '--data-dir', join(root, 'source')], {
    encoding: 'utf8', timeout: 10000, input: requests.map(value => JSON.stringify(value)).join('\n') + '\n',
  });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split('\n').map(line => object(JSON.parse(line)));
  assert.deepEqual(responses.map(value => value.id), requests.map(value => value.id));
  assert.deepEqual(responses.map(value => value.ok), [false, false, true, false, true]);
  assert.deepEqual(responses.slice(0, 2).map(value => value.code), ['INVALID_ARGUMENT', 'INVALID_ARGUMENT']);
  assert.equal(responses[3]?.code, 'PRECONDITION_FAILED');
  assert.equal(object(responses[2]?.data).scope, 'sqlite-only');
  assert.doesNotMatch(child.stdout, /noiseKey|signedIdentityKey|FICTIONAL_AUTH|creds/);
  assert.equal(parseRequest(JSON.stringify({ id: 'rpc', command: 'backup', path: directory })).id, 'rpc');
  assert.equal(dirname(String(object(responses[2]?.data).path)), directory);
});

test('daemon retains ownership after backup RPC timeout and stop until its own copy finishes', { timeout: 15000 }, async () => {
  const root = shortTemporary();
  const directory = join(root, 'source');
  const output = join(root, 'snapshot');
  const child = spawn(process.execPath, ['--import', './dist/test/fixtures/backup-hooks.js', 'dist/src/daemon.js', '--offline', '--data-dir', directory],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = '';
  child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(14000) });
  let stopConfirmed = false;
  try {
    assert.deepEqual(await once(child, 'message', { signal: AbortSignal.timeout(5000) }), ['ready', undefined]);
    const started = once(child, 'message', { signal: AbortSignal.timeout(5000) });
    const timedOut = assert.rejects(rpc(directory, { command: 'backup', path: output }, 150), error =>
      error instanceof RpcError && error.code === 'TIMEOUT' && /backup.json/.test(error.message));
    assert.deepEqual(await started, ['backup-started', undefined]);
    await timedOut;
    assert.equal(existsSync(join(output, 'backup.json')), false);
    assert.equal((await rpc(directory, { command: 'backup', path: join(root, 'parallel') })).code, 'PRECONDITION_FAILED');
    assert.equal((await rpc(directory, { command: 'stop' })).ok, true);
    stopConfirmed = true;
    const status = await rpc(directory, { command: 'status' });
    assert.equal(object(status.recovery).state, 'stopping');
    assert.throws(() => new Store(directory), /locked/);
    assert.equal(existsSync(join(output, 'backup.json')), false);
  } finally {
    if (child.connected) child.send('release-backup');
    // A confirmed stop already owns shutdown. A second request can race the
    // expected socket close or be rejected while stopping; await our child's exit.
    if (!stopConfirmed) await cli(directory, 'stop');
    const [code, signal] = await exited;
    assert.equal(code, 0, diagnostics); assert.equal(signal, null);
  }
  assert.equal(object(JSON.parse(readFileSync(join(output, 'backup.json'), 'utf8'))).state, 'complete');
  const reopened = new Store(directory); reopened.close();
});
