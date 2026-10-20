# SQLite backup and offline recovery

`backup --out NEW_DIRECTORY` requests a SQLite snapshot from the running runtime through its existing database handle. The CLI only sends a socket request. An offline runtime remains offline; no WhatsApp operation, scheduler, or upload is involved.

## Scope

The database contains auth/Signal/app-state keys, messages, deletion audit/tombstones, immutable intents/IDs/routes/receipts, pending chat state, contact/identity/activity/search evidence, events, schema, and rowids. This data is sensitive and **not encrypted at rest**.

The backup excludes execution locks/socket, logs, QR images, downloaded media, original sent files, and the entire observability area, preference, and secret. File manifests retain paths and hashes, not external file bytes. SQLite-only recovery into a new directory leaves observability disabled and cannot restore external files or remote media availability.

For a manual full-directory backup, stop the runtime normally, confirm its PID has exited, then copy the entire private directory, including sidecars. Never copy a live database file alone.

## Create and verify

```sh
node dist/src/cli.js --data-dir /absolute/private/example-session backup \
  --out /absolute/private/backup-parent/snapshot-001
```

The output path must not exist, even as an empty directory or dangling symlink. Its existing parent must be owned/private (0700) with [trusted canonical ancestry](privacy.md). The runtime creates the output directory with 0700 permissions and files with 0600. It does not repair existing content or permissions. Only one backup can run at a time.

[Node's online backup API](https://github.com/nodejs/node/blob/v24.18.0/doc/api/sqlite.md#sqlitebackupsource-db-path-options) produces a consistent committed state. Commits made during copying may be included, so the result does not guarantee command-start state or capture in-flight SDK work. The source database is not vacuumed or checkpointed. The artifact alone uses DELETE journal mode, preserving logical rows, rowids, and schema.

After schema-1 and `PRAGMA integrity_check` validation, the runtime closes, hashes, and synchronizes the artifact and manifest before publishing completion.

| Entry                 | Meaning                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `probe.sqlite`        | Standalone database, potentially partial until completion.                                                  |
| `backup.pending.json` | Verified metadata alone does not establish completion.                                                      |
| `backup.json`         | Published last through an exclusive hard link to the pending manifest; both names share one manifest inode. |

Full, compact, and JSONL output preserve `state: complete`, `scope: sqlite-only`, `sensitive: true`, absolute directory/artifact/manifest paths, bytes/SHA-256, schema 1, integrity ok, local started/verified times, and exclusions.

These times bound the local backup operation, not an exact snapshot or remote event time. The response envelope's connection/recovery describes the responding runtime, not the snapshot's historical state.

## Failures and timeouts

Existing or unsafe output, concurrent backups, and stopping state return `PRECONDITION_FAILED`. Invalid input returns `INVALID_ARGUMENT`; copy, verification, or publication failures return safe `LOCAL_STATE` errors.

Partial output is preserved, never reused or removed automatically. Without `backup.json`, the backup is incomplete even if SQLite can open the database. A filesystem without hard-link or synchronization support cannot publish completion.

A timeout or disconnect does not cancel copying. Runtime shutdown waits for the backup before closing SQLite and releasing ownership. Inspect `backup.json` and verify the recorded bytes and hash before accepting the artifact.

Preserve partial output and choose a new destination for another explicit attempt. Crash and power-loss durability have not been established; an unpersisted completion entry conservatively leaves the output incomplete.

## Recover only into a NEW directory, offline

For real credentials, stop the original runtime and confirm that its recorded PID has exited. Preserve the original state and backup. Do not restore over existing state, copy locks/sockets, run an older writer against schema 1, or start a second live session with cloned credentials.

Choose a completed, trusted backup and a nonexistent target under a private canonical parent. The following procedure verifies the source bytes before copying and checks integrity on the new copy without opening the original as a Store:

```sh
umask 077
backup_dir=/absolute/private/backup-parent/snapshot-001
new_data=/absolute/private/recovered-001
node --input-type=module - "$backup_dir" "$new_data" <<'JS'
import { constants, copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [directory, target] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(directory, 'backup.json'), 'utf8'));
const source = join(directory, 'probe.sqlite'); // Do not follow paths supplied by the manifest.
if (manifest.state !== 'complete' || manifest.scope !== 'sqlite-only' || manifest.schemaVersion !== 1) throw new Error('Unsupported backup');
const hash = createHash('sha256');
for await (const bytes of createReadStream(source)) hash.update(bytes);
if (statSync(source).size !== manifest.bytes || hash.digest('hex') !== manifest.sha256) throw new Error('Backup bytes differ');
mkdirSync(target, { mode: 0o700 }); // Fails if anything already exists; no recursive creation.
const path = join(target, 'probe.sqlite');
copyFileSync(source, path, constants.COPYFILE_EXCL);
const db = new DatabaseSync(path, { readOnly: true });
try {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok' || db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Recovery verification failed');
} finally { db.close(); }
JS
node dist/src/cli.js --data-dir "$new_data" start --offline
node dist/src/cli.js --data-dir "$new_data" status
node dist/src/cli.js --data-dir "$new_data" chats --limit 20
node dist/src/cli.js --data-dir "$new_data" request --key ORIGINAL_KNOWN_KEY
node dist/src/cli.js --data-dir "$new_data" stop
```

Stop on any failure (use `set -eu` in a shell script). A failed copy or integrity check leaves the new directory for investigation; do not reuse it.

After starting, require `networkEnabled: false` and an offline connection. Inspect known history, identity, pending state, and original request keys, preserving exact identities, routes, IDs, and uncertainty. There is no destructive restore command or automatic reconnection.

A snapshot may predate later sends, receipts, or deletions. Missing keys in an older backup do not prove those actions never occurred or authorize resending. Reconcile the missing interval against newer evidence before separately approved live recovery. Credentials may no longer be valid.

## Resource use

Copying runs asynchronously in batches, while artifact integrity checking is synchronous and can delay commands and events. Allow disk space for a database-sized snapshot, including free pages. Copying, integrity checking, and hashing each read the database artifact or source. There is no compression, pruning, throughput, or power-loss durability guarantee.

Large backups may exceed the CLI stop wait; allow normal completion and PID exit.
