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
  isUuid,
  getMessageAuthor,
  addReaction,
  removeReaction,
  type RoomRow,
} from './db/rooms.js';
import {
  moderateContent,
  checkRateLimit,
  checkReactionRateLimit,
  checkTypingRateLimit,
} from './moderation.js';
import { presenceJoin, presenceLeave, getCount } from './presence.js';
import { recordMessage, bumpStat, type AchievementDef } from './achievements.js';

/**
 * The realtime layer. Matches the wire protocol the extension's background.js
 * speaks:
 *
 *   client → server:  {t:'sub',   roomKey, title?}   subscribe + join
 *                     {t:'unsub', roomKey}
 *                     {t:'msg',   roomKey, body, parentId?}
 *                     {t:'typing',roomKey}
 *                     {t:'react', roomKey, messageId, emoji, op:'add'|'remove'}
 *                     {t:'pong'}                     keepalive reply
 *
 *   server → client:  {t:'ping'}                     keepalive (every ~20s —
 *                        REQUIRED so Chrome's MV3 worker stays alive)
 *                     {t:'msg',      roomKey, msg}
 *                     {t:'presence', roomKey, count}
 *                     {t:'typing',   roomKey, handle, color}
 *                     {t:'react',    roomKey, messageId, emoji, count}
 *                     {t:'achievement', a:{id,emoji,title,desc}}   (no roomKey)
 *                     {t:'error',    roomKey?, code}
 *
 * Fanout: a message the server accepts is PUBLISHed to the bus and delivered to
 * every node (including this one) via one identical code path — the node never
 * writes to its own sockets directly on send. See architecture notes.
 *
 * The control channel (bc:ctl) carries node-to-node events that aren't room
 * frames: identity patches (handle/color/badge changed over HTTP while a
 * socket is live) and passive achievement unlocks (you got your 10th reply
 * while online). Every node subscribes; each delivers to its local conns.
 */

interface Conn {
  ws: WebSocket;
  identity: Identity;
  rooms: Set<string>;
  alive: boolean;
}

const PING_INTERVAL_MS = 20_000;
const CTL_CHANNEL = 'bc:ctl';

/** Reactions we accept. Mirrored in the extension's quick-react palette. */
const REACTION_EMOJI = new Set(['👍', '❤️', '😂', '😮', '😢', '🔥']);

// roomKey -> local connections subscribed to it (this node only)
const localSubs = new Map<string, Set<Conn>>();
// roomKey -> resolved room row, cached while anyone here is subscribed
const roomCache = new Map<string, RoomRow>();
// Every live connection on this node (for the keepalive/reaper loop).
const connections = new Set<Conn>();
// userId -> conns, for targeted delivery (achievements, identity patches).
const connsByUser = new Map<string, Set<Conn>>();

function channelToRoomKey(channel: string): string {
  let key = channel.startsWith('room:') ? channel.slice(5) : channel;
  if (env.USE_SHARDED_PUBSUB && key.startsWith('{') && key.endsWith('}')) {
    key = key.slice(1, -1);
  }
  return key;
}

type CtlFrame =
  | { k: 'identity'; userId: string; patch: { handle?: string; color?: number; badge?: string | null } }
  | { k: 'ach'; userId: string; achievements: AchievementDef[] };

function handleCtl(payload: string): void {
  let frame: CtlFrame;
  try {
    frame = JSON.parse(payload) as CtlFrame;
  } catch {
    return;
  }
  const conns = connsByUser.get(frame.userId);
  if (!conns) return;
  if (frame.k === 'identity') {
    for (const conn of conns) {
      if (frame.patch.handle !== undefined) conn.identity.handle = frame.patch.handle;
      if (frame.patch.color !== undefined) conn.identity.displayColor = frame.patch.color;
      if (frame.patch.badge !== undefined) conn.identity.badge = frame.patch.badge;
    }
  } else if (frame.k === 'ach') {
    for (const conn of conns) {
      for (const a of frame.achievements) send(conn, { t: 'achievement', a });
    }
  }
}

