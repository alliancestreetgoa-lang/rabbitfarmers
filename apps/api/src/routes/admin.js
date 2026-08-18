import { Hono } from 'hono';
import { adminQuery } from '../db.js';
import { hashPassword, verifyPassword, newSessionToken, hashToken, HttpError } from '../auth.js';
import {
  renderLogin, renderFarms, renderFarm, renderFarmAnimals, renderFarmAnimal,
  renderFarmStaff, renderImpersonation, renderSicknesses,
} from '../admin-ui.js';
import {
  ADMIN_COOKIE, ADMIN_SESSION_HOURS, readAdminToken, issueAdminSession,
  requireAdmin, requireAdminRole, audit, readBody, wantsJson,
} from '../admin-auth.js';
import { clientIp } from '../middleware.js';
import { payslipPdf } from '../pdf.js';
import { adminBillingRoutes } from './admin-billing.js';

export const adminRoutes = new Hono();

/* ------------------------------------------------------------------ pages -- */

adminRoutes.get('/login', (c) => c.html(renderLogin()));

adminRoutes.post('/login', async (c) => {
  const ct = c.req.header('content-type') ?? '';
  const body = ct.includes('application/json')
    ? await c.req.json()
    : Object.fromEntries(await c.req.formData());

  const email = String(body.email ?? '').trim().toLowerCase();
  const { rows } = await adminQuery(
    'SELECT id, password_hash, is_active FROM platform_admin WHERE email = $1', [email]);
  const admin = rows[0];

  const ok = admin?.is_active
    ? await verifyPassword(String(body.password ?? ''), admin.password_hash)
    : false;

  if (!ok) {
    if (ct.includes('application/json')) throw new HttpError(401, 'Incorrect email or password');
    return c.html(renderLogin('Incorrect email or password'), 401);
  }

  await adminQuery('UPDATE platform_admin SET last_login_at = now() WHERE id = $1', [admin.id]);
  const token = await issueAdminSession(
    admin.id, clientIp(c), c.req.header('user-agent'));
  c.header('Set-Cookie',
    `${ADMIN_COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_SESSION_HOURS * 3600}`);

  if (ct.includes('application/json')) return c.json({ token });
  return c.redirect('/admin/farms');
});

