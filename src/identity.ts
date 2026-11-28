import { CommandError } from './errors.js';
/** Accept exact, device-independent user/group identifiers; never interpret a LID as a phone. */
export function recipientJid(value: string): string {
  if (
    !/^(?:[1-9]\d{7,14}@s\.whatsapp\.net|[1-9]\d*@lid|[1-9]\d*(?:-\d+)?@g\.us)$/.test(
      value,
    )
  ) {
    throw new CommandError(
      'INVALID_ARGUMENT',
      'Use an exact JID (@s.whatsapp.net, @lid or @g.us)',
    );
  }
  return value;
}

/** Require the caller to supply the international prefix; never guess country or area code. */
export function internationalPhone(value: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(value))
    throw new CommandError(
      'INVALID_ARGUMENT',
      'phone must be explicitly international: + followed by 8 to 15 digits',
    );
  return value;
}

export const isPn = (value: string): boolean =>
  /^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(value);
export const isLid = (value: string): boolean => /^[1-9]\d*@lid$/.test(value);

export function contactJid(value: string): string {
  if (!isPn(value) && !isLid(value))
    throw new CommandError(
      'INVALID_ARGUMENT',
      'contact requires an exact PN or LID JID',
    );
  return value;
}

export type IdentitySource =
  | 'lid-mapping.update'
  | 'messaging-history.set'
  | 'contacts.upsert'
  | 'contacts.update'
  | 'message-key'
  | 'baileys.key-store';
export type RecipientCheck = {
  status: 'confirmed' | 'not-found' | 'unknown';
  source: 'baileys.onWhatsApp';
  observedAt: number;
};

/**
 * The phone-number user part of a linked account's own PN JID, ignoring any
 * device suffix. A LID or any other form yields null: no phone is inferred.
 */
export function accountUser(jid: string | null | undefined): string | null {
  return (
    /^([1-9]\d{7,14})(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? '')?.[1] ?? null
  );
}

/**
 * Normalize an account expectation to the PN user part. Accepts bare digits
 * (optionally with +) or the account's PN JID with or without a device
 * suffix. A LID is refused rather than compared with a phone number.
 */
export function expectedAccount(value: string): string {
  const user = /^\+?([1-9]\d{7,14})$/.exec(value)?.[1] ?? accountUser(value);
  if (!user)
    throw new CommandError(
      'INVALID_ARGUMENT',
      'expect-account must be the account phone number (international digits) or its @s.whatsapp.net JID; a LID is not accepted',
    );
  return user;
}

/** Chat kinds by exact JID server. Never inferred from names or digits. */
export const chatKinds = ['direct', 'group', 'broadcast', 'other'] as const;
export type ChatKind = (typeof chatKinds)[number];
export function chatKind(jid: string): ChatKind {
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return 'direct';
  if (jid.endsWith('@g.us')) return 'group';
  // Includes status@broadcast and broadcast lists.
  if (jid.endsWith('@broadcast')) return 'broadcast';
  return 'other';
}
