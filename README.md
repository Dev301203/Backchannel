# Backchannel

A public chat room for every website. Open the sidebar on any page and you're
in that page's (or domain's) lobby — like a Twitch chat, but the "channel" is
the URL you're on.

**Features:**

- 💬 A room for every page, plus a **"whole site" room** — switch scope with
  one click in the sidebar header
- 🧵 One-level **threads** (reply to any top-level message)
- 👍 **Emoji reactions** with live counts
- ⌨️ **Typing indicators**
- 🏆 **Achievements & badges** — 14 unlockables (pioneer a room, keep a streak,
  collect reactions…) with progress bars; wear any earned badge next to your
  name
- 🔔 @mentions with self-highlight, clickable links, date dividers, unread
  "N new messages" pill
- 🚩 One-click **reporting** into a moderation queue; profanity/spam filter and
  per-user rate limits on every message
- 👤 Frictionless **anonymous** viewing; sign in (Google/GitHub/Discord/Apple
  or email code) to post — the anonymous identity upgrades in place

This repo contains both halves of the system:

```
.                       # ← the browser extension (MV3)
├─ manifest.json        # extension manifest
├─ background.js        # service worker: owns ONE WebSocket, fans out to tabs
├─ content.js           # injects the shadow-DOM sidebar, tracks SPA navigation
├─ sidebar.js           # the whole sidebar UI (shared by content script + popout)
├─ popup.js / popup.html# pop-out window shell (same UI, own window)
├─ normalize.js         # URL → room-key rules (SHARED with the server)
├─ auth.js              # extension auth client (anonymous + social via Better Auth)
├─ build.mjs            # esbuild bundler (content/background/popup → dist/)
├─ schema.sql           # Postgres application schema
├─ test/                # jsdom test that drives the sidebar UI end to end
└─ server/              # ← the realtime backend
   ├─ smoketest.mjs     # live end-to-end test (run against a running server)
   └─ src/
      ├─ index.ts       # HTTP + WebSocket entry, graceful shutdown
      ├─ ws.ts          # sub/msg/typing/react protocol, fanout, achievements
      ├─ http.ts        # REST: history, reports, /me, badges, OAuth bridge
      ├─ achievements.ts# gamification: stats, streaks, unlock rules, catalog
      ├─ auth/          # Better Auth config + session/handle helpers
      ├─ db/            # pg pool, room/message/reaction queries, migrator
      ├─ drivers/       # memory vs Redis: fanout + presence + counters
      ├─ presence.ts    # cross-instance "N people here"
      └─ moderation.ts  # content filter + rate limiting
```

## How it works (the 60-second version)

1. **Room resolution.** `normalize.js` turns the current URL into a room key —
   `youtube.com` (domain room) or `youtube.com/watch|v=abc` (page room) — after
   stripping tracking params, `www.`, fragments, etc. The **same file runs in
   the extension and the server**; the server's result is authoritative.
2. **One socket per browser.** The MV3 service worker holds a single WebSocket
   and multiplexes every tab over `chrome.runtime` Ports. Ten YouTube tabs = one
   connection, one subscription.
3. **Fanout.** Each server node subscribes (in Redis) only to the room channels
   it currently hosts. A message published to `room:<key>` is delivered to every
   node with subscribers, which write it to their local sockets. Nodes never
   talk to each other directly — add a tenth node by pointing it at the same
   Redis. (`USE_SHARDED_PUBSUB=true` upgrades to Redis 7 `SPUBLISH/SSUBSCRIBE`.)
4. **Persistence.** Live delivery is fire-and-forget; recent history comes from
   Postgres over HTTP on join/reconnect. Messages are range-partitioned by month
   so retention is a cheap `DROP PARTITION`.
