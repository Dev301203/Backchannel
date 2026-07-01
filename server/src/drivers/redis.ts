import Redis from 'ioredis';
import { env } from '../env.js';
import { logger } from '../logger.js';
import type { Bus, Counters, Drivers, PresenceStore } from './types.js';

/**
 * Redis driver for multi-instance deploys. Implements the same three
 * interfaces as the memory driver:
 *
 *   - Bus:      pub/sub fanout (classic or Redis 7 sharded via SPUBLISH/SSUBSCRIBE)
 *   - Counters: atomic fixed-window rate-limit counters (Lua INCR+EXPIRE)
 *   - Presence: per-room hash keyed by node id + a live-node ZSET, so a crashed
 *               node's counts are ignored and pruned rather than lingering.
 *
 * Three connections by design: pub (PUBLISH), a dedicated sub (subscribe mode
 * can't run other commands), and cmd (everything else).
 */
export function createRedisDrivers(): Drivers {
  const make = (role: string): Redis => {
    const client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });
    client.on('error', (err) => logger.error({ err, role }, 'redis error'));
    client.on('ready', () => logger.info({ role }, 'redis ready'));
    return client;
  };

  const pub = make('pub');
  const sub = make('sub');
  const cmd = make('cmd');

  const sharded = env.USE_SHARDED_PUBSUB;

  const bus: Bus = {
    roomChannel: (roomKey) => (sharded ? `room:{${roomKey}}` : `room:${roomKey}`),
    publish: async (channel, payload) => {
      if (sharded) await pub.spublish(channel, payload);
      else await pub.publish(channel, payload);
    },
    subscribe: async (channel) => {
      if (sharded) await sub.ssubscribe(channel);
      else await sub.subscribe(channel);
    },
    unsubscribe: async (channel) => {
      if (sharded) await sub.sunsubscribe(channel);
      else await sub.unsubscribe(channel);
    },
    onMessage: (handler) => {
      sub.on(sharded ? 'smessage' : 'message', handler);
    },
  };

  // ---- Counters (rate limiting) -------------------------------------------
  const RATE_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;
  let rateSha: string | null = null;
  const counters: Counters = {
    incr: async (key, ttlSec) => {
      try {
        if (!rateSha) rateSha = (await cmd.script('LOAD', RATE_LUA)) as string;
        return (await cmd.evalsha(rateSha, 1, key, String(ttlSec))) as number;
      } catch {
        return (await cmd.eval(RATE_LUA, 1, key, String(ttlSec))) as number;
      }
    },
  };

  // ---- Presence -----------------------------------------------------------
  const NODES_ZSET = 'bc:nodes';
  const presenceKey = (roomKey: string) => `presence:${roomKey}`;

  const liveNodeSet = async (): Promise<Set<string>> => {
    const cutoff = Date.now() - env.PRESENCE_TTL_SEC * 1000;
    const alive = await cmd.zrangebyscore(NODES_ZSET, cutoff, '+inf');
    return new Set(alive);
  };

  const presence: PresenceStore = {
    setRoomCount: async (roomKey, nodeId, count) => {
      await cmd.hset(presenceKey(roomKey), nodeId, count);
    },
    clearRoomNode: async (roomKey, nodeId) => {
      await cmd.hdel(presenceKey(roomKey), nodeId);
    },
    roomTotal: async (roomKey) => {
      const [counts, live] = await Promise.all([cmd.hgetall(presenceKey(roomKey)), liveNodeSet()]);
      let total = 0;
      const dead: string[] = [];
      for (const [node, val] of Object.entries(counts)) {
        if (live.has(node)) total += Number(val) || 0;
        else dead.push(node);
      }
      if (dead.length) await cmd.hdel(presenceKey(roomKey), ...dead).catch(() => {});
      return total;
    },
    heartbeat: async (nodeId, localCounts) => {
      await cmd.zadd(NODES_ZSET, Date.now(), nodeId);
      const pipe = cmd.pipeline();
      for (const [roomKey, count] of localCounts) pipe.hset(presenceKey(roomKey), nodeId, count);
      await pipe.exec();
      const cutoff = Date.now() - env.PRESENCE_TTL_SEC * 1000;
      await cmd.zremrangebyscore(NODES_ZSET, '-inf', cutoff);
    },
    removeNode: async (nodeId, localCounts) => {
      const pipe = cmd.pipeline();
      for (const roomKey of localCounts.keys()) pipe.hdel(presenceKey(roomKey), nodeId);
      pipe.zrem(NODES_ZSET, nodeId);
      await pipe.exec().catch(() => {});
    },
  };

  return {
    bus,
    counters,
    presence,
    close: async () => {
      await Promise.allSettled([pub.quit(), sub.quit(), cmd.quit()]);
    },
  };
}
