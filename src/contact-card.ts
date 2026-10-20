import { CommandError } from './errors.js';
import { internationalPhone } from './identity.js';

export function contactName(name: string): string {
  if (!name.trim() || /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]/u.test(name) || Buffer.byteLength(name) > 256) {
    throw new CommandError('INVALID_ARGUMENT', 'name must be nonblank, well-formed Unicode, at most 256 UTF-8 bytes, without controls or line separators');
  }
  return name;
}

/** Fold vCard 3.0 lines at 75 UTF-8 bytes without splitting a Unicode code point. */
function fold(line: string): string {
  let result = '';
  let bytes = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 75) { result += '\r\n '; bytes = 1; }
    result += character;
    bytes += size;
  }
  return result;
}

/** Explicit shared content only: no identity lookup or assertion of WhatsApp membership. */
export function contactCard(name: string, phone: string): { displayName: string; vcard: string } {
  contactName(name);
  internationalPhone(phone);
  const escaped = name.replace(/[\\,;]/g, character => `\\${character}`);
  return { displayName: name, vcard: [
    'BEGIN:VCARD', 'VERSION:3.0', `N:${escaped};;;;`, `FN:${escaped}`,
    `TEL;TYPE=CELL:${phone}`, 'END:VCARD',
  ].map(fold).join('\r\n') + '\r\n' };
}
