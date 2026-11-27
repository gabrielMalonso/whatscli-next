import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatResponse } from '../src/response.js';
import { object } from '../src/protocol.js';
import { messageOutput } from '../src/output.js';
import {
  conflict,
  history,
  lid,
  pn,
  publicResponse,
  responseFixtures,
  uncertain,
} from './fixtures/responses.js';

function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}

test('full keeps the existing projection; compact is pure and keeps envelope evidence', () => {
  for (const { action, response } of responseFixtures) {
    const before = JSON.stringify(response);
    assert.equal(formatResponse(action, response, 'full'), response);
    const compact = formatResponse(action, response, 'compact');
    const { data: _full, ...envelope } = response;
    const { data: _compact, ...compactEnvelope } = compact;
    assert.deepEqual(compactEnvelope, envelope);
    assert.equal(JSON.stringify(response), before);
    assert.doesNotMatch(
      JSON.stringify(compact),
      /FICTIONAL_(SECRET|DELETED_BODY|BOUNDARY_BODY)_EXCLUDED|messageSecret|mediaKey/,
    );
  }
});

test('chat true/false/null, zero/manual/unknown counters, activity and pending intents remain distinct', () => {
  const fixture = responseFixtures.find((value) => value.action === 'chats')!;
  const full = rows(fixture.response.data);
  const compact = rows(
    formatResponse('chats', fixture.response, 'compact').data,
  );
  assert.deepEqual(
    compact.map((chat) => [
      chat.jid,
      chat.archived,
      chat.unread,
      chat.unreadCount,
      chat.activity,
    ]),
    full.map((chat) => [
      chat.jid,
      chat.archived,
      chat.unread,
      chat.unreadCount,
      chat.activity,
    ]),
  );
  assert.deepEqual(
    compact.map((chat) => chat.unreadCount),
    [0, -1, null, null],
  );
  assert.deepEqual(
    compact.map((chat) => chat.archived),
    [false, true, null, null],
  );
  assert.deepEqual(compact[2]?.pending, full[2]?.pending);
  assert.equal('pending' in compact[0]!, false);
  assert.equal('name' in compact[1]!, false);
  assert.deepEqual(
    formatResponse('chat', publicResponse(null), 'compact').data,
    null,
  );
  const mutation = publicResponse({
    request: uncertain,
    note: 'sdkReported is local SDK evidence; independent observation and phone confirmation remain separate.',
    localChat: full[2],
  });
  const compactMutation = object(
    formatResponse('read', mutation, 'compact').data,
  );
  assert.deepEqual(compactMutation.request, uncertain);
  assert.equal('verification' in compactMutation, false);
  assert.equal(compactMutation.note, object(mutation.data).note);
  assert.deepEqual(object(compactMutation.localChat).pending, full[2]?.pending);
});

/** Restores the documented compact absent = default contract for message rows. */
function expandMessage(row: Record<string, unknown>): Record<string, unknown> {
  return {
    participant: null,
    deletion: { status: 'unknown', source: null, observedAt: null },
    stubType: null,
    status: null,
    quote: null,
    contacts: null,
    media: null,
    ...row,
  };
}

test('messages and search keep data as an array of rows with exact JIDs in both modes', () => {
  const search = responseFixtures.find((value) => value.action === 'search')!;
  for (const action of ['messages', 'search']) {
    for (const response of [
      publicResponse(history),
      search.response,
      publicResponse([]),
    ]) {
      const before = JSON.stringify(response);
      const full = formatResponse(action, response, 'full');
      assert.equal(JSON.stringify(full), before, 'full stays byte-identical');
      const compact = formatResponse(action, response, 'compact');
      assert.ok(Array.isArray(compact.data), `${action} compact data`);
      assert.equal('jid' in compact, false, 'no hoisted envelope JID');
      const fullRows = rows(response.data);
      const compactRows = rows(compact.data);
      assert.equal(compactRows.length, fullRows.length);
      assert.deepEqual(
        compactRows.map((row) => [row.jid, row.id, row.fromMe]),
        fullRows.map((row) => [row.jid, row.id, row.fromMe]),
      );
      assert.deepEqual(compactRows.map(expandMessage), fullRows);
      assert.equal(JSON.stringify(response), before);
    }
  }
  assert.deepEqual(
    formatResponse('messages', publicResponse([]), 'compact').data,
    [],
  );
});