adminRoutes.post('/logout', async (c) => {
  const token = readAdminToken(c);
  if (token) {
    await adminQuery(
      `UPDATE admin_session SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(token)]);
  }
  c.header('Set-Cookie', `${ADMIN_COOKIE}=; Path=/admin; HttpOnly; Max-Age=0`);
  return c.redirect('/admin/login');
});

adminRoutes.use('/farms', requireAdmin);
adminRoutes.use('/farms/*', requireAdmin);
adminRoutes.use('/api/*', requireAdmin);
/*
 * The money screen. Guarded here rather than inside its own router, so that the
 * one line that decides whether the platform's revenue is public sits in the
 * same place as the others — an admin surface that is missing its guard is not
 * something to discover by reading two files.
 */
adminRoutes.use('/billing', requireAdmin);
adminRoutes.use('/sicknesses', requireAdmin);
adminRoutes.use('/sicknesses/*', requireAdmin);
adminRoutes.use('/billing/*', requireAdmin);
adminRoutes.route('/billing', adminBillingRoutes);

/* ------------------------------------------------------------------ farms -- */

async function listFarms({ q, status }) {
  const { rows } = await adminQuery(`
    SELECT * FROM v_admin_farm_overview
    WHERE ($1::text IS NULL OR farm_name ILIKE '%'||$1||'%'
           OR owner_email ILIKE '%'||$1||'%' OR owner_phone ILIKE '%'||$1||'%'
           OR city ILIKE '%'||$1||'%')
      AND ($2::text IS NULL OR status::text = $2)
    ORDER BY signed_up_at DESC`, [q || null, status || null]);
  return rows;
}

adminRoutes.get('/farms', async (c) => {
  const q = c.req.query('q');
  const status = c.req.query('status');
  const [farms, summary] = await Promise.all([
    listFarms({ q, status }),
    adminQuery('SELECT * FROM v_admin_revenue_summary').then((r) => r.rows[0]),
  ]);
  if (c.req.query('format') === 'json') return c.json({ farms, summary });
  return c.html(renderFarms({ farms, summary, q, status, admin: c.get('admin') }));
});

/* -------------------------------------------------------------- sicknesses -- */

const slugify = (name) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');

/** Press the catalogue onto every farm. Called after each catalogue change. */
async function applyCatalogEverywhere() {
  await adminQuery('SELECT apply_condition_catalog(id) FROM farm');
}

/**
 * The sickness catalogue: what every farm's report screen offers, and what
 * each sickness gets. Superadmin only — a farmer reports, they never curate.
 */
adminRoutes.get('/sicknesses', requireAdminRole('superadmin'), async (c) => {
  const { rows } = await adminQuery(
    'SELECT * FROM condition_catalog ORDER BY is_active DESC, name');
  const { rows: farms } = await adminQuery('SELECT count(*)::int AS n FROM farm');
  if (c.req.query('format') === 'json') return c.json({ sicknesses: rows });
  return c.html(renderSicknesses({ rows, farmCount: farms[0].n, admin: c.get('admin') }));
});

adminRoutes.post('/sicknesses', requireAdminRole('superadmin'), async (c) => {
  const ct = c.req.header('content-type') ?? '';
  const b = ct.includes('json') ? await c.req.json()
    : Object.fromEntries((await c.req.formData()).entries());

  const name = String(b.name ?? '').trim();
  if (!name) throw new HttpError(400, 'The sickness needs a name', { field: 'name' });
  const code = String(b.code ?? '').trim() || slugify(name);
  if (!code) throw new HttpError(400, 'The sickness needs a name', { field: 'name' });

  const medicine = String(b.medicine ?? '').trim() || null;
  const days = b.days === undefined || b.days === '' ? null : Number(b.days);
  if (medicine && (!Number.isInteger(days) || days < 1 || days > 60)) {
    throw new HttpError(400, 'For how many days? 1 to 60.', { field: 'days' });
  }
  const reminder = b.reminder_interval_hours == null || b.reminder_interval_hours === ''
    ? null : Number(b.reminder_interval_hours);
  if (reminder !== null && (!Number.isFinite(reminder) || reminder < 0.5 || reminder > 168)) {
    throw new HttpError(400, 'Remind every how many hours? 0.5 to 168, or leave it empty.',
      { field: 'reminder_interval_hours' });
  }

  await adminQuery(`
    INSERT INTO condition_catalog
      (code, name, colour, reminder_interval_hours, is_contagious,
       medicine, treatment_days, interval_days, dose_note, withdrawal_days)
    VALUES ($1, $2, COALESCE($3, '#EA580C'), $4, COALESCE($5, false),
            $6, $7, COALESCE($8, 1), $9, $10)
    ON CONFLICT (code) DO UPDATE
      SET name = EXCLUDED.name,
          colour = EXCLUDED.colour,
          reminder_interval_hours = EXCLUDED.reminder_interval_hours,
          is_contagious = EXCLUDED.is_contagious,
          medicine = EXCLUDED.medicine,
          treatment_days = EXCLUDED.treatment_days,
          interval_days = EXCLUDED.interval_days,
          dose_note = EXCLUDED.dose_note,
          withdrawal_days = EXCLUDED.withdrawal_days,
          is_active = true,
          updated_at = now()`,
    [code, name, b.colour || null, reminder,
     b.is_contagious === 'on' || b.is_contagious === true,
     medicine, medicine ? days : null,
     b.interval_days ? Number(b.interval_days) : null,
     String(b.dose_note ?? '').trim() || null,
     b.withdrawal_days ? Number(b.withdrawal_days) : null]);

  await applyCatalogEverywhere();

  if (ct.includes('json')) {
    const { rows } = await adminQuery(
      'SELECT * FROM condition_catalog WHERE code = $1', [code]);
    return c.json({ sickness: rows[0] }, 201);
  }
  return c.redirect('/admin/sicknesses', 303);
});

adminRoutes.post('/sicknesses/:code/deactivate',
  requireAdminRole('superadmin'), async (c) => {
    const code = c.req.param('code');
    const { rowCount } = await adminQuery(
      'UPDATE condition_catalog SET is_active = false, updated_at = now() WHERE code = $1',
      [code]);
    if (!rowCount) throw new HttpError(404, 'No such sickness in the catalogue');
    await applyCatalogEverywhere();
    if ((c.req.header('content-type') ?? '').includes('json')) return c.json({ ok: true });
    return c.redirect('/admin/sicknesses', 303);
  });

adminRoutes.get('/farms/:id', async (c) => {
  const id = c.req.param('id');
  const [farm, audit_, subs, payments, staff] = await Promise.all([
    adminQuery('SELECT * FROM v_admin_farm_overview WHERE farm_id = $1', [id])
      .then((r) => r.rows[0]),
    adminQuery(`SELECT a.*, p.full_name AS admin_name FROM admin_audit_log a
                JOIN platform_admin p ON p.id = a.admin_id
                WHERE a.target_farm_id = $1 ORDER BY a.at DESC LIMIT 50`, [id])
      .then((r) => r.rows),
    adminQuery('SELECT * FROM subscription WHERE farm_id = $1', [id]).then((r) => r.rows[0]),
    /*
     * This farm's money, on this farm's page. Every admin sees it, including
     * support — "did my payment go through" is the call support takes, and
     * sending them to a separate screen they are not allowed into to answer it
     * is how a farmer ends up on hold. The platform-wide totals are a different
     * question and stay behind the billing role.
     */
    adminQuery(`SELECT * FROM v_admin_payment WHERE farm_id = $1
                 ORDER BY created_at DESC LIMIT 24`, [id]).then((r) => r.rows),
    // The farm's people: who works there, what they are paid, and how much
    // of this month they have worked — half the picture of an account.
    adminQuery(`
      SELECT e.id, e.full_name, e.role, e.phone, e.is_active,
             (e.password_hash IS NOT NULL) AS can_sign_in, e.joined_on,
             cs.monthly_amount AS monthly_salary,
             att.days_worked   AS month_days_worked
      FROM employee e
      LEFT JOIN v_current_salary cs ON cs.employee_id = e.id
      LEFT JOIN v_attendance_summary att
             ON att.employee_id = e.id
            AND att.month = to_char(farm_today(e.farm_id), 'YYYY-MM')
      WHERE e.farm_id = $1
      ORDER BY e.is_active DESC, e.role = 'owner' DESC, e.full_name`, [id])
      .then((r) => r.rows),
  ]);
  if (!farm) throw new HttpError(404, 'Farm not found');
  if (c.req.query('format') === 'json') {
    return c.json({ farm, audit: audit_, subscription: subs, payments, staff });
  }
  return c.html(renderFarm({
    farm, audit: audit_, subscription: subs, payments, staff, admin: c.get('admin'),
  }));
});

/* --------------------------------------------------------- a farm's herd -- */

/**
 * The Animals card opens here: the herd as the farmer sees it, read-only.
 * "What is actually on this farm" is the first question when a farmer calls
 * about anything, and impersonation is a heavier tool than the question needs.
 */
adminRoutes.get('/farms/:id/animals', async (c) => {
  const id = c.req.param('id');
  const [farm, animals] = await Promise.all([
    adminQuery('SELECT farm_id, farm_name FROM v_admin_farm_overview WHERE farm_id = $1', [id])
      .then((r) => r.rows[0]),
    adminQuery(`
      SELECT r.id, r.tag, r.name, r.sex, r.status, r.date_of_birth,
             b.name AS breed, c2.code AS cage
      FROM rabbit r
      LEFT JOIN breed b ON b.id = r.breed_id
      LEFT JOIN cage c2 ON c2.id = r.cage_id
      WHERE r.farm_id = $1
      ORDER BY (r.status = 'active') DESC, r.tag`, [id]).then((r) => r.rows),
  ]);
  if (!farm) throw new HttpError(404, 'Farm not found');
  if (c.req.query('format') === 'json') return c.json({ farm, animals });
  return c.html(renderFarmAnimals({ farm, animals, admin: c.get('admin') }));
});

/** One animal, its whole story: matings, litters, sickness, medicine, moves. */
adminRoutes.get('/farms/:id/animals/:animalId', async (c) => {
  const id = c.req.param('id');
  const animalId = c.req.param('animalId');
  const [farm, animal, events] = await Promise.all([
    adminQuery('SELECT farm_id, farm_name FROM v_admin_farm_overview WHERE farm_id = $1', [id])
      .then((r) => r.rows[0]),
    adminQuery(`
      SELECT r.id, r.tag, r.name, r.sex, r.status, r.date_of_birth,
             b.name AS breed, c2.code AS cage
      FROM rabbit r
      LEFT JOIN breed b ON b.id = r.breed_id
      LEFT JOIN cage c2 ON c2.id = r.cage_id
      WHERE r.farm_id = $1 AND r.id = $2`, [id, animalId]).then((r) => r.rows[0]),
    adminQuery(`
      SELECT on_date, kind, title FROM v_rabbit_history
      WHERE farm_id = $1 AND rabbit_id = $2
      ORDER BY on_date DESC, ord DESC`, [id, animalId]).then((r) => r.rows),
  ]);
  if (!farm) throw new HttpError(404, 'Farm not found');
  if (!animal) throw new HttpError(404, 'No such animal on this farm');
  if (c.req.query('format') === 'json') return c.json({ farm, animal, events });
  return c.html(renderFarmAnimal({ farm, animal, events, admin: c.get('admin') }));
});

/* ------------------------------------------------- a farm's person & pay -- */

/** Month-by-month pay for one employee, computed exactly as the farmer sees it. */
async function adminPayMonths(farmId, employeeId) {
  const { rows } = await adminQuery(`
    WITH span AS (
      SELECT date_trunc('month', LEAST(
               COALESCE((SELECT min(work_date) FROM attendance WHERE employee_id = $2),
                        farm_today($1)),
               COALESCE((SELECT joined_on FROM employee WHERE id = $2), farm_today($1)),
               COALESCE((SELECT min(effective_from) FROM staff_salary WHERE employee_id = $2),
                        farm_today($1))))::date AS a,
             date_trunc('month', farm_today($1)::timestamp)::date AS b
    )
    SELECT to_char(gs, 'YYYY-MM')                                        AS month,
           extract(day FROM (gs + interval '1 month' - interval '1 day'))::int AS days_in_month,
           COALESCE(s.present, 0)   AS present,
           COALESCE(s.half_days, 0) AS half_days,
           COALESCE(s.holiday, 0)   AS holiday,
           COALESCE(s.absent, 0)    AS absent,
           COALESCE(s.leave, 0)     AS leave,
           sal.monthly_amount,
           (COALESCE(s.present, 0) + 0.5 * COALESCE(s.half_days, 0)
            + COALESCE(s.holiday, 0))::numeric(6,1)                      AS paid_days,
           CASE WHEN sal.monthly_amount IS NULL THEN NULL
                ELSE round(sal.monthly_amount
                     * (COALESCE(s.present, 0) + 0.5 * COALESCE(s.half_days, 0)
                        + COALESCE(s.holiday, 0))
                     / extract(day FROM (gs + interval '1 month' - interval '1 day')), 2)
           END                                                           AS amount
    FROM span, generate_series(span.a, span.b, interval '1 month') gs
    LEFT JOIN v_attendance_summary s
           ON s.employee_id = $2 AND s.month = to_char(gs, 'YYYY-MM')
    LEFT JOIN LATERAL (
      SELECT monthly_amount FROM staff_salary
      WHERE employee_id = $2
        AND effective_from <= (gs + interval '1 month' - interval '1 day')::date
      ORDER BY effective_from DESC, created_at DESC LIMIT 1
    ) sal ON true
    ORDER BY month DESC`, [farmId, employeeId]);
  return rows;
}

/** One person on one farm: salary, its history, every month's attendance & pay. */
adminRoutes.get('/farms/:id/staff/:employeeId', async (c) => {
  const id = c.req.param('id');
  const employeeId = c.req.param('employeeId');
  const [farm, person] = await Promise.all([
    adminQuery('SELECT farm_id, farm_name FROM v_admin_farm_overview WHERE farm_id = $1', [id])
      .then((r) => r.rows[0]),
    adminQuery(`
      SELECT e.id, e.full_name, e.role, e.phone, e.is_active, e.joined_on,
             cs.monthly_amount, cs.effective_from
      FROM employee e
      LEFT JOIN v_current_salary cs ON cs.employee_id = e.id
      WHERE e.farm_id = $1 AND e.id = $2`, [id, employeeId]).then((r) => r.rows[0]),
  ]);
  if (!farm) throw new HttpError(404, 'Farm not found');
  if (!person) throw new HttpError(404, 'No such person on this farm');

  const [history, months] = await Promise.all([
    adminQuery(`
      SELECT ss.monthly_amount, ss.effective_from, ss.created_at,
             e2.full_name AS set_by_name
      FROM staff_salary ss LEFT JOIN employee e2 ON e2.id = ss.set_by
      WHERE ss.employee_id = $1
      ORDER BY ss.effective_from DESC, ss.created_at DESC`, [employeeId])
      .then((r) => r.rows),
    adminPayMonths(id, employeeId),
  ]);

  if (c.req.query('format') === 'json') {
    return c.json({ farm, person, history, months });
  }
  return c.html(renderFarmStaff({ farm, person, history, months, admin: c.get('admin') }));
});

/** The same payslip PDF the farmer prints, for the month asked. */
adminRoutes.get('/farms/:id/staff/:employeeId/payslip', async (c) => {
  const id = c.req.param('id');
  const employeeId = c.req.param('employeeId');
  const month = c.req.query('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new HttpError(400, 'month should look like 2026-08', { field: 'month' });
  }
  const [farm, person] = await Promise.all([
    adminQuery('SELECT farm_name FROM v_admin_farm_overview WHERE farm_id = $1', [id])
      .then((r) => r.rows[0]),
    adminQuery(`
      SELECT full_name, phone, role FROM employee
      WHERE farm_id = $1 AND id = $2`, [id, employeeId]).then((r) => r.rows[0]),
  ]);
  if (!farm) throw new HttpError(404, 'Farm not found');
  if (!person) throw new HttpError(404, 'No such person on this farm');

  const pay = (await adminPayMonths(id, employeeId)).find((m) => m.month === month);
  if (!pay || pay.monthly_amount == null) {
    throw new HttpError(409, 'No salary was in force for that month.');
  }
  const slug = person.full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  c.header('content-type', 'application/pdf');
  c.header('content-disposition', `attachment; filename="payslip-${slug}-${month}.pdf"`);
  return c.body(payslipPdf({ farmName: farm.farm_name, person, pay }));
});

/* ----------------------------------------------------- subscription actions -- */

const ACTIONS = {
  extend_trial: {
    roles: ['superadmin', 'support', 'billing'],
    apply: (client, farmId, days) => client(`
      UPDATE subscription
         SET status = 'trialing',
             trial_ends_on = GREATEST(COALESCE(trial_ends_on, current_date), current_date)
                             + $2::int,
             grace_until = NULL
       WHERE farm_id = $1 RETURNING *`, [farmId, days ?? 15]),
  },
  activate: {
    roles: ['superadmin', 'billing'],
    apply: (client, farmId) => client(`
      UPDATE subscription
         SET status = 'active', grace_until = NULL,
             current_period_start = current_date,
             current_period_end = current_date
               + CASE billing_period WHEN 'yearly' THEN 365 ELSE 30 END
       WHERE farm_id = $1 RETURNING *`, [farmId]),
  },
  suspend: {
    roles: ['superadmin', 'billing'],
    apply: (client, farmId) => client(
      `UPDATE subscription SET status = 'suspended' WHERE farm_id = $1 RETURNING *`, [farmId]),
  },
  cancel: {
    roles: ['superadmin', 'billing'],
    apply: (client, farmId) => client(`
      UPDATE subscription SET status = 'cancelled', cancelled_at = now()
       WHERE farm_id = $1 RETURNING *`, [farmId]),
  },
  comp: {
    // Free forever, for a case-study farm or a beta tester. Recorded as a price
    // of zero rather than a hidden flag, so it shows up honestly in MRR.
    roles: ['superadmin'],
    apply: (client, farmId) => client(`
      UPDATE subscription
         SET status = 'active', locked_price_monthly_paise = 0,
             locked_price_yearly_paise = 0, price_locked_at = now(),
             current_period_end = current_date + 3650
       WHERE farm_id = $1 RETURNING *`, [farmId]),
  },
};

/**
 * POST /admin/farms/:id/reset_password — the only way out of a lockout.
 *
 * There is no email verification, so there is no reset link to send. Someone
 * who forgets their password has no path back to their own records except
 * through a person — and until now that person had nothing to click either, so
 * the farm was simply gone.
 *
 * Support sets a temporary password and reads it out. Everything about that is
 * uncomfortable, so it is all constrained: a reason is required, it is audited
 * like every other admin action, the temporary password is shown exactly once
 * and never stored in readable form, and every existing session for that farm
 * is revoked — if the account was taken over, the reset must end the takeover
 * rather than leave the intruder signed in beside the owner.
 *
 * Registered before /farms/:id/:action, like the delete route. Hono matches
 * in registration order, so the wildcard below would otherwise answer
 * `Unknown action "reset_password"` and the role check would never run.
 */
adminRoutes.post('/farms/:id/reset_password',
  requireAdminRole('superadmin', 'support'), async (c) => {
    const admin = c.get('admin');
    const farmId = c.req.param('id');
    const ct = c.req.header('content-type') ?? '';
    const body = ct.includes('application/json')
      ? await c.req.json().catch(() => ({}))
      : Object.fromEntries(await c.req.formData());

    /*
     * No reason required here, alone among the admin actions — the owner's
     * call. The justification: a reset is what the sign-in screen's "call this
     * number" points at, the farmer is on the phone locked out right now, and
     * a compulsory form field between them and working again serves nobody.
     * The audit row still lands, attributed and timestamped; the reason column
     * records that none was asked for.
     */
    const reason = String(body.reason ?? '').trim() || 'password reset by admin (no reason required)';

    const { rows: owner } = await adminQuery(`
      SELECT e.id, e.full_name, e.email::text AS email, f.name AS farm_name
      FROM employee e JOIN farm f ON f.id = e.farm_id
      WHERE e.farm_id = $1 AND e.role = 'owner' AND e.is_active
      ORDER BY e.created_at LIMIT 1`, [farmId]);
    if (!owner.length) throw new HttpError(404, 'That farm has no active owner');

    // Generated, never chosen by the admin: a support person picking
    // "rabbit123" for the fourth time this week is how a platform gets breached.
    const temporary = newSessionToken().token.slice(0, 14);
    await adminQuery(
      `UPDATE employee SET password_hash = $2, password_changed_at = now() WHERE id = $1`,
      [owner[0].id, await hashPassword(temporary)]);

    // Everyone signed out, including whoever may have taken the account.
    await adminQuery(
      `UPDATE user_session SET revoked_at = now()
        WHERE employee_id IN (SELECT id FROM employee WHERE farm_id = $1)
          AND revoked_at IS NULL`, [farmId]);

    await audit(admin, 'reset_password', farmId,
      { owner: owner[0].email }, null, reason,
      clientIp(c), 'employee');

    return c.json({
      owner: { name: owner[0].full_name, email: owner[0].email },
      temporary_password: temporary,
      message: 'Read this to them once. Every session on the farm has been signed out.',
    });
  });

/**
 * DELETE a farm and everything in it.
 *
 * Superadmin only, reason required, and logged before the rows go — otherwise
 * the audit trail disappears along with the farm it was describing.
 *
 * This is for an erasure request or a farm created in error. It is NOT how a
 * lapsed subscription is handled: non-payment goes read-only and the data is
 * retained, because deleting a farmer's own records over ₹99 is indefensible.
 *
 * Registered BEFORE /farms/:id/:action below. Hono matches in registration
 * order, so the wildcard would otherwise swallow this and answer
 * `Unknown action "delete"`.
 */
adminRoutes.post('/farms/:id/delete', requireAdminRole('superadmin'), async (c) => {
  const admin = c.get('admin');
  const farmId = c.req.param('id');
  const ct = c.req.header('content-type') ?? '';
  const body = ct.includes('application/json')
    ? await c.req.json().catch(() => ({}))
    : Object.fromEntries(await c.req.formData());

  const reason = String(body.reason ?? '').trim();
  if (!reason) throw new HttpError(400, 'A reason is required to delete a farm');

  const { rows } = await adminQuery(
    'SELECT name FROM farm WHERE id = $1', [farmId]);
  if (!rows.length) throw new HttpError(404, 'Farm not found');

  // Typed confirmation, checked here and not only in the browser. The console
  // sends it; anything calling this endpoint directly has to mean it too, which
  // is the point — the caller has to have looked up which farm this id is.
  const confirm = String(body.confirm_name ?? '').trim();
  if (confirm !== rows[0].name) {
    throw new HttpError(400,
      `Confirm by sending the farm's exact name. This one is "${rows[0].name}".`,
      { field: 'confirm_name' });
  }

  // Logged first. target_farm_id is ON DELETE SET NULL, so the entry survives
  // with the farm's name preserved in the payload.
  await audit(admin, 'delete_farm', farmId,
    { name: rows[0].name }, null, reason, clientIp(c), 'farm');

  await adminQuery('DELETE FROM farm WHERE id = $1', [farmId]);

  if (ct.includes('application/json')) return c.json({ ok: true, deleted: rows[0].name });
  return c.redirect('/admin/farms');
});

