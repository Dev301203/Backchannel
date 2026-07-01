/**
 * Driver interfaces. Everything that differs between "single in-process node"
 * and "many nodes coordinated through Redis" lives behind these three
 * interfaces. Selecting a driver is a config decision (PUBSUB_DRIVER / DRIVER);
 * no call site changes when you flip it.
 */

/** Cross-node message fanout (chat + presence frames ride this). */
export interface Bus {
  /** Channel name for a room key (driver-specific encoding). */
  roomChannel(roomKey: string): string;
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  /** Register the single process-wide message handler. */
  onMessage(handler: (channel: string, message: string) => void): void;
}

/** Atomic fixed-window counters for rate limiting. */
export interface Counters {
  /** Increment `key`, set TTL on first hit, return the new count. */
  incr(key: string, ttlSec: number): Promise<number>;
}

/** Presence bookkeeping ("N people here"), aggregated across nodes. */
export interface PresenceStore {
  setRoomCount(roomKey: string, nodeId: string, count: number): Promise<void>;
  clearRoomNode(roomKey: string, nodeId: string): Promise<void>;
  /** Total live participants in a room across all nodes. */
  roomTotal(roomKey: string): Promise<number>;
  /** Keep this node marked live and re-assert its per-room counts. */
  heartbeat(nodeId: string, localCounts: ReadonlyMap<string, number>): Promise<void>;
  /** Remove this node's contributions on graceful shutdown. */
  removeNode(nodeId: string, localCounts: ReadonlyMap<string, number>): Promise<void>;
}

export interface Drivers {
  bus: Bus;
  counters: Counters;
  presence: PresenceStore;
  close(): Promise<void>;
}
