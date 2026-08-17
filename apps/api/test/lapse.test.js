/**
 * Subscriptions that run out.
 *
 * Until migration 0029 they did not. `v_farm_entitlement` granted full access to
 * anything whose status was 'active' and nothing ever moved a subscription off
 * 'active', so one ₹99 payment bought the product for ever and MRR counted
 * farms that stopped paying in March as revenue in December. Both halves had
 * been written assuming the other existed, which is why no test caught it: every
 * test that wanted a lapsed farm made one by expiring a TRIAL.
 *
 * So this file is mostly about the day after the last day paid for, and it is
 * organised around the two mechanisms that now exist and the different jobs they
 * do. Access is DERIVED from the period end, so a dead scheduler cannot hand out
 * free access. Status is REPORTED by the scheduler, so the console and MRR say
 * something true — and if that stops, the numbers go stale while access stays
 * right, never the other way round.
 *
 * Running through all of it: read-only is the whole penalty. Every record
 * visible, every reminder still firing. Withholding a nest-box alert over ₹99
 * kills a litter.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupFarm, makeAdmin, cleanup, closePools, adminQuery } from './helpers.js';

const RUN = `${process.pid}${Date.now().toString(36)}`;
let n = 0;

after(async () => { await cleanup(); await closePools(); });

/** A farm that has paid, with its period ending `endsIn` days from today. */
async function paidFarm(endsIn, { period = 'yearly', status = 'active' } = {}) {
  const f = await signupFarm({ farm_name: `Lapse Farm ${RUN} ${++n}` });
  await adminQuery(`
    UPDATE subscription
       SET status = $2::subscription_status_t,
           trial_ends_on = NULL,
           grace_until = NULL,
           billing_period = $3::billing_period_t,
           current_period_start = current_date - 300,
           current_period_end = current_date + $4::int
     WHERE farm_id = $1`, [f.farm.id, status, period, endsIn]);
  return f;
}

const entitlement = (farmId) => adminQuery(
  `SELECT access, status, covered_until, covered_days_left
     FROM v_farm_entitlement WHERE farm_id = $1`, [farmId]).then((r) => r.rows[0]);

const canWrite = async (token, name) =>
  (await api('POST', '/animals', { token, body: { name, sex: 'doe' } })).status === 201;

const advance = () => adminQuery('SELECT * FROM billing_advance_subscriptions()')
  .then((r) => r.rows[0]);

/* ------------------------------------------------------------------ access -- */

