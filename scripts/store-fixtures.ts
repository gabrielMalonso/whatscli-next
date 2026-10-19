import type { WAMessage } from 'baileys';
import type { RequestRecord } from '../src/store.js';

export const chatCount = 726;
export const chatJid = (i: number): string => i % 3 === 0 ? `${12025550000 + i}@s.whatsapp.net`
  : i % 3 === 1 ? `${850000000 + i}@lid` : `${120363000000000000n + BigInt(i)}@g.us`;
export const busyJid = chatJid(0);
export const fixtureVersion = 'store-v1';

/** Generated independently of all account data; no random or wall-clock inputs. */
export function fixtureMessage(i: number): WAMessage {
  const jid = chatJid(i % 5 === 0 ? 0 : i % chatCount);
  const text = i % 11 === 0 ? `Fictional café São Paulo ＡＢＣ İстанбул 🐈 100%_literal item ${i}`
    : `Fictional item ${i}: ${'ordinary text '.repeat(i % 17)}`;
  const quotedMessage = { conversation: `excluded-context-${i} ${'q'.repeat(i % 10000 === 0 ? 448000 : 500)}` };
  const key = { remoteJid: jid, id: `SYNTHETIC-${i}`, fromMe: i % 4 === 0,
    ...(jid.endsWith('@g.us') ? { participant: chatJid(i % 3 === 0 ? 1 : 0) } : {}) };
  const contextInfo = { stanzaId: `QUOTE-${i}`, participant: busyJid, quotedMessage };
  const message = i % 7 === 0 ? { imageMessage: { caption: text, mimetype: 'image/jpeg', fileLength: 1024, contextInfo } }
    : i % 7 === 1 ? { audioMessage: { mimetype: 'audio/ogg', fileLength: 2048, seconds: 2, contextInfo } }
    : i % 7 === 2 ? { documentWithCaptionMessage: { message: { documentMessage: { caption: text, mimetype: 'text/plain', fileName: 'fictional.txt', fileLength: 512, contextInfo } } } }
    : { extendedTextMessage: { text, contextInfo } };
  return { key, messageTimestamp: 1700000000 + Math.floor(i / 3), message };
}

export function fixtureRequest(i: number): RequestRecord {
  return { key: `REQUEST-${i}`, operation: { kind: 'send', jid: busyJid, text: `Fictional immutable intent ${i}` },
    messageId: `OUTBOUND-${i}`, attempt: 'uncertain', acceptance: 'unknown', delivery: 'unknown', read: 'unknown', errorObserved: false,
    ...(i % 3 === 0 ? { route: { status: 'proven', jid: chatJid(1), source: 'baileys.executeUSyncQuery/lid', observedAt: 1700000000000, limit: 'server-association-at-query-time' } as const } : {}),
  };
}
