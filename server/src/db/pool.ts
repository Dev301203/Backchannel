import pg from 'pg';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * One shared connection pool per process. Point DATABASE_URL at pgbouncer
 * (transaction pooling) in production so thousands of app connections collapse
 * onto a small set of real Postgres backends.
 *
 * Note: with pgbouncer transaction pooling, prepared statements and
 * session-level features don't persist across queries — the simple
 * text-protocol queries we use here are safe.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: `backchannel:${env.NODE_ID}`,
});

pool.on('error', (err) => {
  // Idle client errors shouldn't crash the process.
  logger.error({ err }, 'postgres idle client error');
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