/**
 * The console's "view this farm" button.
 *
 * Registered above /farms/:id/:action, like delete and reset_password. Hono
 * matches in registration order; below the wildcard this would answer
 * `Unknown action "impersonate"` and the role check would never run. That has
 * happened twice already, which is why there is a test for it.
 *
 * The work is in startImpersonation, further down.
 */
adminRoutes.post('/farms/:id/impersonate',
  requireAdminRole('superadmin', 'support'), async (c) => {
    const ct = c.req.header('content-type') ?? '';
    const body = ct.includes('application/json')
      ? await c.req.json().catch(() => ({}))
      : Object.fromEntries(await c.req.formData());

    const started = await startImpersonation(
      c, c.req.param('id'), String(body.reason ?? '').trim());

    if (ct.includes('application/json')) {
      return c.json({
        impersonation: started.impersonation,
        token: started.token,
        url: `/#support=${started.token}`,
      });
    }
    return c.html(renderImpersonation(started));
  });

/**
 * POST /admin/farms/:id/record_payment — money that arrived outside Razorpay.
 *
 * Farmers pay by UPI to a phone number and by bank transfer, and then they
 * call. Before this the only way to credit that was `activate`, which sets a
 * period end and leaves no payment row and no invoice — the money is in a bank
 * statement and nowhere in this system, and the GST return is short by ₹999.
 *
 * The work is billing_record_offline_payment, which sends it through the same
 * function Razorpay's webhook calls, so an offline payment extends a period and
 * takes an invoice number by exactly the same rules as an online one.
 *
 * Registered above /farms/:id/:action for the reason the three routes above it
 * are: Hono matches in registration order, and below the wildcard this would
 * answer `Unknown action "record_payment"`.
 */
