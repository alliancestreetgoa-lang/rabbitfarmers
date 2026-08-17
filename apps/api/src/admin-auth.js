/**
 * Who is allowed into the admin console, and the record of what they did.
 *
 * Its own module because there is now more than one admin router — the farms
 * console and the billing screen — and the alternative was one of them
 * importing the other for a middleware, which is a cycle waiting to break the
 * moment somebody adds a third.
 */
import { adminQuery } from './db.js';
import { newSessionToken, hashToken, HttpError } from './auth.js';

export const ADMIN_COOKIE = 'rb_admin';

// Deliberately short. Farm staff get 30 days because they are in a shed; the
// account that can read every farm on the platform does not.
export const ADMIN_SESSION_HOURS = 8;

export function readAdminToken(c) {
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
export async function issueAdminSession(adminId, ip, userAgent) {
  const { token, hash } = newSessionToken();
  await adminQuery(`
    INSERT INTO admin_session (admin_id, token_hash, expires_at, ip, user_agent)
    VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [adminId, hash, ADMIN_SESSION_HOURS, ip || null, userAgent ?? null]);
  return token;
}

export async function requireAdmin(c, next) {
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

export function requireAdminRole(...roles) {
  return async (c, next) => {
    const admin = c.get('admin');
    if (!roles.includes(admin.role)) {
      throw new HttpError(403, `This action needs the ${roles.join(' or ')} role`);
    }
    await next();
  };
}

/** Every admin action against a farm lands here. Append-only, reason required. */
export async function audit(admin, action, farmId, before, after, reason, ip,
                           table = 'subscription') {
  await adminQuery(`
    INSERT INTO admin_audit_log (admin_id, action, target_farm_id, target_table,
                                 before_value, after_value, reason, ip)
    VALUES ($1,$2,$3,$8,$4,$5,$6,$7)`,
    [admin.id, action, farmId, before ? JSON.stringify(before) : null,
     after ? JSON.stringify(after) : null, reason ?? null, ip ?? null, table]);
}

/**
 * Read a body from either an HTML form or a JSON client.
 *
 * The console posts forms; the tests and anything scripting the console post
 * JSON. Every admin action accepts both, and this is the one place that
 * decides which it is looking at.
 */
export async function readBody(c) {
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('application/json')) return await c.req.json().catch(() => ({}));
  return Object.fromEntries(await c.req.formData());
}

export const wantsJson = (c) =>
  (c.req.header('content-type') ?? '').includes('application/json');