5. **Auth.** Handled entirely by [Better Auth](https://better-auth.com) — the
   "does everything" library. New users get a **frictionless anonymous session**
   (pseudonymous handle); they can **link Google/GitHub in place** to upgrade the
   same account. The extension uses **bearer tokens** (stored in
   `chrome.storage.local`) because cookies are awkward in extension contexts.
6. **Gamification.** Every accepted message bumps counters in `user_stats`
   (messages, distinct rooms, rooms pioneered, replies/reactions received,
   day streaks…). Achievements are uniform "counter ≥ target" rules in
   `server/src/achievements.ts`; unlocks arrive as WebSocket frames and toast in
   the sidebar. Earned badges can be displayed next to the handle on every
   message. Handle/color/badge changes propagate to **live sockets** over an
   internal control channel — no reconnect needed.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the scaling story.

## Quick start (local)

### 1. Backend

```bash
cp server/.env.example server/.env
# edit server/.env: set BETTER_AUTH_SECRET (openssl rand -base64 32) and
# TRUSTED_ORIGINS to your extension id once you know it.

docker compose up --build        # postgres + redis + migrate + server
# server on http://localhost:8080  (health: http://localhost:8080/health)
```

Or run the server directly against your own Postgres (Redis optional):

```bash
cd server
npm install
# No Redis? Run single-instance with in-process fanout:
#   set PUBSUB_DRIVER=memory in .env (or just leave REDIS_URL empty)
npm run migrate                  # creates auth tables + app schema + partitions
npm run dev                      # tsx watch
```

**Fanout driver.** `PUBSUB_DRIVER=memory` runs everything (fanout, presence,
rate-limiting) in-process — perfect for a single free instance, no Redis needed.
`PUBSUB_DRIVER=redis` (or just setting `REDIS_URL`) switches to Redis pub/sub for
multi-instance scale. Same interface either way; it's a config flag, not a fork.

### Deploy free (Render + Neon)

`render.yaml` is a ready Blueprint: a single free web service on the **memory**
driver (no Redis) + managed Postgres from **Neon**'s free tier. Point Render at
your repo, set `DATABASE_URL` (Neon pooled string), `BASE_URL`/`BETTER_AUTH_URL`
(your `*.onrender.com` URL), and `TRUSTED_ORIGINS` (`chrome-extension://<id>`),
then deploy. `npm run start:prod` runs migrations on boot; partitions are kept
current by an in-app daily scheduler. See [DEPLOYMENT.md](./DEPLOYMENT.md).

> Free-tier note: the service sleeps after 15 min with **zero** connections and
> cold-starts (~30–60s) on the next connect. An open sidebar's 20s ping keeps it
> warm, so only the first arrival after a fully quiet period waits — the
> extension shows "reconnecting…" and backfills history over HTTP. $7/mo removes
> sleep entirely.

### 2. Extension

```bash
npm install
npm run build                    # bundles into ./dist
```

Point it at your backend at build time (defaults to `https://api.backchannel.app`):

```bash
# PowerShell
$env:BC_API_URL='http://localhost:8080'; npm run build
# bash
BC_API_URL=http://localhost:8080 npm run build
```

Then load it in Chrome:

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Copy the extension ID Chrome assigns and put
   `chrome-extension://<that-id>` into `TRUSTED_ORIGINS` in `server/.env`,
   then restart the server (required so Better Auth + CORS trust the extension).
4. Click the toolbar icon on any page to toggle the sidebar.

> The WebSocket URL is derived from `BC_API_URL` (http→ws, https→wss). If you
> deploy the backend somewhere other than `api.backchannel.app` or localhost,
> also add that host to `host_permissions` in `manifest.json`.

## Auth options — why Better Auth

You asked for a drop-in auth library like the ones common in React Native
(Clerk / Supabase / Firebase). Better Auth is the best fit here because it:

- is **self-hostable on our existing Postgres** (no extra vendor),
- ships an **anonymous plugin** — exactly the pseudonymous-handle model the
  design wanted, with an automatic "upgrade to a real account" path,
- has **social providers** (Google/GitHub) as a config-only add-on, and
- has a **bearer plugin**, which is what makes it work cleanly inside a browser
  extension (token instead of cookies).

Everything auth-related — sessions, CSRF, OAuth dance, account linking, token
rotation — is handled by the library. We only wrote the thin glue in
`server/src/auth/` and `auth.js`.

## Moderation

First-class from day one (`server/src/moderation.ts` + the `reports`,
`room_roles`, `domain_claims`, `user_moderation` tables):

- profanity/abuse hard-block + spam heuristics on every message,
- Redis token-bucket **rate limiting** (per-user, cross-instance),
- **report** button → moderation queue,
- per-room roles (owner/mod/ban) and a **domain-claim** program so site owners
  can moderate their own domain's room (DNS TXT or `/.well-known` verification).

## Testing

Two layers, both fast:

```bash
# UI: drives the real sidebar (threads, reactions, toasts, scope switch,
# achievements drawer) in jsdom with a stubbed port. No server needed.
npm run test:ui

# End-to-end: auth → sockets → fanout → reactions → typing → achievements →
# badges → live identity patch → history → moderation → rate limits.
# Needs the server running (docker compose up, or npm run dev + postgres).
cd server && npm run smoketest
```

## Scripts

Extension (repo root): `npm run build`, `npm run watch`, `npm run test:ui`,
`npm run clean`.
Server (`server/`): `npm run dev`, `npm run start`, `npm run migrate`,
`npm run typecheck`, `npm run build`, `npm run smoketest`.
