/**
 * Refunds.
 *
 * The published policy (docs/09) says a no-questions refund at ₹99 costs almost
 * nothing and buys real trust. What it costs instead is correctness in three
 * places, and this file is organised around them.
 *
 * **The money.** Never more than was taken, however many times the button is
 * pressed. Every rupee that goes back gets a credit note, consecutive within
 * the financial year, and the invoice it offsets is never touched — an invoice
 * deleted because it was later refunded is a gap an auditor reads as evasion.
 *
 * **The access.** Nothing about a farm changes until the money has actually
 * gone. A refund the gateway accepted and has not yet paid is a promise, and
 * locking a farm out on a promise that then fails is a farmer in a shed unable
 * to write down a kindling because of something in a payments system. And when
 * it does settle, whether the days go back depends on WHY: leaving takes them,
 * an apology does not.
 *
 * **Who.** docs/10 puts refunds with `billing` and explicitly not with
 * `support`, so support tries, throughout.
 *
 * The gateway is a stub. api.razorpay.com is unreachable from here, and the
 * cases worth testing — a refund the gateway refuses, one that settles days
 * later by webhook, one that never settles at all — are not things you arrange
 * against a real payment provider.
 */
import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { api, signupFarm, makeAdmin, cleanup, closePools, adminQuery } from './helpers.js';

const KEY_ID = 'rzp_test_refunds';
const KEY_SECRET = 'a-test-key-secret';
const WEBHOOK_SECRET = 'a-test-webhook-secret';

const RUN = `${process.pid}${Date.now().toString(36)}`;
let n = 0;
const nextId = (what) => `${what}_${RUN}_${++n}`;

let server;
/** Every refund the API asked the gateway to make. */
let asked = [];
/** How the stub answers the next refund: 'accept' | 'instant' | 'refuse'. */
let mode = 'accept';

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      asked.push({ url: req.url, payload, idempotency: req.headers['x-razorpay-idempotency-key'] });

      if (mode === 'refuse') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          error: { code: 'BAD_REQUEST_ERROR',
                   description: 'The payment has been fully refunded already' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: nextId('rfnd'),
        payment_id: req.url.split('/')[3],
        amount: payload.amount,
        // 'created' is Razorpay's normal speed: accepted now, paid in five to
        // seven working days, confirmed by a webhook. 'processed' is what an
        // instant refund answers.
        status: mode === 'instant' ? 'processed' : 'created',
        notes: payload.notes,
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.RAZORPAY_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.RAZORPAY_KEY_ID = KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await adminQuery(`DELETE FROM webhook_event WHERE id LIKE $1`, [`%_${RUN}_%`]);
  await cleanup();
  await closePools();
});

/* ---------------------------------------------------------------- fixtures -- */

async function namedFarm(label) {
  const name = `${label} ${RUN}`;
  const f = await signupFarm({ farm_name: name });
  return { ...f, name };
}

/** A farm that has paid, and the payment row it paid through. */
async function paidFarm({ amount = 99900, period = 'yearly', days = 365,
                          gateway = 'razorpay' } = {}) {
  const farm = await namedFarm('Refund Farm');
  const linkId = nextId('plink');
  await adminQuery(`
    INSERT INTO payment (farm_id, gateway, gateway_link_id, amount_paise, billing_period,
                         covers_days, status)
    VALUES ($1, $2, $3, $4, $5::billing_period_t, $6, 'created')`,
    [farm.farm.id, gateway, linkId, amount, period, days]);
  const applied = await adminQuery('SELECT * FROM billing_apply_payment($1,$2,$3)',
    [linkId, nextId('pay'), null]).then((r) => r.rows[0]);
  const payment = await adminQuery(
    'SELECT * FROM payment WHERE gateway_link_id = $1', [linkId]).then((r) => r.rows[0]);
  return { farm, payment, applied };
}

const refund = (paymentId, token, body) =>
  api('POST', `/admin/billing/payments/${paymentId}/refund`, { token, body });

const sub = (farmId) => adminQuery(
  'SELECT status, current_period_end, cancel_reason FROM subscription WHERE farm_id = $1',
  [farmId]).then((r) => r.rows[0]);

