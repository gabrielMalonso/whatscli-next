import type { DatabaseSync } from 'node:sqlite';

/** Additive schema: SDK bodies and private audit stay outside the narrow search table. */
export function createSchema(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version !== 0 && version !== 1)
    throw new Error(
      'Unsupported Store schema; use a compatible version or a NEW --data-dir. Existing state was preserved.',
    );
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS values_store (category TEXT, id TEXT, json TEXT NOT NULL, PRIMARY KEY(category,id));
    CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, json TEXT NOT NULL, observed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      jid TEXT, id TEXT, from_me INTEGER, participant TEXT, timestamp INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY(jid,id,from_me,participant)
    );
    CREATE TABLE IF NOT EXISTS message_deletions (
      jid TEXT, id TEXT, from_me INTEGER, participant TEXT, at INTEGER NOT NULL,
      source TEXT NOT NULL, audit_json TEXT,
      PRIMARY KEY(jid,id,from_me,participant)
    );
    CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_mappings (
      pn TEXT NOT NULL, lid TEXT NOT NULL, source TEXT NOT NULL, observed_at INTEGER,
      PRIMARY KEY(pn,lid,source)
    );
    CREATE INDEX IF NOT EXISTS identity_mapping_lid ON identity_mappings(lid);
    CREATE TABLE IF NOT EXISTS message_text (
      message_rowid INTEGER PRIMARY KEY, jid TEXT NOT NULL, timestamp INTEGER NOT NULL, text TEXT NOT NULL
    );
  `);
}