describe('the day after the last day they paid for', () => {
  test('a farm inside its period writes, one past its grace does not', async () => {
    const live = await paidFarm(30);
    const gone = await paidFarm(-60);

    assert.equal((await entitlement(live.farm.id)).access, 'full');
    assert.equal((await entitlement(gone.farm.id)).access, 'read_only');

    assert.ok(await canWrite(live.token, 'Paid Up'));
    assert.ok(!await canWrite(gone.token, 'Long Lapsed'),
      'one payment must not buy the product for ever');
  });

  test('the grace window ends on a day, and the boundary is exact', async () => {
    // A payment that fails on a Friday is fixed on Monday. Cutting a farmer off
    // at midnight on the day it bounced is how you lose them.
    const lastDay = await paidFarm(-30);     // period end + 30 == today
    const dayAfter = await paidFarm(-31);    // period end + 30 == yesterday

    assert.equal((await entitlement(lastDay.farm.id)).access, 'full');
    assert.equal((await entitlement(lastDay.farm.id)).covered_days_left, 0);
    assert.equal((await entitlement(dayAfter.farm.id)).access, 'read_only');
    assert.equal((await entitlement(dayAfter.farm.id)).covered_days_left, -1);

    assert.ok(await canWrite(lastDay.token, 'Last Day'));
    assert.ok(!await canWrite(dayAfter.token, 'Day After'));
  });

  test('a monthly plan gets a week of it, not a second free month', async () => {
    /*
     * The one place this departs from docs/09, which asks for thirty days for
     * everyone. Thirty was designed around auto-debit, where not paying means a
     * charge failed. Without mandates not paying is a choice, and thirty days of
     * grace on a thirty-day subscription is an invitation to pay every other
     * month — a late payment runs from the day it is made, so the free month is
     * never paid for.
     */
    const monthly = await paidFarm(-8, { period: 'monthly' });
    const yearly = await paidFarm(-8, { period: 'yearly' });

    assert.equal((await entitlement(monthly.farm.id)).access, 'read_only');
    assert.equal((await entitlement(yearly.farm.id)).access, 'full');

    const stillIn = await paidFarm(-7, { period: 'monthly' });
    assert.equal((await entitlement(stillIn.farm.id)).access, 'full',
      'seven days, and the seventh is theirs');
  });

  test('the day it ends is still theirs', async () => {
    const today = await paidFarm(0);
    assert.equal((await entitlement(today.farm.id)).access, 'full');
    assert.ok(await canWrite(today.token, 'Ends Today'));
  });

  test('a subscription with no end date has not lapsed — it was never dated', async () => {
    /*
     * The difference between "expired" and "never given a date". An admin who
     * activated a farm by hand before there was an activate button leaves this
     * shape behind, and a migration that read NULL as expired would have
     * silently locked out every one of them.
     */
    const f = await signupFarm({ farm_name: `Undated Farm ${RUN}` });
    await adminQuery(`
      UPDATE subscription SET status = 'active', trial_ends_on = NULL,
             current_period_end = NULL, grace_until = NULL
       WHERE farm_id = $1`, [f.farm.id]);

    const ent = await entitlement(f.farm.id);
    assert.equal(ent.access, 'full');
    assert.equal(ent.covered_until, null);
    assert.ok(await canWrite(f.token, 'Undated'));
  });

  test('a comped farm is untouched', async () => {
    // `comp` sets a period end ten years out at a price of zero. It has to keep
    // working, and it has to keep showing as ₹0 rather than as a lapse.
    const f = await signupFarm({ farm_name: `Comped Farm ${RUN}` });
    const admin = await makeAdmin('superadmin');
    await api('POST', `/admin/farms/${f.farm.id}/comp`, {
      token: admin.token, body: { reason: 'case study farm' } });

    assert.equal((await entitlement(f.farm.id)).access, 'full');
    await advance();
    assert.equal((await entitlement(f.farm.id)).status, 'active');
    assert.ok(await canWrite(f.token, 'Comped'));
  });

  test('grace_until decides it in both directions', async () => {
    // An admin saying "access until this date": a fortnight for a farmer whose
    // bank is being difficult, or a short leash for a defaulter. A column named
    // grace_until that could only ever extend would be a trap.
    const extended = await paidFarm(-60);
    await adminQuery(
      `UPDATE subscription SET grace_until = current_date + 5 WHERE farm_id = $1`,
      [extended.farm.id]);
    assert.equal((await entitlement(extended.farm.id)).access, 'full');
    assert.ok(await canWrite(extended.token, 'Given More Time'));

    const shortened = await paidFarm(-1);          // would have 6 days of grace
    await adminQuery(
      `UPDATE subscription SET grace_until = current_date - 1 WHERE farm_id = $1`,
      [shortened.farm.id]);
    assert.equal((await entitlement(shortened.farm.id)).access, 'read_only');
  });

  test('suspended and cancelled beat any arithmetic', async () => {
    for (const status of ['suspended', 'cancelled']) {
      const f = await paidFarm(300, { status });
      assert.equal((await entitlement(f.farm.id)).access, 'read_only',
        `${status} must be read-only even with time left on the clock`);
    }
  });
});

/* ------------------------------------------------------- what a lapse costs -- */

