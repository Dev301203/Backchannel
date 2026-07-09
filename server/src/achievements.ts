import { query } from './db/pool.js';
import { logger } from './logger.js';

/**
 * Gamification engine. Every achievement is "stat >= target" against a row in
 * user_stats, so unlock checks are uniform: bump the counters, compare the
 * returned row against the catalog, batch-insert whatever newly qualifies
 * (ON CONFLICT DO NOTHING RETURNING tells us which ones are actually new).
 *
 * The catalog is served to the client at GET /achievements so the extension
 * renders titles/emoji/progress from one source of truth.
 */

export type StatKey =
  | 'messages_sent'
  | 'rooms_posted'
  | 'rooms_pioneered'
  | 'replies_received'
  | 'reactions_received'
  | 'reactions_given'
  | 'night_messages'
  | 'best_streak';

export interface AchievementDef {
  id: string;
  emoji: string;
  title: string;
  desc: string;
  stat: StatKey;
  target: number;
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'first-words',    emoji: '👋', title: 'First words',     desc: 'Send your first message',            stat: 'messages_sent',      target: 1 },
  { id: 'chatterbox',     emoji: '💬', title: 'Chatterbox',      desc: 'Send 100 messages',                  stat: 'messages_sent',      target: 100 },
  { id: 'town-crier',     emoji: '📣', title: 'Town crier',      desc: 'Send 1,000 messages',                stat: 'messages_sent',      target: 1000 },
  { id: 'explorer',       emoji: '🧭', title: 'Explorer',        desc: 'Post in 10 different rooms',         stat: 'rooms_posted',       target: 10 },
  { id: 'globetrotter',   emoji: '🌍', title: 'Globetrotter',    desc: 'Post in 50 different rooms',         stat: 'rooms_posted',       target: 50 },
  { id: 'pioneer',        emoji: '🚩', title: 'Pioneer',         desc: 'Be the first to speak in a room',    stat: 'rooms_pioneered',    target: 1 },
  { id: 'founder',        emoji: '🏘️', title: 'Founder',         desc: 'Start the conversation in 10 rooms', stat: 'rooms_pioneered',    target: 10 },
  { id: 'magnet',         emoji: '🧲', title: 'Magnet',          desc: 'Receive 10 replies',                 stat: 'replies_received',   target: 10 },
  { id: 'crowd-pleaser',  emoji: '✨', title: 'Crowd pleaser',   desc: 'Collect 25 reactions',               stat: 'reactions_received', target: 25 },
  { id: 'beloved',        emoji: '💖', title: 'Beloved',         desc: 'Collect 100 reactions',              stat: 'reactions_received', target: 100 },
  { id: 'cheerleader',    emoji: '🎉', title: 'Cheerleader',     desc: 'Give 50 reactions',                  stat: 'reactions_given',    target: 50 },
  { id: 'regular',        emoji: '🔥', title: 'Regular',         desc: 'Chat 3 days in a row',               stat: 'best_streak',        target: 3 },
  { id: 'devoted',        emoji: '⚡', title: 'Devoted',         desc: 'Chat 7 days in a row',               stat: 'best_streak',        target: 7 },
  { id: 'night-owl',      emoji: '🦉', title: 'Night owl',       desc: 'Post in the dead of night (UTC)',    stat: 'night_messages',     target: 1 },
] as const;

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function achievementById(id: string | null | undefined): AchievementDef | null {
  return (id && BY_ID.get(id)) || null;
}

export type Stats = Record<StatKey, number> & { streak_days: number };

interface StatsRow {
  messages_sent: number;
  rooms_posted: number;
  rooms_pioneered: number;
  replies_received: number;
  reactions_received: number;
  reactions_given: number;
  night_messages: number;
  streak_days: number;
  best_streak: number;
}

/** Compare a stats row against the catalog and persist any newly earned ids. */
async function awardFromStats(userId: string, stats: StatsRow): Promise<AchievementDef[]> {
  const qualified = ACHIEVEMENTS.filter((a) => (stats[a.stat] ?? 0) >= a.target).map((a) => a.id);
  if (qualified.length === 0) return [];
  const res = await query<{ achievement: string }>(
    `INSERT INTO user_achievements (user_id, achievement)
     SELECT $1, unnest($2::text[])
     ON CONFLICT DO NOTHING
     RETURNING achievement`,
    [userId, qualified],
  );
  return res.rows.map((r) => BY_ID.get(r.achievement)!).filter(Boolean);
}

/**
 * Record a sent message: dedupe the room into user_rooms, bump every affected
 * counter (streak logic lives in the upsert), then award. Two-three cheap
 * queries on the send path; failures are logged and swallowed so gamification
 * can never take chat down with it.
 */
