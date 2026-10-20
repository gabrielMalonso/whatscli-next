# Consistent SQLite backup and offline recovery

`backup --out NEW_DIRECTORY` explicitly asks the running runtime to snapshot its SQLite database. The CLI only sends a socket request; it never opens the Store. Nothing is scheduled, uploaded, downloaded, sent to WhatsApp or paired. An offline runtime stays offline. The existing manual option remains valid: stop normally, confirm the recorded PID exited, then privately copy the entire data directory, including any SQLite sidecars. Never copy a live `probe.sqlite` alone.

## Scope

| Included in `probe.sqlite` | Outside this snapshot |
| --- | --- |
| SDK-serialized credentials and key categories, including sessions and app-state keys | Lifetime `writer-lock.sqlite` and its sidecars; control socket |
| Immutable intents, message IDs, routes, receipts and pending chat state | `daemon.log` and other logs |
| Messages, private deletion audit, tombstones and chat-delete boundaries | Pairing QR PNGs |
| Chat/contact/identity evidence, search projection, events, migration markers, schema and rowids | Downloaded media, original sent files and every other external file |

This is **SQLite only**, not a complete copy of the data directory. The database contains sensitive credentials, message bodies, audit and intent evidence, **without encryption at rest**. Keep the entire output private and out of version control. File manifests retain the original local paths/hashes; they do not include the files. Recovery cannot recreate those external files or make media remotely available.

## Create explicitly

Use the same explicit source data directory as the running daemon. Create a new private parent first (its own parent must already exist); never repair an existing directory's permissions silently:

```sh
umask 077
mkdir -m 700 /absolute/private/backup-parent
node dist/src/cli.js --data-dir /absolute/private/session backup \
  --out /absolute/private/backup-parent/snapshot-001
```

The immediate parent must already be owned by the runtime user with mode 0700. Every ancestor must be a directory owned by the runtime user or root, without symlinks or group/world write permission; root-owned sticky temporary directories such as Linux `/tmp` are permitted. A foreign-owned `0755` ancestor is unsafe too: its owner can replace its children. Choose a canonical path without symlink ancestors. The requested output directory must not exist, including as a file, empty directory or dangling symlink. No existing content is overwritten. The operation creates mode 0700 output and mode 0600 files, rejecting unexpected permissions instead of changing them. These checks rely on the owning account remaining trusted; they are not isolation from another process running as that same user or root. macOS remains unvalidated.

