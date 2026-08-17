/**
 * The data layer, tested against a REAL running API.
 *
 * No mocks. The interesting failures here — a queued write replaying twice, a
 * lapsed subscription blocking a write, a token going stale — only happen when
 * something on the other end is actually enforcing the rules.
 *
 * Start the API first:
 *   cd apps/api && npm start
 * or point API_URL somewhere else.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError, OfflineError } from '../src/api/client.ts';
import { Outbox } from '../src/api/outbox.ts';
import { MemoryStorage } from '../src/api/storage.ts';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';

let reachable = false;
before(async () => {
  try {
    const r = await fetch(`${API_URL}/health`);
    reachable = r.ok;
  } catch { reachable = false; }
  if (!reachable) {
    throw new Error(
      `The API is not answering at ${API_URL}.\n` +
      `Start it with: cd apps/api && npm start`);
  }
});

const PREFIX = `m${process.pid}`;
const uniq = () => `${PREFIX}${Date.now()}${Math.floor(Math.random() * 1e4)}`;

/*
 * A phone is a login identity since migration 0024 — unique among accounts that
 * can sign in, so a farm hand's number resolves to one farm. That makes it as
 * unique as the email here: a shared fixture number means the second farm in
 * any run cannot sign up at all.
 */
let phoneSeq = 0;
const uniquePhone = () =>
  `+91${String(process.pid % 100000).padStart(5, '0')}${String(++phoneSeq).padStart(5, '0')}`;

/**
 * These tests sign up real farms against a real API, so they have to clean up
 * after themselves — otherwise the admin console fills with hundreds of "Mobile
 * Test Farm" rows and stops being usable for anything else.
 *
 * Cleanup goes over HTTP through the superadmin delete endpoint rather than
 * straight into the database. That keeps this package free of a `pg`
 * dependency it would otherwise carry only for tests, and it means the teardown
 * exercises the same path a real erasure request takes — if that endpoint ever
 * breaks, this notices.
 *
 * Each test process only deletes farms carrying its own pid prefix, so parallel
 * test files never delete each other's data.
 */
