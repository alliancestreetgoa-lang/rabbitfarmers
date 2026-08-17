/**
 * The admin billing screen.
 *
 * Two things are being protected here and they pull in opposite directions.
 *
 * The first is that this screen reaches across every tenant and shows what the
 * whole platform earns, so most of this file is spent trying to open it without
 * being allowed to — with no session, with a farmer's session, and with an
 * admin whose role does not include money.
 *
 * The second is that its whole reason to exist is showing money that has gone
 * wrong. A dashboard that quietly omits a payment taken from a farm that is
 * still locked out is worse than no dashboard at all, so the rest of the file
 * breaks billing in a specific way and insists the screen says so.
 *
 * Nothing here talks to Razorpay. Payments are made the way the webhook makes
 * them — a row, then billing_apply_payment — because that is the function whose
 * behaviour matters, and the gateway is not reachable from a test anyway.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupFarm, makeAdmin, cleanup, closePools, adminQuery } from './helpers.js';

/*
 * Unique per run, like billing.test.js. webhook_event rows outlive the process
 * on purpose, so a hard-coded id is a duplicate on the second run of this file
 * and the test would be watching idempotency instead of what it meant to check.
 */
const RUN = `${process.pid}${Date.now().toString(36)}`;
let n = 0;
const nextId = (what) => `${what}_${RUN}_${++n}`;

after(async () => {
  // Deliveries this file invented. cleanup() removes the ones attached to a
  // farm; an unattributed one has no farm to be removed with, and leaving it
  // behind would put a permanent entry on a real dashboard's attention list.
  await adminQuery(`DELETE FROM webhook_event WHERE id LIKE $1`, [`%_${RUN}_%`]);
  await cleanup();
  await closePools();
});

/** A farm nobody else in the suite can collide with, by name. */
async function namedFarm(label) {
  const name = `${label} ${RUN}`;
  const f = await signupFarm({ farm_name: name });
  return { ...f, name };
}

/** A payment link, unpaid. What POST /billing/pay leaves behind. */
async function link(farmId, { amount = 99900, period = 'yearly', days = 365 } = {}) {
  const id = nextId('plink');
  await adminQuery(`
    INSERT INTO payment (farm_id, gateway_link_id, amount_paise, billing_period,
                         covers_days, status)
    VALUES ($1, $2, $3, $4::billing_period_t, $5, 'created')`,
    [farmId, id, amount, period, days]);
  return id;
}

/** Pay one, the way the webhook does. */
const pay = (linkId, paymentId = nextId('pay')) =>
  adminQuery('SELECT * FROM billing_apply_payment($1,$2,$3)', [linkId, paymentId, null])
    .then((r) => r.rows[0]);

const dash = (token, query = '') =>
  api('GET', `/admin/billing?format=json${query}`, { token });

/* ------------------------------------------------------------ who may look -- */

describe('who may open the money screen', () => {
  test('nobody, without an admin session', async () => {
    const res = await api('GET', '/admin/billing?format=json');
    assert.equal(res.status, 401, 'platform revenue must not be readable anonymously');
    assert.ok(!res.text.includes('collected'), res.text.slice(0, 120));
  });

  test('not with a farmer\'s token either', async () => {
    // A farm session is a perfectly good token, for the farm's own API. The
    // admin console does not accept it, and the failure must not be a 500 that
    // leaks a query.
    const f = await namedFarm('Curious Farm');
    const res = await api('GET', '/admin/billing?format=json', { token: f.token });
    assert.equal(res.status, 401);
  });

  test('not support — that is the line docs/10 draws', async () => {
    const support = await makeAdmin('support');
    const res = await dash(support.token);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /superadmin or billing/);
  });

  test('billing and superadmin, yes', async () => {
    for (const role of ['billing', 'superadmin']) {
      const admin = await makeAdmin(role);
      const res = await dash(admin.token);
      assert.equal(res.status, 200, `${role} must be able to open billing`);
      assert.ok(res.body.summary, 'the summary is the page');
    }
  });

  test('support is not offered a link to a page it cannot open', async () => {
    // Offering a button that answers 403 teaches whoever is on the rota that
    // the console is broken, and they stop trusting the next thing it says.
    const support = await makeAdmin('support');
    const page = await api('GET', '/admin/farms', { token: support.token });
    assert.ok(!page.text.includes('href="/admin/billing"'),
      'support was shown a billing link');

    const billing = await makeAdmin('billing');
    const shown = await api('GET', '/admin/farms', { token: billing.token });
    assert.ok(shown.text.includes('href="/admin/billing"'),
      'the billing role was not shown the billing link');
  });
});

