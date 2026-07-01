/**
 * One-shot migrator. Idempotent — safe to run on every deploy.
 *
 * Steps:
 *   1. Run Better Auth's own migrations (creates/updates user/session/account/
 *      verification + the displayColor additional field).
 *   2. Apply our application schema (schema.sql at the repo root).
 *   3. Ensure this month's + next month's message partitions exist.
 *
 * Usage:  npm run migrate
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool, query, closePool } from './pool.js';
import { auth } from '../auth/auth.js';
import { logger } from '../logger.js';
import { ensureUpcomingPartitions } from './partitions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/src/db -> repo root
const SCHEMA_PATH = resolve(__dirname, '../../../schema.sql');

async function runBetterAuthMigrations(): Promise<void> {
  try {
    // getMigrations is the same entrypoint the Better Auth CLI uses.
    const mod = (await import('better-auth/db/migration')) as {
      getMigrations?: (opts: unknown) => Promise<{ runMigrations: () => Promise<void> }>;
    };
    if (!mod.getMigrations) throw new Error('getMigrations not exported');
    const { runMigrations } = await mod.getMigrations((auth as unknown as { options: unknown }).options);
    await runMigrations();
    logger.info('better-auth migrations applied');
  } catch (err) {
    logger.warn(
      { err },
      'could not run better-auth migrations programmatically; ' +
        'run `npx @better-auth/cli@latest migrate` against DATABASE_URL instead',
    );
  }
}

async function applyAppSchema(): Promise<void> {
  const sql = await readFile(SCHEMA_PATH, 'utf8');
  await query(sql);
  logger.info('application schema applied');
}

async function main(): Promise<void> {
  logger.info('starting migration');
  await runBetterAuthMigrations();
  await applyAppSchema();
  await ensureUpcomingPartitions();
  logger.info('ensured message partitions');
  logger.info('migration complete');
}

main()
  .catch((err) => {
    logger.error({ err }, 'migration failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => void pool);
  });
