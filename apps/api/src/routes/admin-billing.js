/**
 * The money screen.
 *
 * Mounted at /admin/billing by the admin router, which is also where the
 * sign-in guard for it lives. Everything here reads across every tenant, so
 * every query goes through the admin pool and every route is behind a role.
 *
 * Who may look: superadmin and billing. Not support — docs/10 draws that line
 * ("Subscriptions, invoices, refunds" against "Read farms, extend trials"), and
 * platform revenue is not something a support rota needs. What support does
 * need is one farm's payments while that farmer is on the phone, and those are
 * on the farm's own page, visible to every admin.
 */
import { Hono } from 'hono';
import { adminQuery } from '../db.js';
import { HttpError } from '../auth.js';
import { requireAdminRole, audit, readBody, wantsJson } from '../admin-auth.js';
import { renderBilling, renderWebhook } from '../admin-ui.js';
import { applyWebhookEvent } from './billing.js';
import { createRefund, razorpayConfigured } from '../razorpay.js';

export const adminBillingRoutes = new Hono();

const canBill = requireAdminRole('superadmin', 'billing');

/** The payments table, filtered the way a person looking for one payment would. */
async function payments({ status, q, from, to }) {
  const { rows } = await adminQuery(`
    SELECT * FROM v_admin_payment
     WHERE ($1::text IS NULL OR status::text = $1)
       AND ($2::text IS NULL OR farm_name ILIKE '%'||$2||'%'
            OR invoice_number ILIKE '%'||$2||'%'
            OR gateway_link_id ILIKE '%'||$2||'%'
            OR gateway_payment_id ILIKE '%'||$2||'%')
       AND ($3::date IS NULL OR created_at >= $3::date)
       AND ($4::date IS NULL OR created_at < $4::date + 1)
     ORDER BY created_at DESC
     LIMIT 100`,
    [status || null, q || null, from || null, to || null]);
  return rows;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

adminBillingRoutes.get('/', canBill, async (c) => {
  const filters = {
    status: c.req.query('status'),
    q: c.req.query('q'),
    // A malformed date would abort the whole query with a cast error and take
    // the page down. Ignoring it shows an unfiltered table, which is wrong in a
    // way the person can see and fix.
    from: DATE.test(c.req.query('from') ?? '') ? c.req.query('from') : null,
    to: DATE.test(c.req.query('to') ?? '') ? c.req.query('to') : null,
  };

  const [summary, revenue, exceptions, renewals, rows, fy, months, refunds,
         emailHealth, emails] = await Promise.all([
    adminQuery('SELECT * FROM v_admin_billing_summary').then((r) => r.rows[0]),
    adminQuery('SELECT * FROM v_admin_revenue_summary').then((r) => r.rows[0]),
    adminQuery(`SELECT * FROM v_admin_billing_exception
                 ORDER BY severity, at DESC NULLS LAST LIMIT 50`).then((r) => r.rows),
    adminQuery('SELECT * FROM v_admin_renewal_due ORDER BY days_left, farm_name LIMIT 50')
      .then((r) => r.rows),
    payments(filters),
    adminQuery('SELECT * FROM v_admin_invoice_fy ORDER BY financial_year DESC')
      .then((r) => r.rows),
    adminQuery('SELECT * FROM v_admin_revenue_month ORDER BY month').then((r) => r.rows),
    adminQuery('SELECT * FROM v_admin_refund ORDER BY created_at DESC LIMIT 50')
      .then((r) => r.rows),
    adminQuery('SELECT * FROM v_admin_email_health').then((r) => r.rows[0]),
    adminQuery('SELECT * FROM v_admin_email ORDER BY created_at DESC LIMIT 30')
      .then((r) => r.rows),
  ]);

  if (c.req.query('format') === 'json') {
    return c.json({ summary, revenue, exceptions, renewals, payments: rows, fy, months,
                    refunds, email: emailHealth, emails });
  }
  return c.html(renderBilling({
    summary, revenue, exceptions, renewals, payments: rows, fy, months, refunds,
    emailHealth, emails, filters, admin: c.get('admin'),
  }));
});

/* ----------------------------------------------------------------- refunds -- */

/**
 * POST /admin/billing/payments/:id/refund — give money back.
 *
 * docs/10 puts refunds with `billing` and explicitly not with `support`, and
 * that is the one authorisation rule here. Everything else is about not lying:
 *
 * The refund row is written BEFORE the gateway is called, so a call that times
 * out after Razorpay accepted it leaves us with a record to reconcile rather
 * than money gone and nothing to show for it. If the call then fails outright,
 * the row is marked failed and shows up on the attention list.
 *
 * Nothing about the farm's access changes here. That happens in
 * billing_settle_refund when `refund.processed` arrives, because a refund the
 * gateway has accepted and not yet paid is a promise, and locking a farm out on
 * a promise that then fails is a farmer in a shed unable to write down a
 * kindling because of something happening in a payments system.
 *
 * The exception is a payment we took by hand: there is no gateway to tell us
 * anything, so an offline refund settles when the person recording it says the
 * money has gone.
 */
adminBillingRoutes.post('/payments/:id/refund', canBill, async (c) => {
  const admin = c.get('admin');
  const paymentId = c.req.param('id');
  const body = await readBody(c);

  const reason = String(body.reason ?? '').trim();
  if (!reason) throw new HttpError(400, 'A reason is required to refund');

  const kind = String(body.kind ?? 'cancellation');
  if (!['cancellation', 'goodwill'].includes(kind)) {
    throw new HttpError(400, 'Kind must be cancellation or goodwill', { field: 'kind' });
  }

  const amount = String(body.amount_paise ?? '').trim();
  if (amount && !/^\d+$/.test(amount)) {
    throw new HttpError(400, 'Amount must be a whole number of paise',
      { field: 'amount_paise' });
  }

  const { rows: pay } = await adminQuery(
    'SELECT * FROM v_admin_payment WHERE id = $1', [paymentId]);
  if (!pay.length) throw new HttpError(404, 'No such payment');
  const payment = pay[0];

  // Said before a refund row exists, so a farm is not left with a refund in
  // flight that nothing can settle.
  if (payment.gateway === 'razorpay' && !razorpayConfigured()) {
    throw new HttpError(503,
      'Card refunds are not switched on. Send the money back yourself and record it as an '
      + 'offline refund, or set the Razorpay keys.', { gateway: false });
  }

  /*
   * A reference typed by a person, in a column that is unique because it
   * normally holds the gateway's own id. Two refunds against the same UTR is
   * either a typo or the same refund being recorded twice, and both deserve a
   * sentence rather than a 500 — checked before the refund row exists, so a
   * refused attempt does not leave one stuck in flight.
   */
  const reference = String(body.reference ?? '').trim();
  if (reference) {
    const { rowCount } = await adminQuery(
      'SELECT 1 FROM refund WHERE gateway_refund_id = $1', [reference]);
    if (rowCount) {
      throw new HttpError(409,
        `${reference} is already recorded against another refund`, { field: 'reference' });
    }
  }

  let refund;
  try {
    const { rows } = await adminQuery(
      'SELECT * FROM billing_create_refund($1,$2,$3::refund_kind_t,$4,$5,$6)',
      [paymentId, amount ? Number(amount) : null, kind, reason, admin.id, payment.gateway]);
    refund = rows[0];
  } catch (err) {
    // The function refuses an over-refund, an unpaid payment and an empty
    // reason. All three are things the person can act on, so say which.
    throw new HttpError(409, String(err.message ?? err).replace(/^ERROR:\s*/, ''));
  }

  let settled = null;
  if (payment.gateway === 'razorpay') {
    try {
      const made = await createRefund({
        paymentId: payment.gateway_payment_id,
        amountPaise: refund.amount_paise,
        refundId: refund.id,
        notes: { farm: payment.farm_name },
      });
      await adminQuery('UPDATE refund SET gateway_refund_id = $2 WHERE id = $1',
        [refund.id, made?.id ?? null]);
      refund.gateway_refund_id = made?.id ?? null;

      /*
       * Razorpay can answer `processed` immediately — an instant refund, or a
       * payment still in its settlement window. Believing the response here
       * rather than waiting for a webhook that says the same thing means a
       * farmer is not told "pending" about money that has already gone.
       */
      if (made?.status === 'processed') {
        const done = await adminQuery('SELECT * FROM billing_settle_refund($1,$2)',
          [refund.id, made.id]);
        settled = done.rows[0];
      }
    } catch (err) {
      await adminQuery('SELECT billing_fail_refund($1,$2)',
        [refund.id, String(err.message ?? err).slice(0, 300)]);
      await audit(admin, 'refund_failed', payment.farm_id,
        { payment: paymentId, amount_paise: refund.amount_paise }, null,
        reason, c.req.header('x-forwarded-for') ?? null, 'refund');
      throw new HttpError(502,
        'The payment provider refused the refund. It is on the billing attention list.',
        { gateway: err.gateway ?? null });
    }
  } else {
    /*
     * Money we took by hand goes back by hand. There is no webhook coming, so
     * the person recording it is the confirmation — which is exactly what they
     * are for the payment itself.
     */
    try {
      const done = await adminQuery('SELECT * FROM billing_settle_refund($1,$2)',
        [refund.id, reference || null]);
      settled = done.rows[0];
    } catch (err) {
      // Two people recording the same transfer at once is the only way past the
      // check above. Mark it rather than leaving a refund that looks in flight.
      await adminQuery('SELECT billing_fail_refund($1,$2)',
        [refund.id, String(err.message ?? err).slice(0, 300)]);
      throw new HttpError(409, String(err.message ?? err).replace(/^ERROR:\s*/, ''));
    }
  }

  await audit(admin, 'refund', payment.farm_id,
    { payment: paymentId, paid_paise: payment.amount_paise },
    { amount_paise: refund.amount_paise, kind,
      gateway: payment.gateway,
      credit_note: settled?.credit_note ?? null,
      days_removed: settled?.days_removed ?? null,
      settled: Boolean(settled?.settled) },
    reason, c.req.header('x-forwarded-for') ?? null, 'refund');

  if (wantsJson(c)) {
    return c.json({
      ok: true,
      refund: { ...refund, ...(settled?.settled ? { status: 'processed' } : {}) },
      settled: settled ?? null,
    }, 201);
  }
  return c.redirect(`/admin/farms/${payment.farm_id}`);
});

/**
 * POST /admin/billing/refunds/:id/settle — it went out, nobody told us.
 *
 * The same job as replaying a webhook, for the case where Razorpay's own
 * dashboard shows a refund processed and no `refund.processed` ever arrived.
 * Idempotent, because billing_settle_refund is.
 */
adminBillingRoutes.post('/refunds/:id/settle', canBill, async (c) => {
  const admin = c.get('admin');
  const id = c.req.param('id');
  const body = await readBody(c);
  const reason = String(body.reason ?? '').trim();
  if (!reason) throw new HttpError(400, 'A reason is required to settle a refund by hand');

  const { rows: before } = await adminQuery(
    'SELECT id, farm_id, status, amount_paise FROM refund WHERE id = $1', [id]);
  if (!before.length) throw new HttpError(404, 'No such refund');

  const { rows } = await adminQuery('SELECT * FROM billing_settle_refund($1,$2)',
    [id, String(body.gateway_refund_id ?? '').trim() || null]);
  const settled = rows[0];

  await audit(admin, 'settle_refund', before[0].farm_id,
    { was: before[0].status }, {
      settled: settled.settled, credit_note: settled.credit_note,
      days_removed: settled.days_removed, period_end: settled.period_end,
    }, reason, c.req.header('x-forwarded-for') ?? null, 'refund');

  if (wantsJson(c)) return c.json({ ok: true, ...settled });
  return c.redirect('/admin/billing');
});

/**
 * One webhook, payload and all.
 *
 * The reason 0026 keeps the whole payload: when a farmer says they paid and the
 * app disagrees, this is the only place with both sides of the story. Reading
 * it should not mean a psql prompt.
 */
adminBillingRoutes.get('/webhooks/:id', canBill, async (c) => {
  const id = c.req.param('id');
  const { rows } = await adminQuery(`
    SELECT w.*, e.payload
    FROM v_admin_webhook w
    JOIN webhook_event e ON e.id = w.id
    WHERE w.id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'No such webhook delivery');

  if (c.req.query('format') === 'json' || !c.req.header('accept')?.includes('text/html')) {
    return c.json({ webhook: rows[0] });
  }
  return c.html(renderWebhook({ webhook: rows[0], admin: c.get('admin') }));
});

/**
 * POST /admin/billing/webhooks/:id/replay — run a stored delivery again.
 *
 * For the delivery that arrived while the database was unreachable, or the one
 * whose handler threw on a bug we have since fixed. Razorpay retries for a
 * while and then stops; after that the farm has paid, the row is here, and
 * nothing will ever apply it again on its own.
 *
 * Safe to press twice: it goes through the same applyWebhookEvent the live
 * endpoint does, and billing_apply_payment refuses a payment it has already
 * applied. Pressing it on a delivery that succeeded the first time is a no-op
 * that says "already applied", which is exactly what it should say.
 */
adminBillingRoutes.post('/webhooks/:id/replay', canBill, async (c) => {
  const admin = c.get('admin');
  const id = c.req.param('id');
  const body = await readBody(c);
  const reason = String(body.reason ?? '').trim();
  if (!reason) throw new HttpError(400, 'A reason is required to replay a webhook');

  const { rows } = await adminQuery(
    'SELECT id, event, payload, result FROM webhook_event WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'No such webhook delivery');
  const before = rows[0];

  let outcome;
  try {
    outcome = await applyWebhookEvent(before.payload);
  } catch (err) {
    // Record the failure and report it, rather than a 500 that leaves the row
    // saying whatever it said before the replay.
    const result = `error: ${String(err.message ?? err).slice(0, 200)}`;
    await adminQuery(
      'UPDATE webhook_event SET processed_at = now(), result = $2 WHERE id = $1', [id, result]);
    throw new HttpError(502, `Replay failed: ${result}`);
  }

  await adminQuery(`
    UPDATE webhook_event SET processed_at = now(), result = $2, farm_id = $3
     WHERE id = $1`, [id, outcome.result, outcome.farmId]);

  await audit(admin, 'replay_webhook', outcome.farmId,
    { event: before.event, was: before.result }, { result: outcome.result },
    reason, c.req.header('x-forwarded-for') ?? null, 'webhook_event');

  if (wantsJson(c)) return c.json({ ok: true, ...outcome });
  return c.redirect('/admin/billing');
});
