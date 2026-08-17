/**
 * Subscriptions that run out, and the fact that running out no longer costs
 * anything.
 *
 * This file used to assert the opposite. Before migration 0031 the product was
 * sold: `v_farm_entitlement.access` was a nine-branch CASE over trial dates,
 * grace windows and admin suspension, and a farm past the end of what it had
 * paid for went read-only — every record still visible, every reminder still
 * firing, but nothing new could be written.
 *
 * 0031 made access the constant 'full', because the product's purpose changed.
 * The value is the data farms record, and a farm that cannot write is a farm
 * that has stopped contributing it. Read-only farms are silent farms.
 *
 * So the guarantee under test here is now the inverse, and it is worth testing
 * harder than the paywall ever was: NOTHING a subscription does — expiring,
 * being suspended by an admin, being cancelled, never existing at all — can stop
 * a farm recording its animals. Every case below is one that used to lock a farm
 * out.
 *
 * The billing machinery itself is kept and still tested: statuses still move,
 * payments still apply, and the console still reports who paid and when. It is
 * bookkeeping now rather than a gate. What is switched off is anything that
 * would tell a farmer about money — see the last suite.
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
  `SELECT access, status, covered_until, covered_days_left, trial_days_left
     FROM v_farm_entitlement WHERE farm_id = $1`, [farmId]).then((r) => r.rows[0]);

const canWrite = async (token, name) =>
  (await api('POST', '/animals', { token, body: { name, sex: 'doe' } })).status === 201;

const advance = () => adminQuery('SELECT * FROM billing_advance_subscriptions()')
  .then((r) => r.rows[0]);

/* ------------------------------------------------------------ the promise -- */

