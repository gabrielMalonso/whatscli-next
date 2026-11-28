# Recipients and contact identity

Use an exact observed conversation JID or resolve an explicitly international phone number before first contact.

Display names are not recipient identities. PN, LID, and group JIDs are distinct. Never interpret a LID as a telephone number.

All examples use fictional identifiers.

```sh
node dist/src/cli.js resolve --phone '+12025550101'
node dist/src/cli.js contact --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js contact --jid '123450001@lid'
```

## Resolve a phone number

`resolve` requires an open WhatsApp connection and a phone number formatted as `+` followed by 8–15 digits, starting with a nonzero digit.

It does not add country or area codes, interpret local numbers, or accept punctuation beyond the leading `+`.

Resolution uses the pinned Baileys `onWhatsApp` API.

### Resolution results

| Result              | Meaning                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `status: confirmed` | One affirmative SDK result matches the exact requested PN JID. A usable `jid` is returned.                  |
| `status: unknown`   | The SDK response is missing, partial, ambiguous, identifies a different recipient, or fails. `jid` is null. |
| `not-found`         | An explicit negative result was received.                                                                   |

The installed SDK filters out negative entries, so an empty result remains unknown.

Inspect `data.status`, not just `ok`.

## Verification and first contact

Verification is stored separately from chats.

A confirmed resolution authorizes text, document, and contact-card first contact to that exact PN JID.

Verification survives restarts, but remains historical evidence:

- It has no automatic expiry.
- It does not prove the phone number is still assigned to the same person.
- A later inconclusive or negative lookup replaces the previous verification.

Resolution and an SDK send return do not create an observed conversation.

Archive/read operations still require an observed chat and a stored last-message key/timestamp.

`--allow-jid` restricts operations to one exact JID, even when a PN/LID association is known.

Resolving a PN does not authorize sending to an unobserved LID alias.

## Inspect local contact identity

`contact` is a local query and works offline.

It returns:

- Exact identifiers.
- `source: local` and `historical: true`.
- Verification for the exact JID.
- Contact metadata: `name`, `notify`, `username`, `verifiedName`, and `status`.
- Per-field source and observation time.

Metadata availability and identity coverage remain partial.

### Association evidence

PN/LID associations come from:

- SDK contact, history, and mapping events.
- Alternate message keys.
- The SDK mapping key store.

`mapping.status` can be:

| Value      | Meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| `known`    | Association evidence is available without a recorded conflict. |
| `unknown`  | The association is not established.                            |
| `conflict` | Contradictory association evidence exists.                     |

Contradictory associations are retained in both directions.

For unknown or conflicting LIDs, `phone: null`.

No association is inferred from display names or LID digits. Conflicts block first contact even when a phone lookup was positive.

### Look up contacts

`contacts` finds exact PN and LID JIDs by an observed label or phone number. It is a local, offline lookup:

```sh
node dist/src/cli.js contacts --query 'Example' --limit 20
node dist/src/cli.js contacts --query '+1 202 555 0101'
```

It is not addressing or authorization. A match is a candidate to inspect, never permission to send: sending still requires an exact JID, under the same rules as without the lookup. Two people can share a name, and labels are chosen by people, not verified.

The query must have at least two characters. It matches, case- and accent-insensitively, a substring of an observed `name` (the account's own contact name), `verifiedName` (business name) or `notify` (push name chosen by the contact). A query made only of digits, spaces, `+`, `-`, `(`, `)` and `.`, with at least three digits, also matches those digits in a phone number: the number of a PN JID, or of the PN mapped to a LID. LID digits are never matched as a phone number, and group subjects are not contact labels.

Each result is:

| Field           | Meaning                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `jid`           | Exact PN or LID JID. A known PN/LID pair appears as two results; use the one you need exactly, typically the observed chat. |
| `observedChat`  | Whether a chat with this exact JID is stored locally.                                                                       |
| `matchedFields` | Fields that matched: `name`, `verifiedName`, `notify`, `phone`.                                                             |
| `contact`       | The summary below.                                                                                                          |

Results with an observed chat come first, most recently active first, then the rest, each in exact JID order. Page with `--limit` (at most 100) and `--offset`. A daemon built before `contacts` rejects it as an unknown command.

### Contact summary

`contacts` results and `chats --include contact` rows share this summary:

- `phone`: the number of a PN JID, or of the PN mapped to a LID while `mapping` is `known`. Otherwise `null`.
- `mapping`: the PN/LID association status, as in `contact`: `known`, `unknown` or `conflict`.
- `labels`: every observed `name`, `verifiedName` and `notify` value, in that order, each with its `jid`, `source` and local `observedAt`. Labels come from the exact JID and, only while `mapping` is `known`, from its alias; the label's `jid` says which.

With `conflict`, neither the alias's labels nor a phone number transfer to a LID. Several labels can disagree; all are listed. The first label is only a display hint. `contact --jid` keeps the complete evidence, including mapping sources and verification.

## Historical observation times

Legacy journal mappings retain their original observation times.

Legacy SDK key-store and alternate message-key evidence uses `observedAt: null` when the original observation time is unavailable.

Do not treat missing timestamps or partial metadata as current identity confirmation.