/* -------------------------------------------------------------- the pages -- */

describe('the page a person actually opens', () => {
  test('it renders, with the money on it', async () => {
    /*
     * The JSON every other test here reads never touches the templates, so a
     * broken one would sail through the whole file and be found by whoever
     * opened the console. This is the test that opens the console.
     */
    const farm = await namedFarm('Rendered Farm');
    const applied = await pay(await link(farm.farm.id));
    const admin = await makeAdmin('billing');

    const res = await api('GET', `/admin/billing?q=${encodeURIComponent(farm.name)}`,
      { token: admin.token });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.ok(res.text.includes(farm.name), 'the farm is on the page');
    assert.ok(res.text.includes(applied.invoice_number), 'so is its invoice number');
    assert.ok(res.text.includes('₹999'), 'and what it paid');
    assert.ok(res.text.includes(`/admin/farms/${farm.farm.id}`), 'the farm name links to the farm');
    // Nothing left unrendered. A stray ${...} means a template hole.
    assert.ok(!res.text.includes('${'), 'unrendered template expression on the page');
    assert.ok(!res.text.includes('undefined</'), 'an undefined rendered into the page');
  });

  test('a delivery renders its payload', async () => {
    const farm = await namedFarm('Rendered Webhook Farm');
    const l = await link(farm.farm.id);
    const evt = await stuckDelivery(l, farm.farm.id);
    const admin = await makeAdmin('billing');

    const res = await api('GET', `/admin/billing/webhooks/${evt}`, {
      token: admin.token, headers: { accept: 'text/html' } });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(l), 'the link id is on the page');
    assert.ok(res.text.includes('payment_link.paid'));
    assert.ok(!res.text.includes('${'));
  });

  test('a farm with no payments says so rather than breaking', async () => {
    const farm = await namedFarm('Empty Farm');
    const admin = await makeAdmin('billing');
    const res = await api('GET', `/admin/farms/${farm.farm.id}`, { token: admin.token });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('Nothing paid yet'));
    assert.ok(!res.text.includes('${'));
  });
});

/* ------------------------------------------------------------------ ledger -- */

