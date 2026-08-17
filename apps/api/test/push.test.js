/**
 * Push delivery, against a stub standing in for Expo.
 *
 * The real endpoint is unreachable from here — and would be the wrong thing to
 * test against anyway, because the interesting cases are a phone that has been
 * uninstalled, a provider outage, and the same notification arriving twice.
 * None of those are convenient to arrange on somebody else's servers, and all
 * of them are exactly what decides whether a farmer keeps notifications turned
 * on.
 *
 * So the stub is the provider: it records what it was asked to send and answers
 * however the test needs. Everything up to the network call — the queue, quiet
 * hours, the backlog rules, batching, receipts, retiring dead tokens — is the
 * real code against the real database.
 */
import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { api, signupFarm, cleanup, closePools, adminQuery } from './helpers.js';
import { deliverPending, checkReceipts } from '../src/push.js';

/* --------------------------------------------------------------- the stub -- */

let server;
let base;
/** Every message the provider was handed, in order. */
let sent = [];
/** How the stub should answer. Set per test. */
let reply = () => ({ ok: true });

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const answer = reply(payload, req.url);
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body ?? { data: [] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUSH_ENDPOINT = base;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await cleanup();
  await closePools();
});

/**
 * Answer every message with a ticket, and remember what was asked.
 *
 * The ticket ids come from a counter that never resets. `sent` is cleared per
 * test but notification_delivery rows accumulate across the whole file, so ids
 * derived from the array length collide between tests — which is how a repeated
 * receipt id turned up in the first place.
 */
let ticketSeq = 0;
const acceptAll = () => (payload, url) => {
  if (url.endsWith('/send')) {
    sent.push(...payload);
    return { body: { data: payload.map(() => ({ status: 'ok', id: `r-${++ticketSeq}-${process.pid}` })) } };
  }
  return { body: { data: {} } };
};

/** A farm, a device, and a notification waiting to go out. */
async function farmWithDevice({ urgency = 'high', quiet = false } = {}) {
  const f = await signupFarm();
  const token = `ExponentPushToken[${Math.random().toString(36).slice(2, 12)}]`;

  const reg = await api('POST', '/devices', {
    token: f.token, body: { token, platform: 'android', device_name: 'Redmi' },
  });
  assert.equal(reg.status, 201, reg.text);

  if (quiet) {
    // Every hour of the day is quiet — the only way to be sure regardless of
    // when the suite happens to run.
    await adminQuery(`
      UPDATE farm_settings SET quiet_hours_enabled = true,
             quiet_hours_start = 0, quiet_hours_end = 23 WHERE farm_id = $1`, [f.farm.id]);
    await adminQuery(`UPDATE farm SET timezone = 'UTC' WHERE id = $1`, [f.farm.id]);
  }

  const { rows } = await adminQuery(`
    INSERT INTO notification (farm_id, kind, title, body, urgency, dedupe_key)
    VALUES ($1, 'task_due', 'Nest box — Lakshmi', 'Day 28', $2::task_priority_t, $3)
    RETURNING id`,
    [f.farm.id, urgency, `test-${Math.random()}`]);

  return { farm: f, token, notificationId: rows[0].id, deviceId: reg.body.device.id };
}

