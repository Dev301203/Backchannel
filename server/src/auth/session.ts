import type { IncomingHttpHeaders } from 'node:http';
import { auth } from './auth.js';
import { query } from '../db/pool.js';
import { isPlaceholderHandle, randomHandle } from './handles.js';
import { logger } from '../logger.js';

export interface Identity {
  id: string;
  handle: string;
  displayColor: number;
  isBanned: boolean;
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

  const user = session.user as typeof session.user & { displayColor?: number };
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

  // Global ban state lives in our own moderation table (kept separate from the
  // Better-Auth-managed `user` table so the two migration systems don't couple).
  const banned = await query<{ blocked: boolean }>(
    `SELECT (is_banned AND (banned_until IS NULL OR banned_until > now())) AS blocked
       FROM user_moderation WHERE user_id = $1`,
    [user.id],
  );

  return {
    id: user.id,
    handle,
    displayColor: user.displayColor ?? 0,
    isBanned: banned.rows[0]?.blocked ?? false,
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
