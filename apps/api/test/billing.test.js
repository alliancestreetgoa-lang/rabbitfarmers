/**
 * Razorpay billing.
 *
 * The webhook is the only route in this application that an anonymous caller on
 * the internet can reach and that moves money's worth of state. If its
 * signature check is wrong, anybody who guesses the URL gives themselves a year
 * of a paid subscription by POSTing a JSON body — so most of this file is spent
 * trying to do exactly that.
 *
 * The gateway itself is a stub. api.razorpay.com is unreachable from here, and
 * the cases worth testing are a retried webhook, a forged one, and a farmer who
 * closes the browser on the way back from paying. None of those are things you
 * arrange against a real payment provider.
 */
import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { api, signupFarm, cleanup, closePools, adminQuery } from './helpers.js';

const KEY_ID = 'rzp_test_local';
const KEY_SECRET = 'a-test-key-secret';
const WEBHOOK_SECRET = 'a-test-webhook-secret';

let server;
/** Every payment link the API asked the gateway to make. */
let created = [];
/** How the stub should answer. */
let reply = null;

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      if (reply) {
        const r = reply(payload);
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(r.body ?? {}));
      }
      created.push(payload);
      const id = `plink_${created.length}${process.pid}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id, short_url: `https://rzp.io/i/${id}`, amount: payload.amount,
        reference_id: payload.reference_id, status: 'created',
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
  await cleanup();
  await closePools();
});

/*
 * Event ids have to be unique per RUN, not per test.
 *
 * webhook_event rows outlive the process — that is the whole point of them — so
 * a hard-coded id is a duplicate on the second run of this file and the test
 * sees the idempotency working instead of the thing it meant to check.
 */
const RUN = `${process.pid}${Date.now().toString(36)}`;
const evt = (name) => `evt_${name}_${RUN}`;

const sign = (raw, secret = WEBHOOK_SECRET) =>
  createHmac('sha256', secret).update(raw, 'utf8').digest('hex');

/** Post a webhook the way Razorpay would, signed over the exact bytes. */
async function webhook(body, { signature, eventId, secret } = {}) {
  const raw = JSON.stringify(body);
  return api('POST', '/webhooks/razorpay', {
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature ?? sign(raw, secret ?? WEBHOOK_SECRET),
      ...(eventId ? { 'x-razorpay-event-id': eventId } : {}),
    },
    rawBody: raw,
  });
}

const paidEvent = (linkId, amount, paymentId = `pay_${Math.random().toString(36).slice(2)}`) => ({
  event: 'payment_link.paid',
  payload: {
    payment_link: { entity: { id: linkId, amount, status: 'paid' } },
    payment: { entity: { id: paymentId, amount } },
  },
});

/** A farm whose trial has run out, with a live payment link waiting. */
async function farmReadyToPay({ period = 'yearly' } = {}) {
  const f = await signupFarm();
  await adminQuery(
    `UPDATE subscription SET trial_ends_on = current_date - 1, status = 'trialing'
      WHERE farm_id = $1`, [f.farm.id]);

  const res = await api('POST', '/billing/pay', {
    token: f.token, body: { billing_period: period } });
  assert.equal(res.status, 201, res.text);

  const { rows } = await adminQuery(
    'SELECT gateway_link_id, amount_paise FROM payment WHERE farm_id = $1', [f.farm.id]);
  return { farm: f, linkId: rows[0].gateway_link_id, amount: rows[0].amount_paise,
           payUrl: res.body.pay_url };
}

