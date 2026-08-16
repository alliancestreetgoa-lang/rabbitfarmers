import type { Storage } from './storage.ts';
import { MemoryStorage } from './storage.ts';
import type {
  Animal, Breed, BuckSuggestion, Cage, DailyItem, MatingSchedule, OpenCondition,
  PregnancySummary, PregnantDoe, ReadyDoe, Session, Subscription,
} from './types.ts';

const TOKEN_KEY = 'rb.token';
const SESSION_KEY = 'rb.session';
const CACHE_PREFIX = 'rb.cache.';

export class ApiError extends Error {
  // Written out rather than using constructor parameter properties: Node can
  // run these files directly with --experimental-strip-types, which only
  // removes types and cannot generate the assignments those imply. Being
  // runnable in Node is what lets the data layer be tested against the real
  // API instead of a mock.
  readonly status: number;
  readonly detail?: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
  /** 4xx that will never succeed on retry — do not keep it in the outbox. */
  get isPermanent() {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
  get isAuth() { return this.status === 401; }
  /** Subscription lapsed. Reads still work; only new records are blocked. */
  get isReadOnly() { return this.status === 402; }
}

/** No signal, DNS failure, Neon still waking up. Always worth retrying. */
export class OfflineError extends Error {
  readonly reason?: unknown;

  constructor(reason?: unknown) {
    super('No connection');
    this.name = 'OfflineError';
    this.reason = reason;
  }
}

export interface ClientOptions {
  baseUrl: string;
  storage?: Storage;
  fetchImpl?: typeof fetch;
  /** Called when the server rejects our token, so the UI can send them to sign-in. */
  onSignedOut?: () => void;
  timeoutMs?: number;
}

export class ApiClient {
  readonly baseUrl: string;
  private storage: Storage;
  private fetchImpl: typeof fetch;
  private onSignedOut?: () => void;
  private timeoutMs: number;
  private token: string | null = null;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.storage = opts.storage ?? new MemoryStorage();
    // .bind matters. In a browser, fetch must be invoked with window as its
    // receiver — storing it on a field and calling this.fetchImpl(...) throws
    // "Illegal invocation". Node does not care, so this passes every Node test
    // and then fails on every single request in a browser, surfacing as
    // "no connection" because the throw looks exactly like a network failure.
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onSignedOut = opts.onSignedOut;
    // Generous: Neon suspends idle computes and the first request of the
    // morning pays the wake-up cost. Too tight here and the app looks broken
    // exactly when a farmer opens it at 6am.
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async loadSession(): Promise<Session | null> {
    this.token = await this.storage.get(TOKEN_KEY);
    const raw = await this.storage.get(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  }

  private async setSession(s: Session) {
    this.token = s.token;
    await this.storage.set(TOKEN_KEY, s.token);
    await this.storage.set(SESSION_KEY, JSON.stringify(s));
  }

  async clearSession() {
    this.token = null;
    await this.storage.remove(TOKEN_KEY);
    await this.storage.remove(SESSION_KEY);
  }

  get isSignedIn() { return this.token !== null; }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // fetch only rejects on network-level failure, which is exactly the case
      // worth queueing rather than surfacing as an error.
      throw new OfflineError(err);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

    if (!res.ok) {
      if (res.status === 401) {
        await this.clearSession();
        this.onSignedOut?.();
      }
      throw new ApiError(res.status, json?.error ?? `Request failed (${res.status})`, json?.detail);
    }
    return json as T;
  }

  /* ------------------------------------------------------------------ auth */

  async signUp(input: {
    farm_name: string; full_name: string; email: string; phone: string;
    password: string; address_line?: string; city?: string; state?: string;
    pincode?: string;
  }): Promise<Session> {
    const s = await this.request<Session>('POST', '/auth/signup', input, { auth: false });
    await this.setSession(s);
    return s;
  }

  async signIn(email: string, password: string): Promise<Session> {
    const s = await this.request<Session>(
      'POST', '/auth/signin', { email, password }, { auth: false });
    await this.setSession(s);
    return s;
  }

  /**
   * Sign out clears the device even if the server call fails.
   *
   * Otherwise a farm hand handing the phone over on a patchy connection stays
   * signed in, which is worse than an orphaned server-side session.
   */
  async signOut(everywhere = false) {
    try {
      await this.request('POST', `/auth/signout${everywhere ? '?all=1' : ''}`);
    } catch { /* best effort */ }
    await this.clearSession();
  }

  me() {
    return this.request<{
      user: { id: string; name: string; role: string };
      farm: { id: string; name: string; timezone: string };
      subscription: Subscription;
    }>('GET', '/auth/me');
  }

  /* ------------------------------------------------------------------ read */

