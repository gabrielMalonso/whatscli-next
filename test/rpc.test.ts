import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { object } from '../src/protocol.js';
import { rpc, RpcError } from '../src/rpc.js';

process.umask(0o077);

async function fixture(t: TestContext, respond: (request: Record<string, unknown>, socket: Socket) => Promise<void> | void) {
  const directory = mkdtempSync(join(tmpdir(), 'wcn-rpc-'));
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    connections++; sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let input = '';
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      void Promise.resolve(respond(object(JSON.parse(input.trim())), socket)).catch(error => {
        socket.destroy(); t.assert.fail(String(error));
      });
    });
  });
  await new Promise<void>(done => server.listen(join(directory, 'control.sock'), done));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  });
  return { directory, connections: () => connections };
}

test('RPC assembles fragmented Unicode, preserves full payload and separates correlation from download messageId', async t => {
  const text = 'São 😀 漢字 100%_\n'.repeat(20000);
  const data = { jid: '123450001@lid', messageId: 'fictional-download-id', text, caption: '' };
  let correlation: unknown;
  const server = await fixture(t, async (request, socket) => {
    assert.equal(request.command, 'download');
    assert.equal(request.messageId, data.messageId);
    assert.notEqual(request.id, request.messageId);
    correlation = request.id;
    const bytes = Buffer.from(JSON.stringify({ id: request.id, ok: true, data }) + '\n');
    // Force an actual data-event boundary inside the emoji's UTF-8 bytes, then many response fragments.
    const split = bytes.indexOf(Buffer.from('😀')) + 1;
    socket.write(bytes.subarray(0, split));
    await setImmediate();
    socket.write(bytes.subarray(split, split + 1));
    await setImmediate();
    for (let offset = split + 1; offset < bytes.length; offset += 8191) {
      socket.write(bytes.subarray(offset, offset + 8191));
      await setImmediate();
    }
    socket.end();
  });
  const result = await rpc(server.directory, { command: 'download', jid: data.jid, messageId: data.messageId, path: '/fictional/output' });
  assert.deepEqual(result, { id: correlation, ok: true, data });
  assert.equal(server.connections(), 1);
});

test('RPC retains the inclusive 8 MiB decoded UTF-8 response limit across fragments', async t => {
  const limit = 8 * 1024 * 1024;
  let overLimit = false;
  const server = await fixture(t, (request, socket) => {
    const empty = JSON.stringify({ id: request.id, ok: true, data: '' }) + '\n';
    const remaining = limit - Buffer.byteLength(empty);
    const data = 'á'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2) + (overLimit ? 'x' : '');
    const response = Buffer.from(JSON.stringify({ id: request.id, ok: true, data }) + '\n');
    assert.equal(response.length, limit + Number(overLimit));
    socket.end(response);
  });
  const result = await rpc(server.directory, { command: 'status' });
  assert.equal(Buffer.byteLength(JSON.stringify(result) + '\n'), limit);
  overLimit = true;
  await assert.rejects(rpc(server.directory, { command: 'status' }), error => error instanceof RpcError && error.code === 'PROTOCOL' && /exceeds 8 MiB/.test(error.message));
  assert.equal(server.connections(), 2, 'limit rejection must not retry');
});

test('RPC rejects malformed, mismatched and incomplete fragmented responses without retry', async t => {
  let mode = 'malformed';
  const server = await fixture(t, async (request, socket) => {
    socket.write('{"id":');
    await setImmediate();
    if (mode === 'closed') { socket.end(); return; }
    if (mode === 'malformed') { socket.end('invalid}\n'); return; }
    socket.end(JSON.stringify(mode === 'mismatch' ? 'different-id' : request.id) + ',"ok":' + (mode === 'wrong-ok' ? '"true"' : 'true') + '}\n');
  });
  for (mode of ['malformed', 'mismatch', 'wrong-ok', 'closed']) {
    await assert.rejects(rpc(server.directory, { command: 'request', key: 'fictional-uncertain' }), error => error instanceof RpcError && error.code === 'PROTOCOL');
  }
  assert.equal(server.connections(), 4);
});

test('RPC accepts only the first response line and preserves daemon error envelopes', async t => {
  const server = await fixture(t, async (request, socket) => {
    socket.write(JSON.stringify({ id: request.id, ok: false, error: 'Fictional conflict', code: 'CONFLICT' }));
    await setImmediate();
    socket.end('\n{"id":"unrelated","ok":true}\n');
  });
  const result = await rpc(server.directory, { command: 'request', key: 'fictional-conflict' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Fictional conflict');
  assert.equal(result.code, 'CONFLICT');
  assert.equal(server.connections(), 1);
});
