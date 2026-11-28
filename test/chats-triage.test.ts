import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { WAMessage } from 'baileys';
import { parseCommand } from '../src/protocol.js';
import { formatResponse } from '../src/response.js';
import { Store } from '../src/store.js';
import { publicResponse } from './fixtures/responses.js';

process.umask(0o077);
const temporary = () => mkdtempSync(join(tmpdir(), 'chats-triage-'));
const runFile = promisify(execFile);

// Fictional identities only.
const pnJoao = '12025550101@s.whatsapp.net';
const lidJoao = '123450001@lid';
const lidConflict = '123450002@lid';
const pnBea = '12025550102@s.whatsapp.net';
const pnOther = '12025550103@s.whatsapp.net';
const lidNoName = '123450003@lid';
const group = '120363000000000001@g.us';
const status = 'status@broadcast';
const newsletter = '120363000000000002@newsletter';

const incoming = (
  jid: string,
  id: string,
  timestamp: number,
  fromMe = false,
): WAMessage => ({
  key: { remoteJid: jid, id, fromMe },
  messageTimestamp: timestamp,
  message: { conversation: `FICTIONAL_BODY_${id}` },
});

function seed(store: Store): void {
  const chats: [string, number, string?][] = [
    [status, 600],
    [lidNoName, 500],
    [group, 450, 'Fictional group'],
    [lidJoao, 400],
    [lidConflict, 350],
    [pnJoao, 300],
    [newsletter, 100],
  ];
  for (const [id, conversationTimestamp, name] of chats)
    store.observeChat({
      id,
      unreadCount: 1,
      conversationTimestamp,
      ...(name ? { name } : {}),
    });
  // João: the account's own name on the PN record, a push name on the LID record, known mapping.
  store.observeContact({ id: pnJoao, name: 'João Example' }, 'contacts.upsert');
  store.observeContact({ id: lidJoao, notify: 'Joãozinho' }, 'contacts.update');
  store.observeMapping(pnJoao, lidJoao, 'lid-mapping.update', 100);
  // Contradictory evidence: this LID has two PNs, so neither name nor phone transfers.
  store.observeContact(
    { id: lidConflict, notify: 'Bea Example' },
    'contacts.update',
  );
  store.observeContact({ id: pnBea, name: 'Beatriz Other' }, 'contacts.upsert');
  store.observeMapping(pnBea, lidConflict, 'lid-mapping.update', 100);
  store.observeMapping(pnOther, lidConflict, 'message-key', 200);
  store.observeMessage(incoming(lidJoao, 'in-1', 390));
  store.observeMessage(incoming(lidJoao, 'out-1', 400, true));
  const deleted = incoming(pnJoao, 'del-1', 300);
  store.observeMessage(deleted);
  store.deleteMessages({ keys: [deleted.key] });
}

type Row = Record<string, unknown> & { jid: string };

test('chats --kind filters by exact JID server before paging; the default still lists every kind', () => {
  const store = new Store(temporary());
  try {
    seed(store);
    const jids = (rows: unknown[]) => rows.map((row) => (row as Row).jid);
    assert.deepEqual(jids(store.chats()), [
      status,
      lidNoName,
      group,
      lidJoao,
      lidConflict,
      pnJoao,
      newsletter,
    ]);
    // Without --include, rows are unchanged.
    for (const row of store.chats() as Row[]) {
      assert.equal('contact' in row, false);
      assert.equal('lastMessage' in row, false);
    }
    assert.deepEqual(jids(store.chats(100, 0, { kinds: ['direct'] })), [
      lidNoName,
      lidJoao,
      lidConflict,
      pnJoao,
    ]);
    // Pagination counts only matching rows: status and the group no longer occupy page slots.
    assert.deepEqual(jids(store.chats(2, 1, { kinds: ['direct'] })), [
      lidJoao,
      lidConflict,
    ]);
    assert.deepEqual(
      jids(store.chats(100, 0, { kinds: ['group', 'broadcast'] })),
      [status, group],
    );
    assert.deepEqual(jids(store.chats(100, 0, { kinds: ['other'] })), [
      newsletter,
    ]);
    // Kind combines with state filters.
    assert.deepEqual(
      jids(store.chats(100, 0, { unread: true, kinds: ['direct'] })),
      [lidNoName, lidJoao, lidConflict, pnJoao],
    );
  } finally {
    store.close();
  }
});

