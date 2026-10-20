import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  toNumber,
} from 'baileys';
import type {
  AuthenticationCreds,
  BaileysEventMap,
  Chat,
  ChatUpdate,
  Contact,
  WAMessage,
  WAMessageKey,
  WAMessageUpdate,
} from 'baileys';
import {
  chatOutput,
  isUnreadCount,
  messageOutput,
  messageText,
} from './output.js';
import type { Deletion, QuoteReference } from './output.js';
import { contactJid, isLid, isPn } from './identity.js';
import type { IdentitySource, RecipientCheck } from './identity.js';
import type { ChatFilters, QuoteSelector } from './protocol.js';
import type { QuoteSnapshot } from './quoted-text.js';
import { decode, decodeMessage, encode } from './store-codec.js';
import { createSchema } from './store-schema.js';
import { receiptUserJid } from './send-route.js';
import type { SendRoute } from './send-route.js';
import { CommandError } from './errors.js';
import {
  checkPrivatePath,
  ensurePrivateDirectory,
  isMissing,
} from './private-paths.js';

export { decode, encode } from './store-codec.js';

export type Operation =
  | { kind: 'send'; jid: string; text: string; quote?: QuoteSelector }
  | {
      kind: 'send-file';
      jid: string;
      path: string;
      mime: string;
      caption: string;
      bytes: number;
      sha256: string;
    }
  | {
      kind: 'send-contact';
      jid: string;
      name: string;
      phone: string;
      vcard: string;
    }
  | { kind: 'archive'; jid: string; value: boolean }
  | { kind: 'mark-read'; jid: string; value: boolean };

export function isSendOperation(
  operation: Operation,
): operation is Extract<
  Operation,
  { kind: 'send' | 'send-file' | 'send-contact' }
> {
  return (
    operation.kind === 'send' ||
    operation.kind === 'send-file' ||
    operation.kind === 'send-contact'
  );
}