describe('getting a notification onto a phone', () => {
  test('a registered phone receives what the scheduler raised', async () => {
    sent = [];
    reply = acceptAll();
    const { token, notificationId } = await farmWithDevice();

    const out = await deliverPending();
    assert.ok(out.sent >= 1, `nothing was sent: ${JSON.stringify(out)}`);

    const mine = sent.find((m) => m.to === token);
    assert.ok(mine, 'the message never reached the provider');
    assert.equal(mine.title, 'Nest box — Lakshmi');
    assert.equal(mine.body, 'Day 28');
    // Enough to open the right screen without another round trip.
    assert.equal(mine.data.notification_id, notificationId);
    assert.equal(mine.data.kind, 'task_due');

    // And the row now says it went.
    const { rows } = await adminQuery(
      'SELECT sent_at FROM notification WHERE id = $1', [notificationId]);
    assert.ok(rows[0].sent_at, 'sent_at has been NULL on every row ever written until now');
  });

  test('never the same thing twice', async () => {
    /*
     * The one that decides whether people keep notifications on. A duplicate
     * buzz for a nest box they already placed teaches a farmer that the app
     * cries wolf, and the next one gets ignored.
     */
    sent = [];
    reply = acceptAll();
    const { token } = await farmWithDevice();

    await deliverPending();
    const first = sent.filter((m) => m.to === token).length;
    assert.equal(first, 1);

    await deliverPending();
    await deliverPending();
    assert.equal(sent.filter((m) => m.to === token).length, 1,
      'a second pass re-sent something already delivered');
  });

  test('two phones both hear about it', async () => {
    // Marking the notification itself sent would break exactly here: the first
    // device would close the row and the second would never be told.
    sent = [];
    reply = acceptAll();
    const { farm } = await farmWithDevice();

    const second = `ExponentPushToken[${Math.random().toString(36).slice(2, 12)}]`;
    await api('POST', '/devices', {
      token: farm.token, body: { token: second, platform: 'ios' } });

    // A fresh notification, now that both phones are registered.
    await adminQuery(`
      INSERT INTO notification (farm_id, kind, title, urgency, dedupe_key)
      VALUES ($1, 'task_due', 'Palpate — Meera', 'high', $2)`,
      [farm.farm.id, `two-${Math.random()}`]);

    await deliverPending();
    const both = sent.filter((m) => m.title === 'Palpate — Meera');
    assert.equal(both.length, 2, 'both phones should have been told');
  });

  test('a phone registered today does not get yesterday’s news', async () => {
    sent = [];
    reply = acceptAll();
    const f = await signupFarm();

    // Something raised before the phone existed.
    await adminQuery(`
      INSERT INTO notification (farm_id, kind, title, urgency, dedupe_key, created_at)
      VALUES ($1, 'task_due', 'Old news', 'high', $2, now() - interval '2 hours')`,
      [f.farm.id, `old-${Math.random()}`]);

    const token = `ExponentPushToken[${Math.random().toString(36).slice(2, 12)}]`;
    await api('POST', '/devices', { token: f.token, body: { token, platform: 'android' } });

    await deliverPending();
    assert.ok(!sent.some((m) => m.to === token),
      'a phone that just registered was handed a backlog');
  });

  test('a week-old alert is never delivered at all', async () => {
    sent = [];
    reply = acceptAll();
    const { farm, token } = await farmWithDevice();
    await adminQuery('DELETE FROM notification WHERE farm_id = $1', [farm.farm.id]);

    await adminQuery(`
      INSERT INTO notification (farm_id, kind, title, urgency, dedupe_key, created_at)
      VALUES ($1, 'task_due', 'Ancient', 'high', $2, now() - interval '3 days')`,
      [farm.farm.id, `ancient-${Math.random()}`]);
    // Move the device back so the "registered before it happened" rule cannot
    // be what excludes it — the age is what should.
    await adminQuery(
      `UPDATE push_device SET created_at = now() - interval '7 days' WHERE token = $1`,
      [token]);

    await deliverPending();
    assert.ok(!sent.some((m) => m.title === 'Ancient'),
      'a phone coming back after a week must not get a week of alerts');
  });
});

