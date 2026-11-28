import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { proto } from 'baileys';
import type { WAMessage } from 'baileys';
import { chatKind } from '../src/identity.js';
import { parseCommand, wireCommand } from '../src/protocol.js';
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
      joao.map(({ jid, observedChat, matchedFields }) => ({
        jid,
        observedChat,
        matchedFields,
      })),
      [
        { jid: lidJoao, observedChat: true, matchedFields: ['name', 'notify'] },
        { jid: pnJoao, observedChat: true, matchedFields: ['name', 'notify'] },
      ],
    );
    assert.deepEqual(joao[0]?.contact, store.contactSummary(lidJoao));
    assert.deepEqual(
      search('joao', 1, 1).map((row) => row.jid),
      [pnJoao],
    );
    // The conflicting LID does not inherit "Beatriz Other"; the PN without a chat sorts last.
    assert.deepEqual(
      search('bea').map(({ jid, observedChat, matchedFields }) => ({
        jid,
        observedChat,
        matchedFields,
      })),
      [
        { jid: lidConflict, observedChat: true, matchedFields: ['notify'] },
        { jid: pnBea, observedChat: false, matchedFields: ['name'] },
      ],
    );
    assert.deepEqual(
      search('Beatriz').map((row) => row.jid),
      [pnBea],
    );
    // Phone digits reach a LID only through a known mapping.
    assert.deepEqual(
      search('+1 202 555-0101').map(({ jid, matchedFields }) => [
        jid,
        matchedFields,
      ]),
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
      command: 'filtered-chats',
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
    {},
  ])
    assert.throws(() => parseCommand({ command: 'filtered-chats', ...value }), {
      code: 'INVALID_ARGUMENT',
    });
  // Plain chats never silently carries the filters an older daemon would drop.
  for (const value of [{ kinds: ['direct'] }, { include: ['contact'] }])
    assert.throws(() => parseCommand({ command: 'chats', ...value }), {
      code: 'INVALID_ARGUMENT',
    });
  assert.deepEqual(
    wireCommand({ command: 'chats', limit: 1, offset: 0, kinds: ['direct'] })
      .command,
    'filtered-chats',
  );
  assert.equal(
    wireCommand({ command: 'chats', limit: 1, offset: 0 }).command,
    'chats',
  );
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

/** A fake daemon; `reply` decides the response for each wire request. */
async function fakeDaemon(
  t: { after: (fn: () => void) => void },
  reply: (command: Record<string, unknown>) => Record<string, unknown>,
) {
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
      socket.end(JSON.stringify({ ...reply(command), id: command.id }) + '\n');
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, 'control.sock'), resolve),
  );
  t.after(() => server.close());
  return { directory, commands };
}

const unfiltered = publicResponse([
  { jid: status, name: null, pending: {} },
  { jid: lidNoName, name: null, pending: {} },
]);

test('a daemon without --kind/--include rejects filtered-chats, reported as PROTOCOL', async (t) => {
  // An older daemon knows only plain chats and returns unfiltered, unenriched rows.
  const { directory, commands } = await fakeDaemon(t, (command) =>
    command.command === 'chats'
      ? unfiltered
      : { ok: false, code: 'INVALID_ARGUMENT', error: 'Unknown command' },
  );
  // Rejected on the wire name, so even an offset page that happens to match cannot pass.
  for (const args of [
    ['chats', '--kind', 'direct', '--offset', '1'],
    ['chats', '--include', 'last-message'],
  ]) {
    const result = await cli(directory, ...args);
    assert.equal(result.code, 'PROTOCOL', args.join(' '));
    assert.equal(commands.at(-1)?.command, 'filtered-chats');
  }
  // Without the new options, the same daemon answers as before.
  assert.equal((await cli(directory, 'chats')).ok, true);
  assert.equal(commands.at(-1)?.command, 'chats');
  assert.equal('kinds' in commands.at(-1)!, false);
});