describe('nothing a subscription does can take access away', () => {
  test('a farm sixty days past everything it paid for still writes', async () => {
    const live = await paidFarm(30);
    const gone = await paidFarm(-60);

    assert.equal((await entitlement(live.farm.id)).access, 'full');
    assert.equal((await entitlement(gone.farm.id)).access, 'full',
      'the paywall is gone; being out of period is bookkeeping now');

    assert.ok(await canWrite(live.token, 'Paid Up'));
    assert.ok(await canWrite(gone.token, 'Long Lapsed'),
      'a farm that stops writing stops contributing data, which is the point of being free');
  });

  test('the old grace boundary decides nothing', async () => {
    // These two used to sit either side of the exact cut-off — the last day of
    // grace and the day after. The dates still differ; the access does not.
    const lastDay = await paidFarm(-30);
    const dayAfter = await paidFarm(-31);

    assert.equal((await entitlement(lastDay.farm.id)).access, 'full');
    assert.equal((await entitlement(dayAfter.farm.id)).access, 'full');
    // The arithmetic is still computed, because it is a true fact about the
    // subscription row and the console reports it. It just gates nothing.
    assert.equal((await entitlement(lastDay.farm.id)).covered_days_left, 0);
    assert.equal((await entitlement(dayAfter.farm.id)).covered_days_left, -1);

    assert.ok(await canWrite(lastDay.token, 'Last Day'));
    assert.ok(await canWrite(dayAfter.token, 'Day After'));
  });

  test('monthly and yearly are treated alike, because neither is charged', async () => {
    // A monthly plan used to get seven days of grace and a yearly one thirty, so
    // eight days past the end split them. Nothing splits them now.
    const monthly = await paidFarm(-8, { period: 'monthly' });
    const yearly = await paidFarm(-8, { period: 'yearly' });

    assert.equal((await entitlement(monthly.farm.id)).access, 'full');
    assert.equal((await entitlement(yearly.farm.id)).access, 'full');
    assert.ok(await canWrite(monthly.token, 'Monthly'));
  });

  test('an expired trial keeps everything', async () => {
    const f = await signupFarm({ farm_name: `Trial Farm ${RUN}` });
    await adminQuery(
      `UPDATE subscription SET trial_ends_on = current_date - 90 WHERE farm_id = $1`,
      [f.farm.id]);

    const ent = await entitlement(f.farm.id);
    assert.equal(ent.access, 'full');
    assert.equal(ent.status, 'trialing', 'losing "they were a trial" would lose the funnel');
    assert.equal(ent.trial_days_left, null,
      'no trial is running, so there is no countdown to show — null, not zero');
    assert.ok(await canWrite(f.token, 'Trial Over'));
  });

  test('suspended and cancelled no longer beat anything', async () => {
    /*
     * The surprise in 0031, asserted so nobody discovers it by accident.
     *
     * The admin console still offers Suspend and Cancel, and they still write a
     * status — a true record of who stopped paying and who left. Neither takes
     * write access away any more, because there is no access tier left to put a
     * farm in. Cutting a farm off, if it is ever needed, needs a real mechanism
     * rather than a billing status pressed into service as one.
     */
    for (const status of ['suspended', 'cancelled']) {
      const f = await paidFarm(300, { status });
      assert.equal((await entitlement(f.farm.id)).access, 'full',
        `${status} is a record of payment history, not a lock`);
      assert.ok(await canWrite(f.token, `Still Writing ${status}`),
        `${status} must not stop a farm recording animals`);
    }
  });

  test('a farm with no subscription row at all still writes', async () => {
    // Used to be the first branch of the CASE, and read_only. A farm whose
    // subscription row never existed is not a farm that should lose its records.
    const f = await signupFarm({ farm_name: `Rowless Farm ${RUN}` });
    await adminQuery('DELETE FROM subscription WHERE farm_id = $1', [f.farm.id]);

    const ent = await entitlement(f.farm.id);
    assert.equal(ent.access, 'full');
    assert.equal(ent.status, null);
    assert.ok(await canWrite(f.token, 'No Subscription'));
  });

  test('the app is told access is full, and that reminders keep coming', async () => {
    const f = await paidFarm(-60);
    await advance();

    const me = await api('GET', '/auth/me', { token: f.token });
    assert.equal(me.body.subscription.access, 'full');
    assert.equal(me.body.subscription.reminders_active, true);
    assert.equal(me.body.subscription.trial_days_left, null);
  });

  test('every record stays readable, and welfare alerts keep firing', async () => {
    // The old read-only promise, which still has to hold — there is simply no
    // longer a billing event that could threaten it.
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

    const list = await api('GET', '/animals', { token: f.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.animals.find((a) => a.name === 'Lakshmi')?.name, 'Lakshmi');

    const daily = await api('GET', '/daily', { token: f.token });
    assert.equal(daily.status, 200);
    assert.ok(daily.body.items.some((i) => i.source === 'condition'),
      'a billing state must never silence an animal-welfare alert');
  });
});

/* -------------------------------------------------------- the bookkeeping -- */

describe('the billing bookkeeping still runs', () => {
  test('active still becomes past_due, then suspended', async () => {
    const inGrace = await paidFarm(-25);
    const spent = await paidFarm(-50);

    await advance();

    assert.equal((await entitlement(inGrace.farm.id)).status, 'past_due');
    assert.equal((await entitlement(spent.farm.id)).status, 'suspended');
    // The whole difference from before: the status moved and the access did not.
    assert.equal((await entitlement(spent.farm.id)).access, 'full');
  });

  test('running it twice changes nothing', async () => {
    const f = await paidFarm(-50);
    await advance();
    const first = await entitlement(f.farm.id);
    const second = await advance();
    const after = await entitlement(f.farm.id);

    assert.equal(after.status, first.status);
    assert.equal(after.covered_until, first.covered_until);
    assert.ok(second.suspended >= 0);
  });

  test('the day it ends is still theirs, and so is every day after', async () => {
    const today = await paidFarm(0);
    assert.equal((await entitlement(today.farm.id)).access, 'full');
    assert.ok(await canWrite(today.token, 'Ends Today'));
  });

  test('a subscription with no end date has not lapsed — it was never dated', async () => {
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
    const f = await signupFarm({ farm_name: `Comped Farm ${RUN}` });
    const admin = await makeAdmin('superadmin');
    await api('POST', `/admin/farms/${f.farm.id}/comp`, {
      token: admin.token, body: { reason: 'case study farm' } });

    assert.equal((await entitlement(f.farm.id)).access, 'full');
    await advance();
    assert.equal((await entitlement(f.farm.id)).status, 'active');
    assert.ok(await canWrite(f.token, 'Comped'));
  });

  test('a payment still applies, and still dates the period from today', async () => {
    // The gateway is dormant, not deleted. If charging is ever switched back on,
    // this is the path it runs down, and it is worth keeping honest.
    const f = await paidFarm(-70);
    await advance();
    assert.equal((await entitlement(f.farm.id)).status, 'suspended');

    const link = `plink_lapse_${RUN}_${++n}`;
    await adminQuery(`
      INSERT INTO payment (farm_id, gateway_link_id, amount_paise, billing_period,
                           covers_days, status)
      VALUES ($1, $2, 99900, 'yearly', 365, 'created')`, [f.farm.id, link]);
    await adminQuery('SELECT billing_apply_payment($1,$2,$3)',
      [link, `pay_lapse_${RUN}_${n}`, null]);

    const ent = await entitlement(f.farm.id);
    assert.equal(ent.status, 'active');
    // Paying late runs from the day it is made rather than back-dating, so a
    // farm does not buy a month that has already gone.
    assert.equal(ent.covered_days_left, 365 + 30);
  });
});

/* ------------------------------------------------------------- the console -- */

describe('what the console still reports', () => {
  test('a farm that stopped paying stops counting as revenue', async () => {
    const f = await paidFarm(-50);
    const admin = await makeAdmin('billing');

    const before = await api('GET', '/admin/farms?format=json', { token: admin.token });
    const mrrBefore = Number(before.body.summary.mrr_paise);
    await advance();
    const after = await api('GET', '/admin/farms?format=json', { token: admin.token });

    assert.equal(after.body.farms.find((x) => x.farm_id === f.farm.id).status, 'suspended');
    assert.ok(Number(after.body.summary.mrr_paise) <= mrrBefore,
      'MRR must not rise when a farm stops paying');
  });

  test('the stages a farm goes through are still named', async () => {
    /*
     * Fixed by migration 0033. `stage` was derived from `access`, so when 0031
     * pinned access to 'full', 'lapsed' became unreachable and a farm sixty days
     * overdue reported 'in_grace' — the view asserting a grace window that ended
     * two months ago. It now derives from covered_days_left, which is the
     * arithmetic that used to decide access, so the answers are unchanged.
     */
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

  test('it is on the list to phone, with the owner’s number', async () => {
    const f = await paidFarm(-25);
    const admin = await makeAdmin('billing');
    await advance();

    const { rows } = await adminQuery(
      'SELECT * FROM v_admin_lapsing WHERE farm_id = $1', [f.farm.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stage, 'in_grace');
    assert.equal(rows[0].days_to_due, -25);
    assert.equal(rows[0].covered_days_left, 5);
    assert.equal(rows[0].owner_phone, f.phone);

    const dash = await api('GET', '/admin/billing?format=json', { token: admin.token });
    const due = dash.body.renewals.find((r) => r.farm_id === f.farm.id);
    assert.ok(due, 'a farm in grace belongs on the renewals list');
    assert.equal(due.days_left, -25);
    assert.equal(due.covered_days_left, 5);
  });
});

/* ------------------------------------------------------------- the silence -- */

describe('the scheduler no longer says anything about money', () => {
  const notices = (farmId) => adminQuery(
    `SELECT kind::text FROM notification
      WHERE farm_id = $1 AND kind IN ('renewal_due','subscription_lapsed')`,
    [farmId]).then((r) => r.rows);

  test('a farm days from its old period end is not warned about renewing', async () => {
    /*
     * The trap this guards. generate_billing_notifications() raises its renewal
     * warning on `access = 'full' AND covered_days_left BETWEEN 0 AND 7`. Access
     * is now always 'full', so leaving that function in the pass would warn
     * every farm near its old period end that their subscription ends in three
     * days and to renew from More · Billing — a screen that no longer exists,
     * about a charge that never comes. The scheduler stopped calling it.
     */
    const f = await paidFarm(-24);   // six days of "grace" left, under the old rules
    const prev = process.env.SCHEDULER_SECRET;
    process.env.SCHEDULER_SECRET = `free-secret-${RUN}`;
    try {
      const res = await api('POST', '/scheduler/run', {
        headers: { 'x-scheduler-secret': process.env.SCHEDULER_SECRET },
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.billingNoticesCreated, 0);
      assert.equal(res.body.emailsQueued, 0, 'no dunning mail either — that one leaves the app');
      assert.deepEqual(await notices(f.farm.id), [],
        'a free product must never tell a farmer their subscription is ending');
    } finally {
      if (prev === undefined) delete process.env.SCHEDULER_SECRET;
      else process.env.SCHEDULER_SECRET = prev;
    }
  });

  test('the pass still reports the bookkeeping it moved', async () => {
    const f = await paidFarm(-25);
    const prev = process.env.SCHEDULER_SECRET;
    process.env.SCHEDULER_SECRET = `free-secret2-${RUN}`;
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

  test('the functions themselves are kept, so charging again is an afternoon', async () => {
    // Called directly rather than through the pass. They still exist and still
    // work; nothing in the product calls them. Deleting them would turn a
    // reversible decision into a rebuild of UPI Autopay and e-NACH.
    const billing = await adminQuery('SELECT generate_billing_notifications() AS n');
    const mail = await adminQuery('SELECT generate_dunning_emails() AS n');
    assert.ok(Number(billing.rows[0].n) >= 0);
    assert.ok(Number(mail.rows[0].n) >= 0);
  });
});
