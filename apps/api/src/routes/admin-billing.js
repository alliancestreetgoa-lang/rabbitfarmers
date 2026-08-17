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

  const [summary, revenue, exceptions, renewals, rows, fy, months] = await Promise.all([
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
  ]);

  if (c.req.query('format') === 'json') {
    return c.json({ summary, revenue, exceptions, renewals, payments: rows, fy, months });
  }
  return c.html(renderBilling({
    summary, revenue, exceptions, renewals, payments: rows, fy, months,
    filters, admin: c.get('admin'),
  }));
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
