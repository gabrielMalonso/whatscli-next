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
  for (const { action, response, jid } of responseFixtures) {
    const before = JSON.stringify(response);
    assert.equal(formatResponse(action, response, 'full', jid), response);
    const compact = formatResponse(action, response, 'compact', jid);
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
    verification: 'pending-phone-and-subsequent-client-observation',
    localChat: full[2],
  });
  const compactMutation = object(
    formatResponse('read', mutation, 'compact').data,
  );
  assert.deepEqual(compactMutation.request, uncertain);
  assert.equal(
    compactMutation.verification,
    'pending-phone-and-subsequent-client-observation',
  );
  assert.deepEqual(object(compactMutation.localChat).pending, full[2]?.pending);
});

test('history lifts only the exact chat and preserves direction, receipts, quote/card provenance and deletions', () => {
  const data = object(
    formatResponse('messages', publicResponse(history), 'compact', pn).data,
  );
  assert.equal(data.jid, pn);
  const messages = rows(data.messages);
  for (let i = 0; i < history.length; i++) {
    const compact = messages[i]!;
    const full = history[i]!;
    assert.equal('jid' in compact, false);
    for (const field of [
      'id',
      'fromMe',
      'participant',
      'timestamp',
      'text',
      'contentType',
      'status',
    ] as const) {
      assert.deepEqual(compact[field], full[field]);
    }
  }
  assert.deepEqual(messages[1]?.quote, history[1]?.quote);
  assert.deepEqual(messages[2]?.contacts, history[2]?.contacts);
  assert.equal(object(messages[2]?.contacts).source, 'shared-content');
  assert.deepEqual(messages[3]?.deletion, history[3]?.deletion);
  assert.equal(messages[3]?.text, null);
  assert.deepEqual(messages[4]?.deletion, history[4]?.deletion);
  assert.equal(messages[4]?.text, null);
  assert.deepEqual(messages[0]?.deletion, { status: 'unknown' });
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

test('search preserves cross-JID order and group participants even for colliding message IDs', () => {
  const fixture = responseFixtures.find((value) => value.action === 'search')!;
  const full = rows(fixture.response.data);
  const compact = rows(
    formatResponse('search', fixture.response, 'compact').data,
  );
  assert.deepEqual(
    compact.map((row) => [row.jid, row.id, row.fromMe, row.participant]),
    full.map((row) => [row.jid, row.id, row.fromMe, row.participant]),
  );
  assert.equal(compact[2]?.participant, lid);
  assert.ok(
    Array.isArray(
      formatResponse('messages', fixture.response, 'compact', pn).data,
    ),
    'mixed identities cannot inherit a JID',
  );
  assert.deepEqual(
    formatResponse('messages', publicResponse([]), 'compact', pn).data,
    { jid: pn, messages: [] },
  );
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
  const json = JSON.stringify(
    formatResponse('messages', response, 'compact', pn),
  );
  assert.equal(json.split('\n').length, 1);
  const parsed = object(JSON.parse(json));
  assert.equal(rows(object(parsed.data).messages)[0]?.text, text);
});