describe('the ledger', () => {
  test('every payment shows up, and only paid money is counted as collected', async () => {
    const farm = await namedFarm('Ledger Farm');

    const paidLink = await link(farm.farm.id);
    await pay(paidLink);
    await link(farm.farm.id, { amount: 9900, period: 'monthly', days: 30 });  // never paid

    const admin = await makeAdmin('billing');
    // Filtered by this farm's own name, because the suite runs files
    // concurrently and a global total is a different number by the time it is
    // read. The arithmetic being checked is per-payment either way.
    const res = await dash(admin.token, `&q=${encodeURIComponent(farm.name)}`);
    assert.equal(res.status, 200);

    const rows = res.body.payments;
    assert.equal(rows.length, 2, 'both the paid link and the unpaid one belong on the ledger');

    const paid = rows.find((p) => p.status === 'paid');
    const open = rows.find((p) => p.status === 'created');
    assert.equal(paid.amount_paise, 99900);
    assert.equal(open.amount_paise, 9900);
    assert.match(paid.invoice_number, /^RB\/\d{4}-\d{2}\/\d{5}$/);
    assert.equal(open.invoice_number, null, 'an unpaid link has not been invoiced');

    // GST is inside the price, so the split has to add back up to what was paid.
    assert.equal(paid.subtotal_paise + paid.tax_paise, paid.amount_paise);
    assert.equal(paid.tax_paise, 99900 - Math.round(99900 / 1.18));
  });

  test('the filters find one payment among everything else', async () => {
    const farm = await namedFarm('Filter Farm');
    const l = await link(farm.farm.id);
    const applied = await pay(l);
    const admin = await makeAdmin('billing');

    // By invoice number — what somebody holding a printed invoice searches by.
    const byInvoice = await dash(admin.token,
      `&q=${encodeURIComponent(applied.invoice_number)}`);
    assert.equal(byInvoice.body.payments.length, 1);
    assert.equal(byInvoice.body.payments[0].farm_name, farm.name);

    // By gateway link id — what somebody holding a Razorpay dashboard searches by.
    const byLink = await dash(admin.token, `&q=${l}`);
    assert.equal(byLink.body.payments.length, 1);

    // Status narrows rather than widens.
    const failed = await dash(admin.token,
      `&q=${encodeURIComponent(farm.name)}&status=failed`);
    assert.equal(failed.body.payments.length, 0);
  });

  test('a nonsense date filter does not take the page down', async () => {
    // The dates go into a ::date cast. 'yesterday' there is an error that would
    // 500 the whole screen, and a money screen that is down is a money screen
    // nobody trusts afterwards.
    const admin = await makeAdmin('billing');
    const res = await dash(admin.token, '&from=yesterday&to=soon');
    assert.equal(res.status, 200);
  });

  test('the tax on the return adds up', async () => {
    const admin = await makeAdmin('billing');
    const farm = await namedFarm('GST Farm');
    await pay(await link(farm.farm.id));

    const res = await dash(admin.token);
    const fy = res.body.fy[0];
    assert.ok(fy, 'a paid invoice must show up in the financial-year totals');
    // The identity a return is filed on. True regardless of what else the suite
    // is doing concurrently.
    assert.equal(fy.taxable_paise + fy.tax_paise, fy.total_paise);
    assert.ok(fy.invoices > 0);
    assert.match(fy.financial_year, /^\d{4}-\d{2}$/);
  });
});

/* -------------------------------------------------------------- exceptions -- */

describe('money that has gone wrong', () => {
  test('a farm that paid and is still locked out is the first thing on the page', async () => {
    const farm = await namedFarm('Locked Out Farm');
    await pay(await link(farm.farm.id));

    // The failure this exists to catch: the payment applied, and something
    // afterwards moved the period back. From the farmer's side this is a renew
    // button they have already pressed and paid.
    await adminQuery(`
      UPDATE subscription SET current_period_end = current_date - 1, status = 'grace',
                              grace_until = current_date - 1
       WHERE farm_id = $1`, [farm.farm.id]);

    const admin = await makeAdmin('billing');
    const res = await dash(admin.token);
    const mine = res.body.exceptions.filter((x) => x.farm_id === farm.farm.id);

    assert.equal(mine.length, 1, 'a paid farm that cannot write must be reported');
    assert.equal(mine[0].kind, 'paid_but_locked_out');
    assert.equal(mine[0].severity, 1, 'nothing else on this list costs a customer');
    assert.equal(mine[0].amount_paise, 99900);

    // And it is the sort key, so it cannot be pushed off the bottom by noise.
    assert.equal(res.body.exceptions[0].severity, 1);
  });

  test('a payment with no invoice is reported, farmer fine, GST not', async () => {
    const farm = await namedFarm('No Invoice Farm');
    const l = await link(farm.farm.id);
    const applied = await pay(l);

    // The invoice going missing is the only way the series gets a gap, and a
    // gap is a question from an auditor.
    await adminQuery('DELETE FROM invoice WHERE number = $1', [applied.invoice_number]);

    const admin = await makeAdmin('billing');
    const res = await dash(admin.token);
    const mine = res.body.exceptions.filter((x) => x.farm_id === farm.farm.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kind, 'paid_no_invoice');

    // The ledger says it too, rather than showing a blank cell.
    const ledger = await dash(admin.token, `&q=${encodeURIComponent(farm.name)}`);
    assert.equal(ledger.body.payments[0].invoice_number, null);
  });

  test('a paid link we have no payment row for is money nobody can account for', async () => {
    // The one exception with no farm to click through to, which is exactly what
    // makes it urgent: somebody paid, and this system cannot say who.
    const id = nextId('evt');
    await adminQuery(`
      INSERT INTO webhook_event (id, event, payload, received_at, processed_at, result)
      VALUES ($1, 'payment_link.paid', $2::jsonb, now(), now(), 'no matching payment')`,
      [id, JSON.stringify({
        event: 'payment_link.paid',
        payload: { payment_link: { entity: { id: `plink_ghost_${RUN}`, amount: 99900 } } },
      })]);

    const admin = await makeAdmin('billing');
    const res = await dash(admin.token);
    const mine = res.body.exceptions.find((x) => x.ref === id);
    assert.ok(mine, 'an unattributed payment must be reported');
    assert.equal(mine.kind, 'unattributed_payment');
    assert.equal(mine.severity, 1);
    assert.ok(mine.detail.includes(`plink_ghost_${RUN}`), 'the link id is in the detail');

    // Replaying is the recovery path once somebody has worked out which farm it
    // was and made the payment row. Until then it says so rather than claiming
    // the payment was already applied.
    const replay = await api('POST', `/admin/billing/webhooks/${id}/replay`, {
      token: admin.token, body: { reason: 'checking where this went' } });
    assert.equal(replay.body.result, 'no matching payment');
    assert.equal(replay.body.farmId, null);
  });

  test('an abandoned link is noise, not an emergency', async () => {
    const farm = await namedFarm('Abandoned Farm');
    const l = await link(farm.farm.id);
    await adminQuery(
      `UPDATE payment SET created_at = now() - interval '3 days' WHERE gateway_link_id = $1`,
      [l]);

    const admin = await makeAdmin('billing');
    const res = await dash(admin.token);
    const mine = res.body.exceptions.filter((x) => x.farm_id === farm.farm.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kind, 'abandoned_link');
    assert.equal(mine[0].severity, 3, 'an abandoned checkout must not outrank a lost customer');
  });
});

