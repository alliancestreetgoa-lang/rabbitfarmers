import type { Storage } from './storage.ts';
import { ApiClient, ApiError, OfflineError } from './client.ts';

const OUTBOX_KEY = 'rb.outbox';

export type OutboxKind =
  | 'animal' | 'mating' | 'pregnancy_check' | 'kindling' | 'weaning'
  | 'condition' | 'condition_check';

export interface OutboxEntry {
  /** Client-generated. Sent as the record's id, which is what makes replay safe. */
  id: string;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  /** Extra path segment for the endpoints that need one (litter id, condition id). */
  target?: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
  /** Set when the server rejected it outright. Needs a human, not a retry. */
  failed?: boolean;
}

export function newId(): string {
  // crypto.randomUUID exists in Node 22, Hermes with the polyfill, and browsers.
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Last resort; only used if a runtime lacks the API entirely.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * A write queue that survives no signal.
 *
 * This is the whole reason the app can be used in a shed. A mating recorded at
 * the cage must not be lost because the phone had no bars, and it must not be
 * recorded twice when the phone finds signal again.
 *
 * Replay safety comes from the client generating the record's UUID up front.
 * The server accepts it, so replaying a write that actually succeeded (response
 * lost on a flaky connection) hits the primary key and comes back as
 * "already exists" — which the queue treats as success rather than an error.
 */
export class Outbox {
  private entries: OutboxEntry[] = [];
  private loaded = false;
  private flushing = false;
  private client: ApiClient;
  private storage: Storage;
  private onChange?: (entries: OutboxEntry[]) => void;

  constructor(
    client: ApiClient,
    storage: Storage,
    onChange?: (entries: OutboxEntry[]) => void,
  ) {
    this.client = client;
    this.storage = storage;
    this.onChange = onChange;
  }

  async load(): Promise<OutboxEntry[]> {
    if (this.loaded) return this.entries;
    const raw = await this.storage.get(OUTBOX_KEY);
    this.entries = raw ? (JSON.parse(raw) as OutboxEntry[]) : [];
    this.loaded = true;
    return this.entries;
  }

  private async persist() {
    await this.storage.set(OUTBOX_KEY, JSON.stringify(this.entries));
    this.onChange?.([...this.entries]);
  }

  get pending() { return this.entries.filter((e) => !e.failed); }
  get failed() { return this.entries.filter((e) => e.failed); }
  get size() { return this.entries.length; }

  /**
   * Queue a write and try to send it immediately.
   *
   * Returns whether it reached the server. The caller shows "saved" either way
   * — from the farmer's point of view it *is* saved, it is on the phone and it
   * will arrive. Pretending otherwise trains people not to trust the app.
   */
  async enqueue(kind: OutboxKind, payload: Record<string, unknown>, target?: string):
    Promise<{ id: string; sent: boolean }> {
    await this.load();
    const id = (payload.id as string) ?? newId();
    const entry: OutboxEntry = {
      id, kind, payload: { ...payload, id }, target,
      createdAt: new Date().toISOString(), attempts: 0,
    };
    this.entries.push(entry);
    await this.persist();

    const { sent } = await this.flush();
    return { id, sent: sent > 0 || !this.entries.some((e) => e.id === id) };
  }

  /**
   * Send everything queued, oldest first.
   *
   * Order matters: a pregnancy check references a mating, so replaying out of
   * order would fail. One failure stops the pass rather than skipping ahead.
   */
  async flush(): Promise<{ sent: number; remaining: number; offline: boolean }> {
    if (this.flushing) return { sent: 0, remaining: this.pending.length, offline: false };
    this.flushing = true;
    let sent = 0;
    let offline = false;

    try {
      await this.load();
      for (const entry of [...this.entries]) {
        if (entry.failed) continue;
        try {
          await this.send(entry);
          this.entries = this.entries.filter((e) => e.id !== entry.id);
          sent++;
          await this.persist();
        } catch (err) {
          entry.attempts++;
          if (err instanceof OfflineError) {
            // Still no signal. Keep everything and stop — the next item would
            // fail the same way, and later writes may depend on this one.
            offline = true;
            await this.persist();
            break;
          }
          if (err instanceof ApiError) {
            if (err.status === 409) {
              // Already on the server: this is a replay of a write that landed
              // but whose response we never saw. Exactly what the client-side
              // id is for.
              this.entries = this.entries.filter((e) => e.id !== entry.id);
              sent++;
              await this.persist();
              continue;
            }
            if (err.isAuth) { offline = false; await this.persist(); break; }
            if (err.isPermanent) {
              // Bad data, or a subscription that has lapsed. Retrying forever
              // would just burn battery; surface it instead.
              entry.failed = true;
              entry.lastError = err.message;
              await this.persist();
              continue;
            }
          }
          entry.lastError = String((err as Error)?.message ?? err);
          await this.persist();
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
    return { sent, remaining: this.pending.length, offline };
  }

  private send(entry: OutboxEntry) {
    const p = entry.payload as any;
    switch (entry.kind) {
      case 'animal':          return this.client.addAnimal(p);
      case 'mating':          return this.client.recordMating(p);
      case 'pregnancy_check': return this.client.recordPregnancyCheck(p);
      case 'kindling':        return this.client.recordKindling(p);
      case 'weaning':         return this.client.recordWeaning(entry.target!, p);
      case 'condition':       return this.client.reportCondition(p);
      case 'condition_check':
        return this.client.checkCondition(entry.target!, p.status, p.note);
    }
  }

  /** Drop an entry the server refused, once the farmer has seen why. */
  async discard(id: string) {
    await this.load();
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.persist();
  }

  /** Put a failed entry back in the queue, after fixing whatever was wrong. */
  async retry(id: string) {
    await this.load();
    const e = this.entries.find((x) => x.id === id);
    if (e) { e.failed = false; e.attempts = 0; delete e.lastError; }
    await this.persist();
    return this.flush();
  }
}