/** A refund webhook, signed the way Razorpay signs it. */
async function refundWebhook(event, entity, { eventId } = {}) {
  const raw = JSON.stringify({ event, payload: { refund: { entity } } });
  return api('POST', '/webhooks/razorpay', {
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature':
        createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex'),
      'x-razorpay-event-id': eventId ?? nextId('evt'),
    },
    rawBody: raw,
  });
}

/* --------------------------------------------------------------------- who -- */

describe('who may give money back', () => {
  test('not support — docs/10 says refunds are billing’s', async () => {
    const { payment, farm } = await paidFarm();
    const support = await makeAdmin('support');
    const res = await refund(payment.id, support.token,
      { reason: 'the farmer asked me to' });
    assert.equal(res.status, 403);

    const { rows } = await adminQuery(
      'SELECT count(*)::int AS n FROM refund WHERE farm_id = $1', [farm.farm.id]);
    assert.equal(rows[0].n, 0, 'a refused request must not leave a refund behind');
  });

  test('not anonymously, and not with a farmer’s token', async () => {
    const { payment, farm } = await paidFarm();
    assert.equal((await refund(payment.id, undefined, { reason: 'x' })).status, 401);
    assert.equal((await refund(payment.id, farm.token, { reason: 'x' })).status, 401);
  });

  test('a reason is not optional', async () => {
    const { payment } = await paidFarm();
    const admin = await makeAdmin('billing');
    const res = await refund(payment.id, admin.token, { kind: 'goodwill' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /reason/i);
  });
});

/* ------------------------------------------------------------- the arithmetic -- */

describe('the money', () => {
  test('a full refund settles, issues a credit note and nets off the total', async () => {
    mode = 'instant';
    const { farm, payment } = await paidFarm();
    const admin = await makeAdmin('billing');

    const before = await api('GET', '/admin/billing?format=json', { token: admin.token });

    const res = await refund(payment.id, admin.token,
      { reason: 'cancelled within the refund window' });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.settled.settled, true);
    assert.match(res.body.settled.credit_note, /^CN\/\d{4}-\d{2}\/\d{5}$/);

    const { rows } = await adminQuery(
      'SELECT * FROM v_admin_refund WHERE payment_id = $1', [payment.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'processed');
    assert.equal(rows[0].amount_paise, 99900);
    // GST is inside the price, so the credit note splits the same way the
    // invoice did and the two net to nothing.
    assert.equal(rows[0].subtotal_paise + rows[0].tax_paise, 99900);
    assert.equal(rows[0].tax_paise, 99900 - Math.round(99900 / 1.18));
    assert.equal(rows[0].requested_by_name, 'Test Admin');

    // The payment is spent, and the invoice is untouched.
    const pay = await adminQuery('SELECT status FROM payment WHERE id = $1', [payment.id]);
    assert.equal(pay.rows[0].status, 'refunded');
    const inv = await adminQuery(
      'SELECT status FROM invoice WHERE farm_id = $1', [farm.farm.id]);
    assert.equal(inv.rows[0].status, 'paid',
      'a GST invoice is offset by a credit note, never deleted or edited');

    // Collections come down by what went back.
    const after = await api('GET', '/admin/billing?format=json', { token: admin.token });
    assert.equal(
      Number(before.body.summary.collected_total_paise)
        - Number(after.body.summary.collected_total_paise),
      99900, 'a refund must come off the collected total');
    assert.ok(Number(after.body.summary.refunded_fy_paise)
              >= Number(before.body.summary.refunded_fy_paise) + 99900);
  });

  test('a partial refund leaves the rest refundable', async () => {
    mode = 'instant';
    const { payment } = await paidFarm();
    const admin = await makeAdmin('billing');

    const first = await refund(payment.id, admin.token,
      { amount_paise: 40000, kind: 'goodwill', reason: 'a bad week, partly on us' });
    assert.equal(first.status, 201);

    const { rows } = await adminQuery(
      'SELECT status, refunded_paise, refundable_paise FROM v_admin_payment WHERE id = $1',
      [payment.id]);
    assert.equal(rows[0].status, 'paid', 'partly refunded is not refunded');
    assert.equal(rows[0].refunded_paise, 40000);
    assert.equal(rows[0].refundable_paise, 59900);

    const second = await refund(payment.id, admin.token,
      { reason: 'the rest of it' });
    assert.equal(second.status, 201);
    assert.equal(second.body.refund.amount_paise, 59900,
      'a blank amount means everything still refundable, not the whole payment again');

    const after = await adminQuery(
      'SELECT status, refunded_paise, refundable_paise FROM v_admin_payment WHERE id = $1',
      [payment.id]);
    assert.equal(after.rows[0].status, 'refunded');
    assert.equal(after.rows[0].refundable_paise, 0);
  });

  test('nothing can be refunded twice, however many times the button is pressed', async () => {
    mode = 'instant';
    const { payment } = await paidFarm();
    const admin = await makeAdmin('billing');
    await refund(payment.id, admin.token, { reason: 'first' });

    const again = await refund(payment.id, admin.token, { reason: 'and again' });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already been refunded in full/);

    const over = await refund(payment.id, admin.token,
      { amount_paise: 100, reason: 'just a bit more' });
    assert.equal(over.status, 409);

    const { rows } = await adminQuery(
      `SELECT COALESCE(sum(amount_paise),0)::int AS total FROM refund
        WHERE payment_id = $1 AND status IN ('created','processed')`, [payment.id]);
    assert.equal(rows[0].total, 99900, 'never more than was taken');
  });

  test('more than was paid is refused outright', async () => {
    mode = 'instant';
    const { payment } = await paidFarm();
    const admin = await makeAdmin('billing');
    const res = await refund(payment.id, admin.token,
      { amount_paise: 199900, reason: 'fat fingers' });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /only 99900 paise/);
  });

  test('an unpaid link cannot be refunded', async () => {
    const farm = await namedFarm('Unpaid Farm');
    const { rows } = await adminQuery(`
      INSERT INTO payment (farm_id, gateway_link_id, amount_paise, billing_period,
                           covers_days, status)
      VALUES ($1, $2, 99900, 'yearly', 365, 'created') RETURNING id`,
      [farm.farm.id, nextId('plink')]);
    const admin = await makeAdmin('billing');
    const res = await refund(rows[0].id, admin.token, { reason: 'they never paid' });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /nothing to give back/);
  });

  test('credit notes are consecutive within the financial year', async () => {
    mode = 'instant';
    const admin = await makeAdmin('billing');
    const a = await paidFarm();
    const b = await paidFarm();
    const one = await refund(a.payment.id, admin.token, { reason: 'left' });
    const two = await refund(b.payment.id, admin.token, { reason: 'also left' });

    const num = (s) => Number(s.split('/').at(-1));
    assert.equal(num(two.body.settled.credit_note) - num(one.body.settled.credit_note), 1);
    assert.equal(one.body.settled.credit_note.split('/')[1],
      two.body.settled.credit_note.split('/')[1], 'same financial year, same series');
  });

  test('the return shows both documents and nets them', async () => {
    mode = 'instant';
    const { payment } = await paidFarm();
    const admin = await makeAdmin('billing');
    await refund(payment.id, admin.token, { reason: 'cancelled' });

    const res = await api('GET', '/admin/billing?format=json', { token: admin.token });
    const fy = res.body.fy[0];
    // The identity a return is filed on, on both sides and on the net.
    assert.equal(fy.taxable_paise + fy.tax_paise, fy.total_paise);
    assert.equal(fy.credited_taxable_paise + fy.credited_tax_paise, fy.credited_total_paise);
    assert.equal(fy.net_total_paise, fy.total_paise - fy.credited_total_paise);
    assert.ok(fy.credit_notes > 0, 'the credit note is on the return, not hidden');
    assert.match(fy.first_credit_note, /^CN\//);
  });
});

