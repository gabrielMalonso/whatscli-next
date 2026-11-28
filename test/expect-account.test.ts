import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { sqliteAuth } from '../src/auth.js';
import { accountUser, expectedAccount } from '../src/identity.js';
import {
  object,
  parseCommand,
  parseRequest,
  wireRequest,
} from '../src/protocol.js';
import { createRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';

process.umask(0o077);
const runFile = promisify(execFile);
const temporary = (): string => mkdtempSync(join(tmpdir(), 'whatscli-acct-'));
// Fictional account: its own PN JID carries a device suffix, as linked companions do.
const phone = '12025550199';
const accountJid = `${phone}:7@s.whatsapp.net`;
const other = '12025550188';
const chat = '12025550101@s.whatsapp.net';

function seed(directory: string, linked: boolean): void {
  const store = new Store(directory);
  try {
    const auth = sqliteAuth(store);
    auth.save({ me: { id: accountJid, lid: '123450001:7@lid' } });
    if (linked)
      auth.save({
        account: {
          details: Buffer.from('fictional-device-identity'),
          deviceSignature: Buffer.from('fictional-signature'),
        },
      });
  } finally {
    store.close();
  }
}

async function cli(
  directory: string,
  ...args: string[]
): Promise<{ result: Record<string, unknown>; exit: number }> {
  try {
    const { stdout } = await runFile(
      process.execPath,
      ['dist/src/cli.js', '--data-dir', directory, ...args],
      { timeout: 15000 },
    );
    return { result: JSON.parse(stdout) as Record<string, unknown>, exit: 0 };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'stdout' in error &&
      typeof error.stdout === 'string' &&
      error.stdout.trim()
    )
      return {
        result: JSON.parse(error.stdout) as Record<string, unknown>,
        exit: 'code' in error ? Number(error.code) : -1,
      };
    throw error;
  }
}

test('expectations normalize to the PN user part and never accept a LID', () => {
  for (const value of [
    phone,
    `+${phone}`,
    `${phone}@s.whatsapp.net`,
    accountJid,
  ])
    assert.equal(expectedAccount(value), phone, value);
  for (const value of [
    '',
    '123450001@lid',
    '123450001:7@lid',
    '120363000000000001@g.us',
    `0${phone}`,
    `${phone} `,
    'Fictional name',
    `${phone}@c.us`,
  ])
    assert.throws(
      () => expectedAccount(value),
      (error: Error & { code?: string }) => error.code === 'INVALID_ARGUMENT',
      value,
    );
  assert.equal(accountUser(accountJid), phone);
  assert.equal(accountUser(`${phone}@s.whatsapp.net`), phone);
  // No phone is ever derived from a LID or any other form.
  assert.equal(accountUser('123450001:7@lid'), null);
  assert.equal(accountUser(undefined), null);
});

test('the account wrapper carries the guarded wire name, never a plain guarded command', () => {
  const guarded = parseCommand({
    command: 'guarded-archive',
    jid: chat,
    key: 'fictional-key',
    value: true,
    ifLatestIncoming: 'FICTIONAL-IN-001',
  });
  const wire = wireRequest(guarded, phone);
  assert.equal(
    (wire.request as { command?: unknown }).command,
    'guarded-archive',
  );
  assert.deepEqual(parseRequest(JSON.stringify({ ...wire, id: 'fictional' })), {
    id: 'fictional',
    command: guarded,
    expectAccount: phone,
  });
  assert.equal(wireRequest(guarded).command, 'guarded-archive');
});

test('a repeated --expect-account is refused before any request', async () => {
  const directory = temporary();
  const result = await cli(
    directory,
    '--expect-account',
    '123450001',
    '--expect-account',
    phone,
    'chats',
  );
  assert.equal(result.exit, 1);
  assert.equal(result.result.code, 'INVALID_ARGUMENT');
  assert.match(String(result.result.error), /--expect-account once/);
});

