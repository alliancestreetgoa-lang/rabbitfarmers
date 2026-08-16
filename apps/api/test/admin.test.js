import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, form, signupFarm, makeAdmin, cleanup, closePools, adminQuery,
} from './helpers.js';

after(async () => { await cleanup(); await closePools(); });

describe('entitlements', () => {
  test('a live trial can write', async () => {
    const f = await signupFarm();
    const res = await api('POST', '/animals', {
      token: f.token, body: { name: 'Gauri', sex: 'doe' },
    });
    assert.equal(res.status, 201);
  });

  test('an expired trial goes read-only but keeps every record visible', async () => {
    const f = await signupFarm();
    await api('POST', '/animals', { token: f.token, body: { name: 'Meera', sex: 'doe' } });

    await adminQuery(
      `UPDATE subscription SET trial_ends_on = current_date - 1 WHERE farm_id = $1`,
      [f.farm.id]);

    const blocked = await api('POST', '/animals', {
      token: f.token, body: { name: 'Too Late', sex: 'doe' },
    });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.body.detail.read_only, true);

    // The whole point: nothing is hidden, nothing is deleted.
    const list = await api('GET', '/animals', { token: f.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.animals.length, 1);
    assert.equal(list.body.animals[0].name, 'Meera');
  });

  test('a suspended farm still gets its reminders', async () => {
    const f = await signupFarm();
    const doe = await api('POST', '/animals', {
      token: f.token, body: { name: 'Sita', sex: 'doe', date_of_birth: '2024-01-01' },
    });
    await adminQuery(`
      INSERT INTO condition_type (farm_id, code, name, reminder_interval_hours,
                                  blocks_breeding, escalate_after_hours)
      VALUES ($1,'loose_motion','Loose motion',2,true,24)`, [f.farm.id]);
    await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: doe.body.animal.id },
    });

    await adminQuery(
      `UPDATE subscription SET status = 'suspended', trial_ends_on = current_date - 1
       WHERE farm_id = $1`, [f.farm.id]);

    const me = await api('GET', '/auth/me', { token: f.token });
    assert.equal(me.body.subscription.access, 'read_only');

    // Billing failure must never silence an animal-welfare alert.
    const daily = await api('GET', '/daily', { token: f.token });
    assert.equal(daily.status, 200);
    assert.ok(daily.body.items.some((i) => i.source === 'condition'),
      'a suspended farm must still be told about a sick rabbit');
  });

  test('grace period keeps full access', async () => {
    const f = await signupFarm();
    await adminQuery(`
      UPDATE subscription SET status = 'grace', trial_ends_on = current_date - 5,
             grace_until = current_date + 20 WHERE farm_id = $1`, [f.farm.id]);
    const res = await api('POST', '/animals', {
      token: f.token, body: { name: 'Still Working', sex: 'doe' },
    });
    assert.equal(res.status, 201, 'grace must not degrade anything');
  });
});