export async function recordMessage(
  userId: string,
  roomId: string,
  wasFirstInRoom: boolean,
): Promise<AchievementDef[]> {
  try {
    const roomIns = await query(
      `INSERT INTO user_rooms (user_id, room_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, roomId],
    );
    const newRoom = (roomIns.rowCount ?? 0) > 0 ? 1 : 0;
    const pioneered = wasFirstInRoom ? 1 : 0;
    const hourUtc = new Date().getUTCHours();
    const night = hourUtc < 5 ? 1 : 0;

    const res = await query<StatsRow>(
      `INSERT INTO user_stats AS s
         (user_id, messages_sent, rooms_posted, rooms_pioneered, night_messages,
          streak_days, best_streak, last_active_date)
       VALUES ($1, 1, $2, $3, $4, 1, 1, CURRENT_DATE)
       ON CONFLICT (user_id) DO UPDATE SET
         messages_sent   = s.messages_sent + 1,
         rooms_posted    = s.rooms_posted + $2,
         rooms_pioneered = s.rooms_pioneered + $3,
         night_messages  = s.night_messages + $4,
         streak_days = CASE
           WHEN s.last_active_date = CURRENT_DATE THEN s.streak_days
           WHEN s.last_active_date = CURRENT_DATE - 1 THEN s.streak_days + 1
           ELSE 1 END,
         best_streak = GREATEST(s.best_streak, CASE
           WHEN s.last_active_date = CURRENT_DATE THEN s.streak_days
           WHEN s.last_active_date = CURRENT_DATE - 1 THEN s.streak_days + 1
           ELSE 1 END),
         last_active_date = CURRENT_DATE,
         updated_at = now()
       RETURNING messages_sent, rooms_posted, rooms_pioneered, replies_received,
                 reactions_received, reactions_given, night_messages,
                 streak_days, best_streak`,
      [userId, newRoom, pioneered, night],
    );
    return awardFromStats(userId, res.rows[0]!);
  } catch (err) {
    logger.warn({ err, userId }, 'recordMessage stats failed');
    return [];
  }
}

const BUMPABLE: ReadonlySet<StatKey> = new Set([
  'replies_received',
  'reactions_received',
  'reactions_given',
]);

/** Bump a single passive counter (reply/reaction credit) and award. */
export async function bumpStat(
  userId: string,
  stat: StatKey,
  delta = 1,
): Promise<AchievementDef[]> {
  if (!BUMPABLE.has(stat)) throw new Error(`stat not bumpable: ${stat}`);
  try {
    // Column name is interpolated but comes from the whitelist above.
    const res = await query<StatsRow>(
      `INSERT INTO user_stats AS s (user_id, ${stat})
       VALUES ($1, GREATEST($2, 0))
       ON CONFLICT (user_id) DO UPDATE SET
         ${stat} = GREATEST(s.${stat} + $2, 0),
         updated_at = now()
       RETURNING messages_sent, rooms_posted, rooms_pioneered, replies_received,
                 reactions_received, reactions_given, night_messages,
                 streak_days, best_streak`,
      [userId, delta],
    );
    if (delta <= 0) return []; // decrements can't unlock anything
    return awardFromStats(userId, res.rows[0]!);
  } catch (err) {
    logger.warn({ err, userId, stat }, 'bumpStat failed');
    return [];
  }
}

export interface ProfileStats extends StatsRow {
  display_badge: string | null;
}

export async function getStats(
  userId: string,
): Promise<{ stats: ProfileStats; earned: { id: string; earnedAt: number }[] }> {
  const [statsRes, earnedRes] = await Promise.all([
    query<ProfileStats>(
      `SELECT messages_sent, rooms_posted, rooms_pioneered, replies_received,
              reactions_received, reactions_given, night_messages,
              streak_days, best_streak, display_badge
         FROM user_stats WHERE user_id = $1`,
      [userId],
    ),
    query<{ achievement: string; earned_at: Date }>(
      'SELECT achievement, earned_at FROM user_achievements WHERE user_id = $1 ORDER BY earned_at',
      [userId],
    ),
  ]);
  const stats: ProfileStats = statsRes.rows[0] ?? {
    messages_sent: 0,
    rooms_posted: 0,
    rooms_pioneered: 0,
    replies_received: 0,
    reactions_received: 0,
    reactions_given: 0,
    night_messages: 0,
    streak_days: 0,
    best_streak: 0,
    display_badge: null,
  };
  return {
    stats,
    earned: earnedRes.rows
      .filter((r) => BY_ID.has(r.achievement))
      .map((r) => ({ id: r.achievement, earnedAt: r.earned_at.getTime() })),
  };
}

/** Set (or clear) the badge shown next to the user's handle. Must be earned. */
export async function setDisplayBadge(
  userId: string,
  badgeId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (badgeId !== null) {
    if (!BY_ID.has(badgeId)) return { ok: false, error: 'unknown_badge' };
    const earned = await query(
      'SELECT 1 FROM user_achievements WHERE user_id = $1 AND achievement = $2',
      [userId, badgeId],
    );
    if (earned.rowCount === 0) return { ok: false, error: 'not_earned' };
  }
  await query(
    `INSERT INTO user_stats (user_id, display_badge) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET display_badge = $2, updated_at = now()`,
    [userId, badgeId],
  );
  return { ok: true };
}
