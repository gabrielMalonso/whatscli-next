import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { proto } from 'baileys';
import type { WAMessage } from 'baileys';
import { messageOutput } from '../src/output.js';
import { decode, encode, Store } from '../src/store.js';
import type { RequestRecord } from '../src/store.js';

process.umask(0o077);
const temporary = () => mkdtempSync(join(tmpdir(), 'store-query-'));
const pn = '12025550101@s.whatsapp.net';
const lid = '123450001@lid';
const group = '120363000000000001@g.us';
const message = (id: string, text: string, jid = pn): WAMessage => ({
  key: { remoteJid: jid, id, fromMe: false }, messageTimestamp: 100, message: { conversation: text },
});
const identities = (messages: WAMessage[]) => messages.map(value => value.key);

// The pre-feature algorithm, retained as an oracle over exactly the same fictional rows.
function legacySearch(store: Store, query: string, limit: number, offset: number, jid?: string) {
  store.db.function('legacy_text', value => (messageOutput(decode<WAMessage>(String(value))).text ?? '').normalize('NFKC').toLowerCase());
  return store.db.prepare(`SELECT json FROM messages WHERE json_extract(json,'$.message') IS NOT NULL
    AND instr(legacy_text(json),?)>0 ${jid === undefined ? '' : 'AND jid=?'} ORDER BY timestamp DESC,rowid DESC LIMIT ? OFFSET ?`)
    .all(query.normalize('NFKC').toLowerCase(), ...(jid === undefined ? [] : [jid]), limit, offset)
    .map(row => decode<WAMessage>(String(row.json)));
}

test('persisted substring search equals the original Unicode/literal algorithm with exact JIDs and pagination', () => {
  const store = new Store(temporary());
  try {
    store.transaction(() => {
      const texts = ['ＳÃＯ Cafe\u0301 K ﬃ', 'İstanbul Σςσ', 'emoji 🐈‍⬛ 😀', '100%_literal [x] OR "a" - * :',
        'a\0b after-null', 'one\ntwo\tthree', '', 'x'.repeat(4000) + 'tail'];
      for (const [i, text] of texts.entries()) for (const jid of [pn, lid, group]) {
        store.observeMessage(message(`text-${i}`, text, jid));
      }
      store.observeMessage({ ...message('caption', '', group), message: { documentWithCaptionMessage: {
        message: { documentMessage: { caption: 'Fictional caption 🐈', fileName: 'EXCLUDED_FILENAME' } },
      } } });
      store.observeMessage({ ...message('quote', 'Reply'), message: { extendedTextMessage: {
        text: 'Reply', contextInfo: { quotedMessage: { conversation: 'EXCLUDED_QUOTE' } },
      }, messageContextInfo: { messageSecret: Buffer.from('EXCLUDED_SECRET') } } });
      store.observeMessage({ ...message('card', ''), message: { contactMessage: { displayName: 'EXCLUDED_CARD', vcard: 'EXCLUDED_VCARD' } } });
      store.observeMessage({ ...message('missing', ''), message: null });
      store.observeMapping(pn, lid, 'lid-mapping.update');
    });
    for (const query of ['são', 'café', 'ffi', 'k', 'i\u0307', 'Σ', 'ς', '🐈', '😀', 'a', 'ab', '%_', '[x]', 'OR "a"',
      '*', ' :', '\0b', 'after-null', 'one\ntwo', 'tail', '', 'EXCLUDED_QUOTE', 'EXCLUDED_SECRET', 'EXCLUDED_CARD', 'EXCLUDED_FILENAME', 'none']) {
      for (const jid of [undefined, pn, lid, group]) for (const [limit, offset] of [[1, 0], [2, 1], [100, 0], [5, 200]] as const) {
        assert.deepEqual(identities(store.search(query, limit, offset, jid)), identities(legacySearch(store, query, limit, offset, jid)), encode({ query, jid, limit, offset }));
      }
    }
  } finally { store.close(); }
});

