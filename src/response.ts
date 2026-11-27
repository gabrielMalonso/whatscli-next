import { object } from './protocol.js';

export type OutputMode = 'full' | 'compact';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? object(value)
    : undefined;
}

function compactChat(value: unknown): unknown {
  const chat = record(value);
  if (!chat) return value;
  const result = { ...chat };
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

/** Pure presentation of an already-public response. No SDK, store, retry or tokenization work. */
export function formatResponse(
  action: string,
  response: Record<string, unknown>,
  mode: OutputMode,
): Record<string, unknown> {
  if (mode === 'full' || response.ok !== true) return response;
  let data = response.data;
  switch (action) {
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
    case 'contact':
      data = compactContact(data, response.source);
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
  return { ...response, data };
}