adminRoutes.post('/farms/:id/record_payment',
  requireAdminRole('superadmin', 'billing'), async (c) => {
    const admin = c.get('admin');
    const farmId = c.req.param('id');
    const body = await readBody(c);

    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new HttpError(400, 'A reason is required to record a payment');

    const period = String(body.billing_period ?? 'yearly');
    if (!['monthly', 'yearly'].includes(period)) {
      throw new HttpError(400, 'Billing period must be monthly or yearly',
        { field: 'billing_period' });
    }

    // Blank means "what this farm actually pays", which is the locked price
    // rather than today's list price. Typing the number by hand is for the case
    // where a farmer sent a different amount, which happens.
    const amount = String(body.amount_paise ?? '').trim();
    if (amount && !/^\d+$/.test(amount)) {
      throw new HttpError(400, 'Amount must be a whole number of paise',
        { field: 'amount_paise' });
    }

    const before = await adminQuery(
      'SELECT status, current_period_end FROM subscription WHERE farm_id = $1',
      [farmId]).then((r) => r.rows[0]);
    if (!before) throw new HttpError(404, 'That farm has no subscription');

    let applied;
    try {
      const { rows } = await adminQuery(
        'SELECT * FROM billing_record_offline_payment($1, $2::billing_period_t, $3, $4)',
        [farmId, period, amount ? Number(amount) : null,
         String(body.reference ?? '').trim() || null]);
      applied = rows[0];
    } catch (err) {
      // The function raises for a farm with no subscription and for a farm with
      // no price. Both are things a person can act on, so say which.
      throw new HttpError(409, String(err.message ?? err).replace(/^ERROR:\s*/, ''));
    }

    await audit(admin, 'record_payment', farmId, before,
      { amount_paise: applied.amount_paise, billing_period: period,
        reference: String(body.reference ?? '').trim() || null,
        invoice_number: applied.invoice_number, period_end: applied.period_end },
      reason, clientIp(c), 'payment');

    if (wantsJson(c)) return c.json({ ok: true, payment: applied }, 201);
    return c.redirect(`/admin/farms/${farmId}`);
  });

