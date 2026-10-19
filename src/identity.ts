/** Accept exact, device-independent user/group identifiers; never interpret a LID as a phone. */
export function recipientJid(value: string): string {
  if (!/^(?:[1-9]\d{7,14}@s\.whatsapp\.net|[1-9]\d*@lid|[1-9]\d*(?:-\d+)?@g\.us)$/.test(value)) {
    throw new Error('Use an exact observed JID (@s.whatsapp.net, @lid or @g.us)');
  }
  return value;
}