test('compact history preserves direction, receipts, quote/card provenance and deletion evidence', () => {
  const messages = rows(
    formatResponse('messages', publicResponse(history), 'compact').data,
  );
  for (let i = 0; i < history.length; i++) {
    const compact = messages[i]!;
    const full = history[i]!;
    assert.equal(compact.jid, pn);
    for (const field of [
      'id',
      'fromMe',
      'timestamp',
      'text',
      'contentType',
    ] as const) {
      assert.deepEqual(compact[field], full[field]);
    }
    // 1:1 fixtures carry no key participant or SDK status.
    assert.equal(full.participant, null);
    assert.equal('participant' in compact, false);
    assert.equal(full.status, null);
    assert.equal('status' in compact, false);
  }
  assert.deepEqual(messages[1]?.quote, history[1]?.quote);
  assert.deepEqual(messages[2]?.contacts, history[2]?.contacts);
  assert.equal(object(messages[2]?.contacts).source, 'shared-content');
  assert.deepEqual(messages[3]?.deletion, history[3]?.deletion);
  assert.equal(messages[3]?.text, null);
  assert.deepEqual(messages[4]?.deletion, history[4]?.deletion);
  assert.equal(object(messages[4]?.deletion).status, 'unknown');
  assert.equal(messages[4]?.text, null);
  assert.equal('deletion' in messages[0]!, false);
  assert.equal('quote' in messages[0]!, false);

  const missingQuote = messageOutput({
    key: { remoteJid: pn, id: 'missing-quote', fromMe: false },
    message: {
      extendedTextMessage: {
        text: 'Reply',
        contextInfo: { stanzaId: 'unknown-target' },
      },
    },
  });
  const unavailable = rows(
    formatResponse('search', publicResponse([missingQuote]), 'compact').data,
  )[0]!;
  assert.deepEqual(unavailable.quote, missingQuote.quote);
  assert.equal(object(unavailable.quote).state, 'unknown');
  assert.equal(object(unavailable.quote).text, null);
});

test('compact omits only exact message defaults and keeps every informative value', () => {
  const base = history[0]!;
  const unknown = { status: 'unknown', source: null, observedAt: null };
  const cases: [Record<string, unknown>, string[], string[]][] = [
    [{ ...base, participant: '' }, ['participant'], []],
    [
      { ...base, participant: null, status: null },
      ['participant', 'status'],
      [],
    ],
    [{ ...base, participant: lid, status: 2 }, [], ['participant', 'status']],
    [{ ...base, status: 0 }, [], ['status']],
    [{ ...base, deletion: { ...unknown } }, ['deletion'], []],
    [
      { ...base, deletion: { ...unknown, observedAt: 1700000000000 } },
      [],
      ['deletion'],
    ],
    [
      { ...base, deletion: { ...unknown, source: 'chat-delete-boundary' } },
      [],
      ['deletion'],
    ],
    [
      { ...base, deletion: { ...unknown, note: 'unfamiliar field' } },
      [],
      ['deletion'],
    ],
    [{ ...base, deletion: { status: 'unknown' } }, [], ['deletion']],
    [
      {
        ...base,
        text: null,
        contentType: null,
        timestamp: null,
        fromMe: null,
      },
      [],
      ['text', 'contentType', 'timestamp', 'fromMe'],
    ],
  ];
  for (const [row, omitted, kept] of cases) {
    const compact = rows(
      formatResponse('messages', publicResponse([row]), 'compact').data,
    )[0]!;
    for (const field of omitted)
      assert.equal(field in compact, false, `${field} omitted`);
    for (const field of kept) assert.deepEqual(compact[field], row[field]);
    assert.equal(compact.jid, row.jid);
  }
});

