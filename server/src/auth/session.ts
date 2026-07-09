import type { IncomingHttpHeaders } from 'node:http';
import { auth } from './auth.js';
import { query } from '../db/pool.js';
import { isPlaceholderHandle, randomHandle } from './handles.js';
import { logger } from '../logger.js';

export interface Identity {
  id: string;
  handle: string;
  displayColor: number;
  /** Achievement id the user displays next to their handle (or null). */
  badge: string | null;
  isBanned: boolean;
  isAnonymous: boolean;
}

/** Convert Node's header bag into the Headers object Better Auth expects. */
function toHeaders(raw: IncomingHttpHeaders): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) v.forEach((val) => h.append(k, val));
    else if (v != null) h.set(k, v);
  }
  return h;
}

async function resolve(headers: Headers): Promise<Identity | null> {
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return null;

  const user = session.user as typeof session.user & {
    displayColor?: number;
    isAnonymous?: boolean | null;
  };
  let handle = user.name;

  // Anonymous users start with a placeholder name; give them a real handle
  // the first time we see them and persist it.
  if (isPlaceholderHandle(handle)) {
    handle = randomHandle();
    try {
      await query('UPDATE "user" SET name = $1, "updatedAt" = now() WHERE id = $2', [
        handle,
        user.id,
      ]);
    } catch (err) {
      logger.warn({ err, userId: user.id }, 'failed to persist generated handle');
    }
  }

  // Ban state + display badge in one round trip. Moderation and stats live in
  // our own tables (kept separate from the Better-Auth-managed `user` table so
  // the two migration systems don't couple).
  const extra = await query<{ blocked: boolean | null; badge: string | null }>(
    `SELECT (um.is_banned AND (um.banned_until IS NULL OR um.banned_until > now())) AS blocked,
            us.display_badge AS badge
       FROM (SELECT $1::text AS uid) x
       LEFT JOIN user_moderation um ON um.user_id = x.uid
       LEFT JOIN user_stats us ON us.user_id = x.uid`,
    [user.id],
  );

  return {
    id: user.id,
    handle,
    displayColor: user.displayColor ?? 0,
    badge: extra.rows[0]?.badge ?? null,
    isBanned: extra.rows[0]?.blocked ?? false,
    isAnonymous: Boolean(user.isAnonymous),
  };
}

/** Resolve identity from Express-style request headers (HTTP API). */
export function identityFromHeaders(raw: IncomingHttpHeaders): Promise<Identity | null> {
  return resolve(toHeaders(raw));
}

/** Resolve identity from a bare bearer token (WebSocket `?token=`). */
export function identityFromToken(token: string | null | undefined): Promise<Identity | null> {
  if (!token) return Promise.resolve(null);
  const h = new Headers();
  h.set('authorization', `Bearer ${token}`);
  return resolve(h);
}
