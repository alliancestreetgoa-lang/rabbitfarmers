import type { Storage } from './storage.ts';
import { MemoryStorage } from './storage.ts';
import type {
  Animal, Breed, BuckSuggestion, Cage, DailyItem, HistoryEvent, Litter, MatingSchedule,
  MedicationDose, OpenCondition, PregnancySummary, PregnantDoe, RabbitLifetime,
  ReadyDoe,
  Attendance, AttendanceSummary, BillingRow, PayMonth, Session, Shed, Staff, StaffRole, Subscription,
  SupportAccess,
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
  /**
   * Not readonly, because an installed app is told this after it starts.
   *
   * A web build knows the address from the origin that served it. An APK has no
   * origin: unless it was compiled in, the farmer types it on the sign-in
   * screen and it is read back from storage on every launch after that. See
   * setServerUrl in state.tsx.
   */
  baseUrl: string;
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

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/+$/, '');
  }

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

  /**
   * Email or phone, whichever they typed.
   *
   * The owner signed up with an email. A farm hand was given a login by their
   * manager and knows their phone number — docs/04 is right that farm workers
   * reliably have one and often have no email at all.
   */
  async signIn(identifier: string, password: string): Promise<Session> {
    const looksLikeEmail = identifier.includes('@');
    const s = await this.request<Session>('POST', '/auth/signin', {
      ...(looksLikeEmail ? { email: identifier } : { phone: identifier }),
      password,
    }, { auth: false });
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
      support: SupportAccess | null;
    }>('GET', '/auth/me');
  }

  /**
   * Take over a session minted by the admin console.
   *
   * Support does not sign in as the farmer — there is no password to type and
   * nobody would want there to be. The console mints a real farm session bound
   * to a time-boxed, audited impersonation record and hands the token over in a
   * URL fragment; this is the app end of that handover.
   *
   * The token is proved before it is stored. A stale or already-ended one must
   * leave the app exactly as it found it, rather than replacing whatever
   * session was on the device with a dead one.
   */
  async adoptSupportToken(token: string): Promise<Session> {
    // Both, and read before anything is overwritten. A 401 inside request()
    // clears the stored session, so a dead support link would otherwise sign
    // out whoever was already using the device.
    const previousToken = this.token;
    const previousSession = await this.storage.get(SESSION_KEY);
    this.token = token;
    try {
      const me = await this.request<{
        user: { id: string; name: string; role: string };
        farm: { id: string; name: string };
        support: SupportAccess | null;
      }>('GET', '/auth/me');

      const session: Session = {
        token,
        farm: { id: me.farm.id, name: me.farm.name },
        user: { id: me.user.id, name: me.user.name, role: me.user.role },
        support: me.support,
      };
      await this.setSession(session);
      return session;
    } catch (err) {
      this.token = previousToken;
      if (previousToken) await this.storage.set(TOKEN_KEY, previousToken);
      if (previousSession) await this.storage.set(SESSION_KEY, previousSession);
      throw err;
    }
  }

  /* ------------------------------------------------------------------ read */

  /** The farm at a glance — the home screen's one round trip. */
  summary() {
    return this.request<{
      herd: { total: number; bucks: number; does: number; growers: number };
      pregnant: { total_pregnant: number; confirmed_pregnant: number;
        presumed_pregnant: number; due_within_7_days: number };
      ready: { ready: number; overdue: number };
      kits: { unweaned: number; litters_open: number; weaned_total: number };
      health: { open_conditions: number; sick_rabbits: number; doses_due: number };
      today: { open: number; urgent: number };
      team: { staff: number };
    }>('GET', '/summary');
  }

  /** Every litter, newest first, with the doe named. */
  littersList() {
    return this.request<{ litters: {
      id: string; doe_id: string; doe_name: string | null; doe_tag: string;
      kindled_on: string; born_alive: number; born_dead: number;
      weaned_on: string | null; weaned_count: number | null;
      recorded: number | null; not_yet_recorded: number | null;
    }[] }>('GET', '/litters');
  }

  daily() {
    return this.request<{ date: string; open: number; items: DailyItem[] }>('GET', '/daily');
  }

  pregnant() {
    return this.request<{ summary: PregnancySummary; does: PregnantDoe[] }>('GET', '/pregnant');
  }

  readyToMate() {
    return this.request<{ ready: ReadyDoe[] }>('GET', '/ready-to-mate');
  }

  animals(params: {
    sex?: string; role?: string; q?: string;
    /** 'herd' (default) is the living herd; 'past' the ones that have left it. */
    include?: 'herd' | 'past' | 'all';
  } = {}) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
    return this.request<{ animals: Animal[] }>('GET', `/animals${qs ? `?${qs}` : ''}`);
  }

  /** Everything ever recorded about one rabbit. Works after she has gone. */
  history(id: string) {
    return this.request<{
      animal: Animal & { origin: string; dam: string | null; sire: string | null };
      lifetime: RabbitLifetime | null;
      events: HistoryEvent[];
      offspring: Animal[];
    }>('GET', `/animals/${id}/history`);
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

  /* ------------------------------------------------------------------ team */

  staff(include: 'active' | 'past' | 'all' = 'active') {
    return this.request<{ staff: Staff[] }>('GET', `/staff?include=${include}`);
  }

  sheds() {
    return this.request<{ sheds: Shed[] }>('GET', '/sheds');
  }

  addShed(name: string) {
    return this.request<{ shed: Shed }>('POST', '/sheds', { name });
  }

  addStaff(input: Partial<Staff> & { full_name: string; phone: string }) {
    return this.request<{ staff: Staff }>('POST', '/staff', input);
  }

  editStaff(id: string, input: Partial<Staff> & { shed_ids?: string[] }) {
    return this.request<{ staff: Staff }>('PATCH', `/staff/${id}`, input);
  }

  /** Salary, pay history and month-by-month amounts — the owner's screen. */
  staffSalary(id: string) {
    return this.request<{
      person: { id: string; full_name: string; phone: string | null; role: StaffRole;
                joined_on: string | null; is_active: boolean };
      current: { monthly_amount: string; effective_from: string } | null;
      history: { id: string; monthly_amount: string; effective_from: string;
                 created_at: string; set_by_name: string | null }[];
      months: PayMonth[];
    }>('GET', `/staff/${id}/salary`);
  }

  setStaffSalary(id: string, input: { monthly_salary: number; effective_from?: string }) {
    return this.request<{ salary: { id: string; monthly_amount: string; effective_from: string } }>(
      'POST', `/staff/${id}/salary`, input);
  }

  /** The payslip endpoint with the auth header attached — for web downloads. */
  async payslipBlob(id: string, month: string): Promise<Blob> {
    const res = await this.fetchImpl(`${this.baseUrl}/staff/${id}/payslip?month=${month}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new ApiError(res.status, body?.error ?? 'Could not make the payslip');
    }
    return res.blob();
  }

  /** Shown once, never stored in readable form. */
  giveLogin(id: string) {
    return this.request<{
      staff: { id: string; full_name: string; phone: string };
      temporary_password: string;
      message: string;
    }>('POST', `/staff/${id}/login`, {});
  }

  /** My own day. A farm hand cannot read the team but must see themselves. */
  myAttendance() {
    return this.request<{ attendance: Attendance | null }>('GET', '/me/attendance');
  }

  checkIn(coords?: { lat: number; lng: number }) {
    return this.request<{ attendance: Attendance }>(
      'POST', '/attendance/check-in', coords ?? {});
  }

  checkOut() {
    return this.request<{ attendance: Attendance }>('POST', '/attendance/check-out', {});
  }

  markAttendance(input: {
    employee_id: string; status: string; work_date?: string;
    overtime_minutes?: number; note?: string;
  }) {
    return this.request<{ attendance: Attendance }>('POST', '/attendance', input);
  }

  attendance(month?: string) {
    return this.request<{ month: string; summary: AttendanceSummary[]; days: unknown[] }>(
      'GET', `/attendance${month ? `?month=${month}` : ''}`);
  }

  /* ------------------------------------------------------------------ push */

  registerDevice(input: { token: string; platform: string; device_name?: string }) {
    return this.request<{ device: { id: string } }>('POST', '/devices', input);
  }

  unregisterDevice(token: string) {
    return this.request<{ ok: boolean; removed: boolean }>('DELETE', '/devices', { token });
  }

  /* --------------------------------------------------------------- billing */

  billing() {
    return this.request<{
      subscription: Subscription | null;
      renew: { monthly_paise: number | null; yearly_paise: number | null;
               is_grandfathered: boolean };
      history: BillingRow[];
      gateway_ready: boolean;
    }>('GET', '/billing');
  }

  /** Returns a URL to open. Works the same on the web build and in an APK. */
  startPayment(billing_period: 'monthly' | 'yearly') {
    return this.request<{
      payment: { id: string; amount_paise: number; billing_period: string };
      pay_url: string;
    }>('POST', '/billing/pay', { billing_period });
  }

  permissions() {
    return this.request<{ role: string; can: Record<string, boolean> }>(
      'GET', '/me/permissions');
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

  litter(id: string) {
    return this.request<{ litter: Litter }>('GET', `/litters/${id}`);
  }

  /**
   * Correct a kindling record. The previous values are kept — the server
   * writes both sides into the doe's history rather than overwriting.
   */
  editLitter(id: string, input: {
    kindled_on?: string; born_alive?: number; born_dead?: number; notes?: string;
    nest_box_placed_on?: string; fostered_in?: number; fostered_out?: number;
  }) {
    return this.request<{ litter: Litter & { changed: string[] }; message: string }>(
      'PATCH', `/litters/${id}`, input);
  }

  /**
   * Turn a litter's counts into individual rabbits, each with its mother and
   * father on the record. Sex defaults to unknown — see the endpoint.
   */
  addKits(litterId: string, input: {
    count?: number; names?: string[]; prefix?: string;
    sex?: 'doe' | 'buck' | 'unknown';
  } = {}) {
    return this.request<{
      kits: Animal[];
      litter: { expected: number; recorded: number; not_yet_recorded: number };
      message: string;
    }>('POST', `/litters/${litterId}/kits`, input);
  }

  kits(litterId: string) {
    return this.request<{
      litter: { expected: number; recorded: number; not_yet_recorded: number };
      kits: Animal[];
    }>('GET', `/litters/${litterId}/kits`);
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

  /**
   * Fix what was written down, or fill in what was not — most often sexing a
   * kit at eight weeks. Audited: the previous values stay on her record.
   */
  editAnimal(id: string, input: {
    name?: string; tag?: string; sex?: 'doe' | 'buck' | 'unknown'; role?: string;
    date_of_birth?: string; notes?: string;
    breed_id?: string; breed_name?: string;
    cage_id?: string; cage_code?: string; move_reason?: string;
    /** Only accepted when currently blank — a parent is never rewritten. */
    dam_id?: string; sire_id?: string;
  }) {
    return this.request<{ animal: Animal & { changed: string[] }; message: string }>(
      'PATCH', `/animals/${id}`, input);
  }

  /**
   * The only way a rabbit leaves the herd. There is no delete — her matings,
   * litters and line stay on the farm's record.
   */
  /**
   * Erasure, not an exit — only for an animal added by mistake. The server
   * answers 409 once she has breeding history, and 403 for anyone but the
   * owner.
   */
  deleteAnimal(id: string) {
    return this.request<{ deleted: boolean; name: string }>(
      'DELETE', `/animals/${id}`);
  }

  setAnimalStatus(id: string, input: {
    status: 'active' | 'quarantine' | 'sold' | 'culled' | 'dead';
    reason?: string; changed_on?: string; sale_price_paise?: number;
  }) {
    return this.request<{ change: unknown; message: string }>(
      'POST', `/animals/${id}/status`, input);
  }

  /**
   * A dose was given. Recording it is what takes it off Today — the outstanding
   * list is the schedule minus what has been recorded, so there is no done-flag
   * to fall out of step.
   */
  recordDose(input: {
    id?: string; rabbit_id: string; protocol_id: string; dose_number: number;
    given_on?: string; dose?: string;
  }) {
    return this.request<{ dose: { id: string; medicine: string }; message: string }>(
      'POST', '/medication', input);
  }

  medicationDue() {
    return this.request<{ due: MedicationDose[] }>('GET', '/medication');
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
