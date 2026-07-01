import { pino } from 'pino';
import { env } from './env.js';

const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  base: { node: env.NODE_ID },
  // Pretty logs in dev only; JSON in prod for log aggregation.
  transport: isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
