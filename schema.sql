-- Backchannel: Postgres schema (application tables)
--
-- Identity is owned by Better Auth, which manages its own tables:
--   "user", "session", "account", "verification"
-- Those are created/updated by Better Auth's migrator (see server/src/db/migrate.ts
-- or `npx @better-auth/cli migrate`). Do NOT hand-edit them here.
--
-- The `user.id` column is a TEXT id (Better Auth default). The app tables below
-- reference that id as a plain text column. We intentionally DO NOT add SQL
-- foreign keys from app tables to "user":
--   * it keeps this migration independent of Better Auth's migration, and
--   * on the hottest table (messages) skipping the per-insert FK check is the
--     more scalable choice — user rows are never hard-deleted anyway.
--
-- Design notes retained from the original:
--   * Rooms are created lazily on first join, keyed by a normalized room_key.
--   * Messages are the hot table: range-partitioned, minimal indexes.
--   * Moderation is first-class from day one.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";    -- case-insensitive text

-- ---------------------------------------------------------------------------
-- Per-user moderation state. Separate from the Better-Auth "user" table so the
-- two migration systems stay decoupled. One row only when a user is sanctioned
-- (or we choose to record display metadata); ordinary users have no row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_moderation (
    user_id      text PRIMARY KEY,
    is_banned    boolean NOT NULL DEFAULT false,
    banned_until timestamptz,               -- NULL + is_banned = permanent
    banned_by    text,
    reason       text,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Rooms: one row per chat room. room_key is the normalized identity.
--   domain room:  'youtube.com'
--   page room:    'youtube.com/watch|v=dQw4w9WgXcQ'   (normalizer output)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_key        text NOT NULL UNIQUE,
    kind            text NOT NULL CHECK (kind IN ('domain', 'page')),
    domain          text NOT NULL,
    title           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz,
    message_count   bigint NOT NULL DEFAULT 0,
    is_locked       boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS rooms_domain_idx ON rooms (domain);
CREATE INDEX IF NOT EXISTS rooms_activity_idx ON rooms (last_message_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- Messages: the hot table. Range-partition by created_at so retention is a
-- cheap "DROP PARTITION". Create partitions monthly via pg_partman or the
-- helper below. migrate.ts pre-creates the current + next month.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id          uuid NOT NULL DEFAULT gen_random_uuid(),
    room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id     text NOT NULL,                -- Better Auth user.id (no FK; see header)
    body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
    created_at  timestamptz NOT NULL DEFAULT now(),
    parent_id   uuid,                          -- top-level reply target (1 level deep)
    deleted_at  timestamptz,
    deleted_by  text,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Idempotent add for pre-parent_id installations.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_id uuid;

CREATE INDEX IF NOT EXISTS messages_room_recent_idx ON messages (room_id, created_at DESC);

-- Helper: create a month partition if missing. Call with the first day of the
-- month, e.g. SELECT ensure_month_partition('2026-07-01');
CREATE OR REPLACE FUNCTION ensure_month_partition(month_start date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    part_name text := 'messages_' || to_char(month_start, 'YYYY_MM');
    next_start date := (month_start + interval '1 month')::date;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF messages FOR VALUES FROM (%L) TO (%L)',
            part_name, month_start, next_start
        );
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Room membership / roles. No row = ordinary participant; rows exist only for
-- elevated roles and per-room bans.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_roles (
    room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id     text NOT NULL,
    role        text NOT NULL CHECK (role IN ('owner', 'moderator', 'banned')),
    granted_by  text,
    granted_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz,
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_roles_user_idx ON room_roles (user_id);

-- ---------------------------------------------------------------------------
-- Domain claims: site owners verify via DNS TXT or /.well-known file, then get
-- 'owner' role on all rooms under their domain.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS domain_claims (
    domain       text PRIMARY KEY,
    user_id      text NOT NULL,
    method       text NOT NULL CHECK (method IN ('dns_txt', 'well_known')),
    token        text,                        -- verification challenge
    verified_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Gamification: per-user counters that power achievements + badges.
-- One row per user, created lazily on first message. All columns are plain
-- monotonic counters except the streak pair, which the upsert in
-- achievements.ts maintains (same-day no-op, yesterday +1, else reset to 1).
-- display_badge holds the achievement id the user chose to show by their name.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_stats (
    user_id            text PRIMARY KEY,
    messages_sent      integer NOT NULL DEFAULT 0,
    rooms_posted       integer NOT NULL DEFAULT 0,  -- distinct rooms posted in
    rooms_pioneered    integer NOT NULL DEFAULT 0,  -- rooms where they spoke first
    replies_received   integer NOT NULL DEFAULT 0,
    reactions_received integer NOT NULL DEFAULT 0,
    reactions_given    integer NOT NULL DEFAULT 0,
    night_messages     integer NOT NULL DEFAULT 0,  -- sent 00:00–04:59 UTC
    streak_days        integer NOT NULL DEFAULT 0,
    best_streak        integer NOT NULL DEFAULT 0,
    last_active_date   date,
    display_badge      text,
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Which rooms a user has posted in (dedupe set behind rooms_posted).
CREATE TABLE IF NOT EXISTS user_rooms (
    user_id   text NOT NULL,
    room_id   uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    first_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, room_id)
);

CREATE TABLE IF NOT EXISTS user_achievements (
    user_id     text NOT NULL,
    achievement text NOT NULL,
    earned_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, achievement)
);

-- ---------------------------------------------------------------------------
-- Emoji reactions. No FK to messages (its PK includes created_at for
-- partitioning); reaction rows for pruned partitions are swept by retention.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_reactions (
    message_id uuid NOT NULL,
    user_id    text NOT NULL,
    emoji      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_msg_idx ON message_reactions (message_id);

-- ---------------------------------------------------------------------------
-- Reports: user-submitted moderation queue.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id         uuid NOT NULL,
    message_created_at timestamptz NOT NULL,  -- locate the partition
    room_id            uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    reporter_id        text NOT NULL,
    reason             text NOT NULL CHECK (reason IN
                         ('spam', 'harassment', 'hate', 'illegal', 'other')),
    detail             text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    resolved_at        timestamptz,
    resolved_by        text,
    action             text CHECK (action IN ('dismissed', 'deleted', 'banned')),
    UNIQUE (message_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS reports_open_idx ON reports (created_at) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- Common queries, for reference:
--
-- Recent history on room join (backfill), joining Better Auth's user table:
--   SELECT m.id, m.body, m.created_at, u.name AS handle, u."displayColor"
--   FROM messages m JOIN "user" u ON u.id = m.user_id
--   WHERE m.room_id = $1 AND m.deleted_at IS NULL
--   ORDER BY m.created_at DESC LIMIT 50;
--
-- Lazy room creation (one round trip, race-safe):
--   INSERT INTO rooms (room_key, kind, domain, title)
--   VALUES ($1, $2, $3, $4)
--   ON CONFLICT (room_key) DO UPDATE SET title = COALESCE(rooms.title, EXCLUDED.title)
--   RETURNING id, is_locked;
--
-- Effective ban check (global + per-room, single query):
--   SELECT
--     COALESCE(bool_or(um.is_banned AND (um.banned_until IS NULL OR um.banned_until > now())), false)
--     OR COALESCE(bool_or(rr.role = 'banned' AND (rr.expires_at IS NULL OR rr.expires_at > now())), false)
--       AS blocked
--   FROM (SELECT $1::text AS uid) x
--   LEFT JOIN user_moderation um ON um.user_id = x.uid
--   LEFT JOIN room_roles rr ON rr.user_id = x.uid AND rr.room_id = $2;
-- ---------------------------------------------------------------------------