Only one backup runs at a time; another request gets `PRECONDITION_FAILED`. SQLite uses the runtime's existing database handle and [Node 24.18's online backup API](https://github.com/nodejs/node/blob/v24.18.0/doc/api/sqlite.md#sqlitebackupsource-db-path-options), not raw file copying or manually assembled WAL/SHM. Committed mutations on that same handle may enter the snapshot while it runs; this is a consistent committed state, not a promise to capture command-start time or in-flight SDK work. See [SQLite's online backup consistency rules](https://www.sqlite.org/backup.html#file_and_database_connection_locking). The source is neither vacuumed nor checkpointed by this command. Only the artifact's journal mode is changed to DELETE, producing a standalone SQLite file without changing logical rows/rowids or schema.

The runtime checks the artifact with `PRAGMA integrity_check`, checks schema 1, closes it, streams its bytes through SHA-256 and synchronizes the database and pending manifest before publication. It creates:

- `probe.sqlite`: the standalone database, potentially partial until publication.
- `backup.pending.json`: safe metadata written after verification; alone it does **not** mean completion.
- `backup.json`: atomically published last using a no-overwrite hard link to the pending metadata. Both names refer to the same manifest inode; there is no second database copy.

Full and compact responses contain the same `data`: `state: complete`, `scope: sqlite-only`, `sensitive: true`, absolute `directory`/`path`/`manifestPath`, actual artifact `bytes`/`sha256`, `schemaVersion: 1`, `integrity: ok`, `startedAt`/`verifiedAt` in local milliseconds and the excluded categories. No bodies, identities, credentials, SQL or raw SDK objects are returned. Times bound the operation; neither is an exact remote or snapshot timestamp. The response envelope's connection/recovery fields describe the responding runtime, not the snapshot's historical point. No later live counts are attributed to the backup.

Hash/size establish the recorded local artifact bytes, not authenticity, remote completeness, credential validity or delivery. Local history remains partial, app state unknown and receive continuity unproven. Backup does not settle an uncertain intent, cancel a pending send or authorize another attempt. Changes after the snapshot are absent, including later intents/receipts/deletions; an older snapshot cannot prove they never occurred. Before any separately authorized live recovery, reconcile that missing interval independently and preserve the newer state. Never infer permission to resend from a missing key in an older backup.

## Failure, timeout and interruption

`INVALID_ARGUMENT` covers an invalid path; `PRECONDITION_FAILED` covers unsafe/existing output or an already running backup/stopping runtime. Filesystem/copy/verification/publication failures use safe `LOCAL_STATE` text. Partial output stays in the newly reserved directory; the operation does not delete it or reuse it. A directory, database or pending manifest **without `backup.json` is incomplete**, even if SQLite can open it. Preserve it for diagnosis; choose a new output directory for another explicit attempt. A filesystem that cannot hard-link or synchronize the output fails without publishing completion.

A transport timeout/disconnect is an unknown command outcome, not cancellation. The runtime continues its own backup and waits for it before closing SQLite or releasing the writer lock, including during stop. Inspect the requested output's `backup.json`, parse it and verify its recorded size/hash before treating the artifact as completed. Do not overwrite/retry that same directory. There is no progress/job/retry service. The completion directory entry may be lost across a crash before the filesystem persists it, conservatively leaving incomplete output; this does not claim power-loss, hardware durability or disk-health validation.

## Recover only into a NEW directory, offline

The automated recovery evidence uses fictional fixtures only. The following procedure also describes the bounded manual operation for a separately authorized recovery. Do not replace an active or existing directory, copy execution locks/sockets, start a second network connection for cloned credentials, or run an older writer against schema 1. For an actual account, first stop its original runtime normally and confirm its recorded PID exited; a missing socket or timeout alone is insufficient. Do not signal/kill it, remove locks, log out or re-pair as a recovery shortcut. Keep the original directory and backup untouched.

Select a trusted completed backup and a **nonexistent** new data directory under an already private, canonical parent. This example verifies bytes before copying and SQLite integrity on the new copy. It does not open the backup as a Store or change the original:

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

Stop on any failed step (`set -eu` when running as a shell program). A failed copy/check leaves only its own new directory for investigation; never reuse it. Require `data.networkEnabled: false` and `connection: offline` after every start. Compare known fixture/history/search/identity/pending/request evidence, keeping exact PN/LID identities, original message IDs/routes and uncertainty. Automated tests also reopen the recovered Store and replay existing keys offline twice, including an unavailable original file, with no validation/lookup/read-file/send attempt. There is no destructive restore command, automatic reconnection, real-account recovery validation or guarantee that old credentials remain usable.

## Offline verification and cost

`pnpm test` includes WAL-active commits and an atomic observation written between native backup steps, full logical schema/table/rowid comparison (including SDK binary auth and protobuf Long timestamps), artifact integrity/hash checks, NEW Store/daemon recovery and unchanged original backup bytes. It covers no-overwrite, symlinks, parent permissions, repeated explicit backups, copy/corruption/publication failures, concurrent admission and source ownership. An injected foreign-owned `0755` ancestor is rejected before destination reservation/copy; this checks the ownership boundary without chown, another account or an actual multi-user attack. A gated offline daemon demonstrates that RPC timeout and stop retain the writer lock until the backup finishes. No live account or network factory is used.

Copying is asynchronous in batches; integrity checking runs synchronously on the artifact and can delay commands/events. Hashing streams bounded chunks instead of loading the whole database. Expect roughly one database-sized write plus copy/integrity/hash reads and space for the snapshot (including SQLite free pages); there is no compression, pruning, retention change or throughput guarantee. Stop/shutdown may exceed the existing CLI wait while a large backup finishes; wait for normal completion/PID exit. Do not run repeated heavy backups speculatively.

A bounded Linux x64 observation on Node 24.18.0 / SQLite 3.53.1 used two new generated stores, each seeded in one transaction with fictional 64 KiB values and active WAL. One snapshot per store, including conversion/integrity/hash/publication, took **130.67 ms for 8,540,160 artifact bytes** (8 MiB seed payload) and **310.89 ms for 33,918,976 bytes** (32 MiB payload). These are n=1 observations with uncontrolled/warm OS cache, not latency distributions, event-loop stall measurements, cold-disk throughput or account-specific sizing. They do not validate disk hardware, power loss, live catch-up or macOS.