// One global message handler for the whole process (driver-agnostic).
bus.onMessage((channel, message) => {
  if (channel === CTL_CHANNEL) return handleCtl(message);
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

/**
 * Push an identity change to every node so live sockets pick it up without
 * reconnecting. Called from the HTTP layer after handle/color/badge updates.
 */
export function publishIdentityPatch(
  userId: string,
  patch: { handle?: string; color?: number; badge?: string | null },
): void {
  void bus
    .publish(CTL_CHANNEL, JSON.stringify({ k: 'identity', userId, patch } satisfies CtlFrame))
    .catch((err) => logger.warn({ err }, 'identity patch publish failed'));
}

/** Deliver passive achievement unlocks to the user's live sockets, any node. */
function publishAchievements(userId: string, achievements: AchievementDef[]): void {
  if (achievements.length === 0) return;
  void bus
    .publish(CTL_CHANNEL, JSON.stringify({ k: 'ach', userId, achievements } satisfies CtlFrame))
    .catch((err) => logger.warn({ err }, 'achievement publish failed'));
}

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

function sendAchievements(conn: Conn, achievements: AchievementDef[]): void {
  for (const a of achievements) send(conn, { t: 'achievement', a });
}

async function handleFrame(conn: Conn, raw: RawData): Promise<void> {
  let frame: {
    t?: string;
    roomKey?: unknown;
    body?: unknown;
    title?: unknown;
    parentId?: unknown;
    messageId?: unknown;
    emoji?: unknown;
    op?: unknown;
  };
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

    case 'typing': {
      const roomKey = frame.roomKey;
      if (!isValidRoomKey(roomKey) || !conn.rooms.has(roomKey)) return;
      if (conn.identity.isAnonymous || conn.identity.isBanned) return;
      if (!(await checkTypingRateLimit(conn.identity.id))) return;
      await bus.publish(
        bus.roomChannel(roomKey),
        JSON.stringify({
          t: 'typing',
          roomKey,
          handle: conn.identity.handle,
          color: conn.identity.displayColor,
        }),
      );
      return;
    }

    case 'react': {
      const { roomKey, messageId, emoji, op } = frame;
      if (
        !isValidRoomKey(roomKey) ||
        !isUuid(messageId) ||
        typeof emoji !== 'string' ||
        !REACTION_EMOJI.has(emoji) ||
        (op !== 'add' && op !== 'remove')
      ) {
        return send(conn, { t: 'error', code: 'bad_react' });
      }
      if (!conn.rooms.has(roomKey)) return send(conn, { t: 'error', roomKey, code: 'not_subscribed' });
      if (conn.identity.isBanned) return send(conn, { t: 'error', roomKey, code: 'banned' });
      if (conn.identity.isAnonymous) return send(conn, { t: 'error', roomKey, code: 'sign_in_required' });

      const rate = await checkReactionRateLimit(conn.identity.id);
      if (!rate.allowed) {
        return send(conn, { t: 'error', roomKey, code: 'rate_limited', retryAfter: rate.retryAfterSec });
      }

      const count =
        op === 'add'
          ? await addReaction(messageId, conn.identity.id, emoji)
          : await removeReaction(messageId, conn.identity.id, emoji);
      if (count === null) return; // no-op (double-add / remove of nothing)

      await bus.publish(
        bus.roomChannel(roomKey),
        JSON.stringify({ t: 'react', roomKey, messageId, emoji, count }),
      );

      // Gamification: credit the giver and (if it's someone else) the author.
      if (op === 'add') {
        const mine = await bumpStat(conn.identity.id, 'reactions_given');
        sendAchievements(conn, mine);
        const author = await getMessageAuthor(messageId);
        if (author && author !== conn.identity.id) {
          publishAchievements(author, await bumpStat(author, 'reactions_received'));
        }
      } else {
        const author = await getMessageAuthor(messageId);
        void bumpStat(conn.identity.id, 'reactions_given', -1);
        if (author && author !== conn.identity.id) {
          void bumpStat(author, 'reactions_received', -1);
        }
      }
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
      // Anonymous users can view but not send. Link a provider to post.
      if (conn.identity.isAnonymous) return send(conn, { t: 'error', roomKey, code: 'sign_in_required' });

      const rate = await checkRateLimit(conn.identity.id);
      if (!rate.allowed) {
        return send(conn, { t: 'error', roomKey, code: 'rate_limited', retryAfter: rate.retryAfterSec });
      }

      const mod = moderateContent(body);
      if (!mod.ok) return send(conn, { t: 'error', roomKey, code: `mod_${mod.reason}` });

      const room = roomCache.get(roomKey) ?? (await ensureRoom(roomKey));
      roomCache.set(roomKey, room);
      if (room.is_locked) return send(conn, { t: 'error', roomKey, code: 'locked' });

      // Threads are one level deep. Accept a parentId if the client supplied
      // one; the client is responsible for only offering reply on top-level
      // messages. Validate shape here, and let unknown ids simply save as-is —
      // the client renders orphan replies at the top level.
      const parentId = isUuid(frame.parentId) ? frame.parentId : null;

      const saved = await insertMessage(room.id, conn.identity.id, mod.body!, parentId);
      const msg = {
        id: saved.id,
        handle: conn.identity.handle,
        color: conn.identity.displayColor,
        badge: conn.identity.badge,
        body: mod.body,
        ts: saved.ts,
        parentId,
        reactions: [],
      };
      // Round-trip through the bus; every node (incl. us) delivers identically.
      await bus.publish(bus.roomChannel(roomKey), JSON.stringify({ t: 'msg', roomKey, msg }));

      // Gamification (post-send, never blocks delivery): counters + streak for
      // the sender, reply credit for the parent author.
      const earned = await recordMessage(conn.identity.id, room.id, saved.wasFirst);
      sendAchievements(conn, earned);
      if (parentId) {
        const parentAuthor = await getMessageAuthor(parentId);
        if (parentAuthor && parentAuthor !== conn.identity.id) {
          publishAchievements(parentAuthor, await bumpStat(parentAuthor, 'replies_received'));
        }
      }
      return;
    }

    default:
      return;
  }
}

export function attachWebSocket(wss: WebSocketServer): void {
  // All nodes listen on the control channel for identity/achievement events.
  void bus.subscribe(CTL_CHANNEL).catch((err) => logger.warn({ err }, 'ctl subscribe failed'));

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
      let userSet = connsByUser.get(identity.id);
      if (!userSet) connsByUser.set(identity.id, (userSet = new Set()));
      userSet.add(conn);

      ws.on('close', () => {
        connections.delete(conn!);
        const set = connsByUser.get(conn!.identity.id);
        set?.delete(conn!);
        if (set && set.size === 0) connsByUser.delete(conn!.identity.id);
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