describe('asking to pay', () => {
  test('a lapsed farm was never blocked, pays anyway, and the payment applies', async () => {
    const { farm, linkId, amount } = await farmReadyToPay();

    /*
     * This asserted a 402 until migration 0031. Migration 0003's promise was
     * "reads fine, writes refused"; 0031 replaced it with "everything always
     * works", so the paywall this test was written to prove is gone and a lapsed
     * farm writes exactly like any other.
     *
     * The rest of the test still earns its place: the gateway path is dormant,
     * not deleted, and a webhook that stopped applying payments correctly is how
     * charging again would fail silently on the day it is switched back on.
     */
    assert.equal((await api('POST', '/animals', {
      token: farm.token, body: { name: 'Never Blocked', sex: 'doe' } })).status, 201);
    assert.equal((await api('GET', '/animals', { token: farm.token })).status, 200);

    const res = await webhook(paidEvent(linkId, amount));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.result, 'applied');

    assert.equal((await api('POST', '/animals', {
      token: farm.token, body: { name: 'Unblocked', sex: 'doe' } })).status, 201);

    const me = await api('GET', '/auth/me', { token: farm.token });
    assert.equal(me.body.subscription.status, 'active');
    assert.equal(me.body.subscription.access, 'full');
    assert.equal(me.body.subscription.trial_days_left, null,
      'a paid farm is not still on trial');
  });

  test('the price comes from the farm, never from the request', async () => {
    // A price in a request body is a price a customer can edit.
    const f = await signupFarm();
    const res = await api('POST', '/billing/pay', {
      token: f.token,
      body: { billing_period: 'yearly', amount_paise: 100, amount: 100, price: 1 },
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.payment.amount_paise, 99900, 'the ₹999 list price, not ₹1');
  });

  test('a grandfathered farm renews at the price it was promised', async () => {
    const f = await signupFarm();
    await adminQuery(`
      UPDATE subscription SET locked_price_yearly_paise = 49900, price_locked_at = now()
       WHERE farm_id = $1`, [f.farm.id]);

    const res = await api('POST', '/billing/pay', {
      token: f.token, body: { billing_period: 'yearly' } });
    assert.equal(res.body.payment.amount_paise, 49900,
      'grandfathering is meaningless if the renew button quotes today’s number');
  });

  test('paying early keeps the days already paid for', async () => {
    // Otherwise the sensible move is to wait until the last day, and then miss it.
    const f = await signupFarm();
    await adminQuery(`
      UPDATE subscription SET status = 'active', trial_ends_on = NULL,
             current_period_end = current_date + 100 WHERE farm_id = $1`, [f.farm.id]);

    const pay = await api('POST', '/billing/pay', {
      token: f.token, body: { billing_period: 'yearly' } });
    const { rows } = await adminQuery(
      'SELECT gateway_link_id, amount_paise FROM payment WHERE farm_id = $1', [f.farm.id]);
    await webhook(paidEvent(rows[0].gateway_link_id, rows[0].amount_paise));

    const { rows: sub } = await adminQuery(
      `SELECT current_period_end - current_date AS days FROM subscription WHERE farm_id = $1`,
      [f.farm.id]);
    assert.equal(Number(sub[0].days), 465, '100 days left plus a year');
    assert.ok(pay.body.pay_url.startsWith('https://rzp.io/'));
  });

  test('paying late does not buy a month that has already gone', async () => {
    const f = await signupFarm();
    await adminQuery(`
      UPDATE subscription SET status = 'suspended', trial_ends_on = NULL,
             current_period_end = current_date - 40 WHERE farm_id = $1`, [f.farm.id]);

    const res = await api('POST', '/billing/pay', {
      token: f.token, body: { billing_period: 'monthly' } });
    assert.equal(res.status, 201, res.text);
    const { rows } = await adminQuery(
      'SELECT gateway_link_id, amount_paise FROM payment WHERE farm_id = $1', [f.farm.id]);
    await webhook(paidEvent(rows[0].gateway_link_id, rows[0].amount_paise));

    const { rows: sub } = await adminQuery(
      `SELECT current_period_end - current_date AS days FROM subscription WHERE farm_id = $1`,
      [f.farm.id]);
    assert.equal(Number(sub[0].days), 30, 'thirty days from today, not from six weeks ago');
  });

  test('a farm hand cannot see or start a payment', async () => {
    const f = await signupFarm();
    const hand = await api('POST', '/staff', {
      token: f.token,
      body: { full_name: 'Ravi', phone: `+9155${String(Date.now()).slice(-8)}` } });
    const login = await api('POST', `/staff/${hand.body.staff.id}/login`, {
      token: f.token, body: {} });
    const ravi = await api('POST', '/auth/signin', {
      body: { phone: hand.body.staff.phone, password: login.body.temporary_password } });

    assert.equal((await api('GET', '/billing', { token: ravi.body.token })).status, 403);
    assert.equal((await api('POST', '/billing/pay', {
      token: ravi.body.token, body: {} })).status, 403);
  });
});

