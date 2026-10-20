import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parseRequest, RequestError } from '../src/protocol.js';
import { Store } from '../src/store.js';

process.umask(0o077);
const temporary = () => mkdtempSync(join(tmpdir(), 'whatscli-wire-'));
const runFile = promisify(execFile);
const group = '120363000000000001@g.us';

test('CLI/RPC download preserves the exact message identity through parsing in full and compact', async (t) => {
  const directory = temporary();
  const store = new Store(directory);
  t.after(() => store.close());
  const identities = [
    { remoteJid: group, id: 'fictional-document', fromMe: true },
    {
      remoteJid: group,
      id: 'fictional-document',
      fromMe: false,
      participant: '123450001@lid',
    },
    {
      remoteJid: group,
      id: 'fictional-document',
      fromMe: false,
      participant: '123450002@lid',
    },
    {
      remoteJid: '120363000000000002@g.us',
      id: 'fictional-document',
      fromMe: true,
    },
    { remoteJid: group, id: 'other-document', fromMe: true },
  ];
  for (const [index, key] of identities.entries())
    store.observeMessage({
      key,
      message: { conversation: `Fictional bytes ${index}` },
    });
  const parsed: ReturnType<typeof parseRequest>[] = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      let id: string | null = null;
      try {
        const request = parseRequest(buffer.slice(0, buffer.indexOf('\n')));
        id = request.id;
        parsed.push(request);
        const command = request.command;
        assert.equal(command.command, 'download');
        if (command.command !== 'download')
          throw new Error('Expected download');
        // Exercise real identity selection without fetching or decrypting any media.
        const message = store.locateMessage({
          jid: command.jid,
          id: command.messageId,
          ...(command.fromMe === undefined ? {} : { fromMe: command.fromMe }),
          ...(command.participant === undefined
            ? {}
            : { participant: command.participant }),
        });
        socket.end(
          JSON.stringify({
            id,
            ok: true,
            data: { key: message.key, fixture: message.message?.conversation },
          }) + '\n',
        );
      } catch (error) {
        socket.end(
          JSON.stringify({
            id: error instanceof RequestError ? error.id : id,
            ok: false,
            error: error instanceof Error ? error.message : 'Fixture failed',
          }) + '\n',
        );
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, 'control.sock'), resolve),
  );
  t.after(() => server.close());
  const invoke = (...args: string[]) =>
    runFile(
      process.execPath,
      ['dist/src/cli.js', '--data-dir', directory, 'download', ...args],
      { timeout: 5000 },
    );
  for (const output of ['full', 'compact']) {
    for (const [index, key] of identities.entries()) {
      const out = join(directory, `${output}-${index}.bin`);
      const { stdout } = await invoke(
        '--output',
        output,
        '--jid',
        key.remoteJid,
        '--id',
        key.id,
        '--from-me',
        String(key.fromMe),
        '--out',
        out,
        ...(key.participant ? ['--participant', key.participant] : []),
      );
      const result: { id: string; data: { key: typeof key; fixture: string } } =
        JSON.parse(stdout);
      assert.deepEqual(result.data.key, key);
      assert.equal(result.data.fixture, `Fictional bytes ${index}`);
      assert.notEqual(
        result.id,
        key.id,
        'correlation must be distinct from the media target',
      );
      assert.equal(existsSync(out), false, 'fixture never downloads media');
    }
    for (const selector of [
      ['--jid', group, '--id', 'missing-document', '--from-me', 'true'],
      [
        '--jid',
        '120363000000000003@g.us',
        '--id',
        'fictional-document',
        '--from-me',
        'true',
      ],
      ['--jid', group, '--id', 'fictional-document'],
      ['--jid', group, '--id', 'fictional-document', '--from-me', 'false'],
      [
        '--jid',
        group,
        '--id',
        'fictional-document',
        '--from-me',
        'false',
        '--participant',
        '123450003@lid',
      ],
    ]) {
      const out = join(directory, 'must-not-exist.bin');
      await assert.rejects(
        invoke('--output', output, ...selector, '--out', out),
        (error) => {
          assert.ok(error && typeof error === 'object' && 'stdout' in error);
          assert.match(String(error.stdout), /not stored|Ambiguous/);
          return true;
        },
      );
      assert.equal(existsSync(out), false);
    }
  }
  assert.equal(
    new Set(parsed.map((request) => request.id)).size,
    parsed.length,
  );
  const before = parsed.length;
  await assert.rejects(
    invoke('--jid', group, '--out', join(directory, 'missing-id.bin')),
  );
  assert.equal(
    parsed.length,
    before,
    'a missing CLI --id must fail before RPC',
  );
});