test('the wire wrapper round-trips and an older parser refuses it', () => {
  const command = parseCommand({ command: 'chats', limit: 5 });
  assert.equal(wireRequest(command), command);
  const wire = wireRequest(command, phone);
  assert.deepEqual(wire, {
    command: 'expect-account',
    expectAccount: phone,
    request: command,
  });
  assert.deepEqual(parseRequest(JSON.stringify({ ...wire, id: 'fictional' })), {
    id: 'fictional',
    command,
    expectAccount: phone,
  });
  // A daemon built before the check parsed every request with this same switch.
  assert.throws(
    () => parseCommand(object({ ...wire, id: 'fictional' })),
    /Unknown command/,
  );
  for (const [request, message] of [
    [{ ...command, expectAccount: phone }, /requires the expect-account/],
    [{ ...wire, request: wire }, /Unknown command/],
    [{ ...wire, request: undefined }, /requires a request object/],
    [{ ...wire, request: [command] }, /requires a request object/],
    [{ ...wire, expectAccount: '123450001@lid' }, /LID is not accepted/],
    [{ ...wire, expectAccount: 5 }, /nonempty string/],
  ] as const)
    assert.throws(
      () => parseRequest(JSON.stringify({ ...request, id: 'fictional' })),
      message,
    );
});

test('the runtime compares only the linked account user part', async () => {
  const linked = temporary();
  seed(linked, true);
  const pairing = temporary();
  // Code pairing can set me before a signed account exists: not linked yet.
  seed(pairing, false);
  const empty = temporary();
  for (const [directory, expected, message] of [
    [linked, other, /not the expected account/],
    [pairing, phone, /No WhatsApp account is linked/],
    [empty, phone, /No WhatsApp account is linked/],
  ] as const) {
    const runtime = createRuntime({ dataDir: directory, connect: false });
    try {
      assert.throws(
        () => runtime.checkAccount(expected),
        (error: Error & { code?: string }) =>
          error.code === 'ACCOUNT_MISMATCH' && message.test(error.message),
      );
    } finally {
      await runtime.close();
    }
  }
  const runtime = createRuntime({ dataDir: linked, connect: false });
  try {
    runtime.checkAccount(phone);
  } finally {
    await runtime.close();
  }
});

test('CLI sends one wrapped request, keeps output unchanged and refuses before I/O', async (t) => {
  const directory = temporary();
  const requests: Record<string, unknown>[] = [];
  let legacy = false;
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = object(JSON.parse(buffer.trim()));
      requests.push(request);
      let response: Record<string, unknown>;
      if (legacy)
        try {
          // Emulate a daemon that predates the check: it parses the top-level command.
          parseCommand(request);
          response = { ok: true, data: [] };
        } catch (error) {
          response = {
            ok: false,
            error: (error as Error).message,
            code: 'INVALID_ARGUMENT',
          };
        }
      else response = { ok: true, data: [], running: true, source: 'local' };
      socket.end(JSON.stringify({ ...response, id: request.id }) + '\n');
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, 'control.sock'), resolve),
  );
  t.after(() => server.close());

  const plain = await cli(directory, 'chats', '--limit', '5');
  const expected = await cli(
    directory,
    '--expect-account',
    accountJid,
    'chats',
    '--limit',
    '5',
  );
  assert.equal(expected.exit, 0);
  // Only the per-call correlation id differs.
  const { id: plainId, ...plainRest } = plain.result;
  const { id: expectedId, ...expectedRest } = expected.result;
  assert.notEqual(plainId, expectedId);
  assert.deepEqual(expectedRest, plainRest);
  assert.equal(requests.length, 2, 'one request per command, no status call');
  assert.equal(requests[0]?.command, 'chats');
  assert.equal('expectAccount' in requests[0]!, false);
  const { id, ...wrapped } = requests[1]!;
  assert.equal(typeof id, 'string');
  assert.deepEqual(wrapped, {
    command: 'expect-account',
    expectAccount: phone,
    request: { command: 'chats', limit: 5, offset: 0 },
  });

  legacy = true;
  const refused = await cli(
    directory,
    'send',
    '--expect-account',
    phone,
    '--jid',
    chat,
    '--key',
    'fictional-key',
    '--text',
    'Fictional text',
  );
  assert.equal(refused.exit, 1);
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.code, 'PROTOCOL');
  assert.match(String(refused.result.error), /predate --expect-account/);
  assert.equal(requests.length, 3);
  assert.equal(requests[2]?.command, 'expect-account');

  const before = requests.length;
  for (const args of [
    ['--expect-account', '123450001@lid', 'chats'],
    ['--expect-account', 'Fictional name', 'status'],
    ['--expect-account', phone, 'start', '--offline'],
    ['--expect-account', phone, 'observability', 'status'],
  ]) {
    const response = await cli(directory, ...args);
    assert.equal(response.exit, 1, args.join(' '));
    assert.equal(response.result.code, 'INVALID_ARGUMENT', args.join(' '));
  }
  const help = await cli(directory, '--expect-account', phone, 'help');
  assert.equal(help.result.ok, true);
  assert.match(
    String(object(help.result.data).expectAccountOption),
    /ACCOUNT_MISMATCH/,
  );
  assert.equal(requests.length, before, 'refusals and help never connect');
});