describe('the webhook is the only thing that can be trusted', () => {
  test('an unsigned webhook does nothing', async () => {
    const { farm, linkId, amount } = await farmReadyToPay();
    const res = await api('POST', '/webhooks/razorpay', {
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify(paidEvent(linkId, amount)),
    });
    assert.equal(res.status, 400);
    await assertStillUnpaid(farm);
  });

  test('a forged signature does nothing', async () => {
    const { farm, linkId, amount } = await farmReadyToPay();
    const res = await webhook(paidEvent(linkId, amount), { secret: 'not-the-secret' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /signature/i);
    await assertStillUnpaid(farm);
  });

  test('a body altered after signing does nothing', async () => {
    /*
     * The attack the raw-bytes rule exists for. Sign a cheap body, send an
     * expensive one — if the endpoint re-serialised the parsed JSON before
     * checking, or checked the parsed object, this would go through.
     */
    const { farm, linkId, amount } = await farmReadyToPay();
    const honest = JSON.stringify(paidEvent(linkId, amount));
    const tampered = JSON.stringify(paidEvent(linkId, amount * 10));

    const res = await api('POST', '/webhooks/razorpay', {
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': sign(honest),
      },
      rawBody: tampered,
    });
    assert.equal(res.status, 400);
    await assertStillUnpaid(farm);
  });

  test('a signature of the right length but wrong content does nothing', async () => {
    const { farm, linkId, amount } = await farmReadyToPay();
    const raw = JSON.stringify(paidEvent(linkId, amount));
    const real = sign(raw);
    // Same length, one character different — the case a constant-time compare
    // exists for, and the case a length-only check would pass.
    const near = `${real.slice(0, -1)}${real.endsWith('a') ? 'b' : 'a'}`;
    const res = await webhook(paidEvent(linkId, amount), { signature: near });
    assert.equal(res.status, 400);
    await assertStillUnpaid(farm);
  });

  test('a retried webhook pays for one year, not two', async () => {
    /*
     * Razorpay retries on a timeout, a 500, and a deploy that restarted
     * mid-request. This is the difference between a subscription and a gift.
     */
    const { farm, linkId, amount } = await farmReadyToPay();
    const event = paidEvent(linkId, amount);

    const first = await webhook(event, { eventId: evt('retry') });
    assert.equal(first.body.result, 'applied');

    const { rows: once } = await adminQuery(
      `SELECT current_period_end FROM subscription WHERE farm_id = $1`, [farm.farm.id]);

    for (let i = 0; i < 3; i++) {
      const again = await webhook(event, { eventId: evt('retry') });
      assert.equal(again.status, 200, 'a duplicate must be accepted, not retried forever');
      assert.equal(again.body.duplicate, true);
    }

    const { rows: after } = await adminQuery(
      `SELECT current_period_end FROM subscription WHERE farm_id = $1`, [farm.farm.id]);
    assert.equal(String(after[0].current_period_end), String(once[0].current_period_end));

    const { rows: inv } = await adminQuery(
      'SELECT count(*)::int AS n FROM invoice WHERE farm_id = $1', [farm.farm.id]);
    assert.equal(inv[0].n, 1, 'one payment, one invoice');
  });

  test('the same event delivered with a new id still only pays once', async () => {
    // Belt and braces: the event id catches the retry, and the payment row's
    // own state catches anything that gets past it.
    const { farm, linkId, amount } = await farmReadyToPay();
    const event = paidEvent(linkId, amount);

    await webhook(event, { eventId: evt('a') });
    const second = await webhook(event, { eventId: evt('b') });
    assert.equal(second.body.result, 'already applied');

    const { rows } = await adminQuery(
      'SELECT count(*)::int AS n FROM invoice WHERE farm_id = $1', [farm.farm.id]);
    assert.equal(rows[0].n, 1);
  });

  test('a link that belongs to nobody is accepted and flagged', async () => {
    const res = await webhook(paidEvent('plink_not_ours', 99900), { eventId: evt('orphan') });
    assert.equal(res.status, 200, 'answer 200 or Razorpay retries it for a day');
    // Not "already applied". Somebody paid a link this system has no payment
    // row for, which means money arrived that cannot be attributed to a farm —
    // and it is this string the admin billing screen shows the person working
    // out where it went.
    assert.equal(res.body.result, 'no matching payment');
  });

  test('paying the wrong amount is not a payment', async () => {
    const { farm, linkId, amount } = await farmReadyToPay();
    const res = await webhook(paidEvent(linkId, Math.floor(amount / 10)),
      { eventId: evt('short') });
    assert.equal(res.status, 200);

    const { rows } = await adminQuery(
      'SELECT status, failed_reason FROM payment WHERE gateway_link_id = $1', [linkId]);
    assert.equal(rows[0].status, 'failed');
    assert.match(rows[0].failed_reason, /expected 99900 paise, received 9990/);
    await assertStillUnpaid(farm);
  });

  test('a failed card does not lock anybody out', async () => {
    /*
     * A declined card is not a lapse. The farmer will try again in a minute,
     * and downgrading them mid-round for a bank's decision is how somebody
     * loses a day's records over a payment that eventually went through.
     */
    const f = await signupFarm();
    await adminQuery(`
      UPDATE subscription SET status = 'active', trial_ends_on = NULL,
             current_period_end = current_date + 10 WHERE farm_id = $1`, [f.farm.id]);

    const res = await webhook({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_declined', error_description: 'card declined' } } },
    }, { eventId: evt('failed') });
    assert.equal(res.status, 200);

    const me = await api('GET', '/auth/me', { token: f.token });
    assert.equal(me.body.subscription.access, 'full', 'a declined card must not cost access');
  });

  test('every webhook is kept, whatever it was', async () => {
    // When a farmer says they paid and the app disagrees, this is the only
    // place with both sides of the story.
    const { linkId, amount } = await farmReadyToPay();
    await webhook(paidEvent(linkId, amount), { eventId: evt('kept') });

    const { rows } = await adminQuery(
      `SELECT event, result, processed_at, payload->>'event' AS in_body
         FROM webhook_event WHERE id = $1`, [evt('kept')]);
    assert.equal(rows[0].event, 'payment_link.paid');
    assert.equal(rows[0].in_body, 'payment_link.paid');
    assert.equal(rows[0].result, 'applied');
    assert.ok(rows[0].processed_at);
  });
});