/* ------------------------------------------------------------------ replay -- */

/** A delivery that arrived and was never finished — the database was down. */
async function stuckDelivery(linkId, farmId, { amount = 99900 } = {}) {
  const id = nextId('evt');
  await adminQuery(`
    INSERT INTO webhook_event (id, event, payload, received_at, processed_at)
    VALUES ($1, 'payment_link.paid', $2::jsonb, now() - interval '2 hours', NULL)`,
    [id, JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: linkId, amount, status: 'paid' } },
        payment: { entity: { id: `${id}_pay`, amount } },
      },
    })]);
  return id;
}

describe('replaying a delivery that got stuck', () => {
  test('it is reported, replaying applies it, and the farm can write again', async () => {
    const farm = await namedFarm('Stuck Farm');
    await adminQuery(
      `UPDATE subscription SET trial_ends_on = current_date - 1 WHERE farm_id = $1`,
      [farm.farm.id]);
    const l = await link(farm.farm.id);
    const evt = await stuckDelivery(l, farm.farm.id);

    // Lapsed, and the money is sitting in a row nothing will ever apply on its
    // own: Razorpay gave up retrying hours ago.
    assert.equal((await api('POST', '/animals', {
      token: farm.token, body: { name: 'Blocked', sex: 'doe' } })).status, 402);

    const admin = await makeAdmin('billing');
    const before = await dash(admin.token);
    const stuck = before.body.exceptions.find((x) => x.ref === evt);
    assert.ok(stuck, 'a delivery that never finished must be on the attention list');
    assert.equal(stuck.kind, 'webhook_failed');

    const replay = await api('POST', `/admin/billing/webhooks/${evt}/replay`, {
      token: admin.token, body: { reason: 'stuck while the database was down' },
    });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.body.result, 'applied');
    assert.equal(replay.body.farmId, farm.farm.id);

    // The point of all of it.
    assert.equal((await api('POST', '/animals', {
      token: farm.token, body: { name: 'Unblocked', sex: 'doe' } })).status, 201);

    const after_ = await dash(admin.token);
    assert.ok(!after_.body.exceptions.some((x) => x.ref === evt),
      'a replayed delivery must come off the attention list');
  });

  test('replaying twice does not sell the same year twice', async () => {
    const farm = await namedFarm('Twice Farm');
    const l = await link(farm.farm.id);
    const evt = await stuckDelivery(l, farm.farm.id);
    const admin = await makeAdmin('billing');

    const first = await api('POST', `/admin/billing/webhooks/${evt}/replay`, {
      token: admin.token, body: { reason: 'first' } });
    assert.equal(first.body.result, 'applied');

    const end = async () => (await adminQuery(
      'SELECT current_period_end FROM subscription WHERE farm_id = $1',
      [farm.farm.id])).rows[0].current_period_end;
    const after1 = await end();

    const second = await api('POST', `/admin/billing/webhooks/${evt}/replay`, {
      token: admin.token, body: { reason: 'somebody pressed it again' } });
    assert.equal(second.status, 200);
    assert.equal(second.body.result, 'already applied');
    assert.equal(await end(), after1, 'a second replay must not extend the period');

    const { rows } = await adminQuery(
      'SELECT count(*)::int AS n FROM invoice WHERE farm_id = $1', [farm.farm.id]);
    assert.equal(rows[0].n, 1, 'one payment, one invoice number');
  });

  test('a replay needs a reason, and support cannot press it at all', async () => {
    const farm = await namedFarm('Reasonless Farm');
    const evt = await stuckDelivery(await link(farm.farm.id), farm.farm.id);

    const admin = await makeAdmin('billing');
    const noReason = await api('POST', `/admin/billing/webhooks/${evt}/replay`, {
      token: admin.token, body: {} });
    assert.equal(noReason.status, 400);

    const support = await makeAdmin('support');
    const refused = await api('POST', `/admin/billing/webhooks/${evt}/replay`, {
      token: support.token, body: { reason: 'trying anyway' } });
    assert.equal(refused.status, 403);

    // Nothing happened to the delivery in either case.
    const { rows } = await adminQuery(
      'SELECT processed_at FROM webhook_event WHERE id = $1', [evt]);
    assert.equal(rows[0].processed_at, null);
  });

  test('the payload is readable without a psql prompt', async () => {
    const farm = await namedFarm('Payload Farm');
    const l = await link(farm.farm.id);
    const evt = await stuckDelivery(l, farm.farm.id);
    const admin = await makeAdmin('billing');

    const res = await api('GET', `/admin/billing/webhooks/${evt}`, { token: admin.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.webhook.link_id, l, 'the link id is pulled out of the payload');
    assert.equal(res.body.webhook.payload.event, 'payment_link.paid');

    const missing = await api('GET', `/admin/billing/webhooks/nope_${RUN}`, {
      token: admin.token });
    assert.equal(missing.status, 404);
  });
});

