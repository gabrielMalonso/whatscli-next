import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatResponse } from '../src/response.js';
import { Store } from '../src/store.js';
import {
  publicResponse,
  responseFixtures,
} from '../test/fixtures/responses.js';

// Ranks are bundled in the pinned devDependency; no network or model/API calls.
const tokenizer = new Tiktoken(o200k);
function measure(value: unknown) {
  const json = JSON.stringify(value);
  return {
    bytes: Buffer.byteLength(json),
    tokens: tokenizer.encode(json, [], []).length,
  };
}
const reduction = (full: number, compact: number): number =>
  Number((((full - compact) / full) * 100).toFixed(2));
/** Everything except `data`: running/connection state, recovery, issues and provenance. */
function envelope(value: Record<string, unknown>) {
  const { data: _data, ...rest } = value;
  return measure(rest);
}
const scenarios = responseFixtures.map(({ name, action, response }) => {
  const fullResponse = formatResponse(action, response, 'full');
  const compactResponse = formatResponse(action, response, 'compact');
  const full = measure(fullResponse);
  const compact = measure(compactResponse);
  return {
    scenario: name,
    full,
    compact,
    reductionPercent: {
      bytes: reduction(full.bytes, compact.bytes),
      tokens: reduction(full.tokens, compact.tokens),
    },
    envelopeBytes: {
      full: envelope(fullResponse).bytes,
      compact: envelope(compactResponse).bytes,
    },
  };
});
/**
 * A typical unread triage page (fictional): 20 unread rows, of which status,
 * 7 groups and 12 direct chats (9 LID, 3 PN; few names). Baseline: identify
 * every direct row and its last message with chats + contact + messages
 * --limit 1 per row. New: one chats --kind direct --include call.
 */
function triage() {
  const directory = mkdtempSync(join(tmpdir(), 'benchmark-triage-'));
  const store = new Store(directory);
  try {
    const at = 1700000000;
    const direct: string[] = [];
    store.observeChat({
      id: 'status@broadcast',
      unreadCount: 3,
      conversationTimestamp: at + 100,
    });
    for (let i = 0; i < 7; i++)
      store.observeChat({
        id: `12036300000000000${i}@g.us`,
        name: `Fictional group ${i}`,
        unreadCount: 2,
        conversationTimestamp: at + 90 - i * 7,
      });
    for (let i = 0; i < 12; i++) {
      const lid = i < 9;
      const jid = lid ? `12345000${i}@lid` : `120255501${i}@s.whatsapp.net`;
      direct.push(jid);
      store.observeChat({
        id: jid,
        unreadCount: 1,
        conversationTimestamp: at + 95 - i * 7,
      });
      if (lid && i < 5)
        store.observeMapping(
          `120255502${i}@s.whatsapp.net`,
          jid,
          'lid-mapping.update',
        );
      if (i % 3 !== 2)
        store.observeContact(
          lid
            ? { id: jid, notify: `Fictional person ${i}` }
            : { id: jid, name: `Fictional contact ${i}` },
          'contacts.update',
        );
      for (const [n, fromMe] of [
        [0, i % 3 === 0],
        [1, false],
      ] as const)
        store.observeMessage({
          key: { remoteJid: jid, id: `FICTIONAL-${i}-${n}`, fromMe },
          messageTimestamp: at + 90 - i * 7 + n,
          message: { conversation: `Fictional message ${i}.${n}, olá!` },
        });
    }
    const call = (action: string, data: unknown) =>
      measure(formatResponse(action, publicResponse(data), 'compact'));
    const sum = (values: ReturnType<typeof measure>[]) => ({
      calls: values.length,
      bytes: values.reduce((total, value) => total + value.bytes, 0),
      tokens: values.reduce((total, value) => total + value.tokens, 0),
    });
    const baseline = sum([
      call('chats', store.chats(20, 0, { unread: true })),
      ...direct.map((jid) => call('contact', store.contactView(jid))),
      ...direct.map((jid) =>
        call(
          'messages',
          store.messages(jid, 1).map((message) => store.messageView(message)),
        ),
      ),
    ]);
    const kindOnly = sum([
      call('chats', store.chats(20, 0, { unread: true, kinds: ['direct'] })),
    ]);
    const enriched = sum([
      call(
        'chats',
        store.chats(20, 0, { unread: true, kinds: ['direct'] }, [
          'contact',
          'last-message',
        ]),
      ),
    ]);
    return {
      scenario:
        'compact; 20 unread rows (1 status, 7 groups, 12 direct); identify each direct row and its last message',
      baseline: { ...baseline, commands: 'chats + 12 contact + 12 messages' },
      kindOnly: {
        ...kindOnly,
        commands: 'chats --kind direct (no identity or last message)',
      },
      enriched: {
        ...enriched,
        commands: 'chats --kind direct --include contact,last-message',
      },
      reductionPercent: {
        calls: reduction(baseline.calls, enriched.calls),
        bytes: reduction(baseline.bytes, enriched.bytes),
        tokens: reduction(baseline.tokens, enriched.tokens),
      },
    };
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

process.stdout.write(
  JSON.stringify(
    {
      tokenizer: {
        package: 'js-tiktoken',
        version: '1.0.21',
        encoding: 'o200k_base',
      },
      serialization: 'JSON.stringify; minified; excludes final newline',
      truncation: 'none',
      limits:
        'Fictional fixtures; payload tokens only, not model-specific billing or chat/tool framing. No claim of exact GPT-6.1 token counts.',
      scenarios,
      triage: triage(),
    },
    null,
    2,
  ) + '\n',
);
