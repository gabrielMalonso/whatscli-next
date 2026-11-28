import { object } from './protocol.js';

export type OutputMode = 'full' | 'compact';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? object(value)
    : undefined;
}

/** Labels drop their observation time; a label from the row's own JID also drops its jid. */
function compactContactSummary(value: unknown, jid: unknown): unknown {
  const contact = record(value);
  if (!contact || !Array.isArray(contact.labels)) return value;
  return {
    ...contact,
    labels: contact.labels.map((value) => {
      const label = record(value);
      if (!label) return value;
      const result = { ...label };
      delete result.observedAt;
      if (label.jid === jid) delete result.jid;
      return result;
    }),
  };
}

function compactContactResult(value: unknown): unknown {
  const result = record(value);
  if (!result) return value;
  return {
    ...result,
    contact: compactContactSummary(result.contact, result.jid),
  };
}

function compactChat(value: unknown): unknown {
  const chat = record(value);
  if (!chat) return value;
  const result = { ...chat };
  if ('contact' in chat)
    result.contact = compactContactSummary(chat.contact, chat.jid);
  // Activity carries ordering evidence; the metadata observation clock is available in full.
  delete result.observedAt;
  if (chat.name === null) delete result.name;
  const pending = record(chat.pending);
  if (pending && Object.keys(pending).length === 0) delete result.pending;
  return result;
}

/** Compact message rows keep every field's type; only documented absent = default fields are omitted. */
function compactMessage(value: unknown): unknown {
  const message = record(value);
  if (!message) return value;
  const result = { ...message };
  // Only these optional fields have an absent = null contract in compact output.
  for (const field of ['quote', 'contacts', 'media', 'stubType', 'status']) {
    if (message[field] === null) delete result[field];
  }
  // Absent participant: the message key carried none (null or empty). Never inferred from the chat.
  if (message.participant === null || message.participant === '')
    delete result.participant;
  // Absent deletion: no local deletion or boundary evidence. Any observed evidence stays complete.
  const deletion = record(message.deletion);
  if (
    deletion !== undefined &&
    Object.keys(deletion).length === 3 &&
    deletion.status === 'unknown' &&
    deletion.source === null &&
    deletion.observedAt === null
  )
    delete result.deletion;
  return result;
}

function compactContact(value: unknown, source: unknown): unknown {
  const contact = record(value);
  if (!contact) return value;
  const result = { ...contact };
  if (contact.source === source) delete result.source;
  if (Array.isArray(contact.contacts))
    result.contacts = contact.contacts.map((value) => {
      const entry = record(value);
      const metadata = record(entry?.metadata);
      if (!entry || !metadata) return value;
      return {
        ...entry,
        metadata: Object.fromEntries(
          Object.entries(metadata).map(([name, value]) => {
            const field = record(value);
            // Equal per-field provenance inherits from this exact contact record, never a PN/LID alias.
            return [
              name,
              field &&
              field.source === entry.source &&
              field.observedAt === entry.observedAt
                ? { value: field.value }
                : value,
            ];
          }),
        ),
      };
    });
  return result;
}

/** Exactly the recovery a runtime reports while its connection is steadily open or offline. */
function steadyRecovery(recovery: unknown, connection: unknown): boolean {
  const value = record(recovery);
  return (
    value !== undefined &&
    (connection === 'open' || connection === 'offline') &&
    Object.keys(value).length === 6 &&
    value.state === connection &&
    value.reason === null &&
    value.code === null &&
    value.attempt === 0 &&
    value.nextRetryAt === null &&
    typeof value.since === 'number'
  );
}

/** Compact envelope omits only documented healthy defaults and summarizes inactive issue history. */
function compactEnvelope(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...response };
  if (steadyRecovery(response.recovery, response.connection))
    delete result.recovery;
  const issues = response.issues;
  if (
    !Array.isArray(issues) ||
    !issues.every((code) => typeof code === 'string')
  )
    return result;
  if (!('activeIssues' in response)) {
    // An older daemon reports no activity; its history stays listed rather than guessed.
    if (issues.length === 0) delete result.issues;
    return result;
  }
  const active = response.activeIssues;
  const codes = Array.isArray(active)
    ? active.map((value) => record(value)?.code)
    : [];
  const recorded = new Set(issues);
  if (
    !Array.isArray(active) ||
    !codes.every((code) => typeof code === 'string' && recorded.has(code)) ||
    new Set(codes).size !== codes.length
  )
    return result;
  delete result.issues;
  if (active.length === 0) delete result.activeIssues;
  const inactive = recorded.size - codes.length;
  if (inactive > 0) result.inactiveIssues = inactive;
  return result;
}

/** Status keeps capture health and loss counters; full detail stays in full output and `observability status`. */
function compactObservability(value: unknown): unknown {
  const observability = record(value);
  if (!observability) return value;
  const summary: Record<string, unknown> = {};
  for (const field of [
    'configured',
    'enabled',
    'effective',
    'degraded',
    'dropped',
    'uncertain',
    'captureCompleteness',
  ])
    if (field in observability) summary[field] = observability[field];
  for (const [field, healthy] of [
    ['cleanupFailures', 0],
    ['hashingFailures', 0],
    ['preferenceWatchDegraded', false],
  ] as const)
    if (field in observability && observability[field] !== healthy)
      summary[field] = observability[field];
  return summary;
}

function compactStatus(value: unknown): unknown {
  const status = record(value);
  if (!status) return value;
  const result = { ...status };
  if ('observability' in status)
    result.observability = compactObservability(status.observability);
  // Active issues stay in the envelope; the timed history of every code is in full output.
  if (Array.isArray(status.issueHistory)) delete result.issueHistory;
  return result;
}

/** Pure presentation of an already-public response. No SDK, store, retry or tokenization work. */
export function formatResponse(
  action: string,
  response: Record<string, unknown>,
  mode: OutputMode,
): Record<string, unknown> {
  if (mode === 'full' || response.ok !== true) return response;
  let data = response.data;
  switch (action) {
    case 'status':
    case 'start':
      data = compactStatus(data);
      break;
    case 'chats':
      if (Array.isArray(data)) data = data.map(compactChat);
      break;
    case 'chat':
      data = compactChat(data);
      break;
    case 'messages':
    case 'search':
      // Same array type as full output; every row keeps its exact JID and original order.
      if (Array.isArray(data))
        data = data.map((value) => compactMessage(value));
      break;
    case 'incoming': {
      // Same row shape as messages and search: every row keeps its own jid.
      const listing = record(data);
      if (listing && Array.isArray(listing.messages))
        data = { ...listing, messages: listing.messages.map(compactMessage) };
      break;
    }
    case 'contact':
      data = compactContact(data, response.source);
      break;
    case 'contacts':
      if (Array.isArray(data)) data = data.map(compactContactResult);
      break;
    case 'resolve': {
      const resolution = record(data);
      if (resolution)
        data = {
          ...resolution,
          contact: compactContact(resolution.contact, response.source),
        };
      break;
    }
    case 'archive':
    case 'unarchive':
    case 'read':
    case 'unread': {
      const mutation = record(data);
      if (mutation)
        data = { ...mutation, localChat: compactChat(mutation.localChat) };
      break;
    }
  }
  return { ...compactEnvelope(response), data };
}
