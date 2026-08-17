import { Hono } from 'hono';
import { appQuery, adminQuery } from '../db.js';
import { requireAuth } from '../middleware.js';
import { requireCan } from '../permissions.js';
import { HttpError } from '../auth.js';
import {
  createPaymentLink, verifyWebhook, verifyPaymentLink, razorpayConfigured,
} from '../razorpay.js';
import { createHash } from 'node:crypto';

export const billingRoutes = new Hono();

/* ------------------------------------------------------------- webhook -- */

/**
 * POST /webhooks/razorpay
 *
 * The only route here that is not behind a session, because Razorpay's servers
 * have no session. That makes it the one endpoint an anonymous caller on the
 * internet can reach that moves a farm's subscription, so it does exactly three
 * things before it believes anything: check the signature over the raw bytes,
 * refuse to process an event id it has already seen, and look the farm up from
 * our own payment row rather than from anything in the payload.
 *
 * Deliberately mounted before the farm routes and outside requireAuth — see
 * app.js, where the ordering is the same reason the admin console is mounted
 * early.
 */
billingRoutes.post('/webhooks/razorpay', async (c) => {
  // The exact bytes. Parsing and re-serialising changes key order and
  // whitespace, and the digest would never match a real Razorpay delivery.
  const raw = await c.req.text();
  const signature = c.req.header('x-razorpay-signature');

  if (!verifyWebhook(raw, signature)) {
    /*
     * 400, not 401. Razorpay retries a 5xx and gives up on a 4xx, and something
     * that failed the signature check will fail it again on every retry — there
     * is no point being sent it twenty more times.
     */
    throw new HttpError(400, 'Bad signature');
  }

  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Not JSON'); }

  /*
   * Idempotency, and it is not optional. Razorpay retries on a timeout, on a
   * 500, and on a deploy that restarted mid-request. A `payment_link.paid`
   * applied twice is a farm given two years for one payment.
   *
   * The event id comes from the header; when it is absent — which happens on
   * hand-made test deliveries — a hash of the body stands in, so a repeat of
   * the identical body still collides.
   */
  const eventId = c.req.header('x-razorpay-event-id')
    ?? createHash('sha256').update(raw).digest('hex');
  const event = String(body?.event ?? 'unknown');

  const { rowCount } = await adminQuery(`
    INSERT INTO webhook_event (id, gateway, event, payload)
    VALUES ($1, 'razorpay', $2, $3::jsonb)
    ON CONFLICT (id) DO NOTHING`, [eventId, event, raw]);

  if (rowCount === 0) {
    // Seen it. Answer 200 so Razorpay stops asking.
    return c.json({ ok: true, duplicate: true });
  }

  let result = 'ignored';
  let farmId = null;

  try {
    const link = body?.payload?.payment_link?.entity;
    const payment = body?.payload?.payment?.entity;

    if (event === 'payment_link.paid' && link?.id) {
      const applied = await adminQuery(
        'SELECT * FROM billing_apply_payment($1,$2,$3)',
        [link.id, payment?.id ?? link.id, link.amount ?? null]);
      farmId = applied.rows[0]?.farm_id ?? null;
      result = applied.rows[0]?.applied ? 'applied' : 'already applied';
    } else if ((event === 'payment_link.cancelled' || event === 'payment_link.expired')
               && link?.id) {
      const upd = await adminQuery(`
        UPDATE payment SET status = $2::payment_status_t
         WHERE gateway_link_id = $1 AND status = 'created'
        RETURNING farm_id`,
        [link.id, event.endsWith('expired') ? 'cancelled' : 'cancelled']);
      farmId = upd.rows[0]?.farm_id ?? null;
      result = upd.rowCount ? 'cancelled' : 'nothing to cancel';
    } else if (event === 'payment.failed' && payment?.id) {
      const upd = await adminQuery(`
        UPDATE payment SET failed_reason = $2
         WHERE gateway_payment_id = $1 OR gateway_link_id = $1
        RETURNING farm_id`,
        [payment.id, payment.error_description ?? 'payment failed']);
      farmId = upd.rows[0]?.farm_id ?? null;
      result = 'noted';
      /*
       * Noted, not acted on. A failed attempt is not a lapse — the farmer's
       * card was declined and they will try again in a minute, and downgrading
       * them for it would lock somebody out mid-round for a bank's decision.
       * The period end is what decides access, and it has not moved.
       */
    }
  } catch (err) {
    result = `error: ${String(err.message ?? err).slice(0, 200)}`;
    await adminQuery(
      'UPDATE webhook_event SET processed_at = now(), result = $2 WHERE id = $1',
      [eventId, result]);
    throw err;   // 500, so Razorpay retries — and the row is already marked
  }

  await adminQuery(`
    UPDATE webhook_event SET processed_at = now(), result = $2, farm_id = $3
     WHERE id = $1`, [eventId, result, farmId]);

  return c.json({ ok: true, result });
});

