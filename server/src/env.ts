import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Central, validated configuration. Fail fast at boot if something critical
 * is missing rather than discovering it on the first request.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().nonnegative());

const schema = z.object({
  PORT: int(8080),
  NODE_ID: z
    .string()
    .optional()
    .transform((v) => (v && v.length ? v : `node-${randomUUID().slice(0, 8)}`)),
  BASE_URL: z.string().url().default('http://localhost:8080'),

  DATABASE_URL: z.string().min(1),
  // Optional: only needed when PUBSUB_DRIVER=redis (the default when it's set).
  REDIS_URL: z.string().optional().default(''),
  // 'memory'  = single-instance, in-process fanout/presence/rate-limit (free tier).
  // 'redis'   = multi-instance fanout via Redis pub/sub.
  // Unset     = auto: redis if REDIS_URL is present, else memory.
  PUBSUB_DRIVER: z.enum(['memory', 'redis']).optional(),
  USE_SHARDED_PUBSUB: bool(false),

  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:8080'),
  TRUSTED_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GITHUB_CLIENT_ID: z.string().optional().default(''),
  GITHUB_CLIENT_SECRET: z.string().optional().default(''),
  DISCORD_CLIENT_ID: z.string().optional().default(''),
  DISCORD_CLIENT_SECRET: z.string().optional().default(''),
  // Apple wants a Services ID as clientId and a pre-signed JWT as clientSecret.
  // See https://www.better-auth.com/docs/authentication/apple for how to mint
  // the JWT from your Apple team id + key id + p8 private key.
  APPLE_CLIENT_ID: z.string().optional().default(''),
  APPLE_CLIENT_SECRET: z.string().optional().default(''),

  RATE_LIMIT_MSGS: int(5),
  RATE_LIMIT_WINDOW_SEC: int(5),
  RATE_LIMIT_MSGS_MIN: int(30),
  MAX_HISTORY: int(100),

  PRESENCE_HEARTBEAT_MS: int(15000),
  PRESENCE_TTL_SEC: int(45),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    'Invalid environment configuration:\n',
    JSON.stringify(parsed.error.issues, null, 2),
  );
  process.exit(1);
}

export const env = parsed.data;

/**
 * Resolved driver for fanout/presence/rate-limiting. This is the single switch
 * that decides "in-process" vs "Redis" — flip it (or set REDIS_URL) and nothing
 * else in the code changes. Same interface, config only.
 */
export const DRIVER: 'memory' | 'redis' =
  env.PUBSUB_DRIVER ?? (env.REDIS_URL ? 'redis' : 'memory');

if (DRIVER === 'redis' && !env.REDIS_URL) {
  // eslint-disable-next-line no-console
  console.error('PUBSUB_DRIVER=redis requires REDIS_URL to be set.');
  process.exit(1);
}

export const socialEnabled = {
  google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  discord: Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),
  apple: Boolean(env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET),
};
