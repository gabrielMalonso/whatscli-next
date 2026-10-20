import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { prepareFile, saveMedia } from '../src/media.js';
import { perform } from '../src/operations.js';
import { createRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { CommandError, errorResponse } from '../src/errors.js';

process.umask(0o077);
const temporary = (): string => mkdtempSync(join(tmpdir(), 'media-'));
const jid = '12025550101@s.whatsapp.net';

test('file sends persist an immutable byte manifest and keep failure uncertain across restart', async () => {
  const directory = temporary();
  const path = join(directory, 'fictional.txt');
  writeFileSync(path, 'Original fictional content');
  const prepared = await prepareFile(path);
  writeFileSync(path, 'Changed after snapshot');
  assert.equal(prepared.buffer.toString(), 'Original fictional content');
  assert.equal(prepared.sha256, createHash('sha256').update(prepared.buffer).digest('hex'));
  const store = new Store(join(directory, 'session'));
  const operation = { kind: 'send-file' as const, jid, path, mime: 'text/plain', caption: '', bytes: prepared.bytes, sha256: prepared.sha256 };
  const result = await perform(store, 'file-key', operation, () => {}, async id => {
    assert.ok(id);
    assert.equal(store.request('file-key')?.operation.kind, 'send-file');
    throw new Error('Upload completion unknown');
  });
  assert.equal(result.attempt, 'uncertain');
  store.close();
  const runtime = createRuntime({ dataDir: join(directory, 'session'), connect: false });
  try {
    // Returning the durable request works offline even if the original bytes changed.
    const repeated = await runtime.execute({ command: 'send-file', key: 'file-key', jid, path, mime: 'text/plain', caption: '' });
    assert.deepEqual(repeated, result);
    await assert.rejects(runtime.execute({ command: 'send-file', key: 'file-key', jid, path, mime: 'application/pdf', caption: '' }), /different arguments/);
  } finally { await runtime.close(); }
});

test('downloads preserve exact bytes, private permissions and existing output without calling the network', async () => {
  const directory = temporary();
  const path = join(directory, 'download.txt');
  const buffer = Buffer.from('Fictional downloaded content');
  const result = await saveMedia(path, async () => Readable.from([buffer.subarray(0, 5), buffer.subarray(5)]));
  assert.deepEqual(readFileSync(path), buffer);
  assert.equal(result.sha256, createHash('sha256').update(buffer).digest('hex'));
  assert.equal(result.bytes, buffer.length);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  let calls = 0;
  await assert.rejects(saveMedia(path, async () => { calls++; return Readable.from([Buffer.from('Replacement')]); }), /EEXIST/);
  assert.equal(calls, 0);
  assert.deepEqual(readFileSync(path), buffer);
});

test('failed and oversized media streams are reported as partial and remain private', async () => {
  const directory = temporary();
  const path = join(directory, 'partial.bin');
  await assert.rejects(saveMedia(path, async () => Readable.from([Buffer.from('abc'), Buffer.from('def')]), 4), /partial file preserved/);
  assert.ok(statSync(path).size <= 4);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const broken = join(directory, 'failed.bin');
  await assert.rejects(saveMedia(broken, async () => { throw new Error('FICTIONAL_PRIVATE_NETWORK_BODY'); }), error => {
    assert.ok(error instanceof CommandError);
    assert.equal(error.code, 'UNKNOWN', 'download failure does not classify an arbitrary SDK/network cause');
    assert.match(error.message, /partial file preserved/);
    const response = JSON.stringify(errorResponse(error));
    assert.equal(response.includes(broken), false);
    assert.doesNotMatch(response, /FICTIONAL_PRIVATE_NETWORK_BODY|cause|stack/);
    return true;
  });
  assert.equal(statSync(broken).mode & 0o777, 0o600);
});

test('media lookup requires exact sender identity when message IDs collide', () => {
  const store = new Store(temporary());
  const group = '120363000000000001@g.us';
  try {
    for (const participant of ['12345001@lid', '12345002@lid']) store.observeMessage({
      key: { remoteJid: group, id: 'colliding-id', fromMe: false, participant },
      messageTimestamp: 1, message: { conversation: 'Fictional message' },
    });
    assert.throws(() => store.locateMessage({ jid: group, id: 'colliding-id' }), /Ambiguous/);
    assert.equal(store.locateMessage({ jid: group, id: 'colliding-id', participant: '12345002@lid' }).key.participant, '12345002@lid');
    assert.throws(() => store.locateMessage({ jid, id: 'colliding-id' }), /not stored/);
  } finally { store.close(); }
});

test('concurrent duplicate send requests share one durable attempt while the first result is pending', async () => {
  const store = new Store(temporary());
  let finish: (() => void) | undefined;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const operation = { kind: 'send' as const, jid, text: 'Concurrent fictional message' };
  try {
    const first = perform(store, 'concurrent-key', operation, () => {}, async id => {
      calls++;
      await wait;
      return { key: { remoteJid: jid, id, fromMe: true }, message: { conversation: operation.text } };
    });
    const second = await perform(store, 'concurrent-key', operation, () => {}, async () => { calls++; });
    assert.equal(second.attempt, 'uncertain');
    assert.equal(calls, 1);
    finish?.();
    assert.equal((await first).messageId, second.messageId);
  } finally { finish?.(); store.close(); }
});
