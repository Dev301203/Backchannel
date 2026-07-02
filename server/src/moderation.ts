import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';
import { counters } from './drivers/index.js';
import { env } from './env.js';

/**
 * Lightweight content moderation. This is the "day one" layer the design calls
 * for — deliberately conservative so it can't be the sole defense:
 *   - hard blocklist (slurs / illegal) → reject outright
 *   - common profanity → censor with asterisks, pass through
 *   - obvious spam heuristics (flooding same char, all-links) → reject
 *   - everything else passes; the report queue + human/volunteer mods handle
 *     the long tail.
 */

// Reject-outright list. Kept small: reserve for slurs and content we don't
// want on the site under any framing. Load from a vetted secret file in prod.
const HARD_BLOCK: RegExp[] = [
  /\bkill\s+your\s*self\b/i,
];

// Common-profanity matcher. `englishDataset` covers the usual list and is
// leet-speak / diacritic aware via `englishRecommendedTransformers`. Built once
// at module load; the matcher is stateless and safe to reuse across requests.
const profanityMatcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});
const profanityCensor = new TextCensor();

const URL_RE = /\bhttps?:\/\/\S+/gi;

export interface ModerationResult {
  ok: boolean;
  reason?: string;
  /** Possibly transformed body (e.g. trimmed or censored). */
  body?: string;
}

export function moderateContent(raw: string): ModerationResult {
  const collapsed = raw.replace(/\s+/g, ' ').trim();

  if (collapsed.length === 0) return { ok: false, reason: 'empty' };
  if (collapsed.length > 500) return { ok: false, reason: 'too_long' };

  for (const re of HARD_BLOCK) {
    if (re.test(collapsed)) return { ok: false, reason: 'blocked' };
  }

  // Flood: same character repeated 15+ times.
  if (/(.)\1{14,}/.test(collapsed)) return { ok: false, reason: 'flood' };

  // All-links spam: message is nothing but 3+ URLs.
  const urls = collapsed.match(URL_RE) ?? [];
  if (urls.length >= 3 && collapsed.replace(URL_RE, '').trim().length < 5) {
    return { ok: false, reason: 'link_spam' };
  }

  const matches = profanityMatcher.getAllMatches(collapsed);
  const body = matches.length > 0
    ? profanityCensor.applyTo(collapsed, matches)
    : collapsed;

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