export type RequestRecord = {
  key: string;
  operation: Operation;
  messageId: string | null;
  readonly route?: SendRoute;
  readonly quote?: QuoteSnapshot;
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

type ActivitySource =
  | 'chat.conversationTimestamp'
  | 'chat.lastMsgTimestamp'
  | 'chat.lastMessageRecvTimestamp'
  | 'message.messageTimestamp';

function activityTimestamp(
  value: Chat['conversationTimestamp'],
): number | null {
  if (value == null) return null;
  // Persisted protobuf Longs can be decimal text or plain {low,high,unsigned} objects.
  // rc14's toNumber alone reads only low from a plain object; restore the full value.
  const timestamp = toNumber(
    proto.Conversation.fromObject({ conversationTimestamp: value })
      .conversationTimestamp ?? 0,
  );
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

type ContactMetadata = Partial<
  Record<
    'name' | 'notify' | 'username' | 'verifiedName' | 'status',
    {
      value: string;
      source: IdentitySource;
      observedAt: number;
    }
  >
>;
type ContactRecord = {
  jid: string;
  source: IdentitySource;
  observedAt: number;
  metadata: ContactMetadata;
};

/** One SQLite writer holds a separate lifetime lock DB; the OS releases it on process death. */
export class Store {
  readonly db: DatabaseSync;
  private readonly lock: DatabaseSync;
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
    ensurePrivateDirectory(this.directory);
    for (const name of readdirSync(this.directory)) {
      checkPrivatePath(join(this.directory, name));
    }
    const openDatabase = (name: string): DatabaseSync => {
      const path = join(this.directory, name);
      try {
        checkPrivatePath(path, 'file');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const fd = openSync(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        if (!fstatSync(fd).isFile())
          throw new Error('Database path must be a regular file');
      } finally {
        closeSync(fd);
      }
      checkPrivatePath(path, 'file');
      return new DatabaseSync(path);
    };
    this.lock = openDatabase('writer-lock.sqlite');
    let opened: DatabaseSync | undefined;
    try {
      this.lock.exec(
        'PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER);',
      );
      this.db = opened = openDatabase('probe.sqlite');
      createSchema(this.db);
      this.db.function('chat_unread', { deterministic: true }, (value) => {
        const unread =
          typeof value === 'string'
            ? chatOutput(decode<Chat>(value)).unread
            : null;
        return unread === null ? null : Number(unread);
      });
      this.recoverLegacy();
      this.initializeQueries();
    } catch (error) {
      opened?.close();
      this.lock.close();
      throw error;
    }
  }

  private recoverLegacy(): void {
    // Preserve old journal evidence and the SDK's explicitly typed mapping storage.
    // Legacy key-store entries have no observation timestamp; do not invent one.
    if (!this.get<boolean>('migration', 'contact-identity-v1'))
      this.transaction(() => {
        for (const row of this.db
          .prepare("SELECT at,json FROM events WHERE kind='lid-mapping'")
          .all()) {
          const value = decode<{ pn?: unknown; lid?: unknown }>(
            String(row.json),
          );
          this.observeMapping(
            value.pn,
            value.lid,
            'lid-mapping.update',
            Number(row.at),
          );
        }
        for (const row of this.db
          .prepare(
            "SELECT id,json FROM values_store WHERE category='lid-mapping'",
          )
          .all()) {
          this.observeSdkMapping(
            String(row.id),
            decode<unknown>(String(row.json)),
            null,
          );
        }
        for (const row of this.db
          .prepare(
            "SELECT json_extract(json,'$.key') AS message_key FROM messages",
          )
          .iterate()) {
          if (typeof row.message_key === 'string')
            this.observeMessageIdentities(
              decode<WAMessageKey>(row.message_key),
              null,
            );
        }
        this.set('migration', 'contact-identity-v1', true);
      });
    // Old runtimes journaled deletes without applying them. Recover the evidence privately.
    if (!this.get<boolean>('migration', 'message-deletions-v1'))
      this.transaction(() => {
        // Snapshot raw provenance before replay can redact a notification itself.
        const messages = this.db
          .prepare('SELECT rowid,json FROM messages')
          .all()
          .map((row) => ({
            rowid: Number(row.rowid),
            message: decodeMessage(String(row.json)),
          }));
        for (const row of this.db
          .prepare(
            "SELECT at,json FROM events WHERE kind='messages.delete' ORDER BY sequence",
          )
          .all()) {
          this.applyDeleteEvent(
            decode<BaileysEventMap['messages.delete']>(String(row.json)),
            Number(row.at),
            true,
          );
        }
        const derivedTargets = new Set<string>();
        for (const { message } of messages) {
          const protocol = normalizeMessageContent(
            message.message,
          )?.protocolMessage;
          if (protocol?.type !== proto.Message.ProtocolMessage.Type.REVOKE)
            continue;
          if (protocol.key?.id)
            derivedTargets.add(
              encode(this.deletionKey({ ...message.key, id: protocol.key.id })),
            );
          this.observeRevocation(message);
        }
        for (const { rowid, message } of messages) {
          if (
            message.messageStubType !== proto.WebMessageInfo.StubType.REVOKE ||
            normalizeMessageContent(message.message)?.protocolMessage?.type ===
              proto.Message.ProtocolMessage.Type.REVOKE
          )
            continue;
          if (!derivedTargets.has(encode(this.deletionKey(message.key))))
            this.observeRevocation(message);
          else if (!this.deletion(message.key)) {
            // The old runtime saved rc14's lossy derived stub on this envelope identity.
            // The raw notification was validated above; don't reinstate its wrong direction.
            delete message.messageStubType;
            delete message.messageStubParameters;
            this.db
              .prepare('UPDATE messages SET json=? WHERE rowid=?')
              .run(encode(message), rowid);
          }
        }
        this.set('migration', 'message-deletions-v1', true);
      });
    if (!this.get<boolean>('migration', 'chat-activity-v1'))
      this.transaction(() => {
        this.db.exec(
          'ALTER TABLE chats ADD COLUMN activity_timestamp INTEGER; ALTER TABLE chats ADD COLUMN activity_source TEXT;',
        );
        for (const row of this.db.prepare('SELECT json FROM chats').all())
          this.observeChatActivity(decode<Chat>(String(row.json)));
        // Legacy own-message rows cannot distinguish SDK returns from independent echoes.
        // Recover only incoming message activity, and only for existing observed chats.
        for (const row of this.db
          .prepare(
            'SELECT m.jid,m.timestamp FROM messages m JOIN chats c ON c.jid=m.jid WHERE m.from_me=0 AND m.timestamp>0',
          )
          .iterate()) {
          this.observeActivity(
            String(row.jid),
            Number(row.timestamp),
            'message.messageTimestamp',
          );
        }
        this.set('migration', 'chat-activity-v1', true);
      });
  }

  private indexMessage(
    rowid: number,
    jid: string,
    timestamp: number,
    message: WAMessage,
  ): void {
    if (
      !message.key.remoteJid ||
      message.message == null ||
      this.deletion(message.key)
    )
      return;
    const text = (messageText(normalizeMessageContent(message.message)) ?? '')
      .normalize('NFKC')
      .toLowerCase();
    this.db
      .prepare('INSERT INTO message_text VALUES (?,?,?,?)')
      .run(rowid, jid, timestamp, text);
  }

  private initializeQueries(): void {
    if (
      Number(this.db.prepare('PRAGMA user_version').get()?.user_version) === 1
    )
      return;
    this.transaction(() => {
      // Stream the additive backfill after legacy deletion recovery. Never read audit bodies.
      // Ordering metadata is authoritative in SQLite; decoded protobuf Longs can lose high words.
      for (const row of this.db
        .prepare('SELECT rowid,jid,timestamp,json FROM messages')
        .iterate()) {
        this.indexMessage(
          Number(row.rowid),
          String(row.jid),
          Number(row.timestamp),
          decodeMessage(String(row.json)),
        );
      }
      this.db.exec(`
        CREATE INDEX message_history ON messages(jid,timestamp);
        CREATE INDEX message_text_order ON message_text(timestamp);
        CREATE INDEX message_text_jid_order ON message_text(jid,timestamp);
        CREATE INDEX request_message_id ON requests(json_extract(json,'$.messageId'));
        PRAGMA user_version=1;
      `);
    });
  }

  close(): void {
    this.db.close();
    this.lock.close();
  }

  /** Synchronous mutations join the runtime's surrounding event transaction. */
  transaction<T>(action: () => T): T {
    if (this.db.isTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get<T>(category: string, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT json FROM values_store WHERE category=? AND id=?')
      .get(category, id);
    return row ? decode<T>(String(row.json)) : undefined;
  }

  set(category: string, id: string, value: unknown): void {
    if (value === null || value === undefined) {
      this.db
        .prepare('DELETE FROM values_store WHERE category=? AND id=?')
        .run(category, id);
    } else {
      this.db
        .prepare('INSERT OR REPLACE INTO values_store VALUES (?,?,?)')
        .run(category, id, encode(value));
    }
  }

  event(kind: string, value: unknown): number {
    return Number(
      this.db
        .prepare('INSERT INTO events(at,kind,json) VALUES (?,?,?)')
        .run(Date.now(), kind, encode(value)).lastInsertRowid,
    );
  }

  events(after: number): unknown[] {
    return this.db
      .prepare(
        'SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT 100',
      )
      .all(after)
      .map((row) => ({
        sequence: row.sequence,
        at: row.at,
        kind: row.kind,
        // Older journal entries can contain chats with embedded raw messages too.
        data:
          row.kind === 'chats.update' || row.kind === 'chats.upsert'
            ? decode<ChatUpdate[]>(String(row.json)).map(chatOutput)
            : decode<unknown>(String(row.json)),
      }));
  }

  /** Keep every distinct association, including contradictions; never last-write-wins identity. */
  observeMapping(
    pn: unknown,
    lid: unknown,
    source: IdentitySource,
    observedAt: number | null = Date.now(),
  ): void {
    if (
      typeof pn !== 'string' ||
      typeof lid !== 'string' ||
      !isPn(pn) ||
      !isLid(lid)
    )
      return;
    this.db
      .prepare(
        `INSERT INTO identity_mappings VALUES (?,?,?,?) ON CONFLICT(pn,lid,source)
      DO UPDATE SET observed_at=COALESCE(MAX(observed_at,excluded.observed_at),observed_at,excluded.observed_at)`,
      )
      .run(pn, lid, source, observedAt);
  }

  observeSdkMapping(
    id: string,
    value: unknown,
    observedAt: number | null = Date.now(),
  ): void {
    // Baileys LIDMappingStore writes PN-user -> LID-user and LID-user_reverse -> PN-user.
    // Both directions are evidence, so stale/conflicting reverse entries remain visible.
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return;
    if (/^[1-9]\d*$/.test(id))
      this.observeMapping(
        `${id}@s.whatsapp.net`,
        `${value}@lid`,
        'baileys.key-store',
        observedAt,
      );
    else if (/^[1-9]\d*_reverse$/.test(id))
      this.observeMapping(
        `${value}@s.whatsapp.net`,
        `${id.slice(0, -8)}@lid`,
        'baileys.key-store',
        observedAt,
      );
  }

  observeContact(contact: Partial<Contact>, source: IdentitySource): void {
    const jid = contact.id;
    if (!jid || (!isPn(jid) && !isLid(jid))) return;
    const observedAt = Date.now();
    const previous = this.get<ContactRecord>('contact', jid);
    const metadata: ContactMetadata = { ...previous?.metadata };
    for (const field of [
      'name',
      'notify',
      'username',
      'verifiedName',
      'status',
    ] as const) {
      if (typeof contact[field] === 'string')
        metadata[field] = { value: contact[field], source, observedAt };
    }
    this.set('contact', jid, {
      jid,
      source,
      observedAt,
      metadata,
    } satisfies ContactRecord);
    const pn = isPn(jid) ? jid : contact.phoneNumber;
    const lid = isLid(jid) ? jid : contact.lid;
    this.observeMapping(pn, lid, source, observedAt);
    // Contradictory same-domain fields must be retained too, rather than hidden by id.
    if (contact.phoneNumber && contact.lid)
      this.observeMapping(contact.phoneNumber, contact.lid, source, observedAt);
  }

  recipientCheck(jid: string): RecipientCheck | undefined {
    return this.get<RecipientCheck>('recipient-check', jid);
  }

  private observeMessageIdentities(
    key: WAMessageKey,
    observedAt: number | null = Date.now(),
  ): void {
    for (const [first, second] of [
      [key.remoteJid, key.remoteJidAlt],
      [key.participant, key.participantAlt],
    ]) {
      if (first && second) {
        if (isPn(first))
          this.observeMapping(first, second, 'message-key', observedAt);
        else if (isLid(first))
          this.observeMapping(second, first, 'message-key', observedAt);
      }
    }
  }

  contactView(jid: string) {
    contactJid(jid);
    const direct = this.db
      .prepare('SELECT pn,lid FROM identity_mappings WHERE pn=? OR lid=?')
      .all(jid, jid);
    // Include reverse conflicts at the other endpoint (PN -> LID -> another PN, or vice versa).
    const evidence = this.db
      .prepare(
        `SELECT pn,lid,source,observed_at FROM identity_mappings
      WHERE pn=? OR lid=? OR pn IN (SELECT pn FROM identity_mappings WHERE lid=?)
      OR lid IN (SELECT lid FROM identity_mappings WHERE pn=?) ORDER BY pn,lid,source`,
      )
      .all(jid, jid, jid, jid)
      .map((row) => ({
        pn: String(row.pn),
        lid: String(row.lid),
        source: String(row.source),
        observedAt: row.observed_at,
      }));
    const pns = new Set(evidence.map((row) => row.pn));
    const lids = new Set(evidence.map((row) => row.lid));
    const status =
      direct.length === 0
        ? 'unknown'
        : pns.size === 1 && lids.size === 1
          ? 'known'
          : 'conflict';
    const pn = isPn(jid)
      ? jid
      : status === 'known'
        ? (evidence[0]?.pn ?? null)
        : null;
    const lid = isLid(jid)
      ? jid
      : status === 'known'
        ? (evidence[0]?.lid ?? null)
        : null;
    const identities = new Set([
      jid,
      ...(status === 'known' && pn && lid ? [pn, lid] : []),
    ]);
    return {
      jid,
      source: 'local' as const,
      historical: true,
      phone: pn ? `+${pn.split('@')[0]}` : null,
      mapping: { status, pn, lid, evidence },
      verification: this.recipientCheck(jid) ?? {
        status: 'unknown',
        source: null,
        observedAt: null,
      },
      contacts: [...identities].flatMap((id) => {
        const record = this.get<ContactRecord>('contact', id);
        return record ? [record] : [];
      }),
    };
  }

  /** A proposed pair must agree with every known edge at either endpoint. */
  hasMappingConflict(pn: string, lid: string): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM identity_mappings WHERE (pn=? AND lid<>?) OR (lid=? AND pn<>?) LIMIT 1',
        )
        .get(pn, lid, lid, pn) !== undefined
    );
  }

  chat(jid: string): Chat | undefined {
    const row = this.db.prepare('SELECT json FROM chats WHERE jid=?').get(jid);
    return row ? decode<Chat>(String(row.json)) : undefined;
  }

  chatView(jid: string) {
    const row = this.db
      .prepare(
        'SELECT json,observed_at,activity_timestamp,activity_source FROM chats WHERE jid=?',
      )
      .get(jid);
    if (!row) return null;
    const chat = decode<Chat>(String(row.json));
    const pending = this.get<PendingChatState>('pending-chat', jid) ?? {};
    return {
      ...chatOutput(chat),
      ...(pending.archived ? { archived: null } : {}),
      ...(pending.unread ? { unread: null, unreadCount: null } : {}),
      pending,
      observedAt: row.observed_at,
      activity: {
        timestamp: row.activity_timestamp,
        source: row.activity_source,
      },
    };
  }

  invalidateChatState(key: string, operation: Operation): void {
    if (isSendOperation(operation)) return;
    const pending =
      this.get<PendingChatState>('pending-chat', operation.jid) ?? {};
    if (operation.kind === 'archive')
      pending.archived = { key, value: operation.value };
    else pending.unread = { key, value: !operation.value };
    this.set('pending-chat', operation.jid, pending);
  }

  observeChat(chat: ChatUpdate): void {
    if (!chat.id) {
      this.event('incomplete-chat-key', {});
      return;
    }
    const previous = this.chat(chat.id);
    const merged = { ...previous, ...chat };
    const pending = this.get<PendingChatState>('pending-chat', chat.id) ?? {};
    // Null/absent fields are neutral SDK updates, not observations of false.
    merged.archived =
      typeof chat.archived === 'boolean'
        ? chat.archived
        : (previous?.archived ?? null);
    const freshUnread =
      isUnreadCount(chat.unreadCount) ||
      typeof chat.markedAsUnread === 'boolean';
    merged.unreadCount =
      pending.unread && freshUnread ? null : (previous?.unreadCount ?? null);
    merged.markedAsUnread =
      pending.unread && freshUnread ? null : (previous?.markedAsUnread ?? null);
    if (isUnreadCount(chat.unreadCount)) {
      merged.unreadCount = chat.unreadCount;
      if (chat.unreadCount === 0 || chat.unreadCount === -1)
        merged.markedAsUnread = chat.unreadCount === -1;
    }
    if (typeof chat.markedAsUnread === 'boolean') {
      merged.markedAsUnread = chat.markedAsUnread;
      // -1 is a manual-unread marker, not a remaining message count.
      if (
        !chat.markedAsUnread &&
        !isUnreadCount(chat.unreadCount) &&
        merged.unreadCount === -1
      )
        merged.unreadCount = null;
    }
    if (typeof chat.archived === 'boolean') delete pending.archived;
    // Positive counters can be increments/aggregates; alone they cannot settle pending state.
    if (
      chat.unreadCount === 0 ||
      chat.unreadCount === -1 ||
      chat.markedAsUnread === true
    )
      delete pending.unread;
    this.set(
      'pending-chat',
      chat.id,
      Object.keys(pending).length ? pending : null,
    );
    // SDK event-buffer conditions are functions, not persisted state.
    delete merged.conditional;
    this.db
      .prepare(
        `INSERT INTO chats(jid,json,observed_at) VALUES (?,?,?)
      ON CONFLICT(jid) DO UPDATE SET json=excluded.json,observed_at=excluded.observed_at`,
      )
      .run(chat.id, encode(merged), Date.now());
    this.observeChatActivity(chat);
  }

  private observeActivity(
    jid: string,
    value: Chat['conversationTimestamp'],
    source: ActivitySource,
  ): void {
    const timestamp = activityTimestamp(value);
    if (timestamp === null) return;
    // Preserve the maximum event time; late history and metadata arrival time cannot bump it.
    // Equal timestamps choose a stable field provenance regardless of observation order.
    this.db
      .prepare(
        `UPDATE chats SET activity_timestamp=?,activity_source=? WHERE jid=? AND
      (activity_timestamp IS NULL OR activity_timestamp<? OR (activity_timestamp=? AND activity_source>?))`,
      )
      .run(timestamp, source, jid, timestamp, timestamp, source);
  }

  private observeChatActivity(chat: ChatUpdate): void {
    if (!chat.id) return;
    for (const field of [
      'conversationTimestamp',
      'lastMsgTimestamp',
      'lastMessageRecvTimestamp',
    ] as const) {
      this.observeActivity(chat.id, chat[field], `chat.${field}`);
    }
    for (const entry of chat.messages ?? []) {
      const message = entry.message;
      if (message?.key?.remoteJid === chat.id)
        this.observeActivity(
          chat.id,
          message.messageTimestamp,
          'message.messageTimestamp',
        );
    }
  }

  chats(limit = 100, offset = 0, filters: ChatFilters = {}) {
    const clauses: string[] = [];
    const states: (number | null)[] = [];
    for (const field of ['unread', 'archived'] as const) {
      if (filters[field] === undefined) continue;
      clauses.push(`${field} IS ?`);
      states.push(filters[field] === 'unknown' ? null : Number(filters[field]));
    }
    return this.db
      .prepare(
        `SELECT jid FROM (
      SELECT c.jid,c.activity_timestamp,
        CASE WHEN json_type(p.json,'$.unread')='object' THEN NULL ELSE chat_unread(c.json) END AS unread,
        CASE WHEN json_type(p.json,'$.archived')='object' THEN NULL
          WHEN json_type(c.json,'$.archived') IN ('true','false') THEN json_extract(c.json,'$.archived') ELSE NULL END AS archived
      FROM chats c LEFT JOIN values_store p ON p.category='pending-chat' AND p.id=c.jid
    ) ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY activity_timestamp DESC,jid COLLATE BINARY ASC LIMIT ? OFFSET ?`,
      )
      .all(...states, limit, offset)
      .map((row) => this.chatView(String(row.jid))!);
  }

  observeMessage(message: WAMessage, chatObserved = true): void {
    this.transaction(() => this.writeObservedMessage(message, chatObserved));
  }

  private writeObservedMessage(
    message: WAMessage,
    chatObserved: boolean,
  ): void {
    const { remoteJid: jid, id, fromMe, participant } = message.key;
    if (!jid || !id || typeof fromMe !== 'boolean') {
      this.event('incomplete-message-key', {});
      return;
    }
    this.observeRevocation(message);
    const previousRow = this.messageRow(message.key);
    const previous = previousRow
      ? this.visibleMessage(decodeMessage(String(previousRow.json)))
      : undefined;
    const merged = {
      ...previous,
      ...message,
      key: { ...previous?.key, ...message.key },
    };
    if (previous?.message && !message.message)
      merged.message = previous.message;
    if (
      message.message &&
      message.messageStubType === undefined &&
      previous?.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT
    ) {
      delete merged.messageStubType;
      delete merged.messageStubParameters;
    }
    // Own messages always have the same author. Reuse any existing slot so an
    // older history row and a later phone echo do not require rewriting stored history.
    const participantSlot = fromMe
      ? String(
          this.db
            .prepare(
              'SELECT participant FROM messages WHERE jid=? AND id=? AND from_me=1 ORDER BY rowid LIMIT 1',
            )
            .get(jid, id)?.participant ?? '',
        )
      : (participant ?? '');
    const barrier = this.get<number>('chat-delete-boundary', jid);
    if (
      barrier !== undefined &&
      toNumber(merged.messageTimestamp ?? 0) * 1000 <= barrier &&
      !this.deletion(message.key)
    ) {
      // The all:true event carries no server time/range. A late old/undated arrival is uncertain.
      this.markDeleted(message.key, 'chat-delete-boundary', barrier);
    }
    if (this.deletion(message.key)) {
      this.retainAudit(message.key, merged);
      merged.message = null;
      delete merged.messageStubParameters;
    }
    const timestamp = toNumber(merged.messageTimestamp ?? 0);
    const inserted = this.db
      .prepare('INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?)')
      .run(jid, id, Number(fromMe), participantSlot, timestamp, encode(merged));
    if (previousRow)
      this.db
        .prepare('DELETE FROM message_text WHERE message_rowid=?')
        .run(Number(previousRow.rowid));
    this.indexMessage(Number(inserted.lastInsertRowid), jid, timestamp, merged);
    // Seeing a message proves the conversation exists, not its archive/read state.
    if (chatObserved && !this.chat(jid)) this.observeChat({ id: jid });
    if (chatObserved)
      this.observeActivity(
        jid,
        message.messageTimestamp,
        'message.messageTimestamp',
      );
    this.observeMessageIdentities(message.key);
    const ciphertext =
      message.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT;
    const unexplainedMissingContent =
      !message.message && message.messageStubType == null;
    if (ciphertext || unexplainedMissingContent) {
      this.event('message-content-unavailable', {
        jid,
        id,
        stubType: message.messageStubType ?? null,
      });
    }
    if (message.status !== null && message.status !== undefined)
      this.receipt(message.key, message.status);
  }

  private messageRow(key: WAMessageKey) {
    if (!key.remoteJid || !key.id || typeof key.fromMe !== 'boolean')
      return undefined;
    return key.fromMe
      ? this.db
          .prepare(
            'SELECT rowid,json FROM messages WHERE jid=? AND id=? AND from_me=1 ORDER BY rowid LIMIT 1',
          )
          .get(key.remoteJid, key.id)
      : this.db
          .prepare(
            'SELECT rowid,json FROM messages WHERE jid=? AND id=? AND from_me=0 AND participant=?',
          )
          .get(key.remoteJid, key.id, key.participant ?? '');
  }

  message(key: WAMessageKey): WAMessage | undefined {
    const row = this.messageRow(key);
    return row
      ? this.visibleMessage(decodeMessage(String(row.json)))
      : undefined;
  }

  messages(jid: string, limit = 20, offset = 0): WAMessage[] {
    return this.db
      .prepare(
        'SELECT json FROM messages WHERE jid=? ORDER BY timestamp DESC, rowid DESC LIMIT ? OFFSET ?',
      )
      .all(jid, limit, offset)
      .map((row) => this.visibleMessage(decodeMessage(String(row.json))));
  }

  search(
    query: string,
    limit: number,
    offset: number,
    jid?: string,
  ): WAMessage[] {
    const text = query.normalize('NFKC').toLowerCase();
    // SQLite scans normalized text only. Fetch SDK bodies only for the selected page.
    const rows =
      jid === undefined
        ? this.db
            .prepare(
              'SELECT message_rowid FROM message_text WHERE instr(text,?)>0 ORDER BY timestamp DESC,message_rowid DESC LIMIT ? OFFSET ?',
            )
            .all(text, limit, offset)
        : this.db
            .prepare(
              'SELECT message_rowid FROM message_text WHERE jid=? AND instr(text,?)>0 ORDER BY timestamp DESC,message_rowid DESC LIMIT ? OFFSET ?',
            )
            .all(jid, text, limit, offset);
    const body = this.db.prepare('SELECT json FROM messages WHERE rowid=?');
    return rows.map((row) => {
      const stored = body.get(Number(row.message_rowid));
      if (!stored)
        throw new Error('Search projection references a missing message');
      return this.visibleMessage(decodeMessage(String(stored.json)));
    });
  }

  locateMessage(ref: {
    jid: string;
    id: string;
    fromMe?: boolean;
    participant?: string;
  }): WAMessage {
    const clauses = ['jid=?', 'id=?'];
    const args: (string | number)[] = [ref.jid, ref.id];
    if (ref.fromMe !== undefined) {
      clauses.push('from_me=?');
      args.push(Number(ref.fromMe));
    }
    if (ref.participant !== undefined) {
      clauses.push("json_extract(json,'$.key.participant')=?");
      args.push(ref.participant);
    }
    const rows = this.db
      .prepare(
        `SELECT json FROM messages WHERE ${clauses.join(' AND ')} LIMIT 2`,
      )
      .all(...args);
    if (rows.length === 0)
      throw new CommandError(
        'PRECONDITION_FAILED',
        'Message is not stored for that exact identity',
      );
    if (rows.length > 1)
      throw new CommandError(
        'PRECONDITION_FAILED',
        'Ambiguous message ID; provide fromMe and participant',
      );
    const message = decodeMessage(String(rows[0]?.json));
    if (this.deletion(message.key))
      throw new CommandError(
        'PRECONDITION_FAILED',
        'Message content is unavailable after deletion or an uncertain chat deletion boundary',
      );
    return message;
  }

  messageView(message: WAMessage) {
    const deletion = this.deletion(message.key);
    return messageOutput(message, {
      ...(deletion ? { deletion } : {}),
      quoteVisibility: (ref) => this.quoteVisibility(ref),
    });
  }

  private deletionKey(
    key: WAMessageKey,
  ): [string, string, number, string] | undefined {
    if (!key.remoteJid || !key.id || typeof key.fromMe !== 'boolean')
      return undefined;
    return [
      key.remoteJid,
      key.id,
      Number(key.fromMe),
      key.fromMe ? '' : (key.participant ?? ''),
    ];
  }

  deletion(key: WAMessageKey): Deletion | undefined {
    const identity = this.deletionKey(key);
    if (!identity) return undefined;
    const row = this.db
      .prepare(
        'SELECT at,source FROM message_deletions WHERE jid=? AND id=? AND from_me=? AND participant=?',
      )
      .get(...identity);
    if (!row) return undefined;
    const source =
      row.source === 'revoke'
        ? 'revoke'
        : row.source === 'messages.delete'
          ? 'messages.delete'
          : 'chat-delete-boundary';
    return {
      status: source === 'chat-delete-boundary' ? 'unknown' : 'deleted',
      source,
      observedAt: Number(row.at),
    };
  }

  private visibleMessage(message: WAMessage): WAMessage {
    if (!this.deletion(message.key)) return message;
    const visible = { ...message, message: null };
    delete visible.messageStubParameters;
    return visible;
  }

  private retainAudit(key: WAMessageKey, message: WAMessage): void {
    const identity = this.deletionKey(key);
    if (!identity || !message.message) return;
    this.db
      .prepare(
        'UPDATE message_deletions SET audit_json=COALESCE(audit_json,?) WHERE jid=? AND id=? AND from_me=? AND participant=?',
      )
      .run(encode(message), ...identity);
  }

  private markDeleted(
    key: WAMessageKey,
    source: Exclude<Deletion['source'], null>,
    at = Date.now(),
    entireChat = false,
  ): void {
    const identity = this.deletionKey(key);
    const missingAuthor =
      !key.fromMe &&
      (key.remoteJid?.endsWith('@g.us') ||
        key.remoteJid?.endsWith('@broadcast')) &&
      !key.participant;
    if (
      !identity ||
      (missingAuthor && source !== 'chat-delete-boundary' && !entireChat)
    ) {
      this.event('message-deletion-unknown', {
        jid: key.remoteJid ?? null,
        id: key.id ?? null,
        reason: 'incomplete-target-identity',
      });
      return;
    }
    this.db
      .prepare(
        `INSERT INTO message_deletions VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(jid,id,from_me,participant)
      DO UPDATE SET at=CASE WHEN source='chat-delete-boundary' THEN excluded.at ELSE at END,
      source=CASE WHEN source='chat-delete-boundary' THEN excluded.source ELSE source END`,
      )
      .run(...identity, at, source);
    const [jid, id, fromMe, participant] = identity;
    const rows = fromMe
      ? this.db
          .prepare(
            'SELECT rowid,json FROM messages WHERE jid=? AND id=? AND from_me=1',
          )
          .all(jid, id)
      : this.db
          .prepare(
            'SELECT rowid,json FROM messages WHERE jid=? AND id=? AND from_me=0 AND participant=?',
          )
          .all(jid, id, participant);
    for (const row of rows) {
      const message = decodeMessage(String(row.json));
      this.retainAudit(key, message);
      message.message = null;
      delete message.messageStubParameters;
      this.db
        .prepare('UPDATE messages SET json=? WHERE rowid=?')
        .run(encode(message), Number(row.rowid));
      this.db
        .prepare('DELETE FROM message_text WHERE message_rowid=?')
        .run(Number(row.rowid));
    }
  }

  deleteMessages(event: BaileysEventMap['messages.delete']): void {
    this.transaction(() => {
      this.applyDeleteEvent(event, Date.now());
      this.event(
        'messages.delete',
        'keys' in event
          ? {
              keys: event.keys.map(
                ({ remoteJid, id, fromMe, participant }) => ({
                  remoteJid,
                  id,
                  fromMe,
                  participant,
                }),
              ),
            }
          : { jid: event.jid, all: true },
      );
    });
  }

  private applyDeleteEvent(
    event: BaileysEventMap['messages.delete'],
    at: number,
    recovering = false,
  ): void {
    if ('keys' in event) {
      for (const key of event.keys)
        this.markDeleted(key, 'messages.delete', at);
      return;
    }
    this.set(
      'chat-delete-boundary',
      event.jid,
      Math.max(this.get<number>('chat-delete-boundary', event.jid) ?? 0, at),
    );
    for (const message of this.messages(event.jid, -1)) {
      if (!recovering)
        this.markDeleted(message.key, 'messages.delete', at, true);
      else if (toNumber(message.messageTimestamp ?? 0) * 1000 <= at)
        this.markDeleted(message.key, 'chat-delete-boundary', at);
    }
  }

  private revocationTarget(message: WAMessage): WAMessageKey | undefined {
    const protocol = normalizeMessageContent(message.message)?.protocolMessage;
    if (
      protocol?.type !== proto.Message.ProtocolMessage.Type.REVOKE ||
      !protocol.key ||
      !message.key.remoteJid ||
      typeof message.key.fromMe !== 'boolean'
    )
      return undefined;
    const target = protocol.key;
    const id = target.id;
    if (!id) return undefined;
    const jid = message.key.remoteJid;
    const direct = isPn(jid) || isLid(jid);
    const me = this.get<Pick<AuthenticationCreds, 'me'>>('auth', 'creds')?.me;
    const self = [me?.id, me?.lid]
      .filter((jid): jid is string => Boolean(jid))
      .map(jidNormalizedUser);
    // In an inbound 1:1 the sender's remoteJid can name us. Accept that perspective
    // only against authenticated self identities; the local target stays in this exact chat.
    const addressedToSelf =
      !message.key.fromMe &&
      direct &&
      target.fromMe === true &&
      target.remoteJid != null &&
      self.includes(target.remoteJid);
    if (target.remoteJid && target.remoteJid !== jid && !addressedToSelf)
      return undefined;
    // Embedded fromMe is relative to the notification's sender. Only true identifies
    // that same author; another sender's false cannot establish our account's direction.
    if (target.fromMe === true) {
      if (
        target.participant &&
        target.participant !== message.key.participant &&
        !(message.key.fromMe && self.includes(target.participant)) &&
        !(!message.key.fromMe && direct && target.participant === jid)
      )
        return undefined;
      return { ...message.key, id };
    }
    if (target.fromMe !== false || message.key.fromMe !== true)
      return undefined;
    // Our own administrative revoke supplies account-relative false. In a group it
    // still needs the original participant, not the administrator on the envelope.
    if (
      (message.key.remoteJid?.endsWith('@g.us') ||
        message.key.remoteJid?.endsWith('@broadcast')) &&
      !target.participant
    )
      return undefined;
    if (
      target.participant &&
      (target.participant === message.key.participant ||
        self.includes(target.participant))
    )
      return undefined;
    return {
      remoteJid: message.key.remoteJid,
      id,
      fromMe: false,
      participant: target.participant ?? null,
    };
  }

  private observeRevocation(message: WAMessage): void {
    const protocol = normalizeMessageContent(message.message)?.protocolMessage;
    if (protocol?.type !== proto.Message.ProtocolMessage.Type.REVOKE) {
      if (message.messageStubType === proto.WebMessageInfo.StubType.REVOKE)
        this.markDeleted(message.key, 'revoke');
      return;
    }
    const target = this.revocationTarget(message);
    if (!target) {
      this.event('message-deletion-unknown', {
        reason: 'inconsistent-protocol-target',
      });
      return;
    }
    this.markDeleted(target, 'revoke');
  }

  updateMessage(change: WAMessageUpdate): void {
    this.transaction(() => this.writeMessageUpdate(change));
  }

  private writeMessageUpdate({ key, update }: WAMessageUpdate): void {
    // update.key in a REVOKE is the notification key, not the target key.
    if (update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
      if (update.key) {
        const notification = this.message(update.key);
        const expected = notification
          ? this.revocationTarget(notification)
          : undefined;
        // rc14's derived update drops the embedded target's chat/participant. It cannot
        // override the raw notification's rejection, or establish a target without it.
        if (
          !expected ||
          encode(this.deletionKey(expected)) !== encode(this.deletionKey(key))
        ) {
          this.event('message-deletion-unknown', {
            jid: key.remoteJid ?? null,
            id: key.id ?? null,
            reason: 'unverified-revoke-notification',
          });
          if (update.status != null) this.receipt(key, update.status);
          return;
        }
      }
      this.markDeleted(key, 'revoke');
    }
    const previous = this.message(key);
    // Status/content edits do not establish a newly active conversation.
    if (previous) this.observeMessage({ ...previous, ...update, key }, false);
    if (update.status != null) this.receipt(key, update.status);
  }

  private quoteVisibility(
    ref: QuoteReference,
  ): 'deleted' | 'unknown' | undefined {
    if (!ref.jid) return undefined;
    if (!ref.id)
      return this.get<number>('chat-delete-boundary', ref.jid) === undefined
        ? undefined
        : 'unknown';
    const rows = this.db
      .prepare(
        'SELECT from_me,participant,source FROM message_deletions WHERE jid=? AND id=?',
      )
      .all(ref.jid, ref.id);
    if (rows.length && !ref.participant) return 'unknown';
    const matches = rows.filter(
      (row) =>
        row.participant === ref.participant ||
        (row.from_me === 0 &&
          row.participant === '' &&
          ref.participant === ref.jid),
    );
    if (matches.length)
      return matches.some((row) => row.source !== 'chat-delete-boundary')
        ? 'deleted'
        : 'unknown';
    // An own message may have no stored participant. Do not attribute it by guesswork.
    if (rows.some((row) => row.from_me === 1)) return 'unknown';
    const barrier = this.get<number>('chat-delete-boundary', ref.jid);
    if (barrier === undefined) return undefined;
    // An embedded quote has no timestamp. Only an exact newer observation can clear the boundary.
    const known = this.db
      .prepare('SELECT json FROM messages WHERE jid=? AND id=?')
      .all(ref.jid, ref.id)
      .map((row) => decodeMessage(String(row.json)))
      .filter(
        (message) =>
          ref.participant &&
          (message.key.participant === ref.participant ||
            (message.key.fromMe === false &&
              !message.key.participant &&
              ref.participant === ref.jid)),
      );
    return known.length === 1 &&
      toNumber(known[0]?.messageTimestamp ?? 0) * 1000 > barrier
      ? undefined
      : 'unknown';
  }

  request(key: string): RequestRecord | undefined {
    const row = this.db
      .prepare('SELECT json FROM requests WHERE key=?')
      .get(key);
    return row ? decode<RequestRecord>(String(row.json)) : undefined;
  }

  saveRequest(record: RequestRecord): void {
    this.db
      .prepare('INSERT OR REPLACE INTO requests VALUES (?,?)')
      .run(record.key, encode(record));
  }

  receipt(key: WAMessageKey, status: number): void {
    if (key.fromMe !== true || !key.id || !key.remoteJid) return;
    if (
      !Number.isInteger(status) ||
      status < proto.WebMessageInfo.Status.ERROR ||
      status > proto.WebMessageInfo.Status.PLAYED
    )
      return;
    for (const row of this.db
      .prepare(
        "SELECT json FROM requests WHERE json_extract(json,'$.messageId')=?",
      )
      .all(key.id)) {
      const request = decode<RequestRecord>(String(row.json));
      if (!isSendOperation(request.operation) || request.messageId !== key.id)
        continue;
      const destination =
        request.route?.status === 'proven'
          ? request.route.jid
          : request.operation.jid;
      if (request.route?.status === 'proven') {
        if (key.participant || receiptUserJid(key.remoteJid) !== destination)
          continue;
      } else if (destination !== key.remoteJid) continue;
      // Monotonic evidence: late PENDING/ERROR events cannot erase an observed receipt.
      if (status === proto.WebMessageInfo.Status.ERROR)
        request.errorObserved = true;
      if (status >= proto.WebMessageInfo.Status.SERVER_ACK)
        request.acceptance = 'server-ack';
      if (status >= proto.WebMessageInfo.Status.DELIVERY_ACK)
        request.delivery = 'delivered';
      if (status >= proto.WebMessageInfo.Status.READ) request.read = 'read';
      this.saveRequest(request);
    }
  }
}
