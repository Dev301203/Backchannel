import { EventEmitter } from 'node:events';
import type { Bus, Counters, Drivers, PresenceStore } from './types.js';

/**
 * In-process driver for single-instance deploys (e.g. the free tier).
 *
 * There is exactly one node, so "fanout across nodes" collapses to an
 * EventEmitter, presence is just the local count, and rate-limit counters live
 * in a Map. Losing this state on restart is harmless by design — clients
 * reconnect + resubscribe and history comes from Postgres, identical to the
 * Redis path. Flip PUBSUB_DRIVER=redis (or set REDIS_URL) to scale out.
 */
export function createMemoryDrivers(): Drivers {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  const bus: Bus = {
    roomChannel: (roomKey) => `room:${roomKey}`,
    publish: async (channel, payload) => {
      // Defer to next tick to avoid synchronous re-entrancy (a handler that
      // publishes while handling), mirroring real network delivery.
      setImmediate(() => emitter.emit('message', channel, payload));
    },
    subscribe: async () => {},
    unsubscribe: async () => {},
    onMessage: (handler) => {
      emitter.on('message', handler);
    },
  };

  const buckets = new Map<string, { n: number; exp: number }>();
  const counters: Counters = {
    incr: async (key, ttlSec) => {
      const now = Date.now();
      const cur = buckets.get(key);
      if (!cur || cur.exp <= now) {
        buckets.set(key, { n: 1, exp: now + ttlSec * 1000 });
        // Opportunistic cleanup so the map can't grow unbounded.
        if (buckets.size > 10_000) {
          for (const [k, v] of buckets) if (v.exp <= now) buckets.delete(k);
        }
        return 1;
      }
      cur.n += 1;
      return cur.n;
    },
  };

  // Single node ⇒ the room total is just this node's count.
  const roomCounts = new Map<string, number>();
  const presence: PresenceStore = {
    setRoomCount: async (roomKey, _node, count) => {
      roomCounts.set(roomKey, count);
    },
    clearRoomNode: async (roomKey) => {
      roomCounts.delete(roomKey);
    },
    roomTotal: async (roomKey) => roomCounts.get(roomKey) ?? 0,
    heartbeat: async () => {},
    removeNode: async () => {
      roomCounts.clear();
    },
  };

  return {
    bus,
    counters,
    presence,
    close: async () => {
      emitter.removeAllListeners();
      buckets.clear();
      roomCounts.clear();
    },
  };
}
