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

/**
 * POST /auth/password — change your own password.
 *
 * Until now there was no way to change a password, and no way to recover one:
 * a farmer who forgot theirs lost the farm, permanently, with every record in
 * it. There was no admin action either. For a product people pay for monthly
 * that is not a gap, it is an ending.
 *
 * This is the half that needs no email or SMS: you are signed in, you know the
 * old one, you want a new one. Recovery for someone locked out entirely goes
 * through support — see POST /admin/farms/:id/reset_password.
 */
authRoutes.post('/password', requireAuth, async (c) => {
  const b = await c.req.json();
  const session = c.get('session');
  const current = b.current_password ?? '';
  const next = b.new_password ?? '';

  if (typeof next !== 'string' || next.length < 8) {
    throw new HttpError(400, 'The new password must be at least 8 characters',
      { field: 'new_password' });
  }
  if (next === current) {
    throw new HttpError(400, 'That is the password you already have',
      { field: 'new_password' });
  }

  const { rows } = await appQuery(
    'SELECT password_hash FROM auth_lookup_by_id($1)', [session.employeeId]);
  if (!rows.length || !(await verifyPassword(current, rows[0].password_hash))) {
    throw new HttpError(401, 'That is not your current password',
      { field: 'current_password' });
  }

  await appQuery('SELECT auth_set_password($1, $2)',
    [session.employeeId, await hashPassword(next)]);

  /*
   * Every other session is revoked, and this one is replaced.
   *
   * A password change is what someone does when they think a phone has been
   * taken or a farm hand has left. Leaving the old sessions alive makes the act
   * pointless — the whole reason to change it is to lock somebody out.
   */
  // hashToken, not the raw token: the function matches on token_hash, and a
  // value that matches nothing revokes nothing and reports success. A "sign
  // every device out" that silently does nothing is worse than not offering it.
  await appQuery('SELECT auth_revoke_session($1, true)', [hashToken(session.token)]);
  const { token, hash } = newSessionToken();
  await appQuery('SELECT auth_create_session($1,$2,$3,$4)',
    [session.employeeId, hash, 30, c.req.header('user-agent') ?? null]);

  c.header('Set-Cookie', sessionCookie(token));
  return c.json({
    token,
    message: 'Password changed. Every other device has been signed out.',
  });
});