adminRoutes.post('/farms/:id/:action', async (c) => {
  const admin = c.get('admin');
  const farmId = c.req.param('id');
  const actionName = c.req.param('action');
  const spec = ACTIONS[actionName];
  if (!spec) throw new HttpError(404, `Unknown action "${actionName}"`);
  if (!spec.roles.includes(admin.role)) {
    throw new HttpError(403, `This action needs the ${spec.roles.join(' or ')} role`);
  }

  const ct = c.req.header('content-type') ?? '';
  const body = ct.includes('application/json')
    ? await c.req.json().catch(() => ({}))
    : Object.fromEntries(await c.req.formData());

  const reason = String(body.reason ?? '').trim();
  // A log without a reason is a log nobody can read a year later.
  if (!reason) throw new HttpError(400, 'A reason is required for admin actions');

  const before = await adminQuery(
    'SELECT status, trial_ends_on, current_period_end FROM subscription WHERE farm_id = $1',
    [farmId]).then((r) => r.rows[0]);
  if (!before) throw new HttpError(404, 'That farm has no subscription');

  const run = (text, params) => adminQuery(text, params);
  const after = await spec.apply(run, farmId, body.days ? Number(body.days) : undefined)
    .then((r) => r.rows[0]);

  await audit(admin, actionName, farmId, before,
    { status: after.status, trial_ends_on: after.trial_ends_on,
      current_period_end: after.current_period_end },
    reason, clientIp(c));

  if (ct.includes('application/json')) {
    return c.json({ ok: true, action: actionName, subscription: after });
  }
  return c.redirect(`/admin/farms/${farmId}`);
});