describe('what a lapsed farm keeps', () => {
  test('every record, and every reminder', async () => {
    const f = await paidFarm(30);
    const doe = await api('POST', '/animals', {
      token: f.token, body: { name: 'Lakshmi', sex: 'doe', date_of_birth: '2024-01-01' } });
    // loose_motion comes from the signup seed.
    await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: doe.body.animal.id } });

    await adminQuery(
      `UPDATE subscription SET current_period_end = current_date - 60 WHERE farm_id = $1`,
      [f.farm.id]);
    await advance();

    assert.ok(!await canWrite(f.token, 'Blocked'), 'the farm has lapsed');

    // The whole point of read-only rather than locked out.
    const list = await api('GET', '/animals', { token: f.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.animals.length, 1);
    assert.equal(list.body.animals[0].name, 'Lakshmi');

    const daily = await api('GET', '/daily', { token: f.token });
    assert.equal(daily.status, 200);
    assert.ok(daily.body.items.some((i) => i.source === 'condition'),
      'a billing failure must never silence an animal-welfare alert');

    const me = await api('GET', '/auth/me', { token: f.token });
    assert.equal(me.body.subscription.access, 'read_only');
    assert.equal(me.body.subscription.reminders_active, true,
      'the app is told in so many words that the alerts keep coming');
    assert.ok(me.body.subscription.covered_days_left < 0,
      'and how long ago it ran out');
  });

  test('and can start paying again', async () => {
    const f = await paidFarm(-70);
    await advance();
    assert.equal((await entitlement(f.farm.id)).status, 'suspended');

    // The same function the webhook calls.
    const link = `plink_lapse_${RUN}_${++n}`;
    await adminQuery(`
      INSERT INTO payment (farm_id, gateway_link_id, amount_paise, billing_period,
                           covers_days, status)
      VALUES ($1, $2, 99900, 'yearly', 365, 'created')`, [f.farm.id, link]);
    await adminQuery('SELECT billing_apply_payment($1,$2,$3)',
      [link, `pay_lapse_${RUN}_${n}`, null]);

    const ent = await entitlement(f.farm.id);
    assert.equal(ent.status, 'active');
    assert.equal(ent.access, 'full');
    // Paying late starts from today rather than back-dating, so a farm that
    // lapsed for a month does not buy a month that has already gone.
    assert.equal(ent.covered_days_left, 365 + 30);
    assert.ok(await canWrite(f.token, 'Back In Business'));
  });
});

/* ------------------------------------------------------------------ status -- */

describe('the scheduler moving the status along', () => {
  test('active becomes past_due, then suspended', async () => {
    const inGrace = await paidFarm(-25);
    const spent = await paidFarm(-50);

    await advance();

    assert.equal((await entitlement(inGrace.farm.id)).status, 'past_due',
      'the money was due and did not arrive');
    assert.equal((await entitlement(inGrace.farm.id)).access, 'full',
      'past_due is not locked out — they are inside the grace window');

    // Two passes: the first makes it past_due, the second suspends it. Both run
    // in the same call because the second UPDATE sees the first one's rows.
    assert.equal((await entitlement(spent.farm.id)).status, 'suspended');
    assert.equal((await entitlement(spent.farm.id)).access, 'read_only');
  });

  test('running it twice changes nothing', async () => {
    const f = await paidFarm(-50);
    await advance();
    const first = await entitlement(f.farm.id);
    const second = await advance();
    const after = await entitlement(f.farm.id);

    assert.equal(after.status, first.status);
    assert.equal(after.covered_until, first.covered_until);
    // Nothing left to move for this farm — other test files run concurrently,
    // so the count is not asserted to be zero, only that this farm is stable.
    assert.ok(second.suspended >= 0);
  });

  test('access does not wait for it', async () => {
    /*
     * The failure direction that matters. If the scheduler is dead for a week,
     * the numbers on the console go stale — and nobody gets a free week.
     */
    const f = await paidFarm(-60);
    const ent = await entitlement(f.farm.id);
    assert.equal(ent.status, 'active', 'the scheduler has not run for this farm yet');
    assert.equal(ent.access, 'read_only', 'and it is already read-only');
    assert.ok(!await canWrite(f.token, 'No Free Week'));
  });

  test('a trial that runs out is not suspended — it was never a payment', async () => {
    const f = await signupFarm({ farm_name: `Trial Farm ${RUN}` });
    await adminQuery(
      `UPDATE subscription SET trial_ends_on = current_date - 1 WHERE farm_id = $1`,
      [f.farm.id]);
    await advance();

    const ent = await entitlement(f.farm.id);
    assert.equal(ent.status, 'trialing', 'losing "they were a trial" would lose the funnel');
    assert.equal(ent.access, 'read_only');
  });

  test('the pass reports what it moved', async () => {
    const f = await paidFarm(-25);
    const prev = process.env.SCHEDULER_SECRET;
    process.env.SCHEDULER_SECRET = `lapse-secret-${RUN}`;
    try {
      const res = await api('POST', '/scheduler/run', {
        headers: { 'x-scheduler-secret': process.env.SCHEDULER_SECRET },
      });
      assert.equal(res.status, 200, res.text);
      assert.ok(res.body.subscriptionsPastDue >= 1, 'the run must say what it changed');
      assert.equal((await entitlement(f.farm.id)).status, 'past_due');
    } finally {
      if (prev === undefined) delete process.env.SCHEDULER_SECRET;
      else process.env.SCHEDULER_SECRET = prev;
    }
  });
});