test('rows that ignore --kind or --include are PROTOCOL, also through --expect-account', async (t) => {
  // A daemon that accepts the request but does not apply it.
  const { directory, commands } = await fakeDaemon(t, () => unfiltered);
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
  const expected = await cli(
    directory,
    '--expect-account',
    '12025550199',
    'chats',
    '--kind',
    'direct',
  );
  assert.equal(expected.code, 'PROTOCOL');
  const wrapper = commands.at(-1) as {
    command: string;
    request: Record<string, unknown>;
  };
  assert.equal(wrapper.command, 'expect-account');
  assert.equal(wrapper.request.command, 'filtered-chats');
  assert.deepEqual(wrapper.request.kinds, ['direct']);
});

test('lastMessage skips own reactions, protocol rows and stubs; own deletions keep their author', () => {
  const store = new Store(temporary());
  try {
    seed(store);
    store.observeMessage(incoming(lidJoao, 'in-2', 500));
    // The account reacts and changes disappearing messages: neither answers.
    store.observeMessage({
      key: { remoteJid: lidJoao, id: 'react-1', fromMe: true },
      messageTimestamp: 510,
      message: {
        reactionMessage: {
          key: { remoteJid: lidJoao, id: 'in-2', fromMe: false },
          text: '👍',
        },
      },
    });
    store.observeMessage({
      key: { remoteJid: lidJoao, id: 'proto-1', fromMe: true },
      messageTimestamp: 520,
      message: {
        protocolMessage: {
          type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
          ephemeralExpiration: 86400,
        },
      },
    });
    store.observeMessage({
      key: { remoteJid: lidJoao, id: 'stub-1', fromMe: true },
      messageTimestamp: 530,
      messageStubType: proto.WebMessageInfo.StubType.E2E_ENCRYPTED,
    });
    const last = () =>
      new Map(
        (
          store.chats(100, 0, { kinds: ['direct'] }, ['last-message']) as Row[]
        ).map((row) => [row.jid, row.lastMessage]),
      ).get(lidJoao);
    assert.deepEqual(last(), {
      id: 'in-2',
      fromMe: false,
      timestamp: 500,
      contentType: 'conversation',
    });
    assert.deepEqual(store.lastMessage(lidJoao), last());
    // An own reply that is later deleted is still the account's message.
    const reply = incoming(lidJoao, 'out-2', 540, true);
    store.observeMessage(reply);
    store.deleteMessages({ keys: [reply.key] });
    assert.deepEqual(store.lastMessage(lidJoao), {
      id: 'out-2',
      fromMe: true,
      timestamp: 540,
      contentType: null,
    });
    assert.doesNotMatch(
      JSON.stringify(store.lastMessage(lidJoao)),
      /FICTIONAL_BODY/,
    );
  } finally {
    store.close();
  }
});

test('direct kind is only an exact PN or LID; device-suffixed and malformed ids are other', () => {
  assert.equal(chatKind(pnJoao), 'direct');
  assert.equal(chatKind(lidJoao), 'direct');
  for (const jid of [
    '12025550101:3@s.whatsapp.net',
    '0@s.whatsapp.net',
    '0123@lid',
    newsletter,
  ])
    assert.equal(chatKind(jid), 'other', jid);
  assert.equal(chatKind(status), 'broadcast');
  const store = new Store(temporary());
  try {
    store.observeChat({ id: '12025550101:3@s.whatsapp.net', unreadCount: 1 });
    store.observeChat({ id: pnJoao, unreadCount: 1 });
    assert.deepEqual(
      (store.chats(100, 0, { kinds: ['direct'] }, ['contact']) as Row[]).map(
        (row) => row.jid,
      ),
      [pnJoao],
    );
    assert.deepEqual(
      (store.chats(100, 0, { kinds: ['other'] }, ['contact']) as Row[]).map(
        (row) => [row.jid, row.contact],
      ),
      [['12025550101:3@s.whatsapp.net', null]],
    );
  } finally {
    store.close();
  }
});