  daily() {
    return this.request<{ date: string; open: number; items: DailyItem[] }>('GET', '/daily');
  }

  pregnant() {
    return this.request<{ summary: PregnancySummary; does: PregnantDoe[] }>('GET', '/pregnant');
  }

  readyToMate() {
    return this.request<{ ready: ReadyDoe[] }>('GET', '/ready-to-mate');
  }

  animals(params: { sex?: string; role?: string; q?: string } = {}) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
    return this.request<{ animals: Animal[] }>('GET', `/animals${qs ? `?${qs}` : ''}`);
  }

  suggestBucks(doeId: string) {
    return this.request<{ bucks: BuckSuggestion[] }>(
      'GET', `/bucks/suggest?doe_id=${encodeURIComponent(doeId)}`);
  }

  conditions() {
    return this.request<{ open: OpenCondition[]; clusters: unknown[] }>('GET', '/conditions');
  }

  breeds() {
    return this.request<{ breeds: Breed[] }>('GET', '/breeds');
  }

  cages() {
    return this.request<{ cages: Cage[] }>('GET', '/cages');
  }

  notifications(unreadOnly = false) {
    return this.request<{ notifications: any[]; unread: number }>(
      'GET', `/notifications${unreadOnly ? '?unread=1' : ''}`);
  }

  /* ----------------------------------------------------------------- write */

  addAnimal(input: {
    id?: string; name: string; sex: string; role?: string;
    date_of_birth?: string; dam_id?: string; sire_id?: string; tag?: string;
    /** Pick an existing breed, or name one and the server creates it. */
    breed_id?: string; breed_name?: string;
    /** Pick an existing cage, or write what is painted on it. */
    cage_id?: string; cage_code?: string;
  }) {
    return this.request<{ animal: Animal }>('POST', '/animals', input);
  }

  recordMating(input: {
    id?: string; doe_id: string; buck_id?: string; mated_at?: string;
    service_count?: number; receptivity?: string; notes?: string;
  }) {
    return this.request<{ mating: { id: string; mated_at: string; schedule: MatingSchedule } }>(
      'POST', '/matings', input);
  }

  recordPregnancyCheck(input: {
    id?: string; mating_id: string; result: 'positive' | 'negative' | 'uncertain';
    checked_on?: string; notes?: string;
  }) {
    return this.request<{ check: { id: string; result: string } }>(
      'POST', '/pregnancy-checks', input);
  }

  recordKindling(input: {
    id?: string; doe_id: string; mating_id?: string; kindled_on?: string;
    born_alive?: number; born_dead?: number; notes?: string;
  }) {
    return this.request<{ litter: { id: string; kindled_on: string; schedule: unknown } }>(
      'POST', '/litters', input);
  }

  recordWeaning(litterId: string, input: {
    weaned_on?: string; weaned_count?: number; avg_weaning_weight_g?: number;
  }) {
    return this.request<{ litter: unknown }>('POST', `/litters/${litterId}/wean`, input);
  }

  reportCondition(input: {
    id?: string; rabbit_id?: string; litter_id?: string; code?: string;
    severity?: string; notes?: string;
    /** When it was seen, if that is not now. Starts the reminder clock. */
    observed_at?: string;
  }) {
    return this.request<{ condition: { id: string } }>('POST', '/conditions', input);
  }

  checkCondition(conditionId: string, status: 'ongoing' | 'improving' | 'worse' | 'stopped',
                 note?: string) {
    return this.request<{ resolved: boolean; message: string }>(
      'POST', `/conditions/${conditionId}/check`, { status, note });
  }

  markNotificationsRead(id?: string) {
    return this.request<{ marked_read: number }>('POST', '/notifications/read', { id });
  }

  /* ----------------------------------------------------------------- cache */

  /**
   * Last good response for a screen, so opening the app in a shed with no
   * signal shows yesterday's list rather than a spinner and an error.
   */
  async cacheRead<T>(key: string): Promise<{ data: T; at: string } | null> {
    const raw = await this.storage.get(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  }

  async cacheWrite(key: string, data: unknown) {
    await this.storage.set(CACHE_PREFIX + key,
      JSON.stringify({ data, at: new Date().toISOString() }));
  }

  /** Fetch and cache; fall back to the cache when offline. */
  async cached<T>(key: string, fetcher: () => Promise<T>):
    Promise<{ data: T; stale: boolean; at: string }> {
    try {
      const data = await fetcher();
      await this.cacheWrite(key, data);
      return { data, stale: false, at: new Date().toISOString() };
    } catch (err) {
      if (err instanceof OfflineError) {
        const hit = await this.cacheRead<T>(key);
        if (hit) return { data: hit.data, stale: true, at: hit.at };
      }
      throw err;
    }
  }
}