test('chats --include contact gives observed labels with provenance; phone never comes from LID digits', () => {
  const store = new Store(temporary());
  try {
    seed(store);
    const rows = new Map(
      (store.chats(100, 0, {}, ['contact']) as Row[]).map((row) => [
        row.jid,
        row.contact,
      ]),
    );
    assert.deepEqual(rows.get(lidNoName), {
      phone: null,
      mapping: 'unknown',
      labels: [],
    });
    const joao = rows.get(lidJoao) as {
      phone: string;
      mapping: string;
      labels: Record<string, unknown>[];
    };
    assert.equal(joao.phone, '+12025550101');
    assert.equal(joao.mapping, 'known');
    assert.deepEqual(
      joao.labels.map(({ field, value, jid, source }) => ({
        field,
        value,
        jid,
        source,
      })),
      [
        {
          field: 'name',
          value: 'João Example',
          jid: pnJoao,
          source: 'contacts.upsert',
        },
        {
          field: 'notify',
          value: 'Joãozinho',
          jid: lidJoao,
          source: 'contacts.update',
        },
      ],
    );
    assert.ok(
      joao.labels.every((label) => typeof label.observedAt === 'number'),
    );
    assert.deepEqual(
      (rows.get(pnJoao) as { labels: { jid: string }[] }).labels.map(
        (label) => label.jid,
      ),
      [pnJoao, lidJoao],
    );
    // Conflict: only the exact LID's own label, and no phone.
    assert.deepEqual(
      {
        ...(rows.get(lidConflict) as Record<string, unknown>),
        labels: (
          rows.get(lidConflict) as { labels: { value: string }[] }
        ).labels.map((label) => label.value),
      },
      { phone: null, mapping: 'conflict', labels: ['Bea Example'] },
    );
    for (const jid of [group, status, newsletter])
      assert.equal(rows.get(jid), null);
    assert.doesNotMatch(
      JSON.stringify(
        [...rows.values()].map(
          (row) => (row as { phone?: unknown } | null)?.phone,
        ),
      ),
      /12345000/,
    );
  } finally {
    store.close();
  }
});

test('chats --include last-message is the first messages row without text, including own and deleted rows', () => {
  const store = new Store(temporary());
  try {
    seed(store);
    const rows = store.chats(100, 0, { kinds: ['direct'] }, [
      'last-message',
    ]) as Row[];
    const last = new Map(rows.map((row) => [row.jid, row.lastMessage]));
    assert.deepEqual(last.get(lidJoao), {
      id: 'out-1',
      fromMe: true,
      timestamp: 400,
      contentType: 'conversation',
    });
    assert.equal(
      (last.get(lidJoao) as { id: string }).id,
      store.messageView(store.messages(lidJoao, 1)[0]!).id,
    );
    // A deleted row has no readable content type.
    assert.deepEqual(last.get(pnJoao), {
      id: 'del-1',
      fromMe: false,
      timestamp: 300,
      contentType: null,
    });
    assert.equal(last.get(lidNoName), null);
    assert.doesNotMatch(JSON.stringify(rows), /FICTIONAL_BODY/);
  } finally {
    store.close();
  }
});

