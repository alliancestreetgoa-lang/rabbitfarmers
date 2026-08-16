import pg from 'pg';

// Money is stored in paise as integers; make sure bigint columns come back as
// numbers we can add up rather than strings.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
// NUMERIC stays a string by default (arbitrary precision). Nothing we do needs
// that precision, and silent string concatenation in a total is worse.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
// DATE stays a plain 'YYYY-MM-DD' string rather than becoming a JS Date.
//
// A kindling date is a calendar day on the farm, not an instant. Turning it
// into a Date attaches the server's timezone to it, and a due date that shifts
// by a day depending on where the server runs is precisely the bug the docs
// warn about. Keep calendar dates as calendar dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * Two pools, deliberately.
 *
 *  app   — the farmer-facing API. Connects as a role WITHOUT bypassrls, so
 *          row-level security is doing the isolating, not our WHERE clauses.
 *  admin — the super-admin CRM. Bypasses RLS, because reaching across every
 *          tenant is its entire job. Never used to serve a farmer request.
 */
export const appPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  // Neon suspends idle computes; a cold connection can take a moment.
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
});

export const adminPool = new pg.Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  max: Number(process.env.PG_ADMIN_POOL_MAX ?? 4),
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
});

/**
 * Run `fn` inside a transaction with the farm context set.
 *
 * `set_config(..., true)` makes the setting LOCAL to the transaction. That is
 * the important bit: on a pooled connection, a value that outlived its
 * transaction would leak one farm's context into the next request — which is
 * exactly the cross-tenant bug RLS is here to prevent.
 */
export async function withFarm(farmId, fn) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.farm_id', farmId ?? '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Unscoped query on the app role — only for the SECURITY DEFINER auth_* calls. */
export async function appQuery(text, params) {
  return appPool.query(text, params);
}

/** Admin queries bypass RLS. Every caller must already have checked admin auth. */
export async function adminQuery(text, params) {
  return adminPool.query(text, params);
}

export async function closePools() {
  await Promise.allSettled([appPool.end(), adminPool.end()]);
}
