import { Hono } from 'hono';
import { appQuery } from '../db.js';
import {
  hashPassword, verifyPassword, newSessionToken, hashToken,
  validateSignup, HttpError,
} from '../auth.js';
import { requireAuth, sessionCookie, clearCookie, readToken } from '../middleware.js';

export const authRoutes = new Hono();

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS ?? 30);

/**
 * POST /auth/signup
 *
 * Email, phone, address, password, farm name. No verification step: the account
 * is usable the moment this returns. Creates farm + settings + owner + a
 * 30-day trial on whichever plan is currently on sale, price snapshotted so an
 * introductory rate survives a future price rise.
 */
authRoutes.post('/signup', async (c) => {
  const input = validateSignup(await c.req.json());
  const passwordHash = await hashPassword(input.password);

  let result;
  try {
    result = await appQuery(
      `SELECT * FROM auth_signup($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [input.farmName, input.fullName, input.email, input.phone, passwordHash,
       input.addressLine, input.city, input.state, input.pincode,
       input.timezone, TRIAL_DAYS]);
  } catch (err) {
    if (err.code === '23505') {
      throw new HttpError(409, 'That email is already registered', { field: 'email' });
    }
    throw err;
  }

  const { farm_id: farmId, employee_id: employeeId } = result.rows[0];
  const { token, hash } = newSessionToken();
  await appQuery('SELECT auth_create_session($1,$2,$3,$4)',
    [employeeId, hash, 30, c.req.header('user-agent') ?? null]);

  c.header('Set-Cookie', sessionCookie(token));
  return c.json({
    token,
    farm: { id: farmId, name: input.farmName },
    user: { id: employeeId, name: input.fullName, email: input.email, role: 'owner' },
    trial_days: TRIAL_DAYS,
  }, 201);
});

/** POST /auth/signin — email + password. */
authRoutes.post('/signin', async (c) => {
  const body = await c.req.json();
  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';

  const { rows } = await appQuery('SELECT * FROM auth_lookup_by_email($1)', [email]);
  const user = rows[0];

  // Same message and roughly the same work whether the email exists or not, so
  // the response cannot be used to enumerate who has an account.
  const ok = user?.is_active
    ? await verifyPassword(password, user.password_hash)
    : await verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');

  if (!ok || !user?.is_active) throw new HttpError(401, 'Email or password is incorrect');

  const { token, hash } = newSessionToken();
  await appQuery('SELECT auth_create_session($1,$2,$3,$4)',
    [user.employee_id, hash, 30, c.req.header('user-agent') ?? null]);

  c.header('Set-Cookie', sessionCookie(token));
  return c.json({
    token,
    farm: { id: user.farm_id },
    user: { id: user.employee_id, name: user.full_name, email, role: user.role },
  });
});

/** POST /auth/signout — revokes this device. ?all=1 revokes every device. */
authRoutes.post('/signout', async (c) => {
  const token = readToken(c);
  if (token) {
    const all = c.req.query('all') === '1';
    await appQuery('SELECT auth_revoke_session($1,$2)', [hashToken(token), all]);
  }
  c.header('Set-Cookie', clearCookie());
  return c.json({ ok: true });
});

/** GET /auth/me — who am I, what can I do, and how is the subscription doing. */
authRoutes.get('/me', requireAuth, async (c) => {
  const session = c.get('session');
  const db = c.get('db');

  const data = await db(async (client) => {
    const ent = await client.query(`
      SELECT plan_code, status, billing_period, access, trial_days_left,
             current_period_end, effective_price_paise, is_grandfathered
      FROM v_farm_entitlement`);
    const farm = await client.query(
      'SELECT id, name, timezone, city, state FROM farm');
    const sessions = await client.query(
      `SELECT id, device, issued_at, last_seen_at
       FROM v_active_session WHERE employee_id = $1 ORDER BY issued_at DESC`,
      [session.employeeId]);
    return {
      farm: farm.rows[0],
      subscription: ent.rows[0],
      active_sessions: sessions.rows,
    };
  });

  return c.json({
    user: {
      id: session.employeeId,
      name: session.fullName,
      role: session.role,
    },
    ...data,
  });
});
