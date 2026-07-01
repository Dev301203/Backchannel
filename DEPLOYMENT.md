# Deployment & Scaling

Backchannel is designed to scale horizontally with **stateless** app nodes. The
only shared state lives in Redis (fanout + presence + rate limits) and Postgres
(durable messages + identity). This document covers how to grow each layer.

## Topology

```
        ┌──────────── clients (extensions) ────────────┐
        │  wss://api…/socket        https://api…/*      │
        ▼                                               ▼
   ┌──────────┐  Load balancer (L7, WebSocket-aware, no sticky needed)  ┌──────────┐
   │ server 1 │ ── … ── │ server N │   (add nodes freely; each is stateless)
   └────┬─────┘         └────┬─────┘
        │  PUB/SUB room:<key> (fanout)     │
        ▼                                  ▼
                 ┌──────────────┐   ┌──────────────┐
                 │    Redis     │   │  Postgres    │  (via pgbouncer)
                 │ pub/sub +    │   │  partitioned │
                 │ presence +   │   │  messages    │
                 │ rate limits  │   └──────────────┘
                 └──────────────┘
```

**No sticky sessions required.** A user's socket can land on any node; Redis
pub/sub bridges rooms across nodes. This is the whole point of the fanout
design in `ws.ts` + `redis.ts`.

## App nodes

- Fully stateless. Scale with `docker compose up --scale server=N` behind a
  reverse proxy, or a Deployment with `replicas: N` on Kubernetes.
- Each node keeps only *local* socket registries in memory; on restart clients
  reconnect (the extension has backoff + an alarm-based fallback) and re-`sub`.
- Keepalive: the server pings every ~20s. This is **required** — it keeps the
  extension's MV3 service worker alive (Chrome 116+) and reaps dead sockets.

## Fanout driver: memory vs redis

`PUBSUB_DRIVER` selects how fanout, presence, and rate-limiting coordinate:

- `memory` — everything in-process. Correct **only for a single instance** (the
  free tier). No Redis to run or pay for. State is ephemeral by design; a restart
  costs nothing because clients reconnect + resubscribe and history is in
  Postgres.
- `redis` — Redis pub/sub fanout + shared presence/rate-limit. Required the
  moment you run **2+ instances**. Setting `REDIS_URL` auto-selects this.

Both implement the same interfaces (`server/src/drivers/`), so scaling out is a
config change (set `REDIS_URL`, bump replicas), not a rewrite.

## Redis (when PUBSUB_DRIVER=redis)

- A single instance handles enormous pub/sub throughput; you won't hit the wall
  for a long time. Use Redis with AOF for the rate-limit/presence keys.
- On a managed free tier (e.g. Upstash: ~500K commands/month), watch the command
  budget — presence heartbeats + rate-limit INCRs add up. If it's tight, prefer
  `memory` on a single instance, or raise `PRESENCE_HEARTBEAT_MS`.
- **When you outgrow one node:** classic pub/sub in Redis Cluster broadcasts
  every message to every node (poor scaling). Flip `USE_SHARDED_PUBSUB=true` to
  switch to Redis 7 **sharded pub/sub** (`SPUBLISH`/`SSUBSCRIBE`). Room channels
  are wrapped in a `{hash tag}` so each room maps to exactly one shard — a clean
  fit since rooms are independent.
- Presence uses a per-room hash keyed by node id, plus a `bc:nodes` ZSET of live
  nodes. Dead nodes' contributions are ignored and pruned, so a crash never
  leaves a room showing ghosts.

## Postgres

- Put **pgbouncer** (transaction pooling) in front and point `DATABASE_URL` at
  it. Thousands of app connections collapse onto a few real backends. The code
  uses only simple queries, which are safe under transaction pooling.
- `messages` is **range-partitioned by month**. The server keeps the current +
  next month's partitions live via an in-app daily scheduler
  (`db/partitions.ts`) and `npm run start:prod` re-runs migrations on boot, so no
  external cron is required on the free tier. For heavier setups, `pg_partman` is
  a fine upgrade. Dropping old data = `DROP TABLE messages_YYYY_MM`.
- The single hot index is `messages_room_recent_idx (room_id, created_at DESC)`
  for the history-backfill query.
- Read replicas: history reads (`GET /rooms/:key/messages`) can be routed to a
  replica later; writes and auth stay on the primary.

## Auth (Better Auth) in production

- Set a strong `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` = your public API URL.
- Add each published extension id to `TRUSTED_ORIGINS`
  (`chrome-extension://<id>`), plus any web origins. Better Auth validates
  request Origin against this list, and our CORS layer echoes it.
- Social login: create Google/GitHub OAuth apps whose redirect URI is
  `https://api.yourhost/api/auth/callback/<provider>`. The extension bridge
  (`/ext/callback`) then hands the bearer token back to the extension.
- Run `npm run migrate` (or `npx @better-auth/cli migrate`) on deploy to apply
  auth-table changes.

## Cold-start / "never an empty room"

The design's key UX rule. Implement via:

- **Domain-room fallback** when a page room is empty (client policy in
  `content.js#resolveRoom`; extend with an occupancy check).
- **Async history**: the last 24h of messages are shown on join so a room is
  never blank.
- Launch on a few high-traffic verticals first (live sports, news, launches).

## Health & ops

- `GET /health` → `{ ok, node }` for load-balancer checks.
- Structured JSON logs (pino) in production; set `LOG_LEVEL`.
- Graceful shutdown drains sockets, clears this node's presence, and closes
  Redis/PG on `SIGTERM`/`SIGINT`.