describe('quiet hours', () => {
  test('an ordinary reminder waits until morning', async () => {
    sent = [];
    reply = acceptAll();
    const { token } = await farmWithDevice({ urgency: 'high', quiet: true });

    await deliverPending();
    assert.ok(!sent.some((m) => m.to === token),
      'a phone buzzing at 02:00 for a rebreed gets the whole app muted');
  });

  test('a sick rabbit does not wait', async () => {
    sent = [];
    reply = acceptAll();
    const { token } = await farmWithDevice({ urgency: 'critical', quiet: true });

    await deliverPending();
    const mine = sent.find((m) => m.to === token);
    assert.ok(mine, 'an emergency must get through quiet hours');
    assert.equal(mine.priority, 'high');
    assert.equal(mine.sound, 'default');
  });

  test('what waited is delivered once the window lifts', async () => {
    // The "catch-up at quiet_hours_end" the settings table has promised since
    // migration 0001. Nothing is lost by holding it — it comes back into the
    // queue on its own.
    sent = [];
    reply = acceptAll();
    const { farm, token } = await farmWithDevice({ urgency: 'high', quiet: true });

    await deliverPending();
    assert.equal(sent.filter((m) => m.to === token).length, 0);

    await adminQuery(
      'UPDATE farm_settings SET quiet_hours_enabled = false WHERE farm_id = $1',
      [farm.farm.id]);

    await deliverPending();
    assert.equal(sent.filter((m) => m.to === token).length, 1,
      'the held reminder should arrive once the farm is awake');
  });
});

describe('phones that have gone', () => {
  test('an uninstalled app is retired on the spot, not retried forever', async () => {
    sent = [];
    reply = (payload, url) => {
      if (!url.endsWith('/send')) return { body: { data: {} } };
      sent.push(...payload);
      return { body: { data: payload.map(() => ({
        status: 'error',
        message: '"ExponentPushToken[…]" is not a registered push notification recipient',
        details: { error: 'DeviceNotRegistered' },
      })) } };
    };
    const { token } = await farmWithDevice();

    await deliverPending();
    const { rows } = await adminQuery(
      'SELECT disabled_at, disabled_reason FROM push_device WHERE token = $1', [token]);
    assert.ok(rows[0].disabled_at, 'a dead token must stop being tried');
    assert.match(rows[0].disabled_reason, /not a registered push notification recipient/);

    // And it is out of the queue from now on.
    sent = [];
    reply = acceptAll();
    await deliverPending();
    assert.ok(!sent.some((m) => m.to === token));
  });

  test('a provider outage costs nobody their notifications', async () => {
    /*
     * The failure mode worth being careful about: if an outage counted against
     * devices, a bad afternoon at the provider would quietly disable every
     * phone on the platform and nobody would be told anything again.
     */
    sent = [];
    reply = () => ({ status: 503, body: { error: 'upstream is having a day' } });
    const { token, notificationId } = await farmWithDevice();

    const out = await deliverPending();
    assert.equal(out.sent, 0);
    assert.ok(out.failed >= 1);

    const { rows } = await adminQuery(
      'SELECT failures, disabled_at FROM push_device WHERE token = $1', [token]);
    assert.equal(rows[0].failures, 0, 'an outage is not the phone’s fault');
    assert.equal(rows[0].disabled_at, null);

    // Nothing was marked delivered, so the next pass picks it up.
    sent = [];
    reply = acceptAll();
    await deliverPending();
    assert.ok(sent.some((m) => m.to === token), 'the notification should survive an outage');
    const { rows: after } = await adminQuery(
      'SELECT sent_at FROM notification WHERE id = $1', [notificationId]);
    assert.ok(after[0].sent_at);
  });

  test('five failures in a row is a phone that is not coming back', async () => {
    sent = [];
    reply = (payload, url) => {
      if (!url.endsWith('/send')) return { body: { data: {} } };
      return { body: { data: payload.map(() => ({
        status: 'error', message: 'MessageTooBig', details: { error: 'MessageTooBig' },
      })) } };
    };
    const { farm, token } = await farmWithDevice();

    for (let i = 0; i < 5; i++) {
      await adminQuery(`
        INSERT INTO notification (farm_id, kind, title, urgency, dedupe_key)
        VALUES ($1, 'task_due', 'Try ${i}', 'high', $2)`,
        [farm.farm.id, `retry-${i}-${Math.random()}`]);
      await deliverPending();
    }

    const { rows } = await adminQuery(
      'SELECT failures, disabled_at, disabled_reason FROM push_device WHERE token = $1',
      [token]);
    assert.ok(rows[0].disabled_at, `still enabled after 5 failures: ${JSON.stringify(rows[0])}`);
    assert.match(rows[0].disabled_reason, /five failures in a row/);
  });
});