/**
 * Start a support session on a farm.
 *
 * The record has existed since the first migration and granted nothing. What
 * actually lets support see the farm is the last step here: an ordinary farm
 * session, on the owner's employee row, bound to the impersonation record. It
 * goes through the same RLS as the farmer's own phone, which is the point —
 * support sees exactly what the farmer sees, no more, through no special path.
 *
 * Four things constrain it, and none of them are optional:
 *
 *   a reason, refused without one, in the audit log
 *   one hour, checked on every request rather than at token expiry
 *   read-only, enforced in requireAuth for every method that is not a read
 *   visible — a notification to the farm, and the support session shows up in
 *   the farmer's own list of signed-in devices with the admin's name on it
 *
 * The token is returned, never set as a cookie. The console hands it over in a
 * URL fragment, which browsers do not send to servers and proxies do not log.
 */
async function startImpersonation(c, farmId, reason) {
  const admin = c.get('admin');
  if (!reason) throw new HttpError(400, 'A reason is required to view a farm');

  const { rows: owner } = await adminQuery(`
    SELECT e.id, e.full_name, f.name AS farm_name
    FROM employee e JOIN farm f ON f.id = e.farm_id
    WHERE e.farm_id = $1 AND e.role = 'owner' AND e.is_active
    ORDER BY e.created_at LIMIT 1`, [farmId]);
  // Not "farm not found": a farm whose owner has been deactivated exists and
  // cannot be viewed, and saying so is the difference between a support person
  // retrying and a support person escalating.
  if (!owner.length) throw new HttpError(404, 'That farm has no active owner to view it as');

  const { rows } = await adminQuery(`
    INSERT INTO admin_impersonation (admin_id, farm_id, reason, expires_at, read_only)
    VALUES ($1,$2,$3, now() + interval '1 hour', $4)
    RETURNING id, started_at, expires_at, read_only`,
    // Always read-only. It used to be caller-controlled, which would have been
    // a footgun the moment somebody wired the consumer up: the docs promise
    // impersonation is read-only, and an API that lets the caller opt out of
    // that promise is not read-only.
    [admin.id, farmId, reason, true]);
  const imp = rows[0];

  const { token, hash } = newSessionToken();
  await adminQuery(`
    INSERT INTO user_session (employee_id, token_hash, expires_at, device,
                              impersonation_id, ip)
    VALUES ($1, $2, $3, $4, $5, $6)`,
    [owner[0].id, hash, imp.expires_at,
     `rabbitfarmers support · ${admin.full_name}`, imp.id,
     clientIp(c)]);

  /*
   * Tell the farm. Not by email — there is no sender — but into the same list
   * the nest-box reminders arrive in, which is the one place a farmer already
   * looks. Written after the session so a failure here cannot leave an admin
   * holding a token nobody was told about; if the insert throws, the whole
   * request fails and support tries again.
   */
  await adminQuery(`
    INSERT INTO notification (farm_id, kind, title, body, urgency, dedupe_key)
    VALUES ($1, 'support_access', $2, $3, 'medium', $4)`,
    [farmId,
     `${admin.full_name} from rabbitfarmers support opened your farm`,
     `They can see your records for one hour and cannot change anything. `
     + `Reason given: "${reason}". If you did not ask for help, change your `
     + `password from More — that ends every session on this farm, including theirs.`,
     `support-access:${imp.id}`]);

  await audit(admin, 'impersonate', farmId, null,
    { reason, expires_at: imp.expires_at }, reason,
    clientIp(c), 'admin_impersonation');

  return { impersonation: imp, token, farm_name: owner[0].farm_name, admin };
}

