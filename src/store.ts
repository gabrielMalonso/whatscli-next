import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BufferJSON, proto, toNumber } from 'baileys';
import type { Chat, ChatUpdate, WAMessage, WAMessageKey } from 'baileys';
import { chatOutput, messageOutput } from './output.js';

export const encode = (value: unknown): string => JSON.stringify(value, BufferJSON.replacer);
// SQLite contains objects written by this process using the SDK's binary serializer.
export const decode = <T>(value: string): T => JSON.parse(value, BufferJSON.reviver) as T;

export type Operation =
  | { kind: 'send'; jid: string; text: string }
  | { kind: 'send-file'; jid: string; path: string; mime: string; caption: string; bytes: number; sha256: string }
  | { kind: 'archive'; jid: string; value: boolean }
  | { kind: 'mark-read'; jid: string; value: boolean };

export type RequestRecord = {
  key: string;
  operation: Operation;
  messageId: string | null;
  attempt: 'uncertain' | 'sdk-returned';
  acceptance: 'unknown' | 'server-ack';
  delivery: 'unknown' | 'delivered';
  read: 'unknown' | 'read';
  errorObserved: boolean;
};

type PendingChatState = {
  archived?: { key: string; value: boolean };
  unread?: { key: string; value: boolean };
};

function checkPrivate(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Expected an owned private path (directory 0700 / file 0600): ${path}`);
  }
}

/** One SQLite writer holds a separate lifetime lock DB; the OS releases it on process death. */
export class Store {
  readonly db: DatabaseSync;
  private readonly lock: DatabaseSync;
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    checkPrivate(this.directory);
    for (const name of readdirSync(this.directory)) {
      checkPrivate(join(this.directory, name));
    }
    const openDatabase = (name: string): DatabaseSync => {
      const path = join(this.directory, name);
      const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        if (!fstatSync(fd).isFile()) throw new Error('Database path must be a regular file');
      } finally { closeSync(fd); }
      checkPrivate(path);
      return new DatabaseSync(path);
    };
    this.lock = openDatabase('writer-lock.sqlite');
    try {
      this.lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER);');
      this.db = openDatabase('probe.sqlite');
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS values_store (category TEXT, id TEXT, json TEXT NOT NULL, PRIMARY KEY(category,id));
        CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, json TEXT NOT NULL, observed_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          jid TEXT, id TEXT, from_me INTEGER, participant TEXT, timestamp INTEGER NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY(jid,id,from_me,participant)
        );
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      `);
      this.db.function('search_text', { deterministic: true }, value => typeof value === 'string'
        ? (messageOutput(decode<WAMessage>(value)).text ?? '').normalize('NFKC').toLowerCase() : '');
    } catch (error) {
      this.lock.close();
      throw error;
    }
  }

  close(): void { this.db.close(); this.lock.close(); }

  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  get<T>(category: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT json FROM values_store WHERE category=? AND id=?').get(category, id);
    return row ? decode<T>(String(row.json)) : undefined;
  }

  set(category: string, id: string, value: unknown): void {
    if (value === null || value === undefined) {
      this.db.prepare('DELETE FROM values_store WHERE category=? AND id=?').run(category, id);
    } else {
      this.db.prepare('INSERT OR REPLACE INTO values_store VALUES (?,?,?)').run(category, id, encode(value));
    }
  }

  event(kind: string, value: unknown): number {
    return Number(this.db.prepare('INSERT INTO events(at,kind,json) VALUES (?,?,?)').run(Date.now(), kind, encode(value)).lastInsertRowid);
  }

  events(after: number): unknown[] {
    return this.db.prepare('SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT 100').all(after)
      .map(row => ({
        sequence: row.sequence, at: row.at, kind: row.kind,
        // Older journal entries can contain chats with embedded raw messages too.
        data: row.kind === 'chats.update' || row.kind === 'chats.upsert'
          ? decode<ChatUpdate[]>(String(row.json)).map(chatOutput)
          : decode<unknown>(String(row.json)),
      }));
  }

  chat(jid: string): Chat | undefined {
    const row = this.db.prepare('SELECT json FROM chats WHERE jid=?').get(jid);
    return row ? decode<Chat>(String(row.json)) : undefined;
  }

  chatView(jid: string) {
    const row = this.db.prepare('SELECT json,observed_at FROM chats WHERE jid=?').get(jid);
    if (!row) return null;
    const chat = decode<Chat>(String(row.json));
    const pending = this.get<PendingChatState>('pending-chat', jid) ?? {};
    return {
      ...chatOutput(chat),
      ...(pending.archived ? { archived: null } : {}),
      ...(pending.unread ? { unread: null, unreadCount: null } : {}),
      pending,
      observedAt: row.observed_at,
    };
  }

  invalidateChatState(key: string, operation: Operation): void {
    if (operation.kind === 'send' || operation.kind === 'send-file') return;
    const pending = this.get<PendingChatState>('pending-chat', operation.jid) ?? {};
    if (operation.kind === 'archive') pending.archived = { key, value: operation.value };
    else pending.unread = { key, value: !operation.value };
    this.set('pending-chat', operation.jid, pending);
  }

  observeChat(chat: ChatUpdate): void {
    if (!chat.id) { this.event('incomplete-chat-key', {}); return; }
    const merged = { ...this.chat(chat.id), ...chat };
    // A fresh counter update supersedes an older manual-unread marker.
    if (typeof chat.unreadCount === 'number' && chat.markedAsUnread === undefined && [0, -1].includes(chat.unreadCount)) {
      merged.markedAsUnread = chat.unreadCount === -1;
    }
    const pending = this.get<PendingChatState>('pending-chat', chat.id) ?? {};
    if (typeof chat.archived === 'boolean') delete pending.archived;
    if (typeof chat.unreadCount === 'number' || typeof chat.markedAsUnread === 'boolean') delete pending.unread;
    this.set('pending-chat', chat.id, Object.keys(pending).length ? pending : null);
    // SDK event-buffer conditions are functions, not persisted state.
    delete merged.conditional;
    this.db.prepare('INSERT OR REPLACE INTO chats VALUES (?,?,?)').run(chat.id, encode(merged), Date.now());
  }

  chats(limit = 100, offset = 0): unknown[] {
    return this.db.prepare('SELECT jid FROM chats ORDER BY observed_at DESC,jid LIMIT ? OFFSET ?').all(limit, offset).map(row => this.chatView(String(row.jid)));
  }

  observeMessage(message: WAMessage): void {
    const { remoteJid: jid, id, fromMe, participant } = message.key;
    if (!jid || !id || typeof fromMe !== 'boolean') { this.event('incomplete-message-key', {}); return; }
    const previous = this.message(message.key);
    const merged = { ...previous, ...message, key: { ...previous?.key, ...message.key } };
    if (previous?.message && !message.message) merged.message = previous.message;
    if (message.message && message.messageStubType === undefined && previous?.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
      delete merged.messageStubType;
      delete merged.messageStubParameters;
    }
    // Own messages always have the same author. Reuse any existing slot so an
    // older history row and a later phone echo do not require rewriting stored history.
    const participantSlot = fromMe
      ? String(this.db.prepare('SELECT participant FROM messages WHERE jid=? AND id=? AND from_me=1 ORDER BY rowid LIMIT 1').get(jid, id)?.participant ?? '')
      : participant ?? '';
    this.db.prepare('INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?)').run(
      jid, id, Number(fromMe), participantSlot, toNumber(merged.messageTimestamp ?? 0), encode(merged),
    );
    // Seeing a message proves the conversation exists, not its archive/read state.
    if (!this.chat(jid)) this.observeChat({ id: jid });
    const ciphertext = message.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT;
    const unexplainedMissingContent = !message.message && message.messageStubType == null;
    if (ciphertext || unexplainedMissingContent) {
      this.event('message-content-unavailable', { jid, id, stubType: message.messageStubType ?? null });
    }
    if (message.status !== null && message.status !== undefined) this.receipt(message.key, message.status);
  }

  message(key: WAMessageKey): WAMessage | undefined {
    if (!key.remoteJid || !key.id || typeof key.fromMe !== 'boolean') return undefined;
    if (key.fromMe) {
      const own = this.db.prepare('SELECT json FROM messages WHERE jid=? AND id=? AND from_me=1 ORDER BY rowid LIMIT 1').get(key.remoteJid, key.id);
      return own ? decode<WAMessage>(String(own.json)) : undefined;
    }
    const row = this.db.prepare('SELECT json FROM messages WHERE jid=? AND id=? AND from_me=? AND participant=?')
      .get(key.remoteJid, key.id, Number(key.fromMe), key.fromMe ? '' : key.participant ?? '');
    return row ? decode<WAMessage>(String(row.json)) : undefined;
  }

  messages(jid: string, limit = 20, offset = 0): WAMessage[] {
    return this.db.prepare('SELECT json FROM messages WHERE jid=? ORDER BY timestamp DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(jid, limit, offset).map(row => decode<WAMessage>(String(row.json)));
  }

  search(query: string, limit: number, offset: number, jid?: string): WAMessage[] {
    const text = query.normalize('NFKC').toLowerCase();
    const rows = jid === undefined
      ? this.db.prepare('SELECT json FROM messages WHERE instr(search_text(json),?)>0 ORDER BY timestamp DESC,rowid DESC LIMIT ? OFFSET ?').all(text, limit, offset)
      : this.db.prepare('SELECT json FROM messages WHERE jid=? AND instr(search_text(json),?)>0 ORDER BY timestamp DESC,rowid DESC LIMIT ? OFFSET ?').all(jid, text, limit, offset);
    return rows.map(row => decode<WAMessage>(String(row.json)));
  }

  locateMessage(ref: { jid: string; id: string; fromMe?: boolean; participant?: string }): WAMessage {
    const clauses = ['jid=?', 'id=?'];
    const args: (string | number)[] = [ref.jid, ref.id];
    if (ref.fromMe !== undefined) { clauses.push('from_me=?'); args.push(Number(ref.fromMe)); }
    if (ref.participant !== undefined) { clauses.push("json_extract(json,'$.key.participant')=?"); args.push(ref.participant); }
    const rows = this.db.prepare(`SELECT json FROM messages WHERE ${clauses.join(' AND ')} LIMIT 2`).all(...args);
    if (rows.length === 0) throw new Error('Message is not stored for that exact identity');
    if (rows.length > 1) throw new Error('Ambiguous message ID; provide fromMe and participant');
    return decode<WAMessage>(String(rows[0]?.json));
  }

  request(key: string): RequestRecord | undefined {
    const row = this.db.prepare('SELECT json FROM requests WHERE key=?').get(key);
    return row ? decode<RequestRecord>(String(row.json)) : undefined;
  }

  saveRequest(record: RequestRecord): void {
    this.db.prepare('INSERT OR REPLACE INTO requests VALUES (?,?)').run(record.key, encode(record));
  }

  receipt(key: WAMessageKey, status: number): void {
    if (key.fromMe !== true || !key.id || !key.remoteJid) return;
    for (const row of this.db.prepare('SELECT json FROM requests').all()) {
      const request = decode<RequestRecord>(String(row.json));
      if (!['send', 'send-file'].includes(request.operation.kind) || request.messageId !== key.id || request.operation.jid !== key.remoteJid) continue;
      // Monotonic evidence: late PENDING/ERROR events cannot erase an observed receipt.
      if (status === proto.WebMessageInfo.Status.ERROR) request.errorObserved = true;
      if (status >= proto.WebMessageInfo.Status.SERVER_ACK) request.acceptance = 'server-ack';
      if (status >= proto.WebMessageInfo.Status.DELIVERY_ACK) request.delivery = 'delivered';
      if (status >= proto.WebMessageInfo.Status.READ) request.read = 'read';
      this.saveRequest(request);
    }
  }
}