/* ------------------------------------------------------------------ access -- */

describe('what it does to the farm', () => {
  test('leaving takes the days back, and the farm goes read-only', async () => {
    mode = 'instant';
    const { farm, payment } = await paidFarm();
    assert.equal((await api('POST', '/animals', {
      token: farm.token, body: { name: 'While Paid', sex: 'doe' } })).status, 201);

    const admin = await makeAdmin('billing');
    const res = await refund(payment.id, admin.token, { reason: 'closing the farm down' });
    assert.equal(res.body.settled.days_removed, 365);

    const s = await sub(farm.farm.id);
    assert.equal(s.status, 'cancelled');
    assert.match(s.cancel_reason, /^refunded: closing the farm down/);

    // Read-only, and every record still there. That is the documented shape of
    // a lapse and a refund is not a punishment beyond it.
    assert.equal((await api('POST', '/animals', {
      token: farm.token, body: { name: 'After', sex: 'doe' } })).status, 402);
    const list = await api('GET', '/animals', { token: farm.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.animals.length, 1);
  });

  test('a refunded farm is not an emergency — being read-only is it working', async () => {
    /*
     * Without this exclusion every ordinary refund raises a severity-1 "paid,
     * still locked out" alarm, and a list that cries wolf on every refund is a
     * list nobody reads by March. That is worse than not having the list: the
     * one real "we took their money and they cannot work" would be sitting in
     * the middle of it.
     */
    mode = 'instant';
    const { farm, payment } = await paidFarm();
    // Eleven and a half months into the year they paid for, then a part refund
    // that ends it early. This shape is the one the exclusion is FOR: a fully
    // refunded payment is 'refunded' and drops out of the alarm on its own,
    // while a partly refunded one stays 'paid' and would keep firing.
    await adminQuery(
      `UPDATE subscription SET current_period_end = current_date + 10 WHERE farm_id = $1`,
      [farm.farm.id]);

    const admin = await makeAdmin('billing');
    await refund(payment.id, admin.token,
      { amount_paise: 30000, reason: 'ending it early, refunding the unused part' });

    const me = await api('GET', '/auth/me', { token: farm.token });
    assert.equal(me.body.subscription.access, 'read_only', 'the refund did take effect');
    const still = await adminQuery('SELECT status FROM payment WHERE id = $1', [payment.id]);
    assert.equal(still.rows[0].status, 'paid', 'part of that payment was never refunded');

    const dash = await api('GET', '/admin/billing?format=json', { token: admin.token });
    const alarms = dash.body.exceptions.filter(
      (x) => x.farm_id === farm.farm.id && x.kind === 'paid_but_locked_out');
    assert.deepEqual(alarms, [], 'a refunded farm must not be reported as locked out');
  });

  test('an apology does not take the days back', async () => {
    mode = 'instant';
    const { farm, payment } = await paidFarm();
    const before = await sub(farm.farm.id);

    const admin = await makeAdmin('billing');
    const res = await refund(payment.id, admin.token, {
      kind: 'goodwill', amount_paise: 20000,
      reason: 'two days of push notifications not going out',
    });
    assert.equal(res.body.settled.days_removed, 0);

    const after = await sub(farm.farm.id);
    assert.equal(after.current_period_end, before.current_period_end,
      'clawing back access would undo the apology');
    assert.equal(after.status, 'active');
    assert.equal((await api('POST', '/animals', {
      token: farm.token, body: { name: 'Still Working', sex: 'doe' } })).status, 201);
  });

  test('a part refund takes back its share of the days, rounded the farmer’s way', async () => {
    mode = 'instant';
    const { farm, payment } = await paidFarm();
    const before = await sub(farm.farm.id);
    const admin = await makeAdmin('billing');

    // A third of a year back. 365 × 33300/99900 = 121.66 → 121, not 122.
    const res = await refund(payment.id, admin.token,
      { amount_paise: 33300, reason: 'they only used four months' });
    assert.equal(res.body.settled.days_removed, 121);

    const after = await sub(farm.farm.id);
    const days = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
    assert.equal(days(before.current_period_end, after.current_period_end), 121);
    assert.equal(after.status, 'active', 'there is still time left on it');
  });

  test('nothing moves until the money has actually gone', async () => {
    /*
     * The case this ordering exists for: Razorpay accepts the refund and pays
     * it five working days later. In between, the farm is still a paying
     * customer — locking them out on a promise that might yet fail is a farmer
     * unable to write down a kindling because of something in a payments system.
     */
    mode = 'accept';
    const { farm, payment } = await paidFarm();
    const admin = await makeAdmin('billing');

    const res = await refund(payment.id, admin.token, { reason: 'they are leaving' });
    assert.equal(res.status, 201);
    assert.equal(res.body.settled, null, 'nothing is settled yet');
    assert.equal(res.body.refund.status, 'created');

    const s = await sub(farm.farm.id);
    assert.equal(s.status, 'active');
    assert.equal((await api('POST', '/animals', {
      token: farm.token, body: { name: 'Still Paid Up', sex: 'doe' } })).status, 201);

    // No credit note either: a number burned on a refund that then failed is a
    // gap in a series an auditor asks about.
    const { rows } = await adminQuery(
      'SELECT credit_note_number FROM refund WHERE payment_id = $1', [payment.id]);
    assert.equal(rows[0].credit_note_number, null);
  });
});

/* ---------------------------------------------------------------- webhooks -- */

describe('the gateway telling us how it went', () => {
  test('refund.processed settles it, and a retry does not settle it twice', async () => {
    mode = 'accept';
    const { farm, payment } = await paidFarm();
    const admin = await makeAdmin('billing');
    const made = await refund(payment.id, admin.token, { reason: 'leaving' });
    const row = made.body.refund;

    const entity = { id: row.gateway_refund_id, payment_id: payment.gateway_payment_id,
                     amount: 99900, status: 'processed', notes: { refund_id: row.id } };

    const first = await refundWebhook('refund.processed', entity);
    assert.equal(first.status, 200);
    assert.equal(first.body.result, 'refund settled');

    const s = await sub(farm.farm.id);
    assert.equal(s.status, 'cancelled');

    // Razorpay retries on a timeout, on a 500 and on a deploy that restarted
    // mid-request. Settling twice would take the year off twice.
    const again = await refundWebhook('refund.processed', entity);
    assert.equal(again.body.result, 'refund already settled');
    const after = await sub(farm.farm.id);
    assert.equal(after.current_period_end, s.current_period_end);

    const { rows } = await adminQuery(
      'SELECT count(*)::int AS n FROM refund WHERE payment_id = $1', [payment.id]);
    assert.equal(rows[0].n, 1);
  });

  test('it is matched by our own id when the gateway’s is not known yet', async () => {
    /*
     * A real ordering on a slow connection: the webhook arrives before the
     * response to the call that caused it has been written down. `notes` is
     * what carries our refund id out to the gateway and back.
     */
    mode = 'accept';
    const { payment } = await paidFarm();
    const admin = await makeAdmin('billing');
    const row = (await refund(payment.id, admin.token, { reason: 'leaving' })).body.refund;
    await adminQuery('UPDATE refund SET gateway_refund_id = NULL WHERE id = $1', [row.id]);

    const res = await refundWebhook('refund.processed', {
      id: 'rfnd_never_seen', amount: 99900, status: 'processed',
      notes: { refund_id: row.id },
    });
    assert.equal(res.body.result, 'refund settled');

    const { rows } = await adminQuery(
      'SELECT status, gateway_refund_id FROM refund WHERE id = $1', [row.id]);
    assert.equal(rows[0].status, 'processed');
    assert.equal(rows[0].gateway_refund_id, 'rfnd_never_seen');
  });

  test('refund.failed raises it as urgent and changes nothing about the farm', async () => {
    mode = 'accept';
    const { farm, payment } = await paidFarm();
    const admin = await makeAdmin('billing');
    const row = (await refund(payment.id, admin.token, { reason: 'leaving' })).body.refund;

    const res = await refundWebhook('refund.failed', {
      id: row.gateway_refund_id, status: 'failed',
      error_description: 'the bank rejected the credit',
      notes: { refund_id: row.id },
    });
    assert.equal(res.body.result, 'refund failed');

    const s = await sub(farm.farm.id);
    assert.equal(s.status, 'active', 'a failed refund must not take their days');

    // We told a customer their money was coming back and it did not. Nothing
    // chases that on its own, so it goes to the top of the attention list.
    const dash = await api('GET', '/admin/billing?format=json', { token: admin.token });
    const mine = dash.body.exceptions.find((x) => x.ref === row.id);
    assert.ok(mine, 'a failed refund must be reported');
    assert.equal(mine.kind, 'refund_failed');
    assert.equal(mine.severity, 1);
    assert.match(mine.detail, /bank rejected/);
  });

  test('a late refund.failed does not un-settle a refund that already went', async () => {
    mode = 'instant';
    const { farm, payment } = await paidFarm();
    const admin = await makeAdmin('billing');
    const row = (await refund(payment.id, admin.token, { reason: 'leaving' })).body.refund;

    await refundWebhook('refund.failed', {
      id: row.gateway_refund_id, status: 'failed', notes: { refund_id: row.id },
    });

    const { rows } = await adminQuery('SELECT status FROM refund WHERE id = $1', [row.id]);
    assert.equal(rows[0].status, 'processed', 'events can arrive out of order');
    assert.equal((await sub(farm.farm.id)).status, 'cancelled');
  });

  test('a refund webhook we have no row for is flagged, not guessed at', async () => {
    const res = await refundWebhook('refund.processed', {
      id: `rfnd_stranger_${RUN}`, amount: 99900, status: 'processed',
    });
    assert.equal(res.status, 200, 'answer 200 or Razorpay retries it for a day');
    assert.equal(res.body.result, 'no matching refund');
  });

  test('a refund that never settles is chased by hand', async () => {
    mode = 'accept';
    const { farm, payment } = await paidFarm();
    const admin = await makeAdmin('billing');
    const row = (await refund(payment.id, admin.token, { reason: 'leaving' })).body.refund;

    // Razorpay's normal speed is five to seven working days. Past ten,
    // something is wrong rather than slow.
    await adminQuery(
      `UPDATE refund SET created_at = now() - interval '12 days' WHERE id = $1`, [row.id]);

    const dash = await api('GET', '/admin/billing?format=json', { token: admin.token });
    const mine = dash.body.exceptions.find((x) => x.ref === row.id);
    assert.ok(mine, 'a refund stuck in flight must be reported');
    assert.equal(mine.kind, 'refund_stuck');

    // The gateway's own dashboard shows it processed; no webhook ever arrived.
    const settled = await api('POST', `/admin/billing/refunds/${row.id}/settle`, {
      token: admin.token,
      body: { reason: 'Razorpay shows it processed, no webhook came',
              gateway_refund_id: 'rfnd_from_their_dashboard' },
    });
    assert.equal(settled.status, 200);
    assert.equal(settled.body.settled, true);
    assert.equal((await sub(farm.farm.id)).status, 'cancelled');

    const again = await api('POST', `/admin/billing/refunds/${row.id}/settle`, {
      token: admin.token, body: { reason: 'pressed twice' } });
    assert.equal(again.body.settled, false, 'settling by hand is idempotent too');

    const support = await makeAdmin('support');
    assert.equal((await api('POST', `/admin/billing/refunds/${row.id}/settle`, {
      token: support.token, body: { reason: 'trying' } })).status, 403);
  });
});

/* ----------------------------------------------------------------- gateway -- */

describe('talking to the gateway', () => {
  test('a refund the gateway refuses leaves a record, not silence', async () => {
    mode = 'refuse';
    const { farm, payment } = await paidFarm();
    const admin = await makeAdmin('billing');

    const res = await refund(payment.id, admin.token, { reason: 'they asked' });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /payment provider refused/);

    // The row exists and says why. Money that we told a customer was coming
    // back and that never left must never be invisible.
    const { rows } = await adminQuery(
      'SELECT status, failed_reason FROM refund WHERE payment_id = $1', [payment.id]);
    assert.equal(rows[0].status, 'failed');
    assert.match(rows[0].failed_reason, /fully refunded already/);

    assert.equal((await sub(farm.farm.id)).status, 'active');

    const dash = await api('GET', '/admin/billing?format=json', { token: admin.token });
    assert.ok(dash.body.exceptions.some((x) => x.kind === 'refund_failed'
      && x.farm_id === farm.farm.id));
  });

  test('the gateway is called with an idempotency key and our own refund id', async () => {
    mode = 'accept';
    asked = [];
    const { payment } = await paidFarm();
    const admin = await makeAdmin('billing');
    const row = (await refund(payment.id, admin.token,
      { amount_paise: 50000, reason: 'half back' })).body.refund;

    const call = asked.at(-1);
    assert.ok(call.url.includes(`/v1/payments/${payment.gateway_payment_id}/refund`),
      'a refund goes against the payment, not the link');
    assert.equal(call.payload.amount, 50000);
    assert.equal(call.payload.speed, 'normal');
    assert.equal(call.payload.notes.refund_id, row.id);
    // A retry after a timeout must return the first refund rather than making
    // a second one — the difference between paying a customer once and twice.
    assert.equal(call.idempotency, row.id);
  });

  test('money taken by hand goes back by hand, and settles when it does', async () => {
    // There is no webhook coming for a bank transfer. The person recording it
    // is the confirmation, exactly as they were for the payment.
    const { farm, payment } = await paidFarm({ gateway: 'offline' });
    asked = [];
    const admin = await makeAdmin('billing');

    const res = await refund(payment.id, admin.token, {
      reason: 'sent back by UPI', reference: 'UTR-BACK-1' });
    assert.equal(res.status, 201);
    assert.equal(res.body.settled.settled, true);
    assert.equal(asked.length, 0, 'the gateway has nothing to do with an offline refund');

    const { rows } = await adminQuery(
      'SELECT gateway, gateway_refund_id, status FROM refund WHERE payment_id = $1',
      [payment.id]);
    assert.equal(rows[0].gateway, 'offline');
    assert.equal(rows[0].gateway_refund_id, 'UTR-BACK-1');
    assert.equal(rows[0].status, 'processed');
    assert.equal((await sub(farm.farm.id)).status, 'cancelled');
  });

  test('the same transfer cannot be recorded against two refunds', async () => {
    /*
     * The reference goes in a column that is unique because it normally holds
     * the gateway's own id. A repeated UTR is a typo or the same refund being
     * entered twice, and both deserve a sentence rather than a 500 — which is
     * what a browser pass got, before the check existed.
     */
    const utr = `UTR-DUPLICATE-${RUN}`;
    const first = await paidFarm({ gateway: 'offline' });
    const second = await paidFarm({ gateway: 'offline' });
    const admin = await makeAdmin('billing');

    assert.equal((await refund(first.payment.id, admin.token,
      { reason: 'sent back', reference: utr })).status, 201);

    const dup = await refund(second.payment.id, admin.token,
      { reason: 'sent back again', reference: utr });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already recorded/);

    // And nothing was left half-done on the second farm.
    const { rows } = await adminQuery(
      'SELECT count(*)::int AS n FROM refund WHERE payment_id = $1', [second.payment.id]);
    assert.equal(rows[0].n, 0);
    assert.equal((await sub(second.farm.farm.id)).status, 'active');
  });
});

