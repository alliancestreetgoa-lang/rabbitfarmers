/**
 * Cross-tenant isolation.
 *
 * This is the suite that protects the business rather than the feature. One
 * farm reading another's data ends the product, so these run on every build.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupFarm, cleanup, closePools, adminQuery } from './helpers.js';
import { appPool } from '../src/db.js';

after(async () => { await cleanup(); await closePools(); });

describe('tenant isolation', () => {
  test('farm A cannot see farm B through any endpoint', async () => {
    const a = await signupFarm();
    const b = await signupFarm();

    await api('POST', '/animals', { token: a.token, body: { name: 'Lakshmi-A', sex: 'doe' } });
    await api('POST', '/animals', { token: b.token, body: { name: 'Rani-B', sex: 'doe' } });

    const listA = await api('GET', '/animals', { token: a.token });
    const listB = await api('GET', '/animals', { token: b.token });

    assert.equal(listA.body.animals.length, 1);
    assert.equal(listB.body.animals.length, 1);
    assert.equal(listA.body.animals[0].name, 'Lakshmi-A');
    assert.equal(listB.body.animals[0].name, 'Rani-B');
    assert.ok(!JSON.stringify(listA.body).includes('Rani-B'), "A must not see B's animals");
    assert.ok(!JSON.stringify(listB.body).includes('Lakshmi-A'), "B must not see A's animals");
  });

  test("farm A cannot act on farm B's records even knowing the id", async () => {
    const a = await signupFarm();
    const b = await signupFarm();

    const doeB = await api('POST', '/animals', {
      token: b.token, body: { name: 'Ganga-B', sex: 'doe' },
    });
    const idB = doeB.body.animal.id;

    // A holds a valid id from another tenant. RLS must make it invisible, so
    // the foreign key has nothing to point at.
    const mating = await api('POST', '/matings', { token: a.token, body: { doe_id: idB } });
    assert.notEqual(mating.status, 201, "A must not be able to breed B's doe");

    const { rows } = await adminQuery('SELECT count(*)::int AS n FROM mating WHERE doe_id = $1', [idB]);
    assert.equal(rows[0].n, 0);
  });

  test('every tenant table is covered by RLS, not just the ones we remembered', async () => {
    // Guards against the real failure mode: someone adds a table later and
    // forgets the policy, and nothing notices until it leaks.
    const { rows } = await adminQuery(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT c.relrowsecurity
        -- Platform tables, deliberately outside the tenant model. They are not
        -- reachable by the farmer-facing role at all (see migration 0006), so
        -- RLS would be belt on top of a wall. Adding a table here is a decision
        -- to make on purpose, which is the point of the list.
        -- audit_log is NOT on this list any more. It was, and it was only safe
        -- because nothing ever wrote to it; migration 0013 started writing farm
        -- corrections there and gave it a policy at the same time.
        -- condition_catalog is the superadmin's master list of sicknesses and
        -- treatments (0037): platform-wide by design, granted to the admin role
        -- only, pressed onto farms through SECURITY DEFINER functions.
        AND c.relname NOT IN ('schema_migration','plan','platform_admin',
                              'admin_audit_log','admin_impersonation',
                              'admin_session','scheduler_run','condition_catalog',
        -- invoice_series is one row per financial year, shared by every farm:
        -- a GST invoice number series has no tenant to scope it to. Revoked
        -- from the farmer-facing role entirely (migration 0026), which is the
        -- wall; there is no policy to be the belt. credit_note_series is the
        -- same document series for money going the other way (0028).
        -- email_suppression is the third of these: an address that bounces is
        -- dead for every farm at once, not for one of them, and the send path
        -- must have no way around the list. Revoked entirely (0030).
                              'invoice_series', 'credit_note_series',
                              'email_suppression')
      ORDER BY 1`);
    assert.deepEqual(rows.map((r) => r.relname), [],
      `these tables have no row-level security: ${rows.map((r) => r.relname).join(', ')}`);
  });

  test('every view runs as its caller, not as its owner', async () => {
    // Postgres views default to running with the OWNER's privileges, which
    // silently bypasses the caller's RLS. One view missing this flag leaks
    // every farm's data through it.
    const { rows } = await adminQuery(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'v'
        AND NOT COALESCE((SELECT option_value::boolean
                          FROM pg_options_to_table(c.reloptions)
                          WHERE option_name = 'security_invoker'), false)
      ORDER BY 1`);
    assert.deepEqual(rows.map((r) => r.relname), [],
      `these views bypass row-level security: ${rows.map((r) => r.relname).join(', ')}`);
  });

  test('views do not leak other farms', async () => {
    const a = await signupFarm();
    const b = await signupFarm();
    const doeB = await api('POST', '/animals', {
      token: b.token, body: { name: 'Kaveri-B', sex: 'doe', date_of_birth: '2024-01-01' },
    });
    const buckB = await api('POST', '/animals', {
      token: b.token, body: { name: 'Buck-B', sex: 'buck', date_of_birth: '2024-01-01' },
    });
    await api('POST', '/matings', {
      token: b.token, body: { doe_id: doeB.body.animal.id, buck_id: buckB.body.animal.id },
    });

    // Every one of these reads through a view.
    const pregnant = await api('GET', '/pregnant', { token: a.token });
    const daily = await api('GET', '/daily', { token: a.token });
    const ready = await api('GET', '/ready-to-mate', { token: a.token });
    const conditions = await api('GET', '/conditions', { token: a.token });

    assert.equal(pregnant.body.summary.total_pregnant, 0);
    assert.equal(pregnant.body.does.length, 0);
    assert.equal(daily.body.items.length, 0);
    assert.equal(ready.body.ready.length, 0);
    assert.equal(conditions.body.open.length, 0);
  });

  test('the app role cannot bypass RLS', async () => {
    const { rows } = await adminQuery(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'rabbitry_app'`);
    assert.equal(rows[0]?.rolbypassrls, false,
      'the farmer-facing role must never bypass row-level security');
  });

  test('the app role cannot touch the platform tables at all', async () => {
    // These hold every admin's credentials and every farm's audit trail. RLS is
    // not the defence here — the grant is.
    for (const table of ['platform_admin', 'admin_session', 'admin_audit_log',
                         'scheduler_run']) {
      const { rows } = await adminQuery(
        `SELECT has_table_privilege('rabbitry_app', $1, 'SELECT') AS can_read`, [table]);
      assert.equal(rows[0].can_read, false,
        `the farmer-facing role must not be able to read ${table}`);
    }
  });

  test('an unset farm context sees nothing at all', async () => {
    const a = await signupFarm();
    await api('POST', '/animals', { token: a.token, body: { name: 'Meera-A', sex: 'doe' } });

    // Same pool the API uses, but without set_config. Default-deny means zero
    // rows rather than everything.
    const client = await appPool.connect();
    try {
      const { rows } = await client.query('SELECT count(*)::int AS n FROM rabbit');
      assert.equal(rows[0].n, 0, 'no farm context must mean no rows');
    } finally {
      client.release();
    }
  });

  test('farm context does not leak between pooled requests', async () => {
    const a = await signupFarm();
    const b = await signupFarm();
    await api('POST', '/animals', { token: a.token, body: { name: 'Sita-A', sex: 'doe' } });

    // Hammer the pool alternating tenants; a transaction-local setting means
    // every response stays correct even when connections are reused.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api('GET', '/animals', { token: i % 2 === 0 ? a.token : b.token })
          .then((r) => ({ i, names: r.body.animals.map((x) => x.name) }))));

    for (const { i, names } of results) {
      if (i % 2 === 0) assert.deepEqual(names, ['Sita-A']);
      else assert.deepEqual(names, [], "B's requests must never pick up A's context");
    }
  });
});

/**
 * Privileges, checked as privileges rather than as behaviour.
 *
 * These tests connect as the database superuser, which bypasses every
 * privilege check — so a missing GRANT is invisible to all of them. That is
 * how `apply_condition_catalog` shipped un-executable: migration 0037 revoked
 * it from PUBLIC and granted it back to nobody, the admin console's
 * "Add & apply to every farm" died with "permission denied for function", and
 * the whole suite stayed green. Assert the grants directly instead.
 */