/* --------------------------------------------------- money outside Razorpay -- */

describe('recording a payment taken outside the gateway', () => {
  test('UPI to a phone becomes a real payment, a real invoice and a live farm', async () => {
    const farm = await namedFarm('UPI Farm');
    await adminQuery(
      `UPDATE subscription SET trial_ends_on = current_date - 1 WHERE farm_id = $1`,
      [farm.farm.id]);
    assert.equal((await api('POST', '/animals', {
      token: farm.token, body: { name: 'Before', sex: 'doe' } })).status, 402);

    const admin = await makeAdmin('billing');
    const res = await api('POST', `/admin/farms/${farm.farm.id}/record_payment`, {
      token: admin.token,
      body: { billing_period: 'yearly', reference: 'UTR2026081712345',
              reason: 'paid by UPI to the office number, screenshot on WhatsApp' },
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.payment.amount_paise, 99900);
    assert.match(res.body.payment.invoice_number, /^RB\/\d{4}-\d{2}\/\d{5}$/);

    assert.equal((await api('POST', '/animals', {
      token: farm.token, body: { name: 'After', sex: 'doe' } })).status, 201);

    // It is money in the ledger, not a status flipped by hand. That is the
    // whole difference between this and `activate`.
    const { rows } = await adminQuery(
      `SELECT gateway, status, amount_paise, gateway_payment_id
         FROM payment WHERE farm_id = $1`, [farm.farm.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gateway, 'offline');
    assert.equal(rows[0].status, 'paid');
    assert.equal(rows[0].gateway_payment_id, 'UTR2026081712345');

    const inv = await adminQuery(
      'SELECT subtotal_paise, tax_paise, total_paise FROM invoice WHERE farm_id = $1',
      [farm.farm.id]);
    assert.equal(inv.rows[0].subtotal_paise + inv.rows[0].tax_paise, inv.rows[0].total_paise);
    assert.equal(inv.rows[0].total_paise, 99900);
  });

  test('it charges what the farm pays, not what the price list says today', async () => {
    const farm = await namedFarm('Grandfathered Farm');
    // The introductory price this farm locked in, against a list price that has
    // since risen. Recording a payment at today's number is exactly the bug the
    // locked price exists to prevent.
    await adminQuery(`
      UPDATE subscription SET locked_price_yearly_paise = 49900,
                              locked_price_monthly_paise = 4900
       WHERE farm_id = $1`, [farm.farm.id]);

    const admin = await makeAdmin('superadmin');
    const res = await api('POST', `/admin/farms/${farm.farm.id}/record_payment`, {
      token: admin.token,
      body: { billing_period: 'yearly', reason: 'renewal, cheque' },
    });
    assert.equal(res.body.payment.amount_paise, 49900);
  });

  test('a stated amount wins, because farmers send round numbers', async () => {
    const farm = await namedFarm('Round Number Farm');
    const admin = await makeAdmin('billing');
    const res = await api('POST', `/admin/farms/${farm.farm.id}/record_payment`, {
      token: admin.token,
      body: { billing_period: 'yearly', amount_paise: 100000, reference: 'cash',
              reason: 'paid ₹1000 in cash, kept the ₹1' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.payment.amount_paise, 100000);

    const bad = await api('POST', `/admin/farms/${farm.farm.id}/record_payment`, {
      token: admin.token,
      body: { billing_period: 'yearly', amount_paise: '999.50', reason: 'rupees not paise' },
    });
    assert.equal(bad.status, 400, 'paise are whole numbers');
  });

  test('a second payment stacks rather than restarting the year', async () => {
    const farm = await namedFarm('Stacking Farm');
    const admin = await makeAdmin('billing');
    const first = await api('POST', `/admin/farms/${farm.farm.id}/record_payment`, {
      token: admin.token, body: { billing_period: 'yearly', reason: 'first year' } });
    const second = await api('POST', `/admin/farms/${farm.farm.id}/record_payment`, {
      token: admin.token, body: { billing_period: 'monthly', reason: 'a month on top' } });

    assert.equal(second.status, 201);
    const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
    assert.equal(days(first.body.payment.period_end, second.body.payment.period_end), 30,
      'paying early must not cost the farmer the days they already have');

    // Consecutive, in the same series. GST requires it.
    const { rows } = await adminQuery(
      'SELECT number FROM invoice WHERE farm_id = $1 ORDER BY number', [farm.farm.id]);
    assert.equal(rows.length, 2);
    const num = (s) => Number(s.split('/').at(-1));
    assert.equal(num(rows[1].number) - num(rows[0].number), 1);
  });

  test('a reason is required, and support cannot record money', async () => {
    const farm = await namedFarm('Refused Farm');

    const admin = await makeAdmin('billing');
    const noReason = await api('POST', `/admin/farms/${farm.farm.id}/record_payment`, {
      token: admin.token, body: { billing_period: 'yearly' } });
    assert.equal(noReason.status, 400);

    const support = await makeAdmin('support');
    const refused = await api('POST', `/admin/farms/${farm.farm.id}/record_payment`, {
      token: support.token, body: { billing_period: 'yearly', reason: 'trying' } });
    assert.equal(refused.status, 403);

    const { rows } = await adminQuery(
      'SELECT count(*)::int AS n FROM payment WHERE farm_id = $1', [farm.farm.id]);
    assert.equal(rows[0].n, 0, 'a refused request must not leave a payment row behind');
  });

  test('it is not swallowed by the /farms/:id/:action wildcard', async () => {
    /*
     * Hono matches in registration order, so a route registered below the
     * wildcard answers `Unknown action "record_payment"` and its role check
     * never runs. That has now happened to four routes on this router, which is
     * why every one of them has a test.
     */
    const farm = await namedFarm('Ordering Farm');
    const support = await makeAdmin('support');
    const res = await api('POST', `/admin/farms/${farm.farm.id}/record_payment`, {
      token: support.token, body: { billing_period: 'yearly', reason: 'ordering' } });
    assert.equal(res.status, 403);
    assert.ok(!/Unknown action/.test(res.text), res.text);
  });

  test('it is written down, with the reason, like every other admin action', async () => {
    const farm = await namedFarm('Audited Farm');
    const admin = await makeAdmin('billing');
    await api('POST', `/admin/farms/${farm.farm.id}/record_payment`, {
      token: admin.token,
      body: { billing_period: 'monthly', reference: 'NEFT-88', reason: 'bank transfer, 12 Aug' },
    });

    const { rows } = await adminQuery(
      `SELECT action, reason, after_value FROM admin_audit_log WHERE target_farm_id = $1`,
      [farm.farm.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'record_payment');
    assert.equal(rows[0].reason, 'bank transfer, 12 Aug');
    assert.equal(rows[0].after_value.reference, 'NEFT-88');
    assert.match(rows[0].after_value.invoice_number, /^RB\//);
  });
});

/* ------------------------------------------------------------ the farm page -- */

describe('one farm’s payments, on that farm’s page', () => {
  test('support can see them — that is the call support takes', async () => {
    const farm = await namedFarm('Support Call Farm');
    const l = await link(farm.farm.id);
    const applied = await pay(l);

    const support = await makeAdmin('support');
    const res = await api('GET', `/admin/farms/${farm.farm.id}?format=json`, {
      token: support.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.payments.length, 1);
    assert.equal(res.body.payments[0].invoice_number, applied.invoice_number);
  });

  test('and only that farm’s', async () => {
    const a = await namedFarm('Page Farm A');
    const b = await namedFarm('Page Farm B');
    await pay(await link(a.farm.id));
    await pay(await link(b.farm.id));

    const admin = await makeAdmin('billing');
    const res = await api('GET', `/admin/farms/${a.farm.id}?format=json`, { token: admin.token });
    assert.equal(res.body.payments.length, 1);
    assert.equal(res.body.payments[0].farm_id, a.farm.id);
    assert.ok(!res.text.includes(b.name), "one farm's page must not show another's money");
  });

  test('support is not offered the record-payment form', async () => {
    const farm = await namedFarm('Form Farm');
    const support = await makeAdmin('support');
    const page = await api('GET', `/admin/farms/${farm.farm.id}`, { token: support.token });
    assert.ok(!page.text.includes('record_payment'), 'support was shown a form it cannot post');
  });
});

/* ----------------------------------------------------------------- the wall -- */

describe('the farmer-facing role and the money functions', () => {
  test('it cannot call the functions that move a subscription', async () => {
    // Not a policy question — a grant one. The functions are SECURITY INVOKER,
    // so RLS still applies to whoever calls them, but EXECUTE defaulting to
    // PUBLIC meant the farmer-facing role could call the thing that extends a
    // period. Migration 0027 revoked it.
    for (const fn of ['billing_apply_payment(text, text, int)',
                      'next_invoice_number(date)',
                      'billing_record_offline_payment(uuid, billing_period_t, int, text)']) {
      const { rows } = await adminQuery(
        `SELECT has_function_privilege('rabbitry_app', $1, 'EXECUTE') AS can`, [fn]);
      assert.equal(rows[0].can, false, `rabbitry_app must not be able to execute ${fn}`);
    }
  });

  test('it cannot read the cross-tenant billing views', async () => {
    for (const view of ['v_admin_payment', 'v_admin_webhook', 'v_admin_billing_exception',
                        'v_admin_renewal_due', 'v_admin_invoice_fy', 'v_admin_revenue_month',
                        'v_admin_billing_summary']) {
      const { rows } = await adminQuery(
        `SELECT has_table_privilege('rabbitry_app', $1, 'SELECT') AS can`, [view]);
      assert.equal(rows[0].can, false, `rabbitry_app must not be able to read ${view}`);
    }
  });
});