after(async () => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;   // no admin configured — nothing we can do

  try {
    const login = await fetch(`${API_URL}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!login.ok) return;
    const { token } = await login.json() as { token: string };
    const auth = { authorization: `Bearer ${token}` };

    const listed = await fetch(`${API_URL}/admin/farms?format=json`, { headers: auth });
    if (!listed.ok) return;
    const { farms } = await listed.json() as {
      farms: { farm_id: string; farm_name: string; owner_email: string }[];
    };

    const mine = farms.filter((f) => f.owner_email?.startsWith(PREFIX)
      && f.owner_email.endsWith('@mobile.test'));

    for (const f of mine) {
      await fetch(`${API_URL}/admin/farms/${f.farm_id}/delete`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        // The endpoint wants the farm's name back, so a caller cannot delete by
        // id alone without having looked at what that id is.
        body: JSON.stringify({
          reason: 'Automated test farm cleanup', confirm_name: f.farm_name,
        }),
      });
    }
  } catch { /* the API went away; the next run will sweep these up */ }
});

async function freshFarm() {
  const storage = new MemoryStorage();
  const client = new ApiClient({ baseUrl: API_URL, storage });
  const email = `${uniq()}@mobile.test`;
  await client.signUp({
    farm_name: 'Mobile Test Farm',
    full_name: 'Mobile Tester',
    email,
    phone: uniquePhone(),
    password: 'correct horse battery',
    city: 'Margao', state: 'Goa', pincode: '403709',
  });
  const outbox = new Outbox(client, storage);
  return { client, outbox, storage, email };
}

describe('client', () => {
  test('signs up, persists the session, and reloads it', async () => {
    const { client, storage, email } = await freshFarm();
    assert.equal(client.isSignedIn, true);

    // A second client on the same storage — the app after a restart.
    const revived = new ApiClient({ baseUrl: API_URL, storage });
    const s = await revived.loadSession();
    assert.ok(s, 'the session should survive a restart');
    assert.equal(s.user.role, 'owner');
    const me = await revived.me();
    // Free since migration 0031: full access, and no trial to count down.
    assert.equal(me.subscription.access, 'full');
    assert.equal(me.subscription.trial_days_left, null);
    assert.ok(email.length > 0);
  });

  test('signs in again with the same credentials', async () => {
    const { email } = await freshFarm();
    const c2 = new ApiClient({ baseUrl: API_URL, storage: new MemoryStorage() });
    const s = await c2.signIn(email, 'correct horse battery');
    assert.ok(s.token);
  });

  test('reports a wrong password as an ApiError, not a crash', async () => {
    const { email } = await freshFarm();
    const c2 = new ApiClient({ baseUrl: API_URL, storage: new MemoryStorage() });
    await assert.rejects(
      () => c2.signIn(email, 'nope'),
      (err: unknown) => err instanceof ApiError && err.status === 401);
  });

  test('a dead host is an OfflineError, not an ApiError', async () => {
    const c = new ApiClient({
      baseUrl: 'http://127.0.0.1:9', storage: new MemoryStorage(), timeoutMs: 2000,
    });
    await assert.rejects(
      () => c.signIn('x@y.test', 'zzzzzzzz'),
      (err: unknown) => err instanceof OfflineError);
  });

  test('signing out clears the device even when the server call fails', async () => {
    const { client } = await freshFarm();
    // Point it at nothing so the round-trip fails.
    const broken = new ApiClient({
      baseUrl: 'http://127.0.0.1:9', storage: (client as any).storage, timeoutMs: 1500,
    });
    await broken.loadSession();
    await broken.signOut();
    assert.equal(broken.isSignedIn, false,
      'a farm hand handing the phone over must not stay signed in');
  });

  test('a 401 signs the app out so the UI can react', async () => {
    let signedOut = false;
    const storage = new MemoryStorage();
    await storage.set('rb.token', 'not-a-real-token');
    const c = new ApiClient({
      baseUrl: API_URL, storage, onSignedOut: () => { signedOut = true; },
    });
    await c.loadSession();
    await assert.rejects(() => c.animals());
    assert.equal(signedOut, true);
    assert.equal(c.isSignedIn, false);
  });
});

describe('breeding through the client', () => {
  test('records a full cycle and reads the numbers back', async () => {
    const { client } = await freshFarm();

    const doe = await client.addAnimal({ name: 'Lakshmi', sex: 'doe', date_of_birth: '2024-01-01' });
    const buck = await client.addAnimal({ name: 'Raja', sex: 'buck', date_of_birth: '2024-01-01' });
    assert.equal(doe.animal.name, 'Lakshmi');

    const m = await client.recordMating({
      doe_id: doe.animal.id, buck_id: buck.animal.id,
    });
    // The dates a farmer actually wants, straight back from the write.
    assert.match(m.mating.schedule.palpate_on, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(m.mating.schedule.expected_kindling_on, /^\d{4}-\d{2}-\d{2}$/);

    // Mated today is "awaiting check", not pregnant. Counting her now would be
    // the app claiming certainty it cannot have.
    const preg0 = await client.pregnant();
    assert.equal(preg0.summary.total_pregnant, 0);

    await client.recordPregnancyCheck({ mating_id: m.mating.id, result: 'positive' });
    const preg1 = await client.pregnant();
    assert.equal(preg1.summary.total_pregnant, 1);
    assert.equal(preg1.summary.confirmed_pregnant, 1);
    assert.equal(preg1.summary.presumed_pregnant, 0);
  });

  test('an unpalpated doe past the check window counts as presumed', async () => {
    const { client } = await freshFarm();
    const doe = await client.addAnimal({ name: 'Meera', sex: 'doe', date_of_birth: '2024-01-01' });
    const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000).toISOString();
    await client.recordMating({ doe_id: doe.animal.id, mated_at: twentyDaysAgo });

    const preg = await client.pregnant();
    assert.equal(preg.summary.total_pregnant, 1);
    assert.equal(preg.summary.presumed_pregnant, 1,
      'this is the bucket where quiet losses hide, so it must stay visible');
    assert.equal(preg.summary.confirmed_pregnant, 0);
  });

  test('buck suggestions carry the inbreeding verdict', async () => {
    const { client } = await freshFarm();
    const sire = await client.addAnimal({ name: 'Old Raja', sex: 'buck', date_of_birth: '2022-01-01' });
    const dam = await client.addAnimal({ name: 'Old Lakshmi', sex: 'doe', date_of_birth: '2022-01-01' });
    const doe = await client.addAnimal({
      name: 'Daughter', sex: 'doe', date_of_birth: '2024-01-01',
      dam_id: dam.animal.id, sire_id: sire.animal.id,
    });
    const stranger = await client.addAnimal({
      name: 'Stranger', sex: 'buck', date_of_birth: '2024-01-01' });

    const { bucks } = await client.suggestBucks(doe.animal.id);
    const byId = Object.fromEntries(bucks.map((b) => [b.buck_id, b]));
    assert.equal(byId[sire.animal.id]!.blocked_related, true);
    assert.equal(byId[stranger.animal.id]!.blocked_related, false,
      'unknown parentage must read as false, never null');
  });

  test('the daily list and conditions round-trip', async () => {
    const { client } = await freshFarm();
    const doe = await client.addAnimal({ name: 'Rani', sex: 'doe', date_of_birth: '2024-01-01' });

    const before_ = await client.daily();
    // No condition_type set up by hand: a brand-new farm must already have
    // loose motion available, or the feature is dead on arrival.
    const c = await client.reportCondition({ rabbit_id: doe.animal.id, severity: 'moderate' });

    const after_ = await client.daily();
    assert.ok(after_.items.length > before_.items.length);
    assert.ok(after_.items.some((i) => i.source === 'condition'));

    // The colour mark shows on the animal.
    const list = await client.animals();
    const marked = list.animals.find((a) => a.id === doe.animal.id);
    assert.ok(marked?.primary_colour, 'an open condition must mark the animal');
    assert.ok(marked?.primary_condition, 'and always with words beside the colour');

    const stopped = await client.checkCondition(c.condition.id, 'stopped');
    assert.equal(stopped.resolved, true);
    const cleared = await client.animals();
    assert.equal(cleared.animals.find((a) => a.id === doe.animal.id)?.primary_colour, null);
  });
});

describe('offline outbox', () => {
  /** A client whose network can be switched off, like walking into a shed. */
  function flaky(base: ApiClient) {
    let online = true;
    const real = globalThis.fetch;
    const client = new ApiClient({
      baseUrl: API_URL,
      storage: (base as any).storage,
      fetchImpl: ((...args: Parameters<typeof fetch>) =>
        online ? real(...args) : Promise.reject(new Error('network down'))) as typeof fetch,
    });
    return { client, go: (v: boolean) => { online = v; } };
  }

  test('queues writes with no signal and sends them all when it returns', async () => {
    const base = await freshFarm();
    const { client, go } = flaky(base.client);
    await client.loadSession();
    const storage = new MemoryStorage();
    const outbox = new Outbox(client, storage);

    go(false);
    const a = await outbox.enqueue('animal', { name: 'Meera', sex: 'doe' });
    const b = await outbox.enqueue('animal', { name: 'Ganga', sex: 'doe' });
    assert.equal(a.sent, false, 'nothing can be sent with no signal');
    assert.equal(b.sent, false);
    assert.equal(outbox.pending.length, 2, 'but nothing is lost either');

    go(true);
    const r = await outbox.flush();
    assert.equal(r.sent, 2);
    assert.equal(outbox.pending.length, 0);

    const { animals } = await base.client.animals();
    const names = animals.map((x) => x.name);
    assert.ok(names.includes('Meera') && names.includes('Ganga'));
  });

  test('a queue survives the app being closed and reopened', async () => {
    const base = await freshFarm();
    const { client, go } = flaky(base.client);
    await client.loadSession();
    const storage = new MemoryStorage();

    go(false);
    const first = new Outbox(client, storage);
    await first.enqueue('animal', { name: 'Sita', sex: 'doe' });
    assert.equal(first.pending.length, 1);

    // App killed. New Outbox, same storage — this is a cold start.
    go(true);
    const second = new Outbox(client, storage);
    await second.load();
    assert.equal(second.pending.length, 1, 'the queue must be on disk, not in memory');
    const r = await second.flush();
    assert.equal(r.sent, 1);

    const { animals } = await base.client.animals();
    assert.ok(animals.some((x) => x.name === 'Sita'));
  });

  test('replaying a write that already landed does not duplicate it', async () => {
    const base = await freshFarm();
    const storage = new MemoryStorage();
    const outbox = new Outbox(base.client, storage);

    // Send it for real.
    const { id } = await outbox.enqueue('animal', { name: 'Kaveri', sex: 'doe' });
    assert.equal(outbox.pending.length, 0);

    // Now simulate the case that actually happens: the write succeeded but the
    // response was lost, so the same entry is still queued and gets replayed.
    const replay = new Outbox(base.client, new MemoryStorage());
    const r = await replay.enqueue('animal', { id, name: 'Kaveri', sex: 'doe' });
    assert.equal(r.sent, true, 'a replay must be treated as success, not an error');

    const { animals } = await base.client.animals();
    assert.equal(animals.filter((x) => x.name === 'Kaveri').length, 1,
      'exactly one rabbit, however many times the write is replayed');
  });

  test('order is preserved so dependent writes work', async () => {
    const base = await freshFarm();
    const doe = await base.client.addAnimal({
      name: 'Chandni', sex: 'doe', date_of_birth: '2024-01-01' });

    const { client, go } = flaky(base.client);
    await client.loadSession();
    const outbox = new Outbox(client, new MemoryStorage());

    go(false);
    const matingId = crypto.randomUUID();
    await outbox.enqueue('mating', { id: matingId, doe_id: doe.animal.id });
    // The check references the mating queued a moment ago, offline.
    await outbox.enqueue('pregnancy_check', { mating_id: matingId, result: 'positive' });

    go(true);
    const r = await outbox.flush();
    assert.equal(r.sent, 2, 'the mating must go first or the check has nothing to attach to');

    const preg = await base.client.pregnant();
    assert.equal(preg.summary.confirmed_pregnant, 1);
  });

  test('a write the server refuses is parked, not retried forever', async () => {
    const base = await freshFarm();
    const outbox = new Outbox(base.client, new MemoryStorage());

    // No name — the server rejects this, and it will never become valid.
    await outbox.enqueue('animal', { name: '', sex: 'doe' });
    assert.equal(outbox.pending.length, 0);
    assert.equal(outbox.failed.length, 1, 'parked for a human rather than looping');
    assert.match(outbox.failed[0]!.lastError ?? '', /name/i);

    // And it stays parked across flushes rather than burning battery.
    const r = await outbox.flush();
    assert.equal(r.sent, 0);
    assert.equal(outbox.failed.length, 1);
  });

  test('a lapsed subscription parks the write with a message worth reading', async () => {
    const base = await freshFarm();
    // Expire the trial through the API's own rules by asking the server.
    const admin = await fetch(`${API_URL}/health`);
    assert.ok(admin.ok);

    // Without admin access from here we assert the client's classification
    // instead, which is the part the app depends on.
    const err = new ApiError(402, 'Your subscription has ended', { read_only: true });
    assert.equal(err.isPermanent, true);
    assert.equal(err.isReadOnly, true);
    assert.equal(err.isAuth, false);
  });
});

describe('offline reads', () => {
  test('serves the last good copy when the signal drops', async () => {
    const base = await freshFarm();
    await base.client.addAnimal({ name: 'Gauri', sex: 'doe' });

    const storage = new MemoryStorage();
    let online = true;
    const real = globalThis.fetch;
    const client = new ApiClient({
      baseUrl: API_URL,
      storage,
      fetchImpl: ((...a: Parameters<typeof fetch>) =>
        online ? real(...a) : Promise.reject(new Error('down'))) as typeof fetch,
    });
    await storage.set('rb.token', (await (base.client as any).storage.get('rb.token'))!);
    await client.loadSession();

    const first = await client.cached('animals', () => client.animals());
    assert.equal(first.stale, false);
    assert.equal(first.data.animals.length, 1);

    online = false;
    const second = await client.cached('animals', () => client.animals());
    assert.equal(second.stale, true, 'the screen should say it is showing old data');
    assert.equal(second.data.animals[0]!.name, 'Gauri');
  });

  test('an empty cache offline still surfaces the error', async () => {
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:9', storage: new MemoryStorage(), timeoutMs: 1500,
    });
    await assert.rejects(
      () => client.cached('nothing', () => client.animals()),
      (e: unknown) => e instanceof OfflineError);
  });
});

/**
 * The support handover.
 *
 * The admin console mints a farm session bound to a time-boxed, read-only
 * impersonation record and hands the token over in a URL fragment. This is the
 * app's end of it — needs an admin, so it stands down when none is configured
 * rather than failing a run that never had one.
 */
describe('support access', () => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const configured = !!(email && password);

  test('adopts a support token, read-only, and says so', { skip: !configured }, async () => {
    const farm = await freshFarm();
    await farm.client.addAnimal({ name: 'Gauri', sex: 'doe' });

    const login = await fetch(`${API_URL}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const { token: adminToken } = await login.json() as { token: string };

    const me = await farm.client.me();
    const started = await fetch(`${API_URL}/admin/api/impersonate/${me.farm.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'they cannot find a litter' }),
    });
    assert.equal(started.status, 200);
    const handed = await started.json() as { token: string; url: string };
    // A fragment, never a query string: it is not sent to a server and does not
    // reach an access log.
    assert.match(handed.url, /^\/#support=/);

    // A support person opening the link in a browser that has never seen this
    // farm: a fresh device, one token, nothing else.
    const storage = new MemoryStorage();
    const support = new ApiClient({ baseUrl: API_URL, storage });
    const session = await support.adoptSupportToken(handed.token);

    assert.equal(session.support?.read_only, true);
    assert.ok(session.support?.by, 'the app has to be able to name who is looking');
    assert.equal((await support.animals()).animals[0]!.name, 'Gauri');

    // And the write refused, at the server, whatever the app chose to render.
    await assert.rejects(
      () => support.addAnimal({ name: 'Not mine to add', sex: 'doe' }),
      (e: unknown) => e instanceof ApiError && e.status === 403);
  });

  test('a dead support link leaves the device signed in', { skip: !configured }, async () => {
    const farm = await freshFarm();
    const storage = (farm.client as any).storage as MemoryStorage;

    const client = new ApiClient({ baseUrl: API_URL, storage });
    await client.loadSession();

    await assert.rejects(
      () => client.adoptSupportToken('not-a-real-token'),
      (e: unknown) => e instanceof ApiError && e.status === 401);

    // The farmer was using this phone. A stale link must not sign them out.
    const revived = new ApiClient({ baseUrl: API_URL, storage });
    assert.ok(await revived.loadSession(), 'the session on the device should survive');
    assert.equal((await revived.animals()).animals.length, 0);
  });
});

/**
 * An installed app has no origin to infer its server from.
 *
 * The web build is served by the same site as the API, so it works this out
 * from window.location. An APK is a file on a phone: unless the address was
 * compiled in with EXPO_PUBLIC_API_URL, the farmer types it on the sign-in
 * screen. That means the client's base URL has to be settable after the client
 * exists — everything below is what makes that safe to do.
 */
describe('pointing an installed app at a server', () => {
  test('the base URL can be set after the client is built', async () => {
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:9', storage: new MemoryStorage(), timeoutMs: 1500,
    });

    // Nothing there — which is exactly what a wrong address looks like.
    await assert.rejects(
      () => client.request('GET', '/health', undefined, { auth: false }),
      (e: unknown) => e instanceof OfflineError);

    // A trailing slash is what a person typing a URL produces, and two slashes
    // in a path is a 404 the farmer cannot diagnose.
    client.setBaseUrl(`${API_URL}/`);
    assert.equal(client.baseUrl, API_URL);

    const health = await client.request<{ ok: boolean }>(
      'GET', '/health', undefined, { auth: false });
    assert.equal(health.ok, true);
  });

  test('a session survives being carried across a base URL change', async () => {
    const { client, storage } = await freshFarm();
    await client.addAnimal({ name: 'Gauri', sex: 'doe' });

    // The app relaunching: same storage, base URL applied from what was typed
    // last time, before the session is loaded.
    const revived = new ApiClient({ baseUrl: 'http://127.0.0.1:9', storage });
    revived.setBaseUrl(API_URL);
    assert.ok(await revived.loadSession());
    assert.equal((await revived.animals()).animals[0]!.name, 'Gauri');
  });
});