/* ----------------------------------------------------------------- the CRM -- */

describe('what the console says about it', () => {
  test('a farm that stopped paying stops counting as revenue', async () => {
    const f = await paidFarm(-50);
    const admin = await makeAdmin('billing');

    const before = await api('GET', '/admin/farms?format=json', { token: admin.token });
    const mine = before.body.farms.find((x) => x.farm_id === f.farm.id);
    assert.equal(mine.status, 'active', 'not advanced yet');

    const mrrBefore = Number(before.body.summary.mrr_paise);
    await advance();
    const after = await api('GET', '/admin/farms?format=json', { token: admin.token });

    assert.equal(after.body.farms.find((x) => x.farm_id === f.farm.id).status, 'suspended');
    // MRR counts active, past_due and grace. A suspended farm is none of them.
    // Other files run concurrently, so the assertion is about the direction and
    // the size of this farm's contribution, not an absolute total.
    assert.ok(Number(after.body.summary.mrr_paise) <= mrrBefore,
      'MRR must not rise when a farm stops paying');
  });

  test('it is on the list to phone, with the owner’s number', async () => {
    const f = await paidFarm(-25);
    const admin = await makeAdmin('billing');
    await advance();

    const { rows } = await adminQuery(
      'SELECT * FROM v_admin_lapsing WHERE farm_id = $1', [f.farm.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stage, 'in_grace');
    // Two dates, and the list carries both: the money was due 25 days ago, and
    // they can still work for another 5.
    assert.equal(rows[0].days_to_due, -25);
    assert.equal(rows[0].covered_days_left, 5);
    assert.equal(rows[0].owner_phone, f.phone);

    // And on the billing screen's renewal list, which is built on the same
    // arithmetic so the two screens cannot disagree about who is lapsing.
    const dash = await api('GET', '/admin/billing?format=json', { token: admin.token });
    const due = dash.body.renewals.find((r) => r.farm_id === f.farm.id);
    assert.ok(due, 'a farm in grace belongs on the renewals list');
    assert.equal(due.days_left, -25, 'days_left counts to the money, not to the lockout');
    assert.equal(due.covered_days_left, 5);
    assert.equal(due.renewal_paise, 99900);
  });

  test('the stages a farm goes through are named', async () => {
    const cases = [
      [3, 'ending_soon'],
      [-25, 'in_grace'],
      [-50, 'lapsed'],
    ];
    for (const [endsIn, stage] of cases) {
      const f = await paidFarm(endsIn);
      const { rows } = await adminQuery(
        'SELECT stage FROM v_admin_lapsing WHERE farm_id = $1', [f.farm.id]);
      assert.equal(rows[0]?.stage, stage, `a farm ending in ${endsIn} days is ${stage}`);
    }
  });
});

/* --------------------------------------------------------------- the notice -- */

describe('telling the farm before it happens', () => {
  const notices = (farmId) => adminQuery(
    `SELECT kind::text, title, urgency::text, dedupe_key FROM notification
      WHERE farm_id = $1 AND kind IN ('renewal_due','subscription_lapsed')
      ORDER BY created_at`, [farmId]).then((r) => r.rows);

  test('a week out, on the day, and when it has happened', async () => {
    const f = await paidFarm(-24);   // 6 days of grace left
    await adminQuery('SELECT generate_billing_notifications()');

    let rows = await notices(f.farm.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'renewal_due');
    assert.match(rows[0].title, /ends in 6 days/);
    assert.equal(rows[0].urgency, 'medium', 'a bill is not a 3am buzz');

    // The last day of grace.
    await adminQuery(
      `UPDATE subscription SET current_period_end = current_date - 30 WHERE farm_id = $1`,
      [f.farm.id]);
    await adminQuery('SELECT generate_billing_notifications()');
    rows = await notices(f.farm.id);
    assert.equal(rows.length, 2);
    assert.match(rows[1].title, /ends today/);
    assert.equal(rows[1].urgency, 'high');

    // And the day after.
    await adminQuery(
      `UPDATE subscription SET current_period_end = current_date - 31 WHERE farm_id = $1`,
      [f.farm.id]);
    await adminQuery('SELECT generate_billing_notifications()');
    rows = await notices(f.farm.id);
    assert.equal(rows.length, 3);
    assert.equal(rows[2].kind, 'subscription_lapsed');
    assert.match(rows[2].title, /subscription has ended/);
  });

  test('and says the two things a farmer actually wants to know', async () => {
    const f = await paidFarm(-31);
    await adminQuery('SELECT generate_billing_notifications()');
    const { rows } = await adminQuery(
      `SELECT body FROM notification WHERE farm_id = $1 AND kind = 'subscription_lapsed'`,
      [f.farm.id]);
    assert.match(rows[0].body, /still see and export every record/);
    assert.match(rows[0].body, /every reminder keeps/);
  });

  test('never twice, however often the scheduler runs', async () => {
    const f = await paidFarm(-26);
    for (let i = 0; i < 4; i += 1) await adminQuery('SELECT generate_billing_notifications()');
    assert.equal((await notices(f.farm.id)).length, 1);
  });

  test('it reaches the farmer’s own list', async () => {
    const f = await paidFarm(-26);
    await adminQuery('SELECT generate_billing_notifications()');
    const res = await api('GET', '/notifications', { token: f.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.notifications.some((x) => x.kind === 'renewal_due'),
      'a warning the farmer cannot see is not a warning');
  });

  test('a farm that has already left is not nagged', async () => {
    const f = await paidFarm(-26, { status: 'cancelled' });
    await adminQuery('SELECT generate_billing_notifications()');
    assert.deepEqual(await notices(f.farm.id), []);
  });

  test('a trial gets the same warning, in its own words', async () => {
    const f = await signupFarm({ farm_name: `Trial Notice Farm ${RUN}` });
    await adminQuery(
      `UPDATE subscription SET trial_ends_on = current_date + 3 WHERE farm_id = $1`,
      [f.farm.id]);
    await adminQuery('SELECT generate_billing_notifications()');
    let rows = await notices(f.farm.id);
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /ends in 3 days/);

    await adminQuery(
      `UPDATE subscription SET trial_ends_on = current_date - 1 WHERE farm_id = $1`,
      [f.farm.id]);
    await adminQuery('SELECT generate_billing_notifications()');
    rows = await notices(f.farm.id);
    assert.equal(rows.at(-1).kind, 'subscription_lapsed');
    assert.match(rows.at(-1).title, /free trial has ended/);
  });

  test('a lapse that happened while the scheduler was down is still announced', async () => {
    // The window is a week rather than a day for exactly this: the pass can be
    // down, and a lapse nobody was told about is the support call all of this
    // exists to prevent.
    const f = await paidFarm(-34);   // covered until four days ago
    await adminQuery('SELECT generate_billing_notifications()');
    const rows = await notices(f.farm.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'subscription_lapsed');
  });

  test('a farm that lapsed months ago is left alone', async () => {
    // Said once, on the day. Not every fifteen minutes for the rest of the year.
    const f = await paidFarm(-200);
    await adminQuery('SELECT generate_billing_notifications()');
    assert.deepEqual(await notices(f.farm.id), []);
  });
});
