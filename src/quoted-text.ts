import { getContentType, normalizeMessageContent } from 'baileys';
import type { WAMessage } from 'baileys';
import { CommandError } from './errors.js';
import { contactJid, isLid, isPn } from './identity.js';
import type { QuoteSelector } from './protocol.js';
import { receiptUserJid } from './send-route.js';
import type { Store } from './store.js';

type QuoteContentType = 'conversation' | 'extendedTextMessage' | 'imageMessage' | 'videoMessage' | 'documentMessage';
export type QuoteSnapshot = Readonly<{
  reference: { jid: string; id: string; fromMe: boolean; participant: string | null };
  author: string;
  contentType: QuoteContentType;
  text: string;
}>;

export function sameQuote(a: QuoteSelector | undefined, b: QuoteSelector | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined
    && a.id === b.id && a.fromMe === b.fromMe && a.participant === b.participant;
}

/** Select current visible content only. Never read deletion audit, nested quotes or identity aliases. */
export function prepareQuote(store: Store, jid: string, ref: QuoteSelector, selfId: string | undefined): QuoteSnapshot {
  if (jid.endsWith('@g.us') && !ref.participant) throw new CommandError('PRECONDITION_FAILED', 'A quote in a group requires the exact stored participant');
  const target = store.locateMessage({ jid, ...ref });
  const participant = target.key.participant ?? null;
  const self = selfId ? receiptUserJid(selfId) : undefined;
  let author: string;
  if (ref.fromMe) {
    // rc14 generates own quoted authors from creds.me.id (PN), with an explicit LID TODO.
    if (!self || !isPn(self) || isLid(jid) || (participant !== null && participant !== self)) {
      throw new CommandError('PRECONDITION_FAILED', 'Own-message quote requires a known PN author matching the stored identity; own LID quotes are unsupported');
    }
    author = self;
  } else {
    author = participant ?? jid;
    if ((!isPn(author) && !isLid(author)) || (!jid.endsWith('@g.us') && author !== jid)) {
      throw new CommandError('PRECONDITION_FAILED', 'Quote author is unavailable or inconsistent with the exact stored conversation');
    }
  }
  contactJid(author);
  const content = normalizeMessageContent(target.message);
  const contentType = getContentType(content);
  // rc14 selects one field. Never combine that type with another field's text/caption.
  let text: string | null | undefined;
  switch (contentType) {
    case 'conversation': text = content?.conversation; break;
    case 'extendedTextMessage': text = content?.extendedTextMessage?.text; break;
    case 'imageMessage': text = content?.imageMessage?.caption; break;
    case 'videoMessage': text = content?.videoMessage?.caption; break;
    case 'documentMessage': text = content?.documentMessage?.caption; break;
    default: throw new CommandError('PRECONDITION_FAILED', 'Quote requires stored text or an image/video/document caption up to 64 KiB');
  }
  if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > 65536) {
    throw new CommandError('PRECONDITION_FAILED', 'Quote requires stored text or an image/video/document caption up to 64 KiB');
  }
  return { reference: { jid, id: ref.id, fromMe: ref.fromMe, participant }, author, contentType, text };
}

/** Reconstruct only the minimum SDK quote; cryptographic/media fields and quoted chains never enter it. */
export function quotedMessage(snapshot: QuoteSnapshot): WAMessage {
  const { reference, text, contentType } = snapshot;
  const message = contentType === 'conversation' ? { conversation: text }
    : contentType === 'extendedTextMessage' ? { extendedTextMessage: { text } }
    : contentType === 'imageMessage' ? { imageMessage: { caption: text } }
    : contentType === 'videoMessage' ? { videoMessage: { caption: text } }
    : { documentMessage: { caption: text } };
  return { key: { remoteJid: reference.jid, id: reference.id, fromMe: reference.fromMe,
    ...(reference.participant === null ? {} : { participant: reference.participant }) }, message };
}