test('edits, status/null updates and own participant enrichment replace search text without stale rows', () => {
  const directory = temporary();
  let store = new Store(directory);
  try {
    const own = { ...message('own', 'Original', group), key: { remoteJid: group, id: 'own', fromMe: true } };
    store.observeMessage(own, false);
    store.observeMessage({ ...own, key: { ...own.key, participant: lid }, message: null, status: 2 }, false);
    assert.equal(store.search('original', 100, 0).length, 1);
    store.updateMessage({ key: own.key, update: { message: { editedMessage: { message: { imageMessage: { caption: 'Edited caption' } } } } } });
    assert.deepEqual(store.search('original', 100, 0), []);
    assert.equal(store.search('edited caption', 100, 0).length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM message_text').get()?.n, 1);
    assert.equal(store.chats().length, 0, 'local SDK evidence cannot create a chat');
    store.close(); store = new Store(directory);
    assert.equal(store.search('edited caption', 100, 0)[0]?.key.participant, lid);
    assert.deepEqual(identities(store.messages(group)), identities(legacySearch(store, '', 100, 0, group)));
  } finally { store.close(); }
});

test('deletion/revoke/boundary projections stay absent after late edits/history and restart, preserving exact collisions', () => {
  const directory = temporary();
  let store = new Store(directory);
  const target = { ...message('collision', 'Deleted body', group), key: { remoteJid: group, id: 'collision', fromMe: false, participant: pn } };
  const other = { ...target, key: { ...target.key, participant: lid } };
  try {
    store.observeMessage(target); store.observeMessage(other);
    store.deleteMessages({ keys: [target.key] });
    store.observeMessage(target);
    store.updateMessage({ key: target.key, update: { message: { conversation: 'Resurrection' }, status: 4 } });
    assert.deepEqual(store.search('Resurrection', 100, 0), []);
    assert.deepEqual(identities(store.search('deleted body', 100, 0)), [other.key]);
    store.updateMessage({ key: other.key, update: { messageStubType: proto.WebMessageInfo.StubType.REVOKE } });
    assert.deepEqual(store.search('deleted body', 100, 0), []);
    store.observeMessage(message('before', 'Boundary body'));
    store.deleteMessages({ jid: pn, all: true });
    store.observeMessage(message('late', 'Boundary body'));
    store.observeMessage({ ...message('newer', 'New visible'), messageTimestamp: Math.ceil(Date.now() / 1000) + 60 });
    assert.deepEqual(store.search('boundary body', 100, 0), []);
    store.close(); store = new Store(directory);
    assert.deepEqual(store.search('deleted body', 100, 0), []);
    assert.deepEqual(store.search('boundary body', 100, 0), []);
    assert.equal(store.search('new visible', 100, 0).length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM message_text').get()?.n, 1);
    assert.match(String(store.db.prepare('SELECT audit_json FROM message_deletions WHERE jid=? AND id=?').get(group, 'collision')?.audit_json), /Deleted body/);
  } finally { store.close(); }
});

test('a failed body/projection write rolls back edits and revocations together', () => {
  const store = new Store(temporary());
  try {
    store.observeMessage(message('original', 'Before failure'));
    store.db.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON message_text BEGIN SELECT RAISE(ABORT,'fictional failure'); END;");
    assert.throws(() => store.updateMessage({ key: message('original', '').key, update: { message: { conversation: 'After failure' } } }), /fictional failure/);
    assert.equal(store.search('before failure', 100, 0).length, 1);
    assert.deepEqual(store.search('after failure', 100, 0), []);
    assert.throws(() => store.observeMessage({ ...message('notification', ''), message: { protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.REVOKE, key: { remoteJid: pn, id: 'original', fromMe: true },
    } } }), /fictional failure/);
    assert.equal(store.deletion(message('original', '').key), undefined);
    assert.equal(store.search('before failure', 100, 0).length, 1);
  } finally { store.close(); }
});

test('additive backfill preserves row ordering and requests, hides tombstones and runs only once', () => {
  const directory = temporary();
  const seed = new Store(directory);
  seed.observeMessage(message('visible', 'Visible old body'));
  seed.observeMessage(message('deleted', 'Private audit body'));
  seed.deleteMessages({ keys: [message('deleted', '').key] });
  const request: RequestRecord = { key: 'old', operation: { kind: 'send', jid: pn, text: 'Immutable intent' }, messageId: 'ID',
    attempt: 'uncertain', acceptance: 'unknown', delivery: 'unknown', read: 'unknown', errorObserved: false };
  seed.saveRequest(request);
  const rows = seed.db.prepare('SELECT rowid,* FROM messages ORDER BY rowid').all();
  seed.db.exec('DROP TABLE message_text; DROP INDEX message_history; DROP INDEX request_message_id; PRAGMA user_version=0;');
  seed.close();
  const store = new Store(directory);
  try {
    assert.deepEqual(store.db.prepare('SELECT rowid,* FROM messages ORDER BY rowid').all(), rows);
    assert.deepEqual(store.request('old'), request);
    assert.equal(store.search('visible old body', 100, 0).length, 1);
    assert.deepEqual(store.search('private audit body', 100, 0), []);
    store.receipt({ remoteJid: pn, id: 'ID', fromMe: true }, 4);
    assert.equal(store.request('old')?.read, 'read');
    store.db.exec("CREATE TRIGGER no_backfill BEFORE INSERT ON message_text BEGIN SELECT RAISE(ABORT,'unexpected backfill'); END;");
  } finally { store.close(); }
  const reopened = new Store(directory);
  try { assert.equal(reopened.search('visible old body', 100, 0).length, 1); } finally { reopened.close(); }
});

test('a newer schema fails before modifying the database and releases its writer lock', () => {
  const directory = temporary();
  const path = join(directory, 'probe.sqlite');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('fictional preserved'); PRAGMA user_version=999;");
  db.close();
  const before = readFileSync(path);
  for (let i = 0; i < 2; i++) assert.throws(() => new Store(directory), /Unsupported Store schema.*NEW --data-dir/);
  assert.deepEqual(readFileSync(path), before);
});

test('indexed receipt candidates preserve exact identities, collisions and monotonic evidence across restart', () => {
  const directory = temporary();
  let store = new Store(directory);
  const base: RequestRecord = { key: 'r', operation: { kind: 'send', jid: pn, text: 'Fictional intent' }, messageId: 'COLLISION',
    attempt: 'uncertain', acceptance: 'unknown', delivery: 'unknown', read: 'unknown', errorObserved: false };
  try {
    store.transaction(() => {
      for (let i = 0; i < 300; i++) store.saveRequest({ ...base, key: `unrelated-${i}`, messageId: `ID-${i}` });
      store.saveRequest(base);
      store.saveRequest({ ...base, key: 'same-id-other-domain', operation: { kind: 'send', jid: '123450001@s.whatsapp.net', text: 'Other' } });
      store.saveRequest({ ...base, key: 'non-send', operation: { kind: 'archive', jid: lid, value: true } });
      store.saveRequest({ ...base, key: 'proven', route: { status: 'proven', jid: lid, source: 'baileys.executeUSyncQuery/lid', observedAt: 1, limit: 'server-association-at-query-time' } });
    });
    store.receipt({ remoteJid: '123450001:2@lid', id: 'COLLISION', fromMe: true }, 4);
    assert.equal(store.request('proven')?.read, 'read');
    assert.deepEqual(store.request('r'), base);
    store.receipt({ remoteJid: pn, id: 'COLLISION', fromMe: true }, 3);
    store.receipt({ remoteJid: pn, id: 'COLLISION', fromMe: true }, 0);
    assert.equal(store.request('r')?.delivery, 'delivered');
    assert.equal(store.request('r')?.errorObserved, true);
    assert.equal(store.request('same-id-other-domain')?.acceptance, 'unknown');
    assert.equal(store.request('non-send')?.read, 'unknown');
    assert.equal(store.request('unrelated-299')?.read, 'unknown');
    store.close(); store = new Store(directory);
    assert.equal(store.request('proven')?.read, 'read');
    assert.equal(store.request('r')?.delivery, 'delivered');
  } finally { store.close(); }
});

test('a failed additive backfill leaves no partial projection/version and can retry without recreating intents', () => {
  const directory = temporary();
  const seed = new Store(directory);
  seed.observeMessage(message('first', 'First fictional body'));
  seed.observeMessage(message('broken', 'Second fictional body'));
  seed.saveRequest({ key: 'keep', operation: { kind: 'send', jid: pn, text: 'Durable original' }, messageId: 'KEEP-ID',
    attempt: 'uncertain', acceptance: 'unknown', delivery: 'unknown', read: 'unknown', errorObserved: false });
  const intent = seed.request('keep');
  seed.db.prepare('UPDATE messages SET json=? WHERE id=?').run('{broken json', 'broken');
  seed.db.exec('DROP TABLE message_text; DROP INDEX message_history; DROP INDEX request_message_id; PRAGMA user_version=0;');
  seed.close();
  assert.throws(() => new Store(directory), /JSON/);
  const db = new DatabaseSync(join(directory, 'probe.sqlite'));
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_text').get()?.n, 0);
  db.prepare('UPDATE messages SET json=? WHERE id=?').run(encode(message('broken', 'Second fictional body')), 'broken');
  db.close();
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.search('fictional body', 100, 0).length, 2);
    assert.deepEqual(reopened.request('keep'), intent);
  } finally { reopened.close(); }
});