describe('the invoice', () => {
  test('GST is inside the price, not added to it', async () => {
    // ₹999 on the pricing page means the farmer pays ₹999.
    const { farm, linkId, amount } = await farmReadyToPay();
    await webhook(paidEvent(linkId, amount), { eventId: evt('gst') });

    const { rows } = await adminQuery(
      'SELECT number, subtotal_paise, tax_paise, total_paise FROM invoice WHERE farm_id = $1',
      [farm.farm.id]);
    assert.equal(rows[0].total_paise, 99900);
    assert.equal(rows[0].subtotal_paise + rows[0].tax_paise, rows[0].total_paise,
      'the split has to add back up to what was charged');
    assert.equal(rows[0].subtotal_paise, 84661);   // round(99900 / 1.18)
    assert.equal(rows[0].tax_paise, 15239);
  });

  test('numbers are consecutive and carry the financial year', async () => {
    // GST wants a consecutive series unique within the year, and India's
    // financial year starts in April.
    const a = await farmReadyToPay();
    const b = await farmReadyToPay();
    await webhook(paidEvent(a.linkId, a.amount), { eventId: evt('n1') });
    await webhook(paidEvent(b.linkId, b.amount), { eventId: evt('n2') });

    const { rows } = await adminQuery(
      `SELECT number FROM invoice WHERE farm_id IN ($1,$2) ORDER BY number`,
      [a.farm.farm.id, b.farm.farm.id]);
    assert.match(rows[0].number, /^RB\/\d{4}-\d{2}\/\d{5}$/);
    const n = (s) => Number(s.split('/')[2]);
    assert.equal(n(rows[1].number), n(rows[0].number) + 1, 'a gap is a question from an auditor');
  });

  test('the financial year turns over in April, not January', async () => {
    const { rows } = await adminQuery(`
      SELECT indian_financial_year('2026-03-31'::date) AS before,
             indian_financial_year('2026-04-01'::date) AS after`);
    assert.equal(rows[0].before, '2025-26');
    assert.equal(rows[0].after, '2026-27');
  });

  test('the farm can see what it paid, and another farm cannot', async () => {
    const mine = await farmReadyToPay();
    const theirs = await farmReadyToPay();
    await webhook(paidEvent(mine.linkId, mine.amount), { eventId: evt('h') });

    const seen = await api('GET', '/billing', { token: mine.farm.token });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.history.length, 1);
    assert.equal(seen.body.history[0].status, 'paid');
    assert.ok(seen.body.history[0].invoice_number);

    const other = await api('GET', '/billing', { token: theirs.farm.token });
    assert.ok(!other.body.history.some((h) => h.status === 'paid'),
      'one farm must not see another’s payments');
  });
});

