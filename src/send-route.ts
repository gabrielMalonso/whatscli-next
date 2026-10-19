import { jidDecode, jidEncode, jidNormalizedUser } from 'baileys';
import { isLid, isPn } from './identity.js';

type RouteObservation = {
  jid: string;
  source: 'baileys.executeUSyncQuery/lid';
  observedAt: number;
};

/** A per-attempt server association, never a claim of permanent phone ownership. */
export type SendRoute = Readonly<RouteObservation & (
  | { status: 'proven'; limit: 'server-association-at-query-time' }
  | { status: 'unproven'; limit: 'exact-original-destination-only'; reason: 'query-failed' | 'invalid-response' | 'conflicting-identities' }
)>;

export function unprovenRoute(jid: string, observedAt: number, reason: Extract<SendRoute, { status: 'unproven' }>['reason']): SendRoute {
  return { status: 'unproven', jid, source: 'baileys.executeUSyncQuery/lid', observedAt, limit: 'exact-original-destination-only', reason };
}

/** Accept only a canonical user/device JID in its own domain, using SDK normalization. */
export function receiptUserJid(jid: string): string | undefined {
  const decoded = jidDecode(jid);
  if (!decoded || (decoded.server !== 'lid' && decoded.server !== 's.whatsapp.net')) return;
  // rc14's Signal address conversion rejects device 99 outside hosted domains.
  if (decoded.device !== undefined && (!Number.isSafeInteger(decoded.device) || decoded.device <= 0 || decoded.device === 99)) return;
  if (jidEncode(decoded.user, decoded.server, decoded.device) !== jid) return;
  const normalized = jidNormalizedUser(jid);
  return isLid(normalized) || isPn(normalized) ? normalized : undefined;
}
