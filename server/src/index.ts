import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { env } from './env.js';
import { logger } from './logger.js';
import { createApp } from './http.js';
import { attachWebSocket } from './ws.js';
import { startPresenceHeartbeat, stopPresence } from './presence.js';
import { closeDrivers } from './drivers/index.js';
import { closePool } from './db/pool.js';
import { startPartitionScheduler, stopPartitionScheduler } from './db/partitions.js';

const app = createApp();
const server = createServer(app);

// WebSocket shares the HTTP port, served at /socket (matches the extension).
const wss = new WebSocketServer({ server, path: '/socket', maxPayload: 16 * 1024 });
attachWebSocket(wss);

startPresenceHeartbeat();
startPartitionScheduler();

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, node: env.NODE_ID }, 'backchannel server listening');
});

// ---------------------------------------------------------------------------
// Graceful shutdown: stop accepting, drain sockets, release Redis/PG, clear
// this node's presence contributions so rooms don't show ghosts.
// ---------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const timeout = setTimeout(() => {
    logger.warn('forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000);

  try {
    for (const client of wss.clients) client.close(1001, 'server shutting down');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    stopPartitionScheduler();
    await stopPresence();
    await closeDrivers();
    await closePool();
    clearTimeout(timeout);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void shutdown(sig));
}
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  void shutdown('uncaughtException');
});