describe('coming back from the payment page', () => {
  test('a signed return applies the payment before the webhook arrives', async () => {
    // The browser gets back first. The screen should be able to say "paid"
    // without waiting for a server-to-server call.
    const { farm, linkId } = await farmReadyToPay();
    const paymentId = 'pay_return_1';
    const signature = createHmac('sha256', KEY_SECRET)
      .update(`${linkId}||paid|${paymentId}`, 'utf8').digest('hex');

    const res = await api('GET',
      `/billing/return?razorpay_payment_link_id=${linkId}`
      + `&razorpay_payment_link_reference_id=`
      + `&razorpay_payment_link_status=paid&razorpay_payment_id=${paymentId}`
      + `&razorpay_signature=${signature}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /Paid — thank you/);

    const me = await api('GET', '/auth/me', { token: farm.token });
    assert.equal(me.body.subscription.status, 'active');
  });

  test('an unsigned return grants nothing', async () => {
    const { farm, linkId } = await farmReadyToPay();
    const res = await api('GET',
      `/billing/return?razorpay_payment_link_id=${linkId}`
      + `&razorpay_payment_link_status=paid&razorpay_payment_id=pay_x`
      + `&razorpay_signature=nonsense`);
    assert.equal(res.status, 400);
    await assertStillUnpaid(farm);
  });

  test('the return and the webhook together still pay for one year', async () => {
    const { farm, linkId, amount } = await farmReadyToPay();
    const paymentId = 'pay_both_1';
    const signature = createHmac('sha256', KEY_SECRET)
      .update(`${linkId}||paid|${paymentId}`, 'utf8').digest('hex');

    await api('GET', `/billing/return?razorpay_payment_link_id=${linkId}`
      + `&razorpay_payment_link_reference_id=&razorpay_payment_link_status=paid`
      + `&razorpay_payment_id=${paymentId}&razorpay_signature=${signature}`);
    const { rows: once } = await adminQuery(
      'SELECT current_period_end FROM subscription WHERE farm_id = $1', [farm.farm.id]);

    await webhook(paidEvent(linkId, amount, paymentId), { eventId: evt('both') });

    const { rows: after } = await adminQuery(
      'SELECT current_period_end FROM subscription WHERE farm_id = $1', [farm.farm.id]);
    assert.equal(String(after[0].current_period_end), String(once[0].current_period_end),
      'both arriving is the normal case, not the exception');
    const { rows: inv } = await adminQuery(
      'SELECT count(*)::int AS n FROM invoice WHERE farm_id = $1', [farm.farm.id]);
    assert.equal(inv[0].n, 1);
  });
});

describe('when the gateway is not there', () => {
  test('an unconfigured farm is told plainly rather than shown a broken button', async () => {
    const keep = process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_ID;
    try {
      const f = await signupFarm();
      const res = await api('POST', '/billing/pay', { token: f.token, body: {} });
      assert.equal(res.status, 503);
      assert.match(res.body.error, /not switched on/);

      const view = await api('GET', '/billing', { token: f.token });
      assert.equal(view.body.gateway_ready, false,
        'the app needs to know not to offer the button');
    } finally {
      process.env.RAZORPAY_KEY_ID = keep;
    }
  });

  test('a gateway error leaves a failed payment and no charge', async () => {
    reply = () => ({ status: 500, body: { error: { description: 'gateway on fire' } } });
    try {
      const f = await signupFarm();
      const res = await api('POST', '/billing/pay', {
        token: f.token, body: { billing_period: 'yearly' } });
      assert.equal(res.status, 502);

      const { rows } = await adminQuery(
        'SELECT status, failed_reason FROM payment WHERE farm_id = $1', [f.farm.id]);
      assert.equal(rows[0].status, 'failed');
      assert.match(rows[0].failed_reason, /gateway on fire/);
    } finally {
      reply = null;
    }
  });
});

async function assertStillUnpaid(farm) {
  const { rows } = await adminQuery(
    `SELECT status FROM subscription WHERE farm_id = $1`, [farm.farm.id]);
  assert.notEqual(rows[0].status, 'active', 'something granted a paid subscription');
  const { rows: inv } = await adminQuery(
    'SELECT count(*)::int AS n FROM invoice WHERE farm_id = $1', [farm.farm.id]);
  assert.equal(inv[0].n, 0, 'an invoice was raised for a payment that never happened');
}
