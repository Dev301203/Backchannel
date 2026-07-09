import { query } from './pool.js';
import { classifyRoomKey } from '../normalize.js';

export interface RoomRow {
  id: string;
  is_locked: boolean;
}

export interface ChatMessage {
  id: string;
  handle: string;
  color: number;
  body: string;
  ts: number; // epoch ms
  parentId: string | null;
}

const KEY_RE = /^[^\s\u0000-\u001f]{1,512}$/;

/**
 * The extension sends an already-normalized room key. We can't recompute from
 * the raw URL here (the write frame only carries the key), so we validate the
 * key is well-formed before trusting it for a write. The normalizer is still
 * the single source of truth — this just rejects garbage/oversized keys.
 */
export function isValidRoomKey(roomKey: unknown): roomKey is string {
  return typeof roomKey === 'string' && KEY_RE.test(roomKey);
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

/** Recent history for backfill. Returned newest-first; client reverses. */
export async function getRecentMessages(roomId: string, limit: number): Promise<ChatMessage[]> {
  const res = await query<{
    id: string;
    body: string;
    created_at: Date;
    parent_id: string | null;
    handle: string | null;
    color: number | null;
  }>(
    `SELECT m.id, m.body, m.created_at, m.parent_id,
            u.name AS handle, u."displayColor" AS color
       FROM messages m
       JOIN "user" u ON u.id = m.user_id
      WHERE m.room_id = $1 AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [roomId, limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    handle: r.handle ?? 'anon',
    color: r.color ?? 0,
    body: r.body,
    ts: r.created_at.getTime(),
    parentId: r.parent_id,
  }));
}

/** Persist a message and bump the room's denormalized counters. */
export async function insertMessage(
  roomId: string,
  userId: string,
  body: string,
  parentId: string | null = null,
): Promise<{ id: string; ts: number }> {
  const res = await query<{ id: string; created_at: Date }>(
    `INSERT INTO messages (room_id, user_id, body, parent_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [roomId, userId, body, parentId],
  );
  const row = res.rows[0]!;
  // Fire-and-forget-ish counter bump; not in a txn on purpose (hot path).
  await query(
    `UPDATE rooms
        SET message_count = message_count + 1, last_message_at = $2
      WHERE id = $1`,
    [roomId, row.created_at],
  );
  return { id: row.id, ts: row.created_at.getTime() };
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