/**
 * GET /billing/return — where Razorpay sends the browser afterwards.
 *
 * Unauthenticated on purpose: it is a redirect target, and the browser coming
 * back from a payment page may not carry the session cookie depending on how it
 * got there. That is exactly why it proves nothing on its own — it verifies the
 * signature and then applies the payment through the same idempotent function
 * the webhook uses, so the worst case is that it does the webhook's job early.
 */
billingRoutes.get('/billing/return', async (c) => {
  const q = c.req.query();
  const ok = verifyPaymentLink({
    linkId: q.razorpay_payment_link_id,
    referenceId: q.razorpay_payment_link_reference_id,
    status: q.razorpay_payment_link_status,
    paymentId: q.razorpay_payment_id,
  }, q.razorpay_signature);

  if (!ok) {
    return c.html(page('That payment could not be confirmed',
      'The signature did not check out. Nothing has been charged twice — open the '
      + 'app and look at Billing, and talk to us if it still looks wrong.'), 400);
  }

  if (q.razorpay_payment_link_status !== 'paid') {
    return c.html(page('Payment not completed',
      'Nothing was charged. You can start again from Billing in the app.'));
  }

  const applied = await adminQuery('SELECT * FROM billing_apply_payment($1,$2,$3)',
    [q.razorpay_payment_link_id, q.razorpay_payment_id, null]);

  const until = applied.rows[0]?.period_end;
  return c.html(page('Paid — thank you',
    until
      ? `Your subscription runs to ${until}. You can close this and go back to the app.`
      : 'We have your payment. It may take a moment to show in the app.'));
});

/* --------------------------------------------------------- the farmer's -- */

/*
 * Registered AFTER /billing/return above, and that ordering is the point.
 *
 * Hono applies middleware in registration order, so anything mounted below this
 * line gets the auth guard and anything above it does not. Putting the return
 * page below would answer Razorpay's redirect with 401 — the farmer pays, comes
 * back, and is told to sign in, with the payment already taken. It is the same
 * ordering trap as /farms/:id/:action in the admin console.
 */
billingRoutes.use('/billing', requireAuth);
billingRoutes.use('/billing/*', requireAuth);

const DAYS = { monthly: 30, yearly: 365 };

/**
 * GET /billing — what they pay, what renewing costs, and what they have paid.
 *
 * Readable by anybody who may see billing, which is the owner and, per docs/04,
 * the accountant. A farm hand never sees what the farm pays.
 */
billingRoutes.get('/billing', requireCan('billing:read'), async (c) => {
  const db = c.get('db');
  const data = await db(async (client) => {
    const ent = await client.query(`
      SELECT plan_code, status, billing_period, access, trial_days_left,
             current_period_end, effective_price_paise, is_grandfathered
      FROM v_farm_entitlement`);
    const price = await client.query('SELECT * FROM v_farm_renewal_price');
    const history = await client.query(
      'SELECT * FROM v_billing_history ORDER BY created_at DESC LIMIT 24');
    return {
      subscription: ent.rows[0] ?? null,
      price: price.rows[0] ?? null,
      history: history.rows,
    };
  });

  return c.json({
    subscription: data.subscription,
    history: data.history,
    // What a renewal would cost, at THIS farm's locked price rather than the
    // list price. Grandfathering is meaningless if the renew button quotes
    // today's number.
    renew: {
      monthly_paise: data.price?.monthly_paise ?? null,
      yearly_paise: data.price?.yearly_paise ?? null,
      is_grandfathered: data.subscription?.is_grandfathered ?? false,
    },
    gateway_ready: razorpayConfigured(),
  });
});