describe('the roles the API actually connects as', () => {
  // Looked up by name rather than by signature: the point is the grant, and a
  // hard-coded argument list would make this test fail for the wrong reason the
  // first time somebody adds a parameter.
  const calledDirectly = [
    ['rabbitry_admin', 'apply_condition_catalog'],
    ['rabbitry_app', 'auth_signup'],
    ['rabbitry_app', 'auth_resolve_session'],
    ['rabbitry_app', 'auth_create_session'],
    ['rabbitry_app', 'auth_lookup_by_email'],
    ['rabbitry_app', 'auth_lookup_by_phone'],
    ['rabbitry_app', 'auth_set_password'],
    ['rabbitry_app', 'auth_revoke_session'],
  ];

  test('can execute every SECURITY DEFINER function called straight from Node', async () => {
    for (const [role, fn] of calledDirectly) {
      const { rows } = await adminQuery(
        `SELECT p.oid::regprocedure::text AS sig,
                has_function_privilege($1, p.oid, 'EXECUTE') AS may_execute
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $2`, [role, fn]);
      assert.ok(rows.length > 0, `${fn} does not exist — the API calls it by name`);
      for (const r of rows) {
        assert.equal(r.may_execute, true,
          `${role} cannot EXECUTE ${r.sig} — the API calls it directly and will 500`);
      }
    }
  });

  // A second test that actually pressed the catalogue onto a fresh farm was
  // removed: condition_catalog is global rather than farm-scoped, so it raced
  // with admin.test.js's catalogue assertions when the files run in parallel.
  // The grant is what regressed and the assertion above checks it directly,
  // without touching shared state.

});
