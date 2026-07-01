import { DRIVER } from '../env.js';
import { logger } from '../logger.js';
import type { Drivers } from './types.js';
import { createMemoryDrivers } from './memory.js';
import { createRedisDrivers } from './redis.js';

/**
 * Select the driver once at boot. Everything else imports `bus`, `counters`,
 * and `presence` from here and is oblivious to which implementation is live.
 */
const drivers: Drivers = DRIVER === 'redis' ? createRedisDrivers() : createMemoryDrivers();

logger.info({ driver: DRIVER }, 'fanout/presence driver selected');

export const bus = drivers.bus;
export const counters = drivers.counters;
export const presence = drivers.presence;
export const closeDrivers = drivers.close;
