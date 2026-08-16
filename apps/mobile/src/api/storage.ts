/**
 * Storage behind an interface.
 *
 * The point is testability. AsyncStorage only exists inside React Native, so a
 * data layer that imports it directly can only be tested in a simulator — which
 * in practice means it never gets tested at all. With this seam, the client and
 * the outbox are plain TypeScript and run under `node --test` against the real
 * API.
 */
export interface Storage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** For tests, and for the first render before AsyncStorage has loaded. */
export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  async get(key: string) { return this.map.get(key) ?? null; }
  async set(key: string, value: string) { this.map.set(key, value); }
  async remove(key: string) { this.map.delete(key); }
}

/**
 * A crash between two writes must not leave the outbox half-written, so callers
 * that update several keys together go through this. It is not a real
 * transaction — AsyncStorage has none — but it keeps the ordering deliberate
 * rather than accidental.
 */
export async function writeAll(storage: Storage, entries: [string, string][]) {
  for (const [k, v] of entries) await storage.set(k, v);
}