describe('admin CRM', () => {
  test('needs a sign-in', async () => {
    const res = await api('GET', '/admin/farms?format=json');
    assert.equal(res.status, 401);
  });

  test('lists every farm with owner contact and activity', async () => {
    const f = await signupFarm();
    await api('POST', '/animals', { token: f.token, body: { name: 'Chandni', sex: 'doe' } });
    const admin = await makeAdmin('superadmin');

    const res = await api('GET', '/admin/farms?format=json', { token: admin.token });
    assert.equal(res.status, 200);
    const row = res.body.farms.find((x) => x.farm_id === f.farm.id);
    assert.ok(row, 'the new farm should be listed');
    assert.equal(row.owner_email, f.email.toLowerCase());
    assert.equal(row.owner_phone, '+919876543210');
    assert.equal(row.city, 'Margao');
    assert.equal(row.status, 'trialing');
    assert.equal(row.days_since_activity, 0);
    assert.equal(row.effective_price_paise, 99900);
  });

  test('search finds a farm by owner phone', async () => {
    const f = await signupFarm({ phone: '+919812345678' });
    const admin = await makeAdmin('support');
    const res = await api('GET', '/admin/farms?format=json&q=9812345678', { token: admin.token });
    assert.equal(res.body.farms.length, 1);
    assert.equal(res.body.farms[0].farm_id, f.farm.id);
  });

  test('extending a trial restores access and is logged with a reason', async () => {
    const f = await signupFarm();
    await adminQuery(
      `UPDATE subscription SET trial_ends_on = current_date - 1 WHERE farm_id = $1`,
      [f.farm.id]);
    assert.equal((await api('POST', '/animals', {
      token: f.token, body: { name: 'Blocked', sex: 'doe' } })).status, 402);

    const admin = await makeAdmin('support');
    const res = await api('POST', `/admin/farms/${f.farm.id}/extend_trial`, {
      token: admin.token,
      body: { days: 15, reason: 'Customer needs longer to migrate paper records' },
    });
    assert.equal(res.status, 200, res.text);

    assert.equal((await api('POST', '/animals', {
      token: f.token, body: { name: 'Unblocked', sex: 'doe' } })).status, 201);

    const { rows } = await adminQuery(
      'SELECT action, reason, before_value FROM admin_audit_log WHERE target_farm_id = $1',
      [f.farm.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'extend_trial');
    assert.match(rows[0].reason, /paper records/);
    assert.ok(rows[0].before_value, 'the log records what it was before');
  });

  test('refuses an action with no reason', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('superadmin');
    const res = await api('POST', `/admin/farms/${f.farm.id}/suspend`, {
      token: admin.token, body: {},
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /reason is required/i);
  });

  test('support cannot do billing actions, billing can', async () => {
    const f = await signupFarm();
    const support = await makeAdmin('support');
    const billing = await makeAdmin('billing');

    const denied = await api('POST', `/admin/farms/${f.farm.id}/suspend`, {
      token: support.token, body: { reason: 'testing roles' },
    });
    assert.equal(denied.status, 403);

    const allowed = await api('POST', `/admin/farms/${f.farm.id}/suspend`, {
      token: billing.token, body: { reason: 'payment bounced twice' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.subscription.status, 'suspended');
  });

  test('only a superadmin can comp an account', async () => {
    const f = await signupFarm();
    const billing = await makeAdmin('billing');
    const superadmin = await makeAdmin('superadmin');

    assert.equal((await api('POST', `/admin/farms/${f.farm.id}/comp`, {
      token: billing.token, body: { reason: 'nope' } })).status, 403);

    const res = await api('POST', `/admin/farms/${f.farm.id}/comp`, {
      token: superadmin.token, body: { reason: 'case study farm' },
    });
    assert.equal(res.status, 200);
    // Comped as a price of zero rather than a hidden flag, so MRR stays honest.
    assert.equal(res.body.subscription.locked_price_yearly_paise, 0);
  });

  test('impersonation is time-boxed, read-only and logged', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');

    const noReason = await api('POST', `/admin/api/impersonate/${f.farm.id}`, {
      token: admin.token, body: {},
    });
    assert.equal(noReason.status, 400);

    const res = await api('POST', `/admin/api/impersonate/${f.farm.id}`, {
      token: admin.token, body: { reason: 'customer reports a missing litter' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.impersonation.read_only, true);
    assert.ok(new Date(res.body.impersonation.expires_at) - Date.now() <= 3600_000);

    const { rows } = await adminQuery(
      `SELECT count(*)::int AS n FROM admin_audit_log
       WHERE target_farm_id = $1 AND action = 'impersonate'`, [f.farm.id]);
    assert.equal(rows[0].n, 1);
  });

  test('revenue summary excludes trials from MRR', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('superadmin');

    const before = await api('GET', '/admin/api/summary', { token: admin.token });
    const mrrBefore = before.body.summary.mrr_paise;

    await api('POST', `/admin/farms/${f.farm.id}/activate`, {
      token: admin.token, body: { reason: 'paid by UPI' },
    });

    const after_ = await api('GET', '/admin/api/summary', { token: admin.token });
    // ₹999/year normalised to a month.
    assert.equal(after_.body.summary.mrr_paise - mrrBefore, Math.round(99900 / 12));
  });

  test('the console renders as HTML for a browser', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('superadmin');
    const page = await api('GET', '/admin/farms', {
      token: admin.token, headers: { accept: 'text/html' },
    });
    assert.equal(page.status, 200);
    assert.match(page.text, /<table/);
    assert.match(page.text, /Last seen/);
    assert.ok(page.text.includes(f.email.toLowerCase()));
  });

  test('escapes farm names rather than rendering them as markup', async () => {
    await signupFarm({ farm_name: 'Test <script>alert(1)</script> Farm' });
    const admin = await makeAdmin('superadmin');
    const page = await api('GET', '/admin/farms', {
      token: admin.token, headers: { accept: 'text/html' },
    });
    assert.ok(!page.text.includes('<script>alert(1)</script>'),
      'a farm name must never be able to inject script into the admin console');
    assert.ok(page.text.includes('&lt;script&gt;'));
  });

  test('form login works and a wrong password does not', async () => {
    const admin = await makeAdmin('superadmin');
    const bad = await form('POST', '/admin/login',
      { email: admin.email, password: 'wrong' });
    assert.equal(bad.status, 401);

    const good = await form('POST', '/admin/login',
      { email: admin.email, password: 'admin password 123' });
    assert.equal(good.status, 302);
    assert.match(good.headers.get('set-cookie') ?? '', /rb_admin=/);
  });
});
