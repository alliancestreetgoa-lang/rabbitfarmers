/**
 * Support impersonation — the whole promise, checked.
 *
 * `admin_impersonation` existed for eleven migrations and granted nothing: the
 * console wrote "this admin may view this farm, read-only, for an hour" and had
 * no way to show them anything. Now it does, and every clause of that sentence
 * is a test here, because each one is the sort of thing that is easy to build
 * almost-right:
 *
 *   "may view"     — the token opens the farm, scoped like any other session
 *   "read-only"    — including the endpoints that carry no write guard
 *   "for an hour"  — checked on every request, not at token expiry
 *   "this farm"    — and no other, RLS unchanged
 *   and the farmer is told, in two places, both while it happens and after.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupFarm, makeAdmin, cleanup, closePools, adminQuery } from './helpers.js';

after(async () => { await cleanup(); await closePools(); });

/** Start a support session on a farm and hand back the token. */
async function impersonate(farmId, admin, reason = 'customer reports a missing litter') {
  const res = await api('POST', `/admin/api/impersonate/${farmId}`, {
    token: admin.token, body: { reason },
  });
  assert.equal(res.status, 200, res.text);
  return res.body;
}

describe('support impersonation', () => {
  test('a reason is required, and the record is read-only and time-boxed', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');

    const noReason = await api('POST', `/admin/api/impersonate/${f.farm.id}`, {
      token: admin.token, body: {},
    });
    assert.equal(noReason.status, 400);

    const started = await impersonate(f.farm.id, admin);
    assert.equal(started.impersonation.read_only, true);
    assert.ok(new Date(started.impersonation.expires_at) - Date.now() <= 3600_000);

    const { rows } = await adminQuery(
      `SELECT count(*)::int AS n FROM admin_audit_log
        WHERE target_farm_id = $1 AND action = 'impersonate'`, [f.farm.id]);
    assert.equal(rows[0].n, 1);
  });

  test('billing and readonly admins cannot start one', async () => {
    const f = await signupFarm();
    for (const role of ['billing', 'readonly']) {
      const admin = await makeAdmin(role);
      const res = await api('POST', `/admin/api/impersonate/${f.farm.id}`, {
        token: admin.token, body: { reason: 'curious' },
      });
      assert.equal(res.status, 403, `${role} should not be able to open a farm`);
    }
  });

  test('the token opens the farm, and only that farm', async () => {
    const f = await signupFarm();
    const other = await signupFarm();
    await api('POST', '/animals', { token: f.token, body: { name: 'Gauri', sex: 'doe' } });
    await api('POST', '/animals', { token: other.token, body: { name: 'Chandni', sex: 'doe' } });

    const admin = await makeAdmin('support');
    const { token } = await impersonate(f.farm.id, admin);

    const seen = await api('GET', '/animals', { token });
    assert.equal(seen.status, 200, seen.text);
    const names = seen.body.animals.map((a) => a.name);
    assert.ok(names.includes('Gauri'), 'support should see the farm they opened');
    // Nothing special about this session's reach: it is an ordinary farm
    // session and RLS is what scopes it, exactly as for the farmer's phone.
    assert.ok(!names.includes('Chandni'), 'and nothing of anybody else’s');
  });

  test('every write is refused, including the ones with no write guard', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');
    const { token } = await impersonate(f.farm.id, admin);

    const write = await api('POST', '/animals', {
      token, body: { name: 'Not mine to add', sex: 'doe' },
    });
    assert.equal(write.status, 403, write.text);
    assert.match(write.body.error, /read-only/i);

    /*
     * The one that matters most, and the reason the block sits in requireAuth
     * rather than on the write routes: changing the farmer's password carries
     * no subscription guard, because a farmer with a lapsed subscription must
     * still be able to change it. Support locking a customer out of their own
     * farm through the "read-only" door would be the whole feature backwards.
     */
    const password = await api('POST', '/auth/password', {
      token, body: { current_password: 'correct horse battery', new_password: 'support was here' },
    });
    assert.equal(password.status, 403, password.text);

    // And the farmer's password is untouched — proved by using it.
    const stillWorks = await api('POST', '/auth/signin', {
      body: { email: f.email, password: 'correct horse battery' },
    });
    assert.equal(stillWorks.status, 200);

    // Marking a notification read is a write too. Small, harmless-looking, and
    // it would let support quietly clear the farm's alerts.
    const read = await api('POST', '/notifications/read', { token, body: { all: true } });
    assert.equal(read.status, 403);
  });

  test('the farm is told, on their own screen and in their device list', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');
    await impersonate(f.farm.id, admin, 'they cannot find last week’s litter');

    const notes = await api('GET', '/notifications', { token: f.token });
    assert.equal(notes.status, 200);
    const told = notes.body.notifications.find((n) => n.kind === 'support_access');
    assert.ok(told, 'the farmer must be able to see that support opened the farm');
    assert.match(told.title, /Test Admin/);
    assert.match(told.body, /they cannot find last week’s litter/);

    // And live, while it is happening: the support session sits in the same
    // list as the farmer's own phone, with a name on it.
    const me = await api('GET', '/auth/me', { token: f.token });
    const devices = me.body.active_sessions.map((s) => s.device ?? '');
    assert.ok(devices.some((d) => d.includes('rabbitfarmers support')),
      `support access should be visible in ${JSON.stringify(devices)}`);
    // The farmer's own session is not flagged as support.
    assert.equal(me.body.support, null);
  });

  test('the support session knows it is one', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');
    const { token } = await impersonate(f.farm.id, admin);

    const me = await api('GET', '/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.support.read_only, true);
    assert.equal(me.body.support.by, 'Test Admin');
    // It is the farm owner's identity, because that is whose screens these are.
    assert.equal(me.body.user.role, 'owner');
  });

  test('ending it from the console closes the door on the next request', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');
    const { token, impersonation } = await impersonate(f.farm.id, admin);
    assert.equal((await api('GET', '/animals', { token })).status, 200);

    const ended = await api('POST', `/admin/api/impersonate/${impersonation.id}/end`, {
      token: admin.token, body: {},
    });
    assert.equal(ended.status, 200);
    assert.equal(ended.body.ended, true);

    assert.equal((await api('GET', '/animals', { token })).status, 401,
      'the session must die with the impersonation, not with its own expiry');
  });

  test('an hour is an hour', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');
    const { token, impersonation } = await impersonate(f.farm.id, admin);

    /*
     * Only the impersonation record is moved into the past — the session's own
     * expires_at is left alone. That is the point: the time box has to be
     * enforced by the binding, or a token that outlives it keeps working.
     */
    await adminQuery(
      `UPDATE admin_impersonation SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [impersonation.id]);

    assert.equal((await api('GET', '/animals', { token })).status, 401);
  });

  test('support signing out does not sign the farmer out', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');
    const { token, impersonation } = await impersonate(f.farm.id, admin);

    /*
     * With ?all=1, which is the dangerous shape. Impersonation runs on the
     * owner's own employee row, so "sign out everywhere" from inside a support
     * session would put a farmer in a shed back at a login screen with no idea
     * why. Ending support access ends support access.
     */
    const out = await api('POST', '/auth/signout?all=1', { token });
    assert.equal(out.status, 200);

    assert.equal((await api('GET', '/animals', { token })).status, 401);
    assert.equal((await api('GET', '/animals', { token: f.token })).status, 200,
      'the farmer’s own phone must still be signed in');

    const { rows } = await adminQuery(
      'SELECT ended_at FROM admin_impersonation WHERE id = $1', [impersonation.id]);
    assert.ok(rows[0].ended_at, 'signing out must close the record, not just the session');
  });

  test('the farmer can end it: changing the password locks support out too', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');
    const { token } = await impersonate(f.farm.id, admin);

    const changed = await api('POST', '/auth/password', {
      token: f.token,
      body: { current_password: 'correct horse battery', new_password: 'a longer new password' },
    });
    assert.equal(changed.status, 200, changed.text);

    assert.equal((await api('GET', '/animals', { token })).status, 401,
      'the advice in the notification has to actually work');
  });

  test('a farm with no active owner cannot be opened', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');
    await adminQuery('UPDATE employee SET is_active = false WHERE farm_id = $1', [f.farm.id]);

    const res = await api('POST', `/admin/api/impersonate/${f.farm.id}`, {
      token: admin.token, body: { reason: 'nobody home' },
    });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /no active owner/);
  });

  test('the console lists who is inside a farm right now', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('support');
    const { impersonation } = await impersonate(f.farm.id, admin);

    const live = await api('GET', '/admin/api/impersonations', { token: admin.token });
    assert.equal(live.status, 200);
    const mine = live.body.active.find((i) => i.id === impersonation.id);
    assert.ok(mine, 'a live session should be visible to the platform');
    assert.equal(mine.live_sessions, 1);
    assert.ok(mine.seconds_left > 0 && mine.seconds_left <= 3600);
  });

  test('the app role cannot read the impersonation log', async () => {
    // rabbitry_app is revoked from admin_impersonation, and the view over it is
    // security_invoker — otherwise the view would hand back what the REVOKE was
    // there to withhold, for every farm on the platform.
    const f = await signupFarm();
    const admin = await makeAdmin('support');
    await impersonate(f.farm.id, admin);

    const { appQuery } = await import('../src/db.js');
    await assert.rejects(
      () => appQuery('SELECT * FROM v_active_impersonation'),
      /permission denied/i);
    await assert.rejects(
      () => appQuery('SELECT * FROM admin_impersonation'),
      /permission denied/i);
  });
});