describe('receipts', () => {
  test('the truth arrives later, and retires the token', async () => {
    /*
     * Expo accepts a message and tells you what happened afterwards.
     * DeviceNotRegistered usually turns up here rather than on the send, and a
     * push system that skips receipts accumulates dead tokens and slowly stops
     * working with nothing in any log to say why.
     */
    sent = [];
    reply = acceptAll();
    const { token } = await farmWithDevice();
    await deliverPending();

    const { rows: sentRows } = await adminQuery(`
      SELECT nd.receipt_id FROM notification_delivery nd
      JOIN push_device d ON d.id = nd.device_id WHERE d.token = $1`, [token]);
    assert.ok(sentRows[0]?.receipt_id, 'the ticket id should have been kept');
    const receiptId = sentRows[0].receipt_id;

    // Old enough to be worth asking about.
    await adminQuery(
      `UPDATE notification_delivery SET sent_at = now() - interval '30 minutes'
        WHERE receipt_id = $1`, [receiptId]);

    reply = (payload, url) => {
      if (!url.endsWith('/receipts')) return { body: { data: [] } };
      return { body: { data: Object.fromEntries(payload.ids.map((id) => [id, {
        status: 'error',
        message: 'The recipient device is not registered',
        details: { error: 'DeviceNotRegistered' },
      }])) } };
    };

    const out = await checkReceipts({ olderThanMinutes: 15 });
    assert.ok(out.checked >= 1, `no receipts checked: ${JSON.stringify(out)}`);
    assert.ok(out.dead >= 1);

    const { rows } = await adminQuery(
      'SELECT disabled_at FROM push_device WHERE token = $1', [token]);
    assert.ok(rows[0].disabled_at, 'a receipt saying the app is gone must retire the token');
  });

  test('a good receipt just records that it arrived', async () => {
    sent = [];
    reply = acceptAll();
    const { token } = await farmWithDevice();
    await deliverPending();

    await adminQuery(`
      UPDATE notification_delivery nd SET sent_at = now() - interval '30 minutes'
       FROM push_device d WHERE d.id = nd.device_id AND d.token = $1`, [token]);

    reply = (payload, url) => url.endsWith('/receipts')
      ? { body: { data: Object.fromEntries(payload.ids.map((id) => [id, { status: 'ok' }])) } }
      : { body: { data: [] } };

    await checkReceipts({ olderThanMinutes: 15 });

    const { rows } = await adminQuery(`
      SELECT nd.status FROM notification_delivery nd
      JOIN push_device d ON d.id = nd.device_id WHERE d.token = $1`, [token]);
    assert.equal(rows[0].status, 'delivered');
    const { rows: dev } = await adminQuery(
      'SELECT disabled_at FROM push_device WHERE token = $1', [token]);
    assert.equal(dev[0].disabled_at, null);
  });
});

