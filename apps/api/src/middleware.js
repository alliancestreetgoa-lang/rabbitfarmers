import { appQuery, withFarm } from './db.js';
import { hashToken, HttpError } from './auth.js';

const SESSION_COOKIE = 'rb_session';

export function readToken(c) {
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = c.req.header('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(token, maxAgeDays = 30) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeDays * 86400}`,
  ];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Resolves the session and attaches { session, db } to the request.
 *
 * `db` runs every query inside a transaction with app.farm_id set, so RLS —
 * not application code — is what stops one farm reading another's rows.
 */
export async function requireAuth(c, next) {
  const token = readToken(c);
  if (!token) throw new HttpError(401, 'Sign in to continue');

  const { rows } = await appQuery('SELECT * FROM auth_resolve_session($1)', [hashToken(token)]);
  if (!rows.length) throw new HttpError(401, 'Your session has expired. Sign in again.');

  const s = rows[0];
  c.set('session', {
    sessionId: s.session_id,
    employeeId: s.employee_id,
    farmId: s.farm_id,
    fullName: s.full_name,
    role: s.role,
    token,
  });
  c.set('db', (fn) => withFarm(s.farm_id, fn));
  await next();
}

/**
 * Blocks writes when the subscription no longer entitles them.
 *
 * Read endpoints stay open on every status, and so do reminders — a farm that
 * has stopped paying still gets its nest-box and loose-motion alerts. Billing
 * failure must never cost an animal. See docs/09-saas-model.md.
 */
export async function requireWriteAccess(c, next) {
  const db = c.get('db');
  const access = await db(async (client) => {
    const { rows } = await client.query(
      'SELECT access, status, trial_ends_on FROM v_farm_entitlement');
    return rows[0];
  });

  if (!access || access.access !== 'full') {
    throw new HttpError(402, 'Your subscription has ended', {
      status: access?.status ?? 'none',
      // Deliberately specific: the farmer can still read and export everything.
      // Only new records are blocked.
      read_only: true,
      message: 'You can still view and export all your records. Renew to add new ones.',
    });
  }
  await next();
}

export function requireRole(...roles) {
  return async (c, next) => {
    const session = c.get('session');
    if (!roles.includes(session.role)) {
      throw new HttpError(403, `Only ${roles.join(' or ')} can do that`);
    }
    await next();
  };
}

export async function errorHandler(err, c) {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, detail: err.detail ?? null }, err.status);
  }
  // Postgres unique violation — almost always a duplicate tag or email.
  if (err?.code === '23505') {
    const field = /email/.test(err.detail ?? '') ? 'email' : 'tag';
    return c.json({
      error: field === 'email'
        ? 'That email is already registered'
        : 'That tag is already used by another rabbit',
      detail: { field },
    }, 409);
  }
  if (err?.code === '23514') {
    return c.json({ error: 'That value is out of range', detail: err.constraint }, 400);
  }
  // Foreign key violation. With the tenant-scoped composite keys, the common
  // cause is referencing a record that does not exist *for this farm* — which
  // from the caller's side is indistinguishable from it not existing at all,
  // and should stay that way.
  if (err?.code === '23503') {
    return c.json({
      error: 'That animal or record does not exist on this farm',
      detail: { constraint: err.constraint },
    }, 404);
  }
  console.error('[api]', err);
  return c.json({ error: 'Something went wrong on our side' }, 500);
}
