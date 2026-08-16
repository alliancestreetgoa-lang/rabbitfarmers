import { Hono } from 'hono';
import { adminQuery } from '../db.js';
import {
  hashPassword, verifyPassword, newSessionToken, hashToken, HttpError,
} from '../auth.js';
import { renderLogin, renderFarms, renderFarm } from '../admin-ui.js';

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
async function audit(admin, action, farmId, before, after, reason, ip) {
  await adminQuery(`
    INSERT INTO admin_audit_log (admin_id, action, target_farm_id, target_table,
                                 before_value, after_value, reason, ip)
    VALUES ($1,$2,$3,'subscription',$4,$5,$6,$7)`,
    [admin.id, action, farmId, before ? JSON.stringify(before) : null,
     after ? JSON.stringify(after) : null, reason ?? null, ip ?? null]);
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

/** Time-boxed, reason-tagged, read-only by default, and visible to the farm. */
adminRoutes.post('/api/impersonate/:id', requireAdminRole('superadmin', 'support'), async (c) => {
  const admin = c.get('admin');
  const farmId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason ?? '').trim();
  if (!reason) throw new HttpError(400, 'A reason is required to view a farm');

  const { rows } = await adminQuery(`
    INSERT INTO admin_impersonation (admin_id, farm_id, reason, expires_at, read_only)
    VALUES ($1,$2,$3, now() + interval '1 hour', $4)
    RETURNING id, expires_at, read_only`,
    [admin.id, farmId, reason, body.read_only !== false]);

  await audit(admin, 'impersonate', farmId, null, { reason }, reason, null);
  return c.json({ impersonation: rows[0] });
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