test('search preserves cross-JID order and group participants even for colliding message IDs', () => {
  const fixture = responseFixtures.find((value) => value.action === 'search')!;
  const full = rows(fixture.response.data);
  for (const action of ['search', 'messages']) {
    const compact = rows(
      formatResponse(action, fixture.response, 'compact').data,
    );
    assert.deepEqual(
      compact.map((row) => [row.jid, row.id, row.fromMe, row.participant]),
      full.map((row) => [
        row.jid,
        row.id,
        row.fromMe,
        row.participant ?? undefined,
      ]),
    );
    assert.equal(compact[2]?.participant, lid);
  }
});

test('contact conflicts retain every exact mapping and per-field provenance, including older/different sources', () => {
  const compact = object(
    formatResponse('contact', publicResponse(conflict), 'compact').data,
  );
  assert.deepEqual(compact.mapping, conflict.mapping);
  assert.deepEqual(compact.verification, conflict.verification);
  assert.equal(compact.phone, null);
  assert.equal(compact.historical, true);
  assert.equal('source' in compact, false); // Inherits envelope source: local.
  const entry = rows(compact.contacts)[0]!;
  const original = conflict.contacts[0]!;
  assert.equal(entry.jid, lid);
  assert.equal(entry.source, original.source);
  assert.equal(entry.observedAt, original.observedAt);
  const metadata = object(entry.metadata);
  assert.deepEqual(metadata.name, { value: 'Example contact' });
  assert.deepEqual(metadata.status, original.metadata.status);
  const resolution = {
    phone: '+12025550101',
    status: 'unknown',
    jid: null,
    source: 'whatsapp',
    contact: conflict,
  };
  const resolved = object(
    formatResponse('resolve', publicResponse(resolution), 'compact').data,
  );
  assert.equal(resolved.jid, null);
  assert.equal(resolved.status, 'unknown');
  assert.deepEqual(resolved.contact, compact);
});

test('uncertain intent, every receipt stage, zero status and errors are preserved without inferring success', () => {
  for (const action of ['send', 'send-file', 'request']) {
    for (const receipt of [
      uncertain,
      {
        ...uncertain,
        attempt: 'sdk-returned',
        acceptance: 'server-ack',
        errorObserved: false,
      },
      {
        ...uncertain,
        acceptance: 'server-ack',
        delivery: 'delivered',
        read: 'read',
      },
    ]) {
      const response = publicResponse(receipt);
      assert.deepEqual(formatResponse(action, response, 'compact'), response);
    }
    assert.deepEqual(
      formatResponse(action, publicResponse(null), 'compact').data,
      null,
    );
  }
  const zero = {
    ...history[0],
    fromMe: true,
    status: 0,
    stubType: 0,
    text: '',
  };
  const result = rows(
    formatResponse('search', publicResponse([zero]), 'compact').data,
  )[0]!;
  assert.equal(result.status, 0);
  assert.equal(result.stubType, 0);
  assert.equal(result.fromMe, true);
  assert.equal(result.text, '');
  for (const code of ['TIMEOUT', 'NOT_RUNNING', 'PROTOCOL']) {
    const error = {
      ok: false,
      code,
      error: 'Query the original key before another send',
    };
    assert.equal(formatResponse('send', error, 'compact'), error);
  }
});

test('Unicode, quotes, newlines and all content lengths are unchanged with no implicit truncation', () => {
  const text = 'Olá 👩🏽‍💻! "Sim"\n漢字\t<|endoftext|> ' + 'é'.repeat(10000);
  const response = publicResponse([{ ...history[0], text }]);
  const json = JSON.stringify(formatResponse('messages', response, 'compact'));
  assert.equal(json.split('\n').length, 1);
  const parsed = object(JSON.parse(json));
  assert.equal(rows(parsed.data)[0]?.text, text);
});
