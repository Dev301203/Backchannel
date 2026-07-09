import express, { type Request, type Response, type NextFunction } from 'express';
import { pinoHttp } from 'pino-http';
import { toNodeHandler } from 'better-auth/node';
import { z } from 'zod';
import dns from 'node:dns/promises';
import { auth } from './auth/auth.js';
import { env, socialEnabled } from './env.js';
import { logger } from './logger.js';
import { query } from './db/pool.js';
import { identityFromHeaders, type Identity } from './auth/session.js';
import { getRoomByKey, getRecentMessages, isValidRoomKey } from './db/rooms.js';
import { randomHandle } from './auth/handles.js';

/** Attach the resolved identity (if any) to res.locals. */
interface Locals {
  identity: Identity | null;
}

function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && env.TRUSTED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    // Public reads (history) can be fetched by anyone, without credentials.
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization',
  );
  // Let the extension read the bearer token Better Auth returns on sign-in.
  res.setHeader('Access-Control-Expose-Headers', 'set-auth-token');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const identity = await identityFromHeaders(req.headers);
  if (!identity) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  (res.locals as Locals).identity = identity;
  next();
}

const asyncH =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(pinoHttp({ logger }));
  app.use(cors);

  // -- Better Auth: mounts /api/auth/* (sign-in/anonymous, social, session,
  //    sign-out, etc). MUST be registered before express.json() so it can read
  //    the raw request body itself.
  app.all('/api/auth/*', toNodeHandler(auth));

  app.use(express.json({ limit: '16kb' }));

  // -- Public auth capabilities (which sign-in methods are configured) ------
  app.get('/auth/config', (_req, res) => {
    res.json({
      social: [
        ...(socialEnabled.google ? ['google'] : []),
        ...(socialEnabled.github ? ['github'] : []),
        ...(socialEnabled.discord ? ['discord'] : []),
        ...(socialEnabled.apple ? ['apple'] : []),
      ],
      emailOTP: true,
    });
  });

  // -- Health ---------------------------------------------------------------
  app.get('/health', (_req, res) => {
    res.json({ ok: true, node: env.NODE_ID });
  });

  // -- Current identity -----------------------------------------------------
  app.get(
    '/me',
    requireAuth,
    asyncH(async (_req, res) => {
      const id = (res.locals as Locals).identity!;
      res.json({
        id: id.id,
        handle: id.handle,
        color: id.displayColor,
        isBanned: id.isBanned,
        isAnonymous: id.isAnonymous,
      });
    }),
  );

  // -- Change display color -------------------------------------------------
  const colorSchema = z.object({
    color: z.number().int().min(0).max(11),
  });
  app.post(
    '/me/color',
    requireAuth,
    asyncH(async (req, res) => {
      const parsed = colorSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_color' });
        return;
      }
      const id = (res.locals as Locals).identity!;
      await query('UPDATE "user" SET "displayColor" = $1, "updatedAt" = now() WHERE id = $2', [
        parsed.data.color,
        id.id,
      ]);
      res.json({ color: parsed.data.color });
    }),
  );

  // -- Change handle --------------------------------------------------------
  const handleSchema = z.object({
    handle: z
      .string()
      .trim()
      .min(3)
      .max(24)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'letters, numbers, _ . - only'),
  });
  app.post(
    '/me/handle',
    requireAuth,
    asyncH(async (req, res) => {
      const parsed = handleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_handle', detail: parsed.error.issues });
        return;
      }
      const id = (res.locals as Locals).identity!;
      await query('UPDATE "user" SET name = $1, "updatedAt" = now() WHERE id = $2', [
        parsed.data.handle,
        id.id,
      ]);
      res.json({ handle: parsed.data.handle });
    }),
  );

  // -- Room history backfill (public read) ----------------------------------
  app.get(
    '/rooms/:roomKey/messages',
    asyncH(async (req, res) => {
      const roomKey = decodeURIComponent(req.params.roomKey ?? '');
      if (!isValidRoomKey(roomKey)) {
        res.status(400).json({ error: 'bad_room' });
        return;
      }
      const limit = Math.min(Number(req.query.limit) || 50, env.MAX_HISTORY);
      const room = await getRoomByKey(roomKey);
      if (!room) {
        res.json([]); // room never created = no history yet
        return;
      }
      res.json(await getRecentMessages(room.id, limit));
    }),
  );

  // -- Report a message -----------------------------------------------------
  const reportSchema = z.object({
    messageId: z.string().uuid(),
    messageCreatedAt: z.number().int().positive(),
    roomKey: z.string(),
    reason: z.enum(['spam', 'harassment', 'hate', 'illegal', 'other']),
    detail: z.string().max(1000).optional(),
  });
  app.post(
    '/reports',
    requireAuth,
    asyncH(async (req, res) => {
      const parsed = reportSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_report' });
        return;
      }
      const id = (res.locals as Locals).identity!;
      const room = await getRoomByKey(parsed.data.roomKey);
      if (!room) {
        res.status(404).json({ error: 'room_not_found' });
        return;
      }
      await query(
        `INSERT INTO reports (message_id, message_created_at, room_id, reporter_id, reason, detail)
         VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6)
         ON CONFLICT (message_id, reporter_id) DO NOTHING`,
        [
          parsed.data.messageId,
          parsed.data.messageCreatedAt,
          room.id,
          id.id,
          parsed.data.reason,
          parsed.data.detail ?? null,
        ],
      );
      res.json({ ok: true });
    }),
  );

  // -- Domain claim: request a challenge ------------------------------------
  app.post(
    '/domains/:domain/claim',
    requireAuth,
    asyncH(async (req, res) => {
      const domain = (req.params.domain ?? '').toLowerCase();
      const id = (res.locals as Locals).identity!;
      const token = `backchannel-verify=${randomHandle()}-${Date.now().toString(36)}`;
      await query(
        `INSERT INTO domain_claims (domain, user_id, method, token)
         VALUES ($1, $2, 'dns_txt', $3)
         ON CONFLICT (domain) DO UPDATE
           SET user_id = EXCLUDED.user_id, token = EXCLUDED.token, verified_at = NULL
           WHERE domain_claims.verified_at IS NULL`,
        [domain, id.id, token],
      );
      res.json({
        domain,
        token,
        instructions: {
          dns_txt: `Add a TXT record on ${domain} with value: ${token}`,
          well_known: `Or serve https://${domain}/.well-known/backchannel.txt containing: ${token}`,
        },
      });
    }),
  );

  // -- Domain claim: verify -------------------------------------------------
  app.post(
    '/domains/:domain/verify',
    requireAuth,
    asyncH(async (req, res) => {
      const domain = (req.params.domain ?? '').toLowerCase();
      const id = (res.locals as Locals).identity!;
      const claim = await query<{ token: string; user_id: string }>(
        'SELECT token, user_id FROM domain_claims WHERE domain = $1',
        [domain],
      );
      const row = claim.rows[0];
      if (!row || row.user_id !== id.id) {
        res.status(404).json({ error: 'no_claim' });
        return;
      }
      const verified = await verifyDomain(domain, row.token);
      if (!verified) {
        res.status(422).json({ error: 'not_verified' });
        return;
      }
      await query('UPDATE domain_claims SET verified_at = now() WHERE domain = $1', [domain]);
      // Grant owner role on the domain room (created lazily if needed).
      await query(
        `INSERT INTO rooms (room_key, kind, domain) VALUES ($1, 'domain', $1)
         ON CONFLICT (room_key) DO NOTHING`,
        [domain],
      );
      await query(
        `INSERT INTO room_roles (room_id, user_id, role, granted_by)
         SELECT id, $2, 'owner', $2 FROM rooms WHERE room_key = $1
         ON CONFLICT (room_id, user_id) DO UPDATE SET role = 'owner'`,
        [domain, id.id],
      );
      res.json({ ok: true, domain });
    }),
  );

  // -- Extension OAuth bridge ----------------------------------------------
  // Better Auth redirects the social login back here (same origin as the auth
  // cookie). We read the fresh bearer token via a same-origin session call and
  // bounce to the extension's chromiumapp.org redirect with #token=..., which
  // resolves chrome.identity.launchWebAuthFlow on the extension side.
  app.get('/ext/callback', (req, res) => {
    const redirect = String(req.query.redirect ?? '');
    // Open-redirect guard: only allow the extension's own redirect origin.
    if (!/^https:\/\/[a-z0-9]+\.chromiumapp\.org\//i.test(redirect)) {
      res.status(400).send('invalid redirect');
      return;
    }
    const safe = JSON.stringify(redirect);
    res.type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Signing in…</title>
<body style="font:14px system-ui;padding:24px">Signing you in…
<script>
(async () => {
  try {
    const r = await fetch('/api/auth/get-session', { credentials: 'include' });
    const token = r.headers.get('set-auth-token') || '';
    location.replace(${safe} + '#token=' + encodeURIComponent(token));
  } catch (e) {
    document.body.textContent = 'Sign-in failed: ' + e;
  }
})();
</script>`,
    );
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'unhandled http error');
    if (!res.headersSent) res.status(500).json({ error: 'internal' });
  });

  return app;
}

async function verifyDomain(domain: string, token: string): Promise<boolean> {
  // Try DNS TXT first.
  try {
    const records = await dns.resolveTxt(domain);
    if (records.some((chunks) => chunks.join('').includes(token))) return true;
  } catch {
    /* fall through to well-known */
  }
  // Then the well-known file.
  try {
    const resp = await fetch(`https://${domain}/.well-known/backchannel.txt`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const text = await resp.text();
      if (text.includes(token)) return true;
    }
  } catch {
    /* not verified */
  }
  return false;
}
