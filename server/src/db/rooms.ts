import { query } from './pool.js';
import { classifyRoomKey } from '../normalize.js';

export interface RoomRow {
  id: string;
  is_locked: boolean;
}

export interface ReactionCount {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface ChatMessage {
  id: string;
  handle: string;
  color: number;
  badge: string | null; // achievement id the author displays (client maps to emoji)
  body: string;
  ts: number; // epoch ms
  parentId: string | null;
  reactions: ReactionCount[];
}

const KEY_RE = /^[^\s\x00-\x1f]{1,512}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The extension sends an already-normalized room key. We can't recompute from
 * the raw URL here (the write frame only carries the key), so we validate the
 * key is well-formed before trusting it for a write. The normalizer is still
 * the single source of truth — this just rejects garbage/oversized keys.
 */
export function isValidRoomKey(roomKey: unknown): roomKey is string {
  return typeof roomKey === 'string' && KEY_RE.test(roomKey);
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Lazily create (or fetch) a room. Race-safe single round trip. */
export async function ensureRoom(roomKey: string, title?: string | null): Promise<RoomRow> {
  const { kind, domain } = classifyRoomKey(roomKey);
  const res = await query<RoomRow>(
    `INSERT INTO rooms (room_key, kind, domain, title)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (room_key)
       DO UPDATE SET title = COALESCE(rooms.title, EXCLUDED.title)
     RETURNING id, is_locked`,
    [roomKey, kind, domain, title ?? null],
  );
  return res.rows[0]!;
}

/** Fetch a room by key without creating it (used by read-only endpoints). */
export async function getRoomByKey(roomKey: string): Promise<RoomRow | null> {
  const res = await query<RoomRow>('SELECT id, is_locked FROM rooms WHERE room_key = $1', [
    roomKey,
  ]);
  return res.rows[0] ?? null;
}

/**
 * Recent history for backfill. Returned newest-first; client reverses.
 * `viewerId` (when the request carried a token) marks which reactions are the
 * viewer's own so the UI can render them toggled.
 */
export async function getRecentMessages(
  roomId: string,
  limit: number,
  viewerId: string | null = null,
): Promise<ChatMessage[]> {
  const res = await query<{
    id: string;
    body: string;
    created_at: Date;
    parent_id: string | null;
    handle: string | null;
    color: number | null;
    badge: string | null;
  }>(
    `SELECT m.id, m.body, m.created_at, m.parent_id,
            u.name AS handle, u."displayColor" AS color, us.display_badge AS badge
       FROM messages m
       JOIN "user" u ON u.id = m.user_id
       LEFT JOIN user_stats us ON us.user_id = m.user_id
      WHERE m.room_id = $1 AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [roomId, limit],
  );

  const byId = new Map<string, ChatMessage>();
  const messages = res.rows.map((r) => {
    const msg: ChatMessage = {
      id: r.id,
      handle: r.handle ?? 'anon',
      color: r.color ?? 0,
      badge: r.badge,
      body: r.body,
      ts: r.created_at.getTime(),
      parentId: r.parent_id,
      reactions: [],
    };
    byId.set(msg.id, msg);
    return msg;
  });

  if (messages.length > 0) {
    const reactions = await query<{ message_id: string; emoji: string; count: string; mine: boolean }>(
      `SELECT message_id, emoji, count(*)::text AS count,
              bool_or(user_id = $2) AS mine
         FROM message_reactions
        WHERE message_id = ANY($1::uuid[])
        GROUP BY message_id, emoji
        ORDER BY min(created_at)`,
      [messages.map((m) => m.id), viewerId ?? ''],
    );
    for (const r of reactions.rows) {
      byId.get(r.message_id)?.reactions.push({
        emoji: r.emoji,
        count: Number(r.count),
        mine: r.mine,
      });
    }
  }
  return messages;
}

/**
 * Persist a message and bump the room's denormalized counters.
 * `wasFirst` reports whether this was the room's first-ever message (pioneer
 * achievement) — read straight off the counter bump, no extra query.
 */
export async function insertMessage(
  roomId: string,
  userId: string,
  body: string,
  parentId: string | null = null,
): Promise<{ id: string; ts: number; wasFirst: boolean }> {
  const res = await query<{ id: string; created_at: Date }>(
    `INSERT INTO messages (room_id, user_id, body, parent_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [roomId, userId, body, parentId],
  );
  const row = res.rows[0]!;
  // Counter bump doubles as first-message detection; not in a txn on purpose
  // (hot path — a lost increment is cosmetic).
  const bump = await query<{ message_count: string }>(
    `UPDATE rooms
        SET message_count = message_count + 1, last_message_at = $2
      WHERE id = $1
      RETURNING message_count`,
    [roomId, row.created_at],
  );
  const wasFirst = Number(bump.rows[0]?.message_count ?? 0) === 1;
  return { id: row.id, ts: row.created_at.getTime(), wasFirst };
}

/** Look up a message's author (for reply/reaction credit). */
export async function getMessageAuthor(messageId: string): Promise<string | null> {
  const res = await query<{ user_id: string }>(
    'SELECT user_id FROM messages WHERE id = $1 LIMIT 1',
    [messageId],
  );
  return res.rows[0]?.user_id ?? null;
}

/**
 * Toggle a reaction on. Returns the new count for that emoji, or null when the
 * reaction already existed (client raced itself; nothing to broadcast).
 */
export async function addReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<number | null> {
  const ins = await query(
    `INSERT INTO message_reactions (message_id, user_id, emoji)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [messageId, userId, emoji],
  );
  if ((ins.rowCount ?? 0) === 0) return null;
  return reactionCount(messageId, emoji);
}

/** Toggle a reaction off. Returns the new count, or null if nothing was removed. */
export async function removeReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<number | null> {
  const del = await query(
    'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
    [messageId, userId, emoji],
  );
  if ((del.rowCount ?? 0) === 0) return null;
  return reactionCount(messageId, emoji);
}

async function reactionCount(messageId: string, emoji: string): Promise<number> {
  const res = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM message_reactions WHERE message_id = $1 AND emoji = $2',
    [messageId, emoji],
  );
  return Number(res.rows[0]?.count ?? 0);
}

/** Soft-delete a message (moderator action). */
export async function softDeleteMessage(
  messageId: string,
  messageCreatedAt: Date,
  byUserId: string,
): Promise<void> {
  await query(
    `UPDATE messages
        SET deleted_at = now(), deleted_by = $3
      WHERE id = $1 AND created_at = $2`,
    [messageId, messageCreatedAt, byUserId],
  );
}