describe('registering a phone', () => {
  test('the same phone signing in again is one row, not two', async () => {
    const f = await signupFarm();
    const token = `ExponentPushToken[${Math.random().toString(36).slice(2, 12)}]`;

    await api('POST', '/devices', { token: f.token, body: { token, platform: 'android' } });
    await api('POST', '/devices', { token: f.token, body: { token, platform: 'android' } });

    const { rows } = await adminQuery(
      'SELECT count(*)::int AS n FROM push_device WHERE token = $1', [token]);
    assert.equal(rows[0].n, 1);
  });

  test('re-registering brings a disabled phone back', async () => {
    // Reinstalling the app is how a farmer fixes this themselves, and it has to
    // work without anybody touching the database.
    const f = await signupFarm();
    const token = `ExponentPushToken[${Math.random().toString(36).slice(2, 12)}]`;
    await api('POST', '/devices', { token: f.token, body: { token, platform: 'android' } });
    await adminQuery(
      `UPDATE push_device SET disabled_at = now(), failures = 5 WHERE token = $1`, [token]);

    await api('POST', '/devices', { token: f.token, body: { token, platform: 'android' } });
    const { rows } = await adminQuery(
      'SELECT disabled_at, failures FROM push_device WHERE token = $1', [token]);
    assert.equal(rows[0].disabled_at, null);
    assert.equal(rows[0].failures, 0);
  });

  test('signing out stops the phone being told anything', async () => {
    sent = [];
    reply = acceptAll();
    const { farm, token } = await farmWithDevice();

    const gone = await api('DELETE', '/devices', { token: farm.token, body: { token } });
    assert.equal(gone.status, 200);
    assert.equal(gone.body.removed, true);

    await deliverPending();
    assert.ok(!sent.some((m) => m.to === token),
      'a farm hand handing the phone back must stop getting the farm’s reminders');
  });

  test('one farm never pushes to another farm’s phone', async () => {
    sent = [];
    reply = acceptAll();
    const mine = await farmWithDevice();
    const theirs = await farmWithDevice();

    await deliverPending();
    const toMine = sent.filter((m) => m.to === mine.token);
    const toTheirs = sent.filter((m) => m.to === theirs.token);
    assert.equal(toMine.length, 1);
    assert.equal(toTheirs.length, 1);
    assert.notEqual(toMine[0].data.farm_id, toTheirs[0].data.farm_id);

    // And the device list is a farm's own.
    const seen = await api('GET', '/devices', { token: mine.farm.token });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.devices.length, 1);
  });

  test('the token itself is never handed back to a screen', async () => {
    // Anybody holding a push token can push to that phone. A support screen is
    // not the place for one.
    const { farm, token } = await farmWithDevice();
    const seen = await api('GET', '/devices', { token: farm.token });
    const body = JSON.stringify(seen.body);
    assert.ok(!body.includes(token), 'the full token leaked into the device list');
    assert.ok(body.includes(token.slice(-6)), 'the tail is enough to tell phones apart');
  });

  test('a notification aimed at one person goes only to them', async () => {
    sent = [];
    reply = acceptAll();
    const f = await signupFarm();

    // Two people, two phones.
    const hand = await api('POST', '/staff', {
      token: f.token, body: { full_name: 'Ravi', phone: `+9111${Date.now() % 100000000}` } });
    const login = await api('POST', `/staff/${hand.body.staff.id}/login`, {
      token: f.token, body: {} });
    const ravi = await api('POST', '/auth/signin', {
      body: { phone: hand.body.staff.phone, password: login.body.temporary_password } });

    const ownerToken = `ExponentPushToken[owner${Date.now()}]`;
    const raviToken = `ExponentPushToken[ravi${Date.now()}]`;
    await api('POST', '/devices', { token: f.token, body: { token: ownerToken, platform: 'android' } });
    await api('POST', '/devices', { token: ravi.body.token, body: { token: raviToken, platform: 'android' } });

    await adminQuery(`
      INSERT INTO notification (farm_id, kind, title, urgency, employee_id, dedupe_key)
      VALUES ($1, 'task_due', 'Yours alone', 'high', $2, $3)`,
      [f.farm.id, hand.body.staff.id, `targeted-${Math.random()}`]);

    await deliverPending();
    const got = sent.filter((m) => m.title === 'Yours alone');
    assert.equal(got.length, 1, 'a targeted notification went to more than one phone');
    assert.equal(got[0].to, raviToken);
  });
});
