/**
 * Server-side re-export of the shared normalizer that also runs in the
 * extension (../../normalize.js at the repo root). Keeping ONE implementation
 * is the whole point — the client computes a preview, the server recomputes
 * authoritatively for every write.
 */
import { normalize as _normalize } from '../../normalize.js';

export interface RoomKeys {
  domainKey: string;
  pageKey: string | null;
}

export const normalize = _normalize as (rawUrl: string) => RoomKeys | null;

/**
 * Given a room key produced by the normalizer, recover its kind + domain.
 * A page key contains a path or '|'; a domain key is just the host.
 */
export function classifyRoomKey(roomKey: string): { kind: 'domain' | 'page'; domain: string } {
  const slash = roomKey.indexOf('/');
  const pipe = roomKey.indexOf('|');
  if (slash === -1 && pipe === -1) return { kind: 'domain', domain: roomKey };
  const cut = slash === -1 ? pipe : slash;
  return { kind: 'page', domain: roomKey.slice(0, cut) };
}
