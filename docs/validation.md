# Baileys feasibility validation

Date: 2026-10-19. Decision: **the essential flow passed; proceed with the small CLI and explicit observability limits**. QR pairing, saved-session restart, bidirectional text exchange, idempotency, archive/unarchive, phone-confirmed read/unread, phone-originated changes, automatic WebSocket recovery, and post-recovery sending have live evidence. Read counters can remain stale after an own mutation and must not be treated as current until fresh evidence arrives.

## Version and inspection

The npm registry reported `baileys@7.0.0-rc14` as `latest` and `6.7.24` as `legacy`. The selected version is a release candidate, pinned exactly rather than fetched from a moving Git branch.

- npm `gitHead`: `7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a`.
- npm integrity: `sha512-pewtrljhWx5JTUBvvkXZz1fL3JPiwzjBsnhx/DWf2LWBx1cZNH7J/sF22xDehba5mySWUQU4a1Pwt7lWARUxaA==`.
- Bundled WhatsApp protocol version: `[2, 3000, 1043857760]`. No automatic version fetching or fallback was added. The real QR handshake and subsequent saved-session logins succeeded with this version.
- Inspected the [tagged upstream guide](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/README.md) and the npm-distributed JavaScript/types in `node_modules/baileys/lib/`, especially socket connection, chat synchronization, send/receive, auth storage, and event definitions.
- Some guide URLs (`baileys.wiki/docs/...` and `whiskey.so/migrate-latest`) returned 404/unavailable during research. The tagged README contains stale API names (for example `messaging.history-set`); the installed types specify `messaging-history.set`. Implementation follows the installed version.

## SDK behavior requiring real evidence

1. **Partial app state with an open connection.** In published `lib/Socket/chats.js:410–556`, `resyncAppState` may park collections on missing keys or give up on irrecoverable synchronization failures, log the failure, and return. At `:1101`, initial synchronization can time out after 20 seconds and transition to Online. Connection openness and a resolved promise therefore do not prove complete state. The probe retains warnings and always reports unknown app-state completeness. See [upstream chat synchronization](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Socket/chats.ts).

2. **Synthetic local events.** In the same module around `:695–755`, `appPatch` sends a patch, persists its version, then optionally applies its own decoded mutations as events. The default `emitOwnEvents: true` cannot independently prove the phone's state. The probe sets it to false and leaves mutations unverified. A later incremental resync may not emit that own patch again, since its version was already advanced; absence of a new event is inconclusive. A reliable observation strategy remains part of the gate.

3. **Message return versus receipt.** Published `lib/Socket/messages-send.js:1128–1145` returns the generated message after relay; the generated message is not delivery or read evidence. Statuses are observed separately in `messages.update`. The probe persists a message ID before sending, retains unknown results, and correlates exact recipient/message identities. See [upstream message sending](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Socket/messages-send.ts).

4. **SDK retries can resend.** Published `lib/Socket/messages-recv.js:1040–1157` retrieves outgoing content from its recent-message cache or `getMessage` and can re-relay on retry receipts (`:1205–1216`). Application-level idempotency alone would not prevent those retries. This probe disables the recent-message cache and returns no outgoing content from `getMessage`. Incoming decryption retry requests remain enabled. See [upstream message receiving](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Socket/messages-recv.ts).