test('backfill uses persisted timestamps for protobuf Longs, preserving history/search order and pages', () => {
  const directory = temporary();
  const seed = new Store(directory);
  for (const [id, timestamp] of [['earlier', '1700000000'], ['later', '2147483648'], ['post-wrap', '4294967496']] as const) {
    const key = { remoteJid: pn, id, fromMe: false };
    seed.observeMessage({ ...proto.WebMessageInfo.fromObject({ key,
      messageTimestamp: timestamp, message: { conversation: 'Fictional Long timestamp' } }), key });
  }
  const order = ['post-wrap', 'later', 'earlier'];
  assert.deepEqual(seed.messages(pn).map(m => m.key.id), order);
  assert.deepEqual(seed.search('Long timestamp', 100, 0).map(m => m.key.id), order);
  const original = seed.db.prepare('SELECT rowid,* FROM messages ORDER BY rowid').all();
  seed.db.exec('DROP TABLE message_text; DROP INDEX message_history; DROP INDEX request_message_id; PRAGMA user_version=0;');
  seed.close();
  const store = new Store(directory);
  try {
    assert.deepEqual(store.db.prepare('SELECT rowid,* FROM messages ORDER BY rowid').all(), original);
    assert.deepEqual(store.messages(pn).map(m => m.key.id), order);
    for (const jid of [undefined, pn]) {
      assert.deepEqual(store.search('Long timestamp', 100, 0, jid).map(m => m.key.id), order);
      for (let offset = 0; offset < order.length; offset++) {
        assert.equal(store.search('Long timestamp', 1, offset, jid)[0]?.key.id, order[offset]);
      }
    }
  } finally { store.close(); }
  const reopened = new Store(directory);
  try { assert.deepEqual(reopened.search('Long timestamp', 100, 0).map(m => m.key.id), order); } finally { reopened.close(); }
});