/** The same thing for anything driving the console over JSON. */
adminRoutes.post('/api/impersonate/:id', requireAdminRole('superadmin', 'support'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const started = await startImpersonation(
    c, c.req.param('id'), String(body.reason ?? '').trim());
  return c.json({
    impersonation: started.impersonation,
    token: started.token,
    url: `/#support=${started.token}`,
  });
});

/** End it early. Closing the tab is not ending it; this is. */
adminRoutes.post('/api/impersonate/:id/end',
  requireAdminRole('superadmin', 'support'), async (c) => {
    const id = c.req.param('id');
    const { rows } = await adminQuery(
      `UPDATE admin_impersonation SET ended_at = now()
        WHERE id = $1 AND ended_at IS NULL
        RETURNING farm_id`, [id]);
    // The session goes too. "Ended" and "still usable" disagreeing is the one
    // outcome that would make the audit log a lie.
    await adminQuery(
      `UPDATE user_session SET revoked_at = now(),
                               revoked_reason = 'support access ended'
        WHERE impersonation_id = $1 AND revoked_at IS NULL`, [id]);

    if (c.req.header('accept')?.includes('text/html')) {
      return c.redirect(rows[0]?.farm_id ? `/admin/farms/${rows[0].farm_id}` : '/admin/farms');
    }
    return c.json({ ok: true, ended: rows.length > 0 });
  });

/** Who is inside a customer's farm right now. */
adminRoutes.get('/api/impersonations', async (c) => {
  const { rows } = await adminQuery(
    'SELECT * FROM v_active_impersonation ORDER BY started_at DESC');
  return c.json({ active: rows });
});

adminRoutes.get('/api/summary', async (c) => {
  const { rows } = await adminQuery('SELECT * FROM v_admin_revenue_summary');
  return c.json({ summary: rows[0] });
});

/* ------------------------------------------------------- admin management -- */

adminRoutes.post('/api/admins', requireAdminRole('superadmin'), async (c) => {
  const b = await c.req.json();
  const hash = await hashPassword(b.password ?? '');
  const { rows } = await adminQuery(`
    INSERT INTO platform_admin (email, full_name, phone, role, password_hash)
    VALUES ($1,$2,$3,COALESCE($4,'support')::admin_role_t,$5)
    RETURNING id, email, full_name, role`,
    [String(b.email).toLowerCase(), b.full_name, b.phone ?? null, b.role ?? null, hash]);
  return c.json({ admin: rows[0] }, 201);
});

export { requireAdmin };
