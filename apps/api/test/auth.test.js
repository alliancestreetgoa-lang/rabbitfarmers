import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupFarm, cleanup, closePools, adminQuery, uniqueEmail } from './helpers.js';

after(async () => { await cleanup(); await closePools(); });

describe('signup', () => {
  test('creates a farm and an owner in one call, with nothing to pay', async () => {
    const out = await signupFarm();
    assert.ok(out.token);
    assert.equal(out.user.role, 'owner');
    // Deliberately absent since migration 0031: a response that names a trial
    // length teaches clients to count down to something that never arrives.
    assert.equal(out.trial_days, undefined);

    const me = await api('GET', '/auth/me', { token: out.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.subscription.access, 'full');
    assert.equal(me.body.subscription.trial_days_left, null,
      'no trial is running, so there is no countdown');
  });

  test('is usable immediately — no verification step', async () => {
    const out = await signupFarm();
    const created = await api('POST', '/animals', {
      token: out.token,
      body: { name: 'Lakshmi', sex: 'doe' },
    });
    assert.equal(created.status, 201, 'a brand new account can write straight away');

    const { rows } = await adminQuery(
      'SELECT email_verified_at FROM employee WHERE farm_id = $1', [out.farm.id]);
    assert.equal(rows[0].email_verified_at, null);
  });

  test('the address is compulsory, and each missing piece is named', async () => {
    // A product decision: the platform collects farm data, and a farm that
    // cannot be placed on a map is a farm the data cannot say much about.
    const res = await api('POST', '/auth/signup', {
      body: {
        farm_name: 'No Address Farm', full_name: 'Ravi',
        email: uniqueEmail(), phone: `+9198${Date.now() % 100000000}`,
        password: 'correct horse battery',
      },
    });
    assert.equal(res.status, 400);
    for (const field of ['address_line', 'city', 'state', 'pincode']) {
      assert.ok(res.body.detail[field], `${field} must be named in the error`);
    }
  });

  test('captures email, phone and address', async () => {
    const out = await signupFarm();
    const { rows } = await adminQuery(
      `SELECT e.email::text, e.phone, f.address_line, f.city, f.pincode
       FROM employee e JOIN farm f ON f.id = e.farm_id WHERE e.farm_id = $1`, [out.farm.id]);
    assert.equal(rows[0].email, out.email.toLowerCase());
    assert.equal(rows[0].phone, out.phone);
    assert.equal(rows[0].city, 'Margao');
    assert.equal(rows[0].pincode, '403709');
  });

  test('rejects a bad form with per-field messages', async () => {
    const res = await api('POST', '/auth/signup', {
      body: { farm_name: '', full_name: 'X', email: 'not-an-email', phone: '1', password: 'short' },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.detail.email);
    assert.ok(res.body.detail.password);
    assert.ok(res.body.detail.farm_name);
  });

  test('refuses a duplicate email whatever the case', async () => {
    const email = uniqueEmail();
    await signupFarm({ email });
    const again = await api('POST', '/auth/signup', {
      body: {
        farm_name: 'Test Other', full_name: 'Someone Else',
        email: email.toUpperCase(), phone: '+919000000000', password: 'another password',
        // A full address, so this reaches the duplicate check rather than
        // stopping at the (now compulsory) address validation.
        address_line: 'Survey 9', city: 'Margao', state: 'Goa', pincode: '403709',
      },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.detail.field, 'email');
  });
});

describe('sign in and sign out', () => {
  test('signs in with the right password and not the wrong one', async () => {
    const out = await signupFarm();

    const bad = await api('POST', '/auth/signin', {
      body: { email: out.email, password: 'wrong password' },
    });
    assert.equal(bad.status, 401);

    const good = await api('POST', '/auth/signin', {
      body: { email: out.email.toUpperCase(), password: 'correct horse battery' },
    });
    assert.equal(good.status, 200, 'email is case-insensitive');
    assert.ok(good.body.token);
  });

  test('gives the same answer for an unknown email as a wrong password', async () => {
    const out = await signupFarm();
    const unknown = await api('POST', '/auth/signin', {
      body: { email: 'nobody@example.test', password: 'whatever' },
    });
    const wrong = await api('POST', '/auth/signin', {
      body: { email: out.email, password: 'wrong password' },
    });
    // Otherwise the endpoint tells an attacker which addresses are registered.
    assert.equal(unknown.status, wrong.status);
    assert.equal(unknown.body.error, wrong.body.error);
  });

  test('sign out kills only that device; sign out everywhere kills all', async () => {
    const out = await signupFarm();
    const second = await api('POST', '/auth/signin', {
      body: { email: out.email, password: 'correct horse battery' },
    });
    const tokenA = out.token;
    const tokenB = second.body.token;

    assert.equal((await api('POST', '/auth/signout', { token: tokenA })).status, 200);
    assert.equal((await api('GET', '/auth/me', { token: tokenA })).status, 401);
    assert.equal((await api('GET', '/auth/me', { token: tokenB })).status, 200,
      'the other device stays signed in');

    const third = await api('POST', '/auth/signin', {
      body: { email: out.email, password: 'correct horse battery' },
    });
    await api('POST', '/auth/signout?all=1', { token: tokenB });
    assert.equal((await api('GET', '/auth/me', { token: tokenB })).status, 401);
    assert.equal((await api('GET', '/auth/me', { token: third.body.token })).status, 401);
  });

  test('revokes rather than deletes, so the history survives', async () => {
    const out = await signupFarm();
    await api('POST', '/auth/signout', { token: out.token });
    const { rows } = await adminQuery(
      `SELECT revoked_at, revoked_reason FROM user_session
       WHERE employee_id = (SELECT id FROM employee WHERE farm_id = $1)`, [out.farm.id]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].revoked_at);
    assert.equal(rows[0].revoked_reason, 'sign out');
  });

  test('rejects a missing or garbage token', async () => {
    assert.equal((await api('GET', '/auth/me')).status, 401);
    assert.equal((await api('GET', '/auth/me', { token: 'made-up' })).status, 401);
  });
});
