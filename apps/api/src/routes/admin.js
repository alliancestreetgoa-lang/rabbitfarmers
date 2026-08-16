import { Hono } from 'hono';
import { adminQuery } from '../db.js';
import {
  hashPassword, verifyPassword, newSessionToken, hashToken, HttpError,
} from '../auth.js';
import { renderLogin, renderFarms, renderFarm, renderImpersonation } from '../admin-ui.js';

export const adminRoutes = new Hono();

const ADMIN_COOKIE = 'rb_admin';
// Deliberately short. Farm staff get 30 days because they are in a shed; the
// account that can read every farm on the platform does not.
const ADMIN_SESSION_HOURS = 8;

/* ------------------------------------------------------------------ auth -- */

function readAdminToken(c) {
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = c.req.header('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === ADMIN_COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Admin sessions live in the database, not in a Map. On serverless each request
// may hit a different instance, and an in-memory session store means the admin
// console signs you out at random. They also get their own table rather than
// sharing user_session, because platform admins are not tenants.
async function issueAdminSession(adminId, ip, userAgent) {
  const { token, hash } = newSessionToken();
  await adminQuery(`
    INSERT INTO admin_session (admin_id, token_hash, expires_at, ip, user_agent)
    VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [adminId, hash, ADMIN_SESSION_HOURS, ip || null, userAgent ?? null]);
  return token;
}

async function requireAdmin(c, next) {
  const token = readAdminToken(c);
  const wantsHtml = c.req.header('accept')?.includes('text/html');

  if (!token) {
    if (wantsHtml) return c.redirect('/admin/login');
    throw new HttpError(401, 'Admin sign-in required');
  }

  const { rows } = await adminQuery(`
    SELECT p.id, p.email, p.full_name, p.role
    FROM admin_session s
    JOIN platform_admin p ON p.id = s.admin_id
    WHERE s.token_hash = $1
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
      AND p.is_active`, [hashToken(token)]);

  if (!rows.length) {
    if (wantsHtml) return c.redirect('/admin/login');
    throw new HttpError(401, 'Admin sign-in required');
  }
  c.set('admin', rows[0]);
  await next();
}

function requireAdminRole(...roles) {
  return async (c, next) => {
    const admin = c.get('admin');
    if (!roles.includes(admin.role)) {
      throw new HttpError(403, `This action needs the ${roles.join(' or ')} role`);
    }
    await next();
  };
}

/** Every admin action against a farm lands here. Append-only, reason required. */
async function audit(admin, action, farmId, before, after, reason, ip, table = 'subscription') {
  await adminQuery(`
    INSERT INTO admin_audit_log (admin_id, action, target_farm_id, target_table,
                                 before_value, after_value, reason, ip)
    VALUES ($1,$2,$3,$8,$4,$5,$6,$7)`,
    [admin.id, action, farmId, before ? JSON.stringify(before) : null,
     after ? JSON.stringify(after) : null, reason ?? null, ip ?? null, table]);
}

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
    admin.id, c.req.header('x-forwarded-for'), c.req.header('user-agent'));
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

adminRoutes.get('/farms/:id', async (c) => {
  const id = c.req.param('id');
  const [farm, audit_, subs] = await Promise.all([
    adminQuery('SELECT * FROM v_admin_farm_overview WHERE farm_id = $1', [id])
      .then((r) => r.rows[0]),
    adminQuery(`SELECT a.*, p.full_name AS admin_name FROM admin_audit_log a
                JOIN platform_admin p ON p.id = a.admin_id
                WHERE a.target_farm_id = $1 ORDER BY a.at DESC LIMIT 50`, [id])
      .then((r) => r.rows),
    adminQuery('SELECT * FROM subscription WHERE farm_id = $1', [id]).then((r) => r.rows[0]),
  ]);
  if (!farm) throw new HttpError(404, 'Farm not found');
  if (c.req.query('format') === 'json') return c.json({ farm, audit: audit_, subscription: subs });
  return c.html(renderFarm({ farm, audit: audit_, subscription: subs, admin: c.get('admin') }));
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

    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new HttpError(400, 'A reason is required to reset a password');

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
      c.req.header('x-forwarded-for') ?? null, 'employee');

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
    { name: rows[0].name }, null, reason, c.req.header('x-forwarded-for') ?? null, 'farm');

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
    reason, c.req.header('x-forwarded-for') ?? null);

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
     `Rabbitry support · ${admin.full_name}`, imp.id,
     c.req.header('x-forwarded-for') || null]);

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
     `${admin.full_name} from Rabbitry support opened your farm`,
     `They can see your records for one hour and cannot change anything. `
     + `Reason given: "${reason}". If you did not ask for help, change your `
     + `password from More — that ends every session on this farm, including theirs.`,
     `support-access:${imp.id}`]);

  await audit(admin, 'impersonate', farmId, null,
    { reason, expires_at: imp.expires_at }, reason,
    c.req.header('x-forwarded-for') ?? null, 'admin_impersonation');

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
