import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { env } from './env.js';
import { logger } from './logger.js';
import { bus } from './drivers/index.js';
import { identityFromToken, type Identity } from './auth/session.js';
import {
  ensureRoom,
  insertMessage,
  isValidRoomKey,
  type RoomRow,
} from './db/rooms.js';
import { moderateContent, checkRateLimit } from './moderation.js';
import { presenceJoin, presenceLeave, getCount } from './presence.js';

/**
 * The realtime layer. Matches the wire protocol the extension's background.js
 * already speaks:
 *
 *   client → server:  {t:'sub',  roomKey, title?}   subscribe + join
 *                     {t:'unsub',roomKey}
 *                     {t:'msg',  roomKey, body}
 *                     {t:'pong'}                     keepalive reply
 *
 *   server → client:  {t:'ping'}                     keepalive (every ~20s —
 *                        REQUIRED so Chrome's MV3 worker stays alive)
 *                     {t:'msg',      roomKey, msg}
 *                     {t:'presence', roomKey, count}
 *                     {t:'error',    roomKey?, code}
 *
 * Fanout: a message the server accepts is PUBLISHed to Redis and delivered to
 * every node (including this one) via one identical code path — the node never
 * writes to its own sockets directly on send. See architecture notes.
 */

interface Conn {
  ws: WebSocket;
  identity: Identity;
  rooms: Set<string>;
  alive: boolean;
}

const PING_INTERVAL_MS = 20_000;

// roomKey -> local connections subscribed to it (this node only)
const localSubs = new Map<string, Set<Conn>>();
// roomKey -> resolved room row, cached while anyone here is subscribed
const roomCache = new Map<string, RoomRow>();
// Every live connection on this node (for the keepalive/reaper loop).
const connections = new Set<Conn>();

function channelToRoomKey(channel: string): string {
  let key = channel.startsWith('room:') ? channel.slice(5) : channel;
  if (env.USE_SHARDED_PUBSUB && key.startsWith('{') && key.endsWith('}')) {
    key = key.slice(1, -1);
  }
  return key;
}

// One global message handler for the whole process (driver-agnostic).
bus.onMessage((channel, message) => {
  const roomKey = channelToRoomKey(channel);
  const subs = localSubs.get(roomKey);
  if (!subs || subs.size === 0) return;
  for (const conn of subs) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(message);
      } catch {
        /* socket dying; cleaned up on close */
      }
    }
  }
});

async function addLocalSub(conn: Conn, roomKey: string, title?: string): Promise<RoomRow> {
  let set = localSubs.get(roomKey);
  const firstOnThisNode = !set || set.size === 0;
  if (!set) {
    set = new Set();
    localSubs.set(roomKey, set);
  }
  set.add(conn);
  conn.rooms.add(roomKey);

  // Subscribe to the room channel only once per node per room.
  if (firstOnThisNode) await bus.subscribe(bus.roomChannel(roomKey));

  let room = roomCache.get(roomKey);
  if (!room) {
    room = await ensureRoom(roomKey, title);
    roomCache.set(roomKey, room);
  }
  await presenceJoin(roomKey);
  return room;
}

async function removeLocalSub(conn: Conn, roomKey: string): Promise<void> {
  const set = localSubs.get(roomKey);
  if (!set || !set.has(conn)) return;
  set.delete(conn);
  conn.rooms.delete(roomKey);
  await presenceLeave(roomKey);
  if (set.size === 0) {
    localSubs.delete(roomKey);
    roomCache.delete(roomKey);
    await bus.unsubscribe(bus.roomChannel(roomKey));
  }
}

function send(conn: Conn, obj: unknown): void {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(obj));
}

