import { isLid, isPn } from './identity.js';
import { object } from './protocol.js';

export type ContactDisplay = {
  mapping: 'known' | 'unknown' | 'conflict';
  label: {
    value: string;
    jid: string;
    field: 'name' | 'verifiedName' | 'notify';
  } | null;
};

/** Display metadata only; a label never identifies a recipient or merges history. */
export function contactDisplay(jid: string, value: unknown): ContactDisplay {
  const contact = object(value);
  const mapping = object(contact.mapping);
  const status = mapping.status;
  if (
    contact.jid !== jid ||
    contact.source !== 'local' ||
    (status !== 'known' && status !== 'unknown' && status !== 'conflict') ||
    !Array.isArray(contact.contacts)
  )
    throw new Error('Invalid contact projection');
  const allowed = new Set([jid]);
  if (status === 'known') {
    if (
      typeof mapping.pn !== 'string' ||
      !isPn(mapping.pn) ||
      typeof mapping.lid !== 'string' ||
      !isLid(mapping.lid) ||
      (jid !== mapping.pn && jid !== mapping.lid)
    )
      throw new Error('Invalid contact association');
    allowed.add(mapping.pn);
    allowed.add(mapping.lid);
  }
  const records = contact.contacts
    .flatMap((value) => {
      const record = object(value);
      if (typeof record.jid !== 'string' || !allowed.has(record.jid)) return [];
      return [{ jid: record.jid, metadata: object(record.metadata) }];
    })
    .sort((a, b) => Number(b.jid === jid) - Number(a.jid === jid));
  // Saved address-book names take precedence over business/profile names,
  // even when the saved name belongs to an unambiguously mapped PN/LID.
  for (const field of ['name', 'verifiedName', 'notify'] as const) {
    for (const record of records) {
      const metadata = record.metadata;
      if (metadata[field] == null) continue;
      const entry = object(metadata[field]);
      if (typeof entry.value === 'string' && entry.value.trim()) {
        return {
          mapping: status,
          label: { value: entry.value.trim(), jid: record.jid, field },
        };
      }
    }
  }
  return { mapping: status, label: null };
}
