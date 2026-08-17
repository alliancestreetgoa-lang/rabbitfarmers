import { createApp } from '../src/app.js';
import { adminQuery, closePools } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const app = createApp();

/** Call the API the way a client does — through fetch, not by importing handlers. */
export async function api(method, path, { body, rawBody, token, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  // rawBody sends exactly these bytes. The Razorpay webhook is signed over the
  // body as it arrives, so a test that re-serialises through `body` would be
  // signing something other than what it sends.
  if (rawBody !== undefined) {
    init.body = rawBody;
  } else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (token) init.headers.authorization = `Bearer ${token}`;
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* html page */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

export async function form(method, path, fields, { token } = {}) {
  const params = new URLSearchParams(fields);
  const res = await app.fetch(new Request(`http://test${path}`, {
    method,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: params,
  }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

let counter = 0;
export const uniqueEmail = () =>
  `owner${process.pid}x${++counter}@example.test`;

/** Also unique: a phone is a login identity since migration 0024. */
export const uniquePhone = () =>
  `+91${String(process.pid).padStart(7, '0').slice(-7)}${String(++counter).padStart(3, '0')}`;

/** Sign up a farm and return its token plus ids. */
export async function signupFarm(overrides = {}) {
  const email = overrides.email ?? uniqueEmail();
  // Unique per farm, like the email. Since migration 0024 a phone is a login
  // identity — unique among accounts that can sign in — so a shared fixture
  // number means the second farm in any test cannot sign up at all.
  const phone = overrides.phone ?? uniquePhone();
  const res = await api('POST', '/auth/signup', {
    body: {
      farm_name: 'Test Rabbitry',
      full_name: 'Farm Owner',
      email,
      phone,
      password: 'correct horse battery',
      address_line: 'Survey 42',
      city: 'Margao',
      state: 'Goa',
      pincode: '403709',
      ...overrides,
    },
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.text}`);

  /*
   * Test farms run on UTC.
   *
   * Since migration 0020 the engine counts days in the farm's timezone, which
   * is right — and it means a fixture that builds dates with toISOString (UTC)
   * disagrees with the farm by one day for part of every day. The suite would
   * pass at noon and fail at three in the morning, which is the worst kind of
   * test.
   *
   * Pinning the fixture's timezone to UTC makes `dateAgo(n)` mean exactly n
   * days on the farm, whenever the suite happens to run. The farm-local
   * behaviour itself is covered deliberately, by a test that picks a timezone
   * far from UTC on purpose.
   */
  if (!overrides.timezone) {
    await adminQuery(`UPDATE farm SET timezone = 'UTC' WHERE id = $1`, [res.body.farm.id]);
  }

  return { ...res.body, email, phone };
}

export async function makeAdmin(role = 'superadmin') {
  const email = `admin${process.pid}x${++counter}@example.test`;
  const password = 'admin password 123';
  await adminQuery(
    `INSERT INTO platform_admin (email, full_name, role, password_hash)
     VALUES ($1,'Test Admin',$2::admin_role_t,$3)`,
    [email, role, await hashPassword(password)]);
  const res = await api('POST', '/admin/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`admin login failed: ${res.text}`);
  return { token: res.body.token, email };
}

/**
 * Remove everything THIS process created, leaving the seeded plan alone.
 *
 * Scoped by pid on purpose: `node --test` runs each file in its own process,
 * concurrently. A cleanup that matched on farm name would delete the farms and
 * admins another file was still using, which shows up as baffling 401s and
 * missing rows in whichever suite happened to be slower.
 */
export async function cleanup() {
  const mine = `%${process.pid}x%@example.test`;
  const farms = `SELECT farm_id FROM employee WHERE email::text LIKE '${mine}'`;
  await adminQuery(`DELETE FROM webhook_event     WHERE farm_id       IN (${farms})`);
  await adminQuery(`DELETE FROM admin_audit_log   WHERE target_farm_id IN (${farms})`);
  await adminQuery(`DELETE FROM admin_impersonation WHERE farm_id      IN (${farms})`);
  await adminQuery(`DELETE FROM farm               WHERE id            IN (${farms})`);
  // Then anything else this process's admins logged. Deleting a farm nulls the
  // audit row's target_farm_id — that is the point, the entry outlives the farm
  // — so those rows are no longer reachable through the farm and would
  // otherwise hold their admin hostage. In production nobody deletes an admin;
  // they are deactivated, and the log's foreign key is what guarantees it.
  await adminQuery(
    `DELETE FROM admin_audit_log
      WHERE admin_id IN (SELECT id FROM platform_admin WHERE email::text LIKE $1)`, [mine]);
  await adminQuery(`DELETE FROM platform_admin WHERE email::text LIKE $1`, [mine]);
}

export { closePools, adminQuery };