test('SQL contact lookup equals a brute-force oracle over summaries, including conflicts and paging', () => {
  const store = new Store(temporary());
  const names = ['Ana Exâmple', 'ANDRÉ Sample', 'Bea', 'Joana', 'Zé'];
  try {
    store.transaction(() => {
      for (let i = 0; i < 120; i++) {
        const pn = `120255${String(10000 + i)}@s.whatsapp.net`;
        const lid = `${700000 + i}@lid`;
        // Known pairs, unknown endpoints, and conflicts in both directions.
        if (i % 5 !== 4) store.observeMapping(pn, lid, 'lid-mapping.update', i);
        if (i % 7 === 0)
          store.observeMapping(pn, `${800000 + i}@lid`, 'message-key', i);
        if (i % 11 === 0)
          store.observeMapping(
            `120255${String(20000 + i)}@s.whatsapp.net`,
            lid,
            'contacts.update',
            i,
          );
        if (i % 2 === 0)
          store.observeContact(
            { id: pn, name: `${names[i % names.length]} ${i}` },
            'contacts.upsert',
          );
        if (i % 3 === 0)
          store.observeContact(
            { id: lid, notify: names[(i + 2) % names.length]! },
            'contacts.update',
          );
        if (i % 4 === 0)
          store.observeChat({
            id: i % 8 ? lid : pn,
            ...(i % 12 ? { conversationTimestamp: 1000 + (i % 9) } : {}),
          });
      }
    });
    const fold = (value: string) =>
      value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    const jids = new Set<string>();
    for (const sql of [
      "SELECT id AS jid FROM values_store WHERE category='contact'",
      'SELECT pn AS jid FROM identity_mappings',
      'SELECT lid AS jid FROM identity_mappings',
      'SELECT jid FROM chats',
    ])
      for (const row of store.db.prepare(sql).all()) jids.add(String(row.jid));
    const activity = new Map(
      store.db
        .prepare('SELECT jid,activity_timestamp FROM chats')
        .all()
        .map((row) => [String(row.jid), Number(row.activity_timestamp) || 0]),
    );
    const oracle = (query: string) => {
      const text = fold(query.trim());
      const digits = /^\+?[\d\s().-]+$/.test(query.trim())
        ? query.replace(/\D/g, '')
        : '';
      return [...jids]
        .flatMap((jid) => {
          const contact = store.contactSummary(jid);
          if (!contact) return [];
          const matched =
            contact.labels.some((label) => fold(label.value).includes(text)) ||
            (digits.length >= 3 && !!contact.phone?.slice(1).includes(digits));
          return matched ? [jid] : [];
        })
        .sort((a, b) => {
          const x = activity.has(a) ? activity.get(a)! : -1;
          const y = activity.has(b) ? activity.get(b)! : -1;
          return (
            Number(activity.has(b)) - Number(activity.has(a)) ||
            y - x ||
            (a < b ? -1 : a > b ? 1 : 0)
          );
        });
    };
    for (const query of [
      'an',
      'andre',
      'exa',
      'Zé',
      'bea 1',
      '2025510',
      '+1 202 551 0003',
      '700001',
      '20020',
      'no match here',
    ]) {
      const expected = oracle(query);
      const actual = store.contactSearch(query, 100).map((row) => row.jid);
      assert.deepEqual(actual, expected.slice(0, 100), query);
      assert.deepEqual(
        store.contactSearch(query, 7, 5).map((row) => row.jid),
        expected.slice(5, 12),
        query,
      );
      for (const row of store.contactSearch(query, 100))
        assert.ok(row.matchedFields.length > 0, `${query} ${row.jid}`);
    }
    // LID digits alone never match, even though 700001@lid exists: every
    // phone match comes from a PN number.
    for (const row of store.contactSearch('700001', 100))
      assert.ok(row.contact.phone?.includes('700001'), row.jid);
  } finally {
    store.close();
  }
});