/**
 * POST /billing/pay — make a link for them to pay.
 *
 * The amount is read from the farm's own entitlement, never from the request.
 * A price that arrives in a request body is a price a customer can edit.
 */
billingRoutes.post('/billing/pay', requireCan('billing:read'), async (c) => {
  if (!razorpayConfigured()) {
    throw new HttpError(503,
      'Card payments are not switched on yet. Talk to us and we will take it directly.',
      { gateway: false });
  }

  const b = await c.req.json().catch(() => ({}));
  const period = b.billing_period ?? 'yearly';
  if (!DAYS[period]) {
    throw new HttpError(400, 'Billing period must be monthly or yearly',
      { field: 'billing_period' });
  }

  const session = c.get('session');
  const db = c.get('db');

  const { amount, farm, owner } = await db(async (client) => {
    const { rows: ent } = await client.query('SELECT * FROM v_farm_renewal_price');
    const { rows: f } = await client.query('SELECT id, name FROM farm');
    const { rows: o } = await client.query(`
      SELECT full_name, email::text AS email, phone FROM employee
       WHERE role = 'owner' AND is_active ORDER BY created_at LIMIT 1`);
    return {
      amount: period === 'monthly' ? ent[0]?.monthly_paise : ent[0]?.yearly_paise,
      farm: f[0],
      owner: o[0] ?? {},
    };
  });

  if (!amount || amount <= 0) {
    throw new HttpError(409, 'This farm has no price to charge — talk to us.');
  }

  // The row first, so the link can carry its id and a webhook has something to
  // land on even if the response to this request never reaches the phone.
  const paymentId = await db(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO payment (farm_id, amount_paise, billing_period, covers_days, created_by)
      VALUES (current_farm_id(), $1, $2::billing_period_t, $3, $4)
      RETURNING id`,
      [amount, period, DAYS[period], session.employeeId]);
    return rows[0].id;
  });

  let link;
  try {
    link = await createPaymentLink({
      amountPaise: amount,
      description: `Rabbitry — ${period === 'monthly' ? 'one month' : 'one year'} for ${farm.name}`,
      referenceId: paymentId,
      customer: { name: owner.full_name, email: owner.email, phone: owner.phone },
      callbackUrl: `${process.env.PUBLIC_URL ?? ''}/billing/return`,
      // A quote is good for a day. Longer and a farmer pays against a price
      // that has since changed, or against a farm that has since been closed.
      expireBy: Math.floor(Date.now() / 1000) + 24 * 3600,
    });
  } catch (err) {
    await db(async (client) => {
      await client.query(
        `UPDATE payment SET status = 'failed', failed_reason = $2 WHERE id = $1`,
        [paymentId, String(err.message ?? err).slice(0, 300)]);
    });
    throw new HttpError(502, 'Could not reach the payment provider. Try again in a minute.',
      { gateway: err.gateway ?? null });
  }

  await db(async (client) => {
    await client.query(
      'UPDATE payment SET gateway_link_id = $2, short_url = $3 WHERE id = $1',
      [paymentId, link.id, link.short_url]);
  });

  return c.json({
    payment: { id: paymentId, amount_paise: amount, billing_period: period },
    // The phone opens this. Same URL on web and on a native build.
    pay_url: link.short_url,
  }, 201);
});

/** A page for a farmer standing in a browser, not a JSON body. */
function page(title, body) {
  const esc = (v) => String(v).replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{background:#F6F8F4;color:#1B211D;margin:0;
       font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{max-width:420px;margin:18vh auto;padding:0 24px}
  h1{font:400 26px/1.25 Georgia,serif;margin:0 0 12px}
  p{color:#3B443E}
  a{display:inline-block;margin-top:22px;background:#2C5F53;color:#F6F8F4;
    text-decoration:none;padding:12px 20px;border-radius:3px}
</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p>
<a href="/">Back to Rabbitry</a></main></body></html>`;
}