test('contacts lookup matches observed labels and known phone digits only, with explicit provenance', () => {
  const store = new Store(temporary());
  try {
    seed(store);
    const search = (query: string, limit?: number, offset?: number) =>
      store.contactSearch(query, limit, offset);
    // Accent- and case-insensitive; the known LID alias inherits the PN label.
    const joao = search('JOAO');
    assert.deepEqual(
      joao.map(({ jid, observedChat, matchedBy }) => ({
        jid,
        observedChat,
        matchedBy,
      })),
      [
        { jid: lidJoao, observedChat: true, matchedBy: ['name', 'notify'] },
        { jid: pnJoao, observedChat: true, matchedBy: ['name', 'notify'] },
      ],
    );
    assert.deepEqual(joao[0]?.contact, store.contactSummary(lidJoao));
    assert.deepEqual(
      search('joao', 1, 1).map((row) => row.jid),
      [pnJoao],
    );
    // The conflicting LID does not inherit "Beatriz Other"; the PN without a chat sorts last.
    assert.deepEqual(
      search('bea').map(({ jid, observedChat, matchedBy }) => ({
        jid,
        observedChat,
        matchedBy,
      })),
      [
        { jid: lidConflict, observedChat: true, matchedBy: ['notify'] },
        { jid: pnBea, observedChat: false, matchedBy: ['name'] },
      ],
    );
    assert.deepEqual(
      search('Beatriz').map((row) => row.jid),
      [pnBea],
    );
    // Phone digits reach a LID only through a known mapping.
    assert.deepEqual(
      search('+1 202 555-0101').map(({ jid, matchedBy }) => [jid, matchedBy]),
      [
        [lidJoao, ['phone']],
        [pnJoao, ['phone']],
      ],
    );
    assert.deepEqual(
      search('5550102').map((row) => row.jid),
      [pnBea],
    );
    assert.deepEqual(
      search('5550103').map((row) => row.jid),
      [pnOther],
    );
    // LID digits are never a phone number, and LIDs without labels never match.
    assert.deepEqual(search('123450003'), []);
    assert.deepEqual(search('12345'), []);
    // Group subjects are chat names, not contact labels.
    assert.deepEqual(search('Fictional group'), []);
  } finally {
    store.close();
  }
});

