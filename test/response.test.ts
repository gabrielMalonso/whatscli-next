import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatResponse } from '../src/response.js';
import { object } from '../src/protocol.js';
import { messageOutput } from '../src/output.js';
import {
  conflict,
  history,
  issueHistory,
  lid,
  liveResponse,
  observability,
  pn,
  publicResponse,
  responseFixtures,
  status,
  uncertain,
} from './fixtures/responses.js';

function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}

const steady = {
  reason: null,
  code: null,
  attempt: 0,
  nextRetryAt: null,
};

/** Checks the documented compact envelope: only steady recovery is omitted and inactive issues are counted. */
function assertEnvelope(
  compact: Record<string, unknown>,
  full: Record<string, unknown>,
): void {
  const { data: _data, recovery, issues, activeIssues, ...evidence } = full;
  for (const [field, value] of Object.entries(evidence))
    assert.deepEqual(compact[field], value, `${field} kept`);
  if ('recovery' in compact) assert.deepEqual(compact.recovery, recovery);
  else {
    const { since, ...current } = object(recovery);
    assert.deepEqual(current, { state: full.connection, ...steady });
    assert.equal(typeof since, 'number');
  }
  assert.ok(Array.isArray(issues) && Array.isArray(activeIssues));
  assert.equal('issues' in compact, false);
  assert.deepEqual(compact.activeIssues ?? [], activeIssues);
  assert.notDeepEqual(compact.activeIssues, []);
  assert.equal(
    compact.inactiveIssues ?? 0,
    issues.length - activeIssues.length,
  );
  assert.notEqual(compact.inactiveIssues, 0);
  assert.deepEqual(
    Object.keys(compact).filter(
      (field) =>
        !(field in full) && field !== 'inactiveIssues' && field !== 'data',
    ),
    [],
  );
}

test('full keeps the existing projection; compact is pure and keeps envelope evidence', () => {
  for (const { action, response } of responseFixtures) {
    const before = JSON.stringify(response);
    assert.equal(formatResponse(action, response, 'full'), response);
    const compact = formatResponse(action, response, 'compact');
    assertEnvelope(compact, response);
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
      const compact = formatResponse(action, response, 'compact');
      assert.deepEqual(compact.data, response.data);
      assertEnvelope(compact, response);
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

test('compact omits recovery only at the exact steady open/offline default', () => {
  const base = object(liveResponse([]).recovery);
  const cases: [Record<string, unknown>, unknown, boolean][] = [
    [base, 'open', true],
    [{ ...base, state: 'offline' }, 'offline', true],
    [{ ...base, state: 'offline' }, 'open', false],
    [base, 'close', false],
    [{ ...base, attempt: 1 }, 'open', false],
    [{ ...base, reason: 'manual-reconnect' }, 'open', false],
    [{ ...base, code: 428 }, 'open', false],
    [{ ...base, nextRetryAt: 1700000001000 }, 'open', false],
    [{ ...base, since: null }, 'open', false],
    [{ ...base, note: 'unfamiliar field' }, 'open', false],
    [
      {
        state: 'connecting',
        reason: 'startup',
        code: null,
        attempt: 0,
        nextRetryAt: null,
        since: 1,
      },
      'connecting',
      false,
    ],
    [
      {
        state: 'waiting-retry',
        reason: 'connection-closed',
        code: 428,
        attempt: 2,
        nextRetryAt: 1700000004000,
        since: 1,
      },
      'close',
      false,
    ],
    [
      {
        state: 'intervention-required',
        reason: 'logged-out',
        code: 401,
        attempt: 0,
        nextRetryAt: null,
        since: 1,
      },
      'close',
      false,
    ],
  ];
  for (const [recovery, connection, omitted] of cases) {
    const response = { ...liveResponse(null), recovery, connection };
    const compact = formatResponse('request', response, 'compact');
    assert.equal(compact.connection, connection);
    if (omitted) assert.equal('recovery' in compact, false);
    else assert.deepEqual(compact.recovery, recovery);
    assert.equal(
      JSON.stringify(formatResponse('request', response, 'full')),
      JSON.stringify(response),
    );
  }
});

test('compact lists active issues with timing and counts only inactive history', () => {
  const active = {
    code: 'decryption-or-integrity-failure',
    count: 3,
    firstAt: 1700000000000,
    lastAt: 1700000060000,
  };
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ issues: [], activeIssues: [] }, {}],
    [
      {
        issues: ['decryption-or-integrity-failure', 'initial-sync-timed-out'],
        activeIssues: [],
      },
      { inactiveIssues: 2 },
    ],
    [
      {
        issues: ['decryption-or-integrity-failure', 'initial-sync-timed-out'],
        activeIssues: [active],
      },
      { activeIssues: [active], inactiveIssues: 1 },
    ],
    [
      { issues: ['decryption-or-integrity-failure'], activeIssues: [active] },
      { activeIssues: [active] },
    ],
    // Older daemon: no activity evidence, so history stays listed unchanged.
    [
      { issues: ['initial-sync-timed-out'] },
      { issues: ['initial-sync-timed-out'] },
    ],
    [{ issues: [] }, {}],
    // Inconsistent or malformed activity is never trusted to hide history.
    [
      { issues: ['initial-sync-timed-out'], activeIssues: [active] },
      { issues: ['initial-sync-timed-out'], activeIssues: [active] },
    ],
    [
      {
        issues: ['decryption-or-integrity-failure'],
        activeIssues: [active, active],
      },
      {
        issues: ['decryption-or-integrity-failure'],
        activeIssues: [active, active],
      },
    ],
    [
      { issues: ['decryption-or-integrity-failure'], activeIssues: null },
      { issues: ['decryption-or-integrity-failure'], activeIssues: null },
    ],
  ];
  for (const [issues, expected] of cases) {
    const {
      issues: _issues,
      activeIssues: _active,
      ...base
    } = liveResponse(null);
    const response = { ...base, ...issues };
    const compact = formatResponse('request', response, 'compact');
    assert.deepEqual(
      Object.fromEntries(
        ['issues', 'activeIssues', 'inactiveIssues']
          .filter((field) => field in compact)
          .map((field) => [field, compact[field]]),
      ),
      expected,
    );
    assert.equal(formatResponse('request', response, 'full'), response);
  }
});

