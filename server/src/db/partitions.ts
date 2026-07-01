import { query } from './pool.js';
import { logger } from '../logger.js';

/**
 * Ensure the current + next month's `messages` partitions exist. Idempotent.
 * Called by the migrator and by an in-app daily scheduler, so you don't need a
 * separate cron on the free tier. For production, pg_partman is a fine upgrade.
 */
export async function ensureUpcomingPartitions(): Promise<void> {
  const now = new Date();
  const months = [
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  ];
  for (const d of months) {
    const iso = d.toISOString().slice(0, 10);
    await query('SELECT ensure_month_partition($1::date)', [iso]);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startPartitionScheduler(): void {
  const tick = async () => {
    try {
      await ensureUpcomingPartitions();
    } catch (err) {
      logger.warn({ err }, 'partition scheduler tick failed');
    }
  };
  void tick();
  // Once a day is plenty; partitions are monthly.
  timer = setInterval(() => void tick(), 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
}

export function stopPartitionScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
