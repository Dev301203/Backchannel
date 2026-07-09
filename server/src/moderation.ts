import { counters } from './drivers/index.js';
import { env } from './env.js';

/**
 * Lightweight content moderation. This is the "day one" layer the design calls
 * for — deliberately conservative so it can't be the sole defense:
 *   - hard blocklist (slurs / illegal) → reject outright
 *   - obvious spam heuristics (flooding same char, all-links) → reject
 *   - everything else passes; the report queue + human/volunteer mods handle
 *     the long tail.
 *
 * Common profanity is NOT filtered — rooms are per-website communities and
 * that's a decision each community can make with reports + volunteer mods.
 */

// Reject-outright list. Kept small: reserve for slurs and content we don't
// want on the site under any framing. Load from a vetted secret file in prod.
const HARD_BLOCK: RegExp[] = [
  /\bkill\s+your\s*self\b/i,
];

const URL_RE = /\bhttps?:\/\/\S+/gi;

export interface ModerationResult {
  ok: boolean;
  reason?: string;
  /** Possibly transformed body (e.g. trimmed). */
  body?: string;
}

export function moderateContent(raw: string): ModerationResult {
  const body = raw.replace(/\s+/g, ' ').trim();

  if (body.length === 0) return { ok: false, reason: 'empty' };
  if (body.length > 500) return { ok: false, reason: 'too_long' };

  for (const re of HARD_BLOCK) {
    if (re.test(body)) return { ok: false, reason: 'blocked' };
  }

  // Flood: same character repeated 15+ times.
  if (/(.)\1{14,}/.test(body)) return { ok: false, reason: 'flood' };

  // All-links spam: message is nothing but 3+ URLs.
  const urls = body.match(URL_RE) ?? [];
  if (urls.length >= 3 && body.replace(URL_RE, '').trim().length < 5) {
    return { ok: false, reason: 'link_spam' };
  }

  return { ok: true, body };
}

// ---------------------------------------------------------------------------
// Rate limiting — atomic fixed-window counters via the active driver (in-process
// for memory, Redis INCR+EXPIRE for redis). Two windows: a short burst window
// and a per-minute cap.
// ---------------------------------------------------------------------------
export interface RateResult {
  allowed: boolean;
  retryAfterSec?: number;
}

export async function checkRateLimit(userId: string): Promise<RateResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const shortWindow = Math.floor(nowSec / env.RATE_LIMIT_WINDOW_SEC);
  const minuteWindow = Math.floor(nowSec / 60);

  const shortKey = `rl:s:${userId}:${shortWindow}`;
  const minKey = `rl:m:${userId}:${minuteWindow}`;

  const [shortN, minN] = await Promise.all([
    counters.incr(shortKey, env.RATE_LIMIT_WINDOW_SEC),
    counters.incr(minKey, 60),
  ]);

  if (shortN > env.RATE_LIMIT_MSGS) {
    return { allowed: false, retryAfterSec: env.RATE_LIMIT_WINDOW_SEC };
  }
  if (minN > env.RATE_LIMIT_MSGS_MIN) {
    return { allowed: false, retryAfterSec: 60 - (nowSec % 60) };
  }
  return { allowed: true };
}

/** Reactions are cheaper than messages but still capped: 30 per 10s window. */
export async function checkReactionRateLimit(userId: string): Promise<RateResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const window = Math.floor(nowSec / 10);
  const n = await counters.incr(`rl:react:${userId}:${window}`, 10);
  if (n > 30) return { allowed: false, retryAfterSec: 10 };
  return { allowed: true };
}

/** Typing signals: at most one relayed per 2s per user (cheap dedupe). */
export async function checkTypingRateLimit(userId: string): Promise<boolean> {
  const window = Math.floor(Date.now() / 2000);
  const n = await counters.incr(`rl:typ:${userId}:${window}`, 2);
  return n <= 1;
}
