import { CommandError } from './errors.js';
import { internationalPhone } from './identity.js';

export function contactName(name: string): string {
  if (
    !name.trim() ||
    /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]/u.test(name) ||
    Buffer.byteLength(name) > 256
  ) {
    throw new CommandError(
      'INVALID_ARGUMENT',
      'name must be nonblank, well-formed Unicode, at most 256 UTF-8 bytes, without controls or line separators',
    );
  }
  return name;
}

/**
 * Explicit shared content in the layout WhatsApp clients generate: unfolded LF lines and
 * `TEL;type=CELL;waid=DIGITS:PHONE`. Recipients offer a chat action only for a `waid`.
 * The `waid` repeats the explicit phone's digits; no lookup verifies WhatsApp membership.
 */
export function contactCard(
  name: string,
  phone: string,
): { displayName: string; vcard: string } {
  contactName(name);
  internationalPhone(phone);
  const escaped = name.replace(/[\\,;]/g, (character) => `\\${character}`);
  return {
    displayName: name,
    vcard: [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `N:;${escaped};;;`,
      `FN:${escaped}`,
      `TEL;type=CELL;waid=${phone.slice(1)}:${phone}`,
      'END:VCARD',
    ].join('\n'),
  };
}
