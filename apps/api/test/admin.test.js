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

  test('an expired trial keeps writing, and keeps every record visible', async () => {
    // Asserted a 402 until migration 0031. There is no trial to expire now: the
    // date is still written and still ages, and nothing consults it.
    const f = await signupFarm();
    await api('POST', '/animals', { token: f.token, body: { name: 'Meera', sex: 'doe' } });

    await adminQuery(
      `UPDATE subscription SET trial_ends_on = current_date - 1 WHERE farm_id = $1`,
      [f.farm.id]);

    const after = await api('POST', '/animals', {
      token: f.token, body: { name: 'Not Too Late', sex: 'doe' },
    });
    assert.equal(after.status, 201, 'an aged-out trial date must not stop a farm recording');

    const list = await api('GET', '/animals', { token: f.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.animals.length, 2);
  });

  test('a suspended farm still gets its reminders', async () => {
    const f = await signupFarm();
    const doe = await api('POST', '/animals', {
      token: f.token, body: { name: 'Sita', sex: 'doe', date_of_birth: '2024-01-01' },
    });
    // loose_motion comes from the signup seed.
    await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: doe.body.animal.id },
    });

    await adminQuery(
      `UPDATE subscription SET status = 'suspended', trial_ends_on = current_date - 1
       WHERE farm_id = $1`, [f.farm.id]);

    const me = await api('GET', '/auth/me', { token: f.token });
    // Suspension is a record of payment history since 0031, not a lock.
    assert.equal(me.body.subscription.access, 'full');
    assert.equal(me.body.subscription.status, 'suspended');

    // Billing state must never silence an animal-welfare alert.
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
    assert.equal(row.owner_phone, f.phone);
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

  test('extending a trial still moves the date and is logged with a reason', async () => {
    /*
     * The action used to restore access, which is what made it "the most common
     * support request". Since 0031 nobody loses access, so there is nothing to
     * restore — but the action, its required reason and its audit entry are all
     * still here, because the audit log is the record of what admins did to
     * farms and that has not stopped mattering.
     */
    const f = await signupFarm();
    await adminQuery(
      `UPDATE subscription SET trial_ends_on = current_date - 1 WHERE farm_id = $1`,
      [f.farm.id]);
    assert.equal((await api('POST', '/animals', {
      token: f.token, body: { name: 'Never Blocked', sex: 'doe' } })).status, 201);

    const admin = await makeAdmin('support');
    const res = await api('POST', `/admin/farms/${f.farm.id}/extend_trial`, {
      token: admin.token,
      body: { days: 15, reason: 'Customer needs longer to migrate paper records' },
    });
    assert.equal(res.status, 200, res.text);

    assert.equal((await api('POST', '/animals', {
      token: f.token, body: { name: 'After Extension', sex: 'doe' } })).status, 201);

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

  // Impersonation has a file of its own — test/impersonation.test.js — because
  // "time-boxed, read-only and logged" is five behaviours, not one.

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

  test('an admin session survives a fresh app instance', async () => {
    // On Netlify each request may land on a different instance. An in-memory
    // session store passes every test on one long-lived server and then logs
    // admins out at random in production, so prove it against a second app.
    const admin = await makeAdmin('superadmin');
    const { createApp } = await import('../src/app.js?fresh=1');
    const other = createApp();

    const res = await other.fetch(new Request('http://test/admin/api/summary', {
      headers: { authorization: `Bearer ${admin.token}` },
    }));
    assert.equal(res.status, 200,
      'a token issued by one instance must work on another');
  });

  test('signing out revokes the admin session everywhere', async () => {
    const admin = await makeAdmin('superadmin');
    assert.equal((await api('GET', '/admin/api/summary', { token: admin.token })).status, 200);
    await form('POST', '/admin/logout', {}, { token: admin.token });
    assert.equal((await api('GET', '/admin/api/summary', { token: admin.token })).status, 401);
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

  test('signs in from behind a proxy chain, and the audit IP is the client', async () => {
    /*
     * Behind Netlify, x-forwarded-for is "client, proxy1, proxy2". The session
     * and audit ip columns are `inet`, and inserting the whole chain answered
     * every production admin sign-in with "That is not a valid inet" (22P02) —
     * while local dev, where the header is absent, never saw it. clientIp()
     * takes the first hop and prefers null over garbage.
     */
    const admin = await makeAdmin('superadmin');
    const res = await api('POST', '/admin/login', {
      headers: { 'x-forwarded-for': '203.0.113.7, 64.252.72.1, 10.0.0.2' },
      body: { email: admin.email, password: 'admin password 123' },
    });
    assert.equal(res.status, 200, res.text);

    const { rows } = await adminQuery(
      `SELECT host(ip) AS ip FROM admin_session ORDER BY issued_at DESC LIMIT 1`);
    assert.equal(rows[0].ip, '203.0.113.7', 'first hop, not the chain');

    // And garbage in the header must degrade to null, not to a 500.
    const junk = await api('POST', '/admin/login', {
      headers: { 'x-forwarded-for': 'not-an-ip at all' },
      body: { email: admin.email, password: 'admin password 123' },
    });
    assert.equal(junk.status, 200, junk.text);
  });

  describe('deleting a farm', () => {
    test('needs superadmin, a reason, and the farm typed back', async () => {
      const f = await signupFarm();
      const support = await makeAdmin('support');
      const admin = await makeAdmin('superadmin');
      const url = `/admin/farms/${f.farm.id}/delete`;

      const wrongRole = await api('POST', url, {
        token: support.token, body: { reason: 'x', confirm_name: f.farm.name },
      });
      assert.equal(wrongRole.status, 403);

      const noReason = await api('POST', url, {
        token: admin.token, body: { confirm_name: f.farm.name },
      });
      assert.equal(noReason.status, 400);
      assert.match(noReason.body.error, /reason/i);

      const wrongName = await api('POST', url, {
        token: admin.token, body: { reason: 'Erasure request', confirm_name: 'Some Other Farm' },
      });
      assert.equal(wrongName.status, 400);
      assert.equal(wrongName.body.detail.field, 'confirm_name');

      // Three refusals and the farm is still there.
      assert.equal((await api('GET', '/auth/me', { token: f.token })).status, 200);
    });

    test('a farm that has actually been used can still be deleted', async () => {
      // Regression. Every child table that referenced a cage, an employee or a
      // protocol with no ON DELETE action quietly made the farm undeletable
      // once a row existed — and none of them had rows until cage moves and
      // Ostovet doses started being recorded. An erasure request that cannot be
      // honoured is not an inconvenience, it is a legal problem.
      const f = await signupFarm();
      const doe = (await api('POST', '/animals', {
        token: f.token, body: { name: 'Lakshmi', sex: 'doe', date_of_birth: '2024-01-01',
                                cage_code: 'A-1' } })).body.animal.id;
      await api('PATCH', `/animals/${doe}`, {
        token: f.token, body: { cage_code: 'B-2', move_reason: 'nest box' } });
      await api('POST', '/matings', { token: f.token, body: { doe_id: doe } });
      const dose = (await api('GET', '/medication', { token: f.token })).body.due[0];
      if (dose) {
        await api('POST', '/medication', {
          token: f.token,
          body: { rabbit_id: dose.rabbit_id, protocol_id: dose.protocol_id,
                  dose_number: dose.dose_number } });
      }
      await api('POST', '/conditions', { token: f.token, body: { rabbit_id: doe } });

      const admin = await makeAdmin('superadmin');
      const res = await api('POST', `/admin/farms/${f.farm.id}/delete`, {
        token: admin.token,
        body: { reason: 'Owner asked for erasure', confirm_name: f.farm.name },
      });
      assert.equal(res.status, 200, res.text);
      assert.equal((await api('GET', '/auth/me', { token: f.token })).status, 401);
    });

    test('removes the farm but keeps the audit entry that says why', async () => {
      const f = await signupFarm();
      await api('POST', '/animals', { token: f.token, body: { name: 'Gauri', sex: 'doe' } });
      const admin = await makeAdmin('superadmin');

      const res = await api('POST', `/admin/farms/${f.farm.id}/delete`, {
        token: admin.token,
        body: { reason: 'Owner asked for their data to be removed', confirm_name: f.farm.name },
      });
      assert.equal(res.status, 200, res.text);

      // Gone, and the farmer's session with it.
      assert.equal((await api('GET', '/auth/me', { token: f.token })).status, 401);
      const list = await api('GET', '/admin/farms?format=json', { token: admin.token });
      assert.equal(list.body.farms.filter((x) => x.farm_id === f.farm.id).length, 0);

      // The log survives the row it describes — target_farm_id is nulled by the
      // cascade, so the farm's name has to be in the payload or the entry
      // becomes unreadable the moment it matters.
      const { rows } = await adminQuery(
        `SELECT action, reason, before_value, target_farm_id, target_table
         FROM admin_audit_log WHERE admin_id = (SELECT id FROM platform_admin WHERE email = $1)
           AND action = 'delete_farm'`, [admin.email]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].target_farm_id, null);
      assert.equal(rows[0].target_table, 'farm');
      assert.equal(rows[0].before_value.name, f.farm.name);
      assert.match(rows[0].reason, /removed/);
    });
  });
});

describe('a farm cannot break the platform', () => {
  test('an unknown timezone is refused at signup', async () => {
    const res = await api('POST', '/auth/signup', {
      body: {
        farm_name: 'TZ Probe', full_name: 'Probe Person',
        email: `tz${process.pid}x${Date.now()}@example.test`,
        phone: '+919820000000', password: 'probe-password-123',
        timezone: 'Middle-Earth/Shire',
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.detail.timezone, 'and it says which field');
  });

  test('the database refuses one too, however it is written', async () => {
    const f = await signupFarm();
    await assert.rejects(
      () => adminQuery(`UPDATE farm SET timezone = 'Nowhere/Nothing' WHERE id = $1`,
        [f.farm.id]),
      /unknown timezone/i,
      'the API is not the only way rows get written');
  });

  test('a bad row cannot take the scheduler down for everybody', async () => {
    /*
     * The reason this is here rather than in a note somewhere.
     *
     * Task generation is one set-based statement across every farm. Before the
     * guard, a single farm with an unrecognised timezone aborted that
     * statement, so nobody on the platform got a nest box task, a separation
     * reminder or an Ostovet dose — from an unauthenticated signup.
     *
     * The trigger stops it getting in. farm_today falling back to UTC is what
     * stops a row that got in some other way (an old dump, a superuser) from
     * doing it again.
     */
    const f = await signupFarm();
    await api('POST', '/animals', {
      token: f.token, body: { name: 'Lakshmi', sex: 'doe', date_of_birth: '2024-01-01' } });

    // The trigger is the guarantee, and it is what this asserts. Getting a bad
    // row past it needs table ownership, which nothing in this suite has — so
    // the UTC fallback inside farm_today is deliberately belt to the trigger's
    // braces, for a restore from an older dump or a superuser at a prompt.
    await assert.rejects(
      () => adminQuery(`UPDATE farm SET timezone = '' WHERE id = $1`, [f.farm.id]),
      /unknown timezone/i);

    const daily = await api('GET', '/daily', { token: f.token });
    assert.equal(daily.status, 200);
    const { rows } = await adminQuery('SELECT farm_today($1::uuid) AS d', [f.farm.id]);
    assert.ok(rows[0].d, 'and the farm still has a day');
  });

  test('a farm can correct its own timezone', async () => {
    const f = await signupFarm();
    const bad = await api('PATCH', '/settings', {
      token: f.token, body: { timezone: 'Nowhere/Nothing' } });
    assert.equal(bad.status, 400);

    const ok = await api('PATCH', '/settings', {
      token: f.token, body: { timezone: 'Asia/Kolkata' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.settings.timezone, 'Asia/Kolkata',
      'a farm that got it wrong at signup had no way back before this');
  });
});

describe('specific admin routes are not swallowed by the wildcard', () => {
  test('every named action reaches its own handler', async () => {
    /*
     * Hono matches in registration order, and /farms/:id/:action is a wildcard
     * that will happily answer for a path a specific route was meant to take.
     * It has caught two routes already — delete, then reset_password — and each
     * time the symptom was a 404 saying "Unknown action", with the role check
     * never running. This fails the moment a third one is added below it.
     */
    const f = await signupFarm();
    const admin = await makeAdmin('superadmin');

    // reset_password answers 200 to an empty body since no reason is required
    // any more — which proves the same thing more directly: the wildcard would
    // have said 404 "Unknown action".
    const expected = { delete: 400, reset_password: 200, impersonate: 400 };
    for (const [action, status] of Object.entries(expected)) {
      const res = await api('POST', `/admin/farms/${f.farm.id}/${action}`, {
        token: admin.token, body: {} });
      assert.ok(!/Unknown action/.test(res.body?.error ?? ''),
        `${action} is being answered by the wildcard, not its own handler`);
      assert.equal(res.status, status,
        `${action} should reach its own handler`);
    }
  });
});

describe('passwords can be changed and recovered', () => {
  test('changing it signs every other device out', async () => {
    const f = await signupFarm();
    // A second device, signed in before the change.
    const other = await api('POST', '/auth/signin', {
      body: { email: f.email, password: 'correct horse battery' } });
    assert.equal(other.status, 200);

    const wrong = await api('POST', '/auth/password', {
      token: f.token,
      body: { current_password: 'not it', new_password: 'a longer new password' } });
    assert.equal(wrong.status, 401);

    const res = await api('POST', '/auth/password', {
      token: f.token,
      body: { current_password: 'correct horse battery',
              new_password: 'a longer new password' } });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.body.token, 'the caller gets a fresh session');

    // The other device is out — the whole point of changing it.
    assert.equal((await api('GET', '/auth/me', { token: other.body.token })).status, 401);
    // And the new one works.
    assert.equal((await api('GET', '/auth/me', { token: res.body.token })).status, 200);

    assert.equal((await api('POST', '/auth/signin', {
      body: { email: f.email, password: 'correct horse battery' } })).status, 401);
    assert.equal((await api('POST', '/auth/signin', {
      body: { email: f.email, password: 'a longer new password' } })).status, 200);
  });

  test('a short new password is refused', async () => {
    const f = await signupFarm();
    const res = await api('POST', '/auth/password', {
      token: f.token, body: { current_password: 'correct horse battery', new_password: 'short' } });
    assert.equal(res.status, 400);
  });

  test('support can get a locked-out farmer back in, no reason demanded', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');

    /*
     * Alone among admin actions, no reason is required — the owner's call.
     * The farmer is on the phone locked out right now; the audit row still
     * lands either way, attributed and timestamped.
     */
    const res = await api('POST', `/admin/farms/${f.farm.id}/reset_password`, {
      token: admin.token, body: {} });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.body.temporary_password?.length >= 12);

    // The old one is dead, the temporary one works, the old session is gone.
    assert.equal((await api('POST', '/auth/signin', {
      body: { email: f.email, password: 'correct horse battery' } })).status, 401);
    assert.equal((await api('GET', '/auth/me', { token: f.token })).status, 401,
      'a reset must end a takeover, not sit alongside it');
    assert.equal((await api('POST', '/auth/signin', {
      body: { email: f.email, password: res.body.temporary_password } })).status, 200);

    const { rows } = await adminQuery(
      `SELECT action, reason FROM admin_audit_log
       WHERE target_farm_id = $1 AND action = 'reset_password'`, [f.farm.id]);
    assert.equal(rows.length, 1);
    assert.match(rows[0].reason, /no reason required/,
      'the trail says none was asked for, rather than sitting blank');
  });

  test('billing cannot reset a password', async () => {
    const f = await signupFarm();
    const billing = await makeAdmin('billing');
    assert.equal((await api('POST', `/admin/farms/${f.farm.id}/reset_password`, {
      token: billing.token, body: { reason: 'nope' } })).status, 403);
  });
});
