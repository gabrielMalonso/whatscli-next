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