test('socket validation of kinds, include and contacts queries', () => {
  assert.deepEqual(
    parseCommand({
      command: 'chats',
      kinds: ['group', 'direct'],
      include: ['last-message', 'contact'],
    }),
    {
      command: 'chats',
      limit: 100,
      offset: 0,
      kinds: ['direct', 'group'],
      include: ['contact', 'last-message'],
    },
  );
  for (const value of [
    { kinds: [] },
    { kinds: ['direct', 'direct'] },
    { kinds: ['person'] },
    { kinds: 'direct' },
    { include: ['text'] },
  ])
    assert.throws(() => parseCommand({ command: 'chats', ...value }), {
      code: 'INVALID_ARGUMENT',
    });
  assert.deepEqual(parseCommand({ command: 'contacts', query: ' Ana ' }), {
    command: 'contacts',
    query: 'Ana',
    limit: 20,
    offset: 0,
  });
  for (const query of [undefined, '', ' a ', 7])
    assert.throws(() => parseCommand({ command: 'contacts', query }), {
      code: 'INVALID_ARGUMENT',
    });
  assert.throws(
    () => parseCommand({ command: 'contacts', query: 'Ana', limit: 101 }),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('compact enrichment drops label times and own-JID label jids, never provenance or null meanings', () => {
  const store = new Store(temporary());
  try {
    seed(store);
    const rows = store.chats(100, 0, {}, ['contact', 'last-message']);
    const full = publicResponse(rows);
    assert.deepEqual(formatResponse('chats', full, 'full'), full);
    const compact = formatResponse('chats', full, 'compact').data as Row[];
    const byJid = new Map(compact.map((row) => [row.jid, row]));
    assert.deepEqual(
      (byJid.get(lidJoao)?.contact as Record<string, unknown>).labels,
      [
        {
          field: 'name',
          value: 'João Example',
          jid: pnJoao,
          source: 'contacts.upsert',
        },
        { field: 'notify', value: 'Joãozinho', source: 'contacts.update' },
      ],
    );
    assert.equal(byJid.get(group)?.contact, null);
    assert.equal(byJid.get(lidNoName)?.lastMessage, null);
    assert.deepEqual(byJid.get(lidNoName)?.contact, {
      phone: null,
      mapping: 'unknown',
      labels: [],
    });
    const results = store.contactSearch('joao');
    const contacts = formatResponse(
      'contacts',
      publicResponse(results),
      'compact',
    ).data as { jid: string; contact: { labels: Record<string, unknown>[] } }[];
    assert.deepEqual(
      contacts.map((row) =>
        row.contact.labels.map((label) => label.jid ?? row.jid),
      ),
      results.map((row) => row.contact!.labels.map((label) => label.jid)),
    );
    assert.ok(
      contacts.every((row) =>
        row.contact.labels.every((label) => !('observedAt' in label)),
      ),
    );
  } finally {
    store.close();
  }
});

async function cli(directory: string, ...args: string[]) {
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
}

test('offline CLI triage: kind, include and contacts lookup through the daemon', async (t) => {
  const directory = temporary();
  const store = new Store(directory);
  seed(store);
  store.close();
  t.after(async () => {
    await cli(directory, 'stop');
  });
  assert.equal((await cli(directory, 'start', '--offline')).ok, true);
  const page = await cli(
    directory,
    '--output',
    'compact',
    'chats',
    '--unread',
    'true',
    '--kind',
    'direct',
    '--include',
    'contact,last-message',
    '--limit',
    '2',
  );
  assert.equal(page.ok, true);
  assert.equal(page.source, 'local');
  const rows = page.data as Row[];
  assert.deepEqual(
    rows.map((row) => row.jid),
    [lidNoName, lidJoao],
  );
  assert.deepEqual(rows[1]?.lastMessage, {
    id: 'out-1',
    fromMe: true,
    timestamp: 400,
    contentType: 'conversation',
  });
  assert.equal((rows[1]?.contact as { phone: string }).phone, '+12025550101');
  assert.deepEqual(
    ((await cli(directory, 'chats', '--kind', 'all')).data as Row[]).length,
    7,
  );
  const lookup = await cli(directory, 'contacts', '--query', 'joão');
  assert.equal(lookup.ok, true);
  assert.deepEqual(
    (lookup.data as Row[]).map((row) => row.jid),
    [lidJoao, pnJoao],
  );
  for (const args of [
    ['chats', '--kind', 'direct,person'],
    ['chats', '--kind', 'direct,direct'],
    ['chats', '--include', 'text'],
    ['contacts'],
    ['contacts', '--query', 'x'],
    ['contacts', '--query', 'joao', '--jid', pnJoao],
  ]) {
    const result = await cli(directory, ...args);
    assert.equal(result.ok, false, args.join(' '));
    assert.equal(result.code, 'INVALID_ARGUMENT', args.join(' '));
  }
  const help = (await cli(directory, 'help')).data as {
    commands: Record<string, string>;
  };
  assert.match(help.commands.contacts!, /never addressing or authorization/);
  assert.match(help.commands.chats!, /--kind/);
});

test('a daemon that ignores --kind or --include is reported as PROTOCOL, not as filtered rows', async (t) => {
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
      // An older daemon drops unknown fields and returns unfiltered, unenriched rows.
      socket.end(
        JSON.stringify({
          ...publicResponse([
            { jid: status, name: null, pending: {} },
            { jid: lidNoName, name: null, pending: {} },
          ]),
          id: command.id,
        }) + '\n',
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, 'control.sock'), resolve),
  );
  t.after(() => server.close());
  const filtered = await cli(directory, 'chats', '--kind', 'direct');
  assert.equal(filtered.ok, false);
  assert.equal(filtered.code, 'PROTOCOL');
  assert.deepEqual(commands.at(-1)?.kinds, ['direct']);
  const enriched = await cli(
    directory,
    'chats',
    '--kind',
    'direct,broadcast',
    '--include',
    'contact',
  );
  assert.equal(enriched.code, 'PROTOCOL');
  assert.deepEqual(commands.at(-1)?.include, ['contact']);
  // Without the new options, the same response is passed through unchanged.
  assert.equal((await cli(directory, 'chats')).ok, true);
  assert.equal('kinds' in commands.at(-1)!, false);
});