async function handleFrame(conn: Conn, raw: RawData): Promise<void> {
  let frame: { t?: string; roomKey?: unknown; body?: unknown; title?: unknown };
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return;
  }

  switch (frame.t) {
    case 'pong':
      conn.alive = true;
      return;

    case 'sub': {
      if (!isValidRoomKey(frame.roomKey)) return send(conn, { t: 'error', code: 'bad_room' });
      if (conn.rooms.has(frame.roomKey)) return;
      const title = typeof frame.title === 'string' ? frame.title.slice(0, 300) : undefined;
      await addLocalSub(conn, frame.roomKey, title);
      // Immediate presence for the joiner (broadcast may race the subscribe).
      send(conn, { t: 'presence', roomKey: frame.roomKey, count: await getCount(frame.roomKey) });
      return;
    }

    case 'unsub': {
      if (typeof frame.roomKey === 'string') await removeLocalSub(conn, frame.roomKey);
      return;
    }

    case 'msg': {
      const roomKey = frame.roomKey;
      const body = frame.body;
      if (!isValidRoomKey(roomKey) || typeof body !== 'string') {
        return send(conn, { t: 'error', code: 'bad_msg' });
      }
      if (!conn.rooms.has(roomKey)) return send(conn, { t: 'error', roomKey, code: 'not_subscribed' });
      if (conn.identity.isBanned) return send(conn, { t: 'error', roomKey, code: 'banned' });

      const rate = await checkRateLimit(conn.identity.id);
      if (!rate.allowed) {
        return send(conn, { t: 'error', roomKey, code: 'rate_limited', retryAfter: rate.retryAfterSec });
      }

      const mod = moderateContent(body);
      if (!mod.ok) return send(conn, { t: 'error', roomKey, code: `mod_${mod.reason}` });

      const room = roomCache.get(roomKey) ?? (await ensureRoom(roomKey));
      roomCache.set(roomKey, room);
      if (room.is_locked) return send(conn, { t: 'error', roomKey, code: 'locked' });

      const saved = await insertMessage(room.id, conn.identity.id, mod.body!);
      const msg = {
        id: saved.id,
        handle: conn.identity.handle,
        color: conn.identity.displayColor,
        body: mod.body,
        ts: saved.ts,
      };
      // Round-trip through the bus; every node (incl. us) delivers identically.
      await bus.publish(bus.roomChannel(roomKey), JSON.stringify({ t: 'msg', roomKey, msg }));
      return;
    }

    default:
      return;
  }
}

export function attachWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Token arrives in the query string (extension) or Authorization header.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token =
      url.searchParams.get('token') ??
      req.headers.authorization?.replace(/^Bearer\s+/i, '') ??
      null;

    // Attach the message listener SYNCHRONOUSLY. Auth is async (a DB lookup),
    // and the `ws` library drops any frames that arrive before a listener
    // exists — so we buffer frames until the connection is authenticated.
    let conn: Conn | null = null;
    const pending: RawData[] = [];

    ws.on('message', (raw) => {
      if (!conn) {
        pending.push(raw);
        return;
      }
      handleFrame(conn, raw).catch((err) =>
        logger.error({ err, userId: conn?.identity.id }, 'frame handler error'),
      );
    });
    ws.on('error', () => ws.close());

    void (async () => {
      const identity = await identityFromToken(token);
      if (!identity) {
        ws.close(4401, 'unauthorized');
        return;
      }
      conn = { ws, identity, rooms: new Set(), alive: true };
      connections.add(conn);

      ws.on('close', () => {
        connections.delete(conn!);
        for (const roomKey of [...conn!.rooms]) void removeLocalSub(conn!, roomKey);
      });

      // Drain anything that arrived during auth, in order.
      for (const raw of pending.splice(0)) {
        handleFrame(conn, raw).catch((err) =>
          logger.error({ err, userId: identity.id }, 'frame handler error'),
        );
      }
    })();
  });

  // Keepalive + dead-socket reaper. The {t:'ping'} is what keeps the MV3
  // service worker alive on the extension side; the pong tells us it's live.
  const interval = setInterval(() => {
    for (const conn of connections) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.send('{"t":"ping"}');
      } catch {
        /* ignore */
      }
    }
  }, PING_INTERVAL_MS);

  wss.on('close', () => clearInterval(interval));
}