/* ------------------------------------------------------------- the farmer -- */

describe('what the farmer sees', () => {
  test('the refund is on their own billing screen, with the credit note', async () => {
    mode = 'instant';
    const { farm, payment } = await paidFarm();
    const admin = await makeAdmin('billing');
    const done = await refund(payment.id, admin.token,
      { amount_paise: 30000, kind: 'goodwill', reason: 'service credit' });

    const billing = await api('GET', '/billing', { token: farm.token });
    assert.equal(billing.status, 200);
    const row = billing.body.history.find((h) => h.id === payment.id);
    assert.equal(row.refunded_paise, 30000);
    assert.equal(row.credit_note_number, done.body.settled.credit_note);
    assert.ok(row.refunded_at, 'and when it went back');
  });

  test('one farm cannot see another’s refunds', async () => {
    mode = 'instant';
    const a = await paidFarm();
    const b = await paidFarm();
    const admin = await makeAdmin('billing');
    await refund(b.payment.id, admin.token, { reason: 'B is leaving' });

    const billing = await api('GET', '/billing', { token: a.farm.token });
    assert.ok(!billing.body.history.some((h) => h.refunded_paise),
      "A must not see B's refund");

    // And through the table directly, which is where RLS is doing the work.
    const { rows } = await adminQuery(
      `SELECT has_table_privilege('rabbitry_app', 'refund', 'INSERT') AS can_write,
              has_table_privilege('rabbitry_app', 'refund', 'SELECT') AS can_read`);
    assert.equal(rows[0].can_write, false, 'a farm must never write its own refund');
    assert.equal(rows[0].can_read, true, 'but must be able to see one that happened');
  });

  test('the farmer-facing role cannot call the refund functions', async () => {
    for (const fn of ['billing_create_refund(uuid, int, refund_kind_t, text, uuid, text)',
                      'billing_settle_refund(uuid, text)',
                      'billing_fail_refund(uuid, text)',
                      'next_credit_note_number(date)']) {
      const { rows } = await adminQuery(
        `SELECT has_function_privilege('rabbitry_app', $1, 'EXECUTE') AS can`, [fn]);
      assert.equal(rows[0].can, false, `rabbitry_app must not be able to execute ${fn}`);
    }
  });
});