test('download wire requires a messageId independently of correlation, including JSONL errors', () => {
  const directory = temporary();
  const command = {
    command: 'download',
    jid: group,
    path: join(directory, 'never-created.bin'),
    fromMe: true,
  };
  for (const messageId of [undefined, null, '', 123]) {
    assert.throws(
      () =>
        parseRequest(
          JSON.stringify({ id: 'fictional-document', ...command, messageId }),
        ),
      (error) =>
        error instanceof RequestError &&
        error.id === 'fictional-document' &&
        /messageId/.test(error.message),
    );
  }
  const explicit = { ...command, messageId: 'fictional-document' };
  assert.equal(
    parseRequest(JSON.stringify({ id: 'separate-correlation', ...explicit }))
      .command.command,
    'download',
  );
  for (const id of [undefined, null, '', 'x'.repeat(201)]) {
    assert.throws(
      () => parseRequest(JSON.stringify({ id, ...explicit })),
      RequestError,
    );
  }
  const child = spawnSync(
    process.execPath,
    ['dist/src/probe.js', '--data-dir', directory],
    {
      encoding: 'utf8',
      timeout: 5000,
      input:
        [
          { id: 'no-target', ...command },
          {
            id: 'explicit-target',
            ...command,
            messageId: 'fictional-document',
          },
          { id: 'stop', command: 'stop' },
        ]
          .map((value) => JSON.stringify(value))
          .join('\n') + '\n',
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const replies: { id: string; ok: boolean; error?: string }[] = child.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(replies[0]?.id, 'no-target');
  assert.match(replies[0]?.error ?? '', /messageId/);
  assert.equal(replies[1]?.id, 'explicit-target');
  assert.match(replies[1]?.error ?? '', /requires network access/);
  assert.equal(replies[2]?.ok, true);
  assert.equal(existsSync(command.path), false);
});

test('CLI/RPC rejects mismatched response correlation in both output modes without retrying', async (t) => {
  const directory = temporary();
  let calls = 0;
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      calls++;
      const request = parseRequest(buffer.slice(0, buffer.indexOf('\n')));
      if (request.command.command !== 'download')
        throw new Error('Expected download');
      // A message ID cannot be accepted as the response's RPC correlation.
      socket.end(
        JSON.stringify({
          id: request.command.messageId,
          ok: true,
          data: { bytes: 123 },
        }) + '\n',
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, 'control.sock'), resolve),
  );
  t.after(() => server.close());
  for (const output of ['full', 'compact']) {
    await assert.rejects(
      runFile(
        process.execPath,
        [
          'dist/src/cli.js',
          '--data-dir',
          directory,
          '--output',
          output,
          'download',
          '--jid',
          group,
          '--id',
          'fictional-document',
          '--out',
          join(directory, 'no-download.bin'),
        ],
        { timeout: 5000 },
      ),
      (error) => {
        assert.ok(error && typeof error === 'object' && 'stdout' in error);
        const response: { ok: boolean; code: string } = JSON.parse(
          String(error.stdout),
        );
        assert.equal(response.ok, false);
        assert.equal(response.code, 'PROTOCOL');
        return true;
      },
    );
  }
  assert.equal(calls, 2);
});
