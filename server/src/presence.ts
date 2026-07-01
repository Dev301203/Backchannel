import { bus, presence as store } from './drivers/index.js';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Presence ("47 people here"). This module is driver-agnostic: it keeps a local
 * per-room count for this node and delegates aggregation + fanout to the active
 * driver (in-process for memory, Redis hash + ZSET for redis). Whenever a
 * count changes it recomputes the total and publishes a presence frame on the
 * room channel, so every subscribed node relays it to its sockets — the same
 * path chat messages take.
 */
const NODE = env.NODE_ID;
const local = new Map<string, number>(); // roomKey -> this node's count
let heartbeatTimer: NodeJS.Timeout | null = null;

export async function presenceJoin(roomKey: string): Promise<void> {
  const next = (local.get(roomKey) ?? 0) + 1;
  local.set(roomKey, next);
  await store.setRoomCount(roomKey, NODE, next);
  await broadcastPresence(roomKey);
}

export async function presenceLeave(roomKey: string): Promise<void> {
  const next = (local.get(roomKey) ?? 1) - 1;
  if (next <= 0) {
    local.delete(roomKey);
    await store.clearRoomNode(roomKey, NODE);
  } else {
    local.set(roomKey, next);
    await store.setRoomCount(roomKey, NODE, next);
  }
  await broadcastPresence(roomKey);
}

export function getCount(roomKey: string): Promise<number> {
  return store.roomTotal(roomKey);
}

async function broadcastPresence(roomKey: string): Promise<void> {
  const count = await getCount(roomKey);
  await bus.publish(bus.roomChannel(roomKey), JSON.stringify({ t: 'presence', roomKey, count }));
}

export function startPresenceHeartbeat(): void {
  const beat = async () => {
    try {
      await store.heartbeat(NODE, local);
    } catch (err) {
      logger.warn({ err }, 'presence heartbeat failed');
    }
  };
  void beat();
  heartbeatTimer = setInterval(() => void beat(), env.PRESENCE_HEARTBEAT_MS);
}

export async function stopPresence(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await store.removeNode(NODE, local).catch(() => {});
  local.clear();
}
