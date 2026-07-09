import { betterAuth } from 'better-auth';
import { anonymous, bearer, emailOTP } from 'better-auth/plugins';
import { env, socialEnabled } from '../env.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * Auth is fully delegated to Better Auth — the "does everything" library the
 * design called for. We turn on three capabilities:
 *
 *   - anonymous(): the pseudonymous handles from the design. A brand-new user
 *     gets a real session with zero friction (no email, no password). They can
 *     later "upgrade" that same account by linking Google/GitHub — Better Auth
 *     migrates the anonymous user into the social account automatically.
 *
 *   - social providers (google/github/discord/apple): optional OAuth, enabled
 *     only when the client id/secret are present.
 *
 *   - emailOTP(): passwordless 6-digit code login — ideal for extensions
 *     because the OTP round-trips through the sidebar UI (no redirect).
 *     In dev the code is logged to the server console; wire a real transport
 *     in sendVerificationOTP for production.
 *
 *   - bearer(): critical for a browser extension. Extension contexts make
 *     first-party cookies awkward, so we issue a session TOKEN that the
 *     extension stores in chrome.storage.local and presents as
 *     `Authorization: Bearer <token>` (HTTP) or `?token=<token>` (WebSocket).
 *
 * Better Auth owns the identity tables (`user`, `session`, `account`,
 * `verification`). Our app tables reference `user.id` (text) — see schema.sql.
 * We add `displayColor` as an additional field so the UI can color handles.
 */
export const auth = betterAuth({
  appName: 'Backchannel',
  database: pool,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',
  trustedOrigins: env.TRUSTED_ORIGINS,

  // We don't use email/password — identity is anonymous or social only.
  emailAndPassword: { enabled: false },

  socialProviders: {
    ...(socialEnabled.google
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
    ...(socialEnabled.github
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
          },
        }
      : {}),
    ...(socialEnabled.discord
      ? {
          discord: {
            clientId: env.DISCORD_CLIENT_ID,
            clientSecret: env.DISCORD_CLIENT_SECRET,
          },
        }
      : {}),
    ...(socialEnabled.apple
      ? {
          apple: {
            clientId: env.APPLE_CLIENT_ID,
            clientSecret: env.APPLE_CLIENT_SECRET,
          },
        }
      : {}),
  },

  user: {
    additionalFields: {
      // Palette index 0..11 the client maps to a color. Server-assigned only.
      displayColor: {
        type: 'number',
        required: false,
        input: false,
        defaultValue: () => Math.floor(Math.random() * 12),
      },
    },
  },

  session: {
    // Long-lived so ambient presence survives days of not opening the panel.
    expiresIn: 60 * 60 * 24 * 60, // 60 days
    updateAge: 60 * 60 * 24, // refresh once/day
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },

  advanced: {
    // Extension traffic is cross-site relative to the API host.
    defaultCookieAttributes: { sameSite: 'none', secure: true },
  },

  plugins: [
    anonymous({
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        logger.info(
          { from: anonymousUser.user.id, to: newUser.user.id },
          'anonymous account upgraded to social',
        );
      },
    }),
    // Passwordless email login via 6-digit OTP. Works well from a browser
    // extension because the code round-trips through the extension UI — no
    // magic-link redirect dance. In dev, sendVerificationOTP just logs the
    // code to the server console; wire a real transport (Resend / Postmark /
    // SendGrid / SMTP) here for production.
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        logger.info(
          { email, otp, type },
          '📧 email OTP (dev mode — replace sendVerificationOTP with a real transport for prod)',
        );
      },
    }),
    // bearer() must be able to read tokens; it also exposes them in the
    // `set-auth-token` response header on sign-in so the extension can capture.
    bearer(),
  ],
});

export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