test('compact status summarizes observability and leaves the timed issue history to full output', () => {
  for (const action of ['status', 'start']) {
    const response = liveResponse(
      action === 'start' ? { ...status, alreadyRunning: true } : status,
    );
    const before = JSON.stringify(response);
    assert.equal(
      JSON.stringify(formatResponse(action, response, 'full')),
      before,
    );
    const compact = object(formatResponse(action, response, 'compact').data);
    assert.deepEqual(compact.observability, {
      configured: true,
      enabled: true,
      effective: true,
      degraded: false,
      dropped: 0,
      uncertain: 0,
      captureCompleteness: 'unknown',
    });
    assert.equal('issueHistory' in compact, false);
    const {
      observability: _observability,
      issueHistory: _issueHistory,
      ...rest
    } = object(response.data);
    for (const [field, value] of Object.entries(rest))
      assert.deepEqual(compact[field], value, `${field} kept`);
    assert.equal(JSON.stringify(response), before);
  }
  const failing = {
    ...observability,
    effective: false,
    degraded: true,
    dropped: 4,
    uncertain: 1,
    cleanupFailures: 2,
    hashingFailures: 1,
    preferenceWatchDegraded: true,
  };
  assert.deepEqual(
    object(
      formatResponse(
        'status',
        liveResponse({ ...status, observability: failing }),
        'compact',
      ).data,
    ).observability,
    {
      configured: true,
      enabled: true,
      effective: false,
      degraded: true,
      dropped: 4,
      uncertain: 1,
      captureCompleteness: 'unknown',
      cleanupFailures: 2,
      hashingFailures: 1,
      preferenceWatchDegraded: true,
    },
  );
  // Unconfigured capture keeps its explicit null/false values.
  assert.deepEqual(
    object(
      formatResponse(
        'status',
        liveResponse({
          ...status,
          observability: { ...observability, configured: null, enabled: false },
        }),
        'compact',
      ).data,
    ).observability,
    {
      configured: null,
      enabled: false,
      effective: true,
      degraded: false,
      dropped: 0,
      uncertain: 0,
      captureCompleteness: 'unknown',
    },
  );
  // A stopped status from the CLI has no envelope or observability to compact.
  const stopped = {
    ok: true,
    running: false,
    data: { running: false, alreadyStopped: false },
  };
  assert.deepEqual(formatResponse('status', stopped, 'compact'), stopped);
  assert.ok(issueHistory.every((entry) => entry.active === false));
});