test('an offline daemon refuses another account before any persist and serves the expected one unchanged', async (t) => {
  const directory = temporary();
  seed(directory, true);
  t.after(async () => {
    await cli(directory, 'stop');
  });
  assert.equal((await cli(directory, 'start', '--offline')).result.ok, true);

  const plain = await cli(directory, 'status');
  for (const value of [
    phone,
    `+${phone}`,
    `${phone}@s.whatsapp.net`,
    accountJid,
  ]) {
    const { result, exit } = await cli(
      directory,
      '--expect-account',
      value,
      'status',
    );
    assert.equal(exit, 0, value);
    assert.deepEqual(result.data, plain.result.data, value);
    assert.equal(result.pid, plain.result.pid);
    const chats = await cli(directory, '--expect-account', value, 'chats');
    assert.equal(chats.result.ok, true, value);
  }

  for (const args of [
    ['status'],
    ['chats'],
    [
      'send',
      '--jid',
      chat,
      '--key',
      'fictional-mismatch',
      '--text',
      'Fictional text',
    ],
    ['read', '--jid', chat, '--key', 'fictional-read'],
  ]) {
    const { result, exit } = await cli(
      directory,
      '--expect-account',
      other,
      ...args,
    );
    assert.equal(exit, 1, args[0]);
    assert.equal(result.code, 'ACCOUNT_MISMATCH', args[0]);
    assert.match(String(result.error), /nothing was done/);
    // The refusal carries no account identifiers.
    assert.doesNotMatch(JSON.stringify(result), new RegExp(phone));
  }
  for (const key of ['fictional-mismatch', 'fictional-read']) {
    const request = await cli(directory, 'request', '--key', key);
    assert.equal(request.result.ok, true);
    assert.equal(request.result.data, null, 'no intent was persisted');
  }
});

test('the JSONL probe applies the same check before executing', () => {
  const directory = temporary();
  seed(directory, true);
  const status = parseCommand({ command: 'status' });
  const line = (id: string, expect?: string) =>
    JSON.stringify({ ...wireRequest(status, expect), id });
  const child = spawnSync(
    process.execPath,
    ['dist/src/probe.js', '--data-dir', directory],
    {
      encoding: 'utf8',
      input:
        [
          line('match', accountJid),
          line('mismatch', other),
          JSON.stringify({ command: 'stop', id: 'stop' }),
        ].join('\n') + '\n',
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const output = child.stdout
    .trim()
    .split('\n')
    .map((value) => object(JSON.parse(value)));
  assert.deepEqual(
    output.map(({ id, ok, code }) => [id, ok, code]),
    [
      ['match', true, undefined],
      ['mismatch', false, 'ACCOUNT_MISMATCH'],
      ['stop', true, undefined],
    ],
  );
});