5. **Buffered/missing events and unavailable content.** The receive path treats `!!node.attrs.offline` as the offline flag (`:1603`); even the string `"0"` is truthy. A report describes events remaining buffered when the expected offline completion node never arrives. This is an upstream report and code observation, not a failure reproduced here. See [issue #2810](https://github.com/WhiskeySockets/Baileys/issues/2810). The probe records missing-content/stub events; empty local results and `isLatest`/history milestones never imply full coverage.

6. **Credential logging in a dependency.** Installed `libsignal@6.0.0/src/session_record.js:267–301` passes complete session objects to `console.info`/`console.warn`. Those objects can contain private keys. The probe discards console object arguments and routes the remaining diagnostic string to stderr. A child-process test verifies that session object keys cannot appear in stdout or stderr.

7. **The raw registration flag is not a Web pairing verdict.** The observed SDK state had a signed account, a linked-device identity, and an authenticated open connection, while `creds.registered` stayed false. Published `configureSuccessfulPairing` in `lib/Utils/validate-connection.js` installs the signed `account` and `me` without setting that flag. The probe exposes `hasLinkedCredentials` separately and requires a live open connection when operating. A pending phone-code request setting `me` alone is not treated as a completed pairing.

## Local results

Environment: Linux, Node `24.18.0`, pnpm `10.24.0`, TypeScript `5.9.3`. Published Baileys and its native dependency load successfully. Tests use fictional data and no WhatsApp network access.

Probe validation: 23 tests passed. Final daemon/CLI suite: **32 tests passed**, with `pnpm check` also passing. Installation with `pnpm install --frozen-lockfile --ignore-scripts` confirmed that the pinned lockfile is current. Covered behaviors:

- Credentials, binary Signal keys, and protobuf app-state keys survive reopening SQLite.
- Failed key batches roll back; private permissions and one-writer exclusion are enforced.
- Duplicate message events deduplicate while recipient, direction, and participant remain distinct.
- Partial chat updates preserve previously observed fields; missing keys/content produce evidence gaps.
- Exact PN/LID identities are accepted without telephone inference; display names, device JIDs, and malformed group IDs are rejected.
- Requests and message IDs are committed before invocation; repeated/conflicting keys are handled across restart.
- Network exceptions and abrupt process exit preserve uncertainty, never re-execute the request, and release the writer lock.
- Receipt identity checks, monotonic evidence, and receipts arriving before the SDK returns behave correctly.
- Archive/read SDK returns do not optimistically replace observed chat state.
- The JSONL process starts offline, emits only JSON on stdout, and rejects unapproved mutations.
- Terminal disconnect codes stop reconnecting; transient retry delays are capped.
- Dependency session objects do not leak through console diagnostics.
- QR images are private and generated with unique filenames; repeated requests preserve existing images. Offline QR requests fail without exposing authentication data.
- Web-paired credentials survive restart while `registered` remains false; service notifications are not misclassified as decryption gaps, and later plaintext clears an earlier ciphertext stub.
- Exact modern/legacy group JIDs are accepted. A group send and its phone echo share one stored message even when the echo adds the sender's participant ID. Group send return values do not imply delivery/read by participants.
- Public message/chat/event projections exclude embedded protocol secrets while retaining the raw SDK data in private storage for the SDK's own use.
- Pending archive/read intents invalidate only the affected public field, survive restart, and clear only after a corresponding fresh SDK observation. Unrelated chat updates do not make a stale read counter current.
- Offline CLI lifecycle, Unix-socket request/response correlation, pagination, literal Unicode search, configuration preservation, stale-socket recovery, and preservation of unfamiliar files are exercised through real child processes.
- File manifests describe an immutable byte snapshot before invocation. Download tests check exact bytes, SHA-256, private permissions, output collisions, failures and size limits. Ambiguous message identities are rejected. Concurrent duplicate sends share one durable attempt.

File sending and media downloading were tested with injected SDK/I/O boundaries, not with real WhatsApp media. macOS execution and prolonged physical network outages remain unverified.

## Live checkpoints

### Recipient resolution feature — offline evidence

The recipient-resolution change adds 12 offline regression tests (44 total passing), with `pnpm check` passing. Tests inject a partial SDK socket; no private session, real WhatsApp connection, messages or account mutations are used. The real-socket CLI tests use a short OS temporary path to remain below the Unix socket limit in long worktrees.

Inspected the installed `baileys@7.0.0-rc14` code/types: `lib/Socket/socket.js` (`onWhatsApp` and its filtering of negative entries), `lib/Socket/chats.d.ts`, `lib/Types/Contact.d.ts`, `lib/Types/Events.d.ts`, `lib/Signal/lid-mapping.js`, and `lib/Utils/process-message.js`/`history.js`. Exact PN confirmation is separate from contact/mapping observations and from observed conversations. SDK mapping storage uses forward and reverse user-ID entries; legacy entries lack an observation time and are reported with null times.

Covered strict international input; missing/partial/negative/ambiguous/different-identity responses; unknown and conflicting PN/LID associations in both directions; event/metadata provenance; legacy evidence migration; verification after restart; offline lookup/network refusal; verified versus unverified first text/document contact; exact recipient restrictions; repeated/conflicting immutable keys; unchanged receipt identities; no synthetic chats from lookup/send return; and safe contact projections/error handling. No new SDK, dependency or SDK fork was introduced. Positive resolution and real first-contact text/document/receipt behavior remain unverified until checkpoint 06.

### Baseline live evidence

Account identifiers, conversation names, QR images, message data, and exact event evidence remain in the ignored private session directory. This report contains no account-specific examples.

- QR pairing: the account owner confirmed scanning, and the probe observed an authenticated open connection with signed account credentials.
- Session restart: the probe was stopped normally and relaunched with the same private directory. It returned to an open connection with no QR, preserving the linked device and stored history. This succeeded on repeated process restarts.
- History: initial bootstrap and recent-history milestones were explicitly completed by the SDK. One live encrypted message still arrived as `CIPHERTEXT` with `No session found to decrypt message`; the client remained connected. Its eventual recovery has not been demonstrated. History completeness therefore remains unknown. Service notifications without ordinary message bodies are retained as notifications rather than counted as decryption failures.
- Recipient identity: an explicitly selected group was found by exact name and its exact JID was verified through live group metadata. Test mutations are restricted to that observed JID.
- Send intent: one authorized test text was persisted before invocation and returned the expected message ID from `sendMessage`. The account owner confirmed that it appeared exactly once. Acceptance, delivery, and read remain unknown in the SDK-derived request record because no matching acknowledgment/receipt evidence has been observed by the probe; the owner's observation is separate evidence.
- Idempotency across restart: after stopping/relaunching, the same request key returned the same recorded message ID. The durable event journal contains one network-attempt entry for that key, and the owner confirmed one visible copy.
- Receiving: a new plaintext group message arrived from the other participant (`fromMe: false`), with an exact participant LID and an SDK-provided alternate JID. Its message ID, direction, body, and timestamp remained stored after a further process restart. No phone number was inferred from a LID.
- Archive/unarchive: the owner confirmed both states on the linked account. Subsequent `chats.update` events carried `archived: true` and then `false`, despite `emitOwnEvents: false`. The archived state also survived a process restart. Immediate command responses still showed the previous local value before these later events, which is a real eventual-consistency window.
- Mark read/unread: both calls returned, and the owner confirmed their effects. The local `unreadCount` remained `1` after marking read and also did not immediately become the manual-unread marker after marking unread. This is a real stale-cache condition, not proof that the phone mutation failed.
- Phone-originated changes: at the owner's request, the owner manually unarchived and opened the conversation. Fresh `chats.update` events subsequently carried `unreadCount: 0` and `archived: false`. The stored state became read/unarchived and survived the following process restart. This demonstrates the reverse synchronization path.
- Automatic recovery: the probe closed its underlying WebSocket without explicitly calling its reconnect routine. Its normal close handler observed code `428`, reconnected automatically, and returned to an authenticated open connection in about 2.3 seconds, without a new pairing. Repeating the original send key still left its network-attempt count at one. A second text send returned after recovery, and the owner confirmed its appearance.
- Final CLI handoff: the probe was stopped normally and the daemon started against the same private session. It reached `connection: open` with linked credentials and no new QR. The final daemon was also stopped and restarted through the CLI, returning to the same authenticated state. Read-only CLI queries found both test messages and their original request/message IDs; the selected conversation remained read and unarchived, with no pending mutation. No additional test messages or chat changes were made during these checks.

## Recommendation before building the CLI

The tested essential operations work, including the phone-confirmed send after automatic recovery. Proceed with a small CLI, retaining these constraints:

- Keep observed state separate from a mutation request. When a read/archive mutation begins, make that affected field unknown until a fresh corresponding SDK observation arrives; do not reuse an old counter merely because a different chat field updated.
- Keep send intent durable and do not automatically resend uncertainty. SDK completion, a phone-side observation, and recipient receipt evidence are different facts.
- Keep local history coverage partial. Neither an open connection nor an explicit history milestone removes the observed decryption gap.
- Preserve the probe and private evidence for regression diagnosis. A closed WebSocket was tested; a prolonged physical network outage and macOS runtime execution were not.

`pnpm audit --prod`: no reported vulnerabilities at the time of the check. This is dependency metadata, not proof of runtime correctness. macOS execution remains unverified.

## Real validation procedure

Agree on a test account, an exact conversation (individual or group), and permission for test texts and archive/read changes. Use a separate linked-device session and keep account-specific evidence in `.private/`, never in this report. For groups, verify live group metadata and distinguish participant receipts from whole-group outcomes. Use two accounts when testing delivery/read distinctions; self-messages alone do not adequately exercise them.

1. Start the probe with a new private directory and `--connect`. Pair by scanning the locally generated QR image (or by phone-number pairing code). Check the reported account on both the phone and client. Stop, restart with the same directory, and confirm connection without another pairing.
2. Send a unique test text from the other phone. Confirm its exact JID, message key, body, and timestamp in stored messages. Confirm duplicate observations do not create duplicate rows after reconnect/restart.
3. Configure that observed JID as `--test-jid`. Send one agreed text with an idempotency key. Compare the returned ID, phone appearance, recipient receipt, and subsequent client evidence. Repeat the same key after restart and confirm there is no second phone message.
4. Archive and unarchive that chat from the probe with different keys. For each operation, compare before/after on the phone and later client events/state. A resolved SDK call or an unchanged local row is insufficient. Record unknown if there is no independent observation.
5. Repeat for marking read/unread. Also change archive/read state on the phone and verify the reverse path to client events, including after restarting. Interpret SDK `unreadCount: 0` and `-1` as read/manual-unread evidence; ordinary positive counts and unknown manual flags require care.
6. Exercise automatic recovery using `drop-connection`, which closes this probe's WebSocket without explicitly reopening it; separately use `reconnect` and a real temporary network interruption if feasible. Check that messages received during the gap become visible, credentials persist, and no uncertain sends are resubmitted. Restart normally and repeat message exchange.
7. Inspect diagnostics and history milestones. Record missing collections, missing decryptable content, silent event gaps, PN/LID alias gaps, or incomplete history as limitations even if text messaging continues to work.

Do not record a pass without both the phone effect and later client evidence. Keep each result tied to event sequences/timestamps and the owner's phone confirmation. A missing receipt is unknown, not evidence of nondelivery. Do not resend an uncertain result automatically.

## Gate for the CLI

Proceed only after the essential live flow has convincing evidence for pairing/session restart, exchange, archive/unarchive, read/unread, phone-originated changes, and recovery. If a required operation cannot be reliably observed or works with materially inconsistent state, present that evidence and a recommendation before expanding the project.

The live validation gate is complete. The daemon and CLI implementation follows these constraints; its automated tests must remain independent of real WhatsApp.
