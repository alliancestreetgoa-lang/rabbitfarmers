#!/usr/bin/env node
/**
 * Create a platform admin — the only account that can reach the CRM.
 *
 *   node src/create-admin.js you@example.com "Your Name" superadmin
 *
 * The password is read from the ADMIN_PASSWORD environment variable rather than
 * an argument, because arguments end up in shell history and in `ps`.
 */
import { adminQuery, closePools } from './db.js';
import { hashPassword } from './auth.js';

const [email, fullName, role = 'superadmin'] = process.argv.slice(2);
const password = process.env.ADMIN_PASSWORD;

if (!email || !fullName || !password) {
  console.error(`Usage: ADMIN_PASSWORD='...' node src/create-admin.js <email> <name> [role]

  role: superadmin | billing | support | readonly  (default superadmin)`);
  process.exit(1);
}
if (password.length < 12) {
  console.error('Use at least 12 characters — this account can read every farm.');
  process.exit(1);
}

const { rows } = await adminQuery(`
  INSERT INTO platform_admin (email, full_name, role, password_hash)
  VALUES ($1, $2, $3::admin_role_t, $4)
  ON CONFLICT (email) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        full_name = EXCLUDED.full_name,
        role = EXCLUDED.role,
        is_active = true
  RETURNING id, email, full_name, role`,
  [email.toLowerCase(), fullName, role, await hashPassword(password)]);

console.log(`admin ready: ${rows[0].email} (${rows[0].role})`);
console.log('sign in at /admin/login');
await closePools();
