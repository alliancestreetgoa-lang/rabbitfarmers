import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// scrypt is in Node core, so there is no native module to build and nothing to
// go wrong on a deploy. N=2^15 costs ~100ms per hash, which is the point — it
// is what makes an offline attack on a stolen database expensive.
//
// maxmem must be raised explicitly: N=32768, r=8 needs 128*N*r = exactly 32 MiB,
// and Node's default ceiling is also 32 MiB, so the call fails by a hair
// without it.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
  const salt = randomBytes(16);
  const key = await scryptAsync(plain, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(plain, stored) {
  if (!stored || typeof plain !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  let actual;
  try {
    actual = await scryptAsync(plain, salt, expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  } catch {
    return false;
  }
  // Constant-time: a length-dependent or early-exit compare leaks the hash.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Session tokens.
 *
 * The token goes to the client; only its SHA-256 goes in the database. A stolen
 * database therefore yields no usable sessions. SHA-256 is right here rather
 * than scrypt: the token is already 256 bits of entropy, so there is nothing to
 * brute-force and no reason to pay the cost on every request.
 */
export function newSessionToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Is this a timezone the system actually knows?
 *
 * It goes into farm.timezone, and every day count in the breeding engine is
 * computed in it. An unrecognised name does not degrade gracefully — Postgres
 * raises on `now() AT TIME ZONE 'nonsense'`, which broke that farm's herd list
 * outright and, because task generation is one statement across every farm,
 * took the whole platform's reminders down with it.
 *
 * The database refuses bad values too (migration 0021). This is here so the
 * farmer gets a sentence they can act on rather than a constraint violation.
 */
export function isKnownTimezone(tz) {
  try {
    // Throws RangeError for anything the ICU database does not recognise.
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Signup validation.
 *
 * Email is NOT verified — that is a deliberate product decision (see
 * docs/10-admin-console.md). But it is still format-checked and normalised,
 * because the one thing an unverified address must not be is un-parseable: it
 * is where every receipt and every renewal warning goes (migration 0030), and
 * there is no second channel to fall back to. SMS was considered and decided
 * against; recovery for somebody locked out is an admin resetting the password,
 * not a code.
 */
export function validateSignup(body) {
  const errors = {};
  const farmName = (body.farm_name ?? '').trim();
  const fullName = (body.full_name ?? '').trim();
  const email = (body.email ?? '').trim().toLowerCase();
  const phone = (body.phone ?? '').trim();
  const password = body.password ?? '';

  if (farmName.length < 2) errors.farm_name = 'Enter your farm name';
  if (fullName.length < 2) errors.full_name = 'Enter your name';
  if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address';
  // Deliberately loose: +91, spaces and dashes are all normal, and rejecting a
  // real number is worse than accepting an odd one.
  if (phone.replace(/\D/g, '').length < 8) errors.phone = 'Enter a valid phone number';
  if (typeof password !== 'string' || password.length < 8) {
    errors.password = 'Password must be at least 8 characters';
  }

  const timezone = (body.timezone ?? '').trim() || 'Asia/Kolkata';
  if (!isKnownTimezone(timezone)) {
    errors.timezone = 'Use a timezone name like Asia/Kolkata';
  }

  if (Object.keys(errors).length) throw new HttpError(400, 'Check the form', errors);

  return {
    farmName,
    fullName,
    email,
    phone,
    password,
    addressLine: (body.address_line ?? '').trim() || null,
    city: (body.city ?? '').trim() || null,
    state: (body.state ?? '').trim() || null,
    pincode: (body.pincode ?? '').trim() || null,
    timezone,
  };
}
