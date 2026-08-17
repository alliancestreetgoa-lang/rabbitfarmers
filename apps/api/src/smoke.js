#!/usr/bin/env node
/**
 * Smoke-test a deployed instance over HTTP.
 *
 *   node src/smoke.js https://your-site.netlify.app
 *
 * Read-only by default: it checks health, pricing and that the admin console
 * and auth guards behave. Pass --write to also create a throwaway farm, which
 * proves the database is writable and the trial starts — note that this leaves
 * a real farm behind, so only do it against a staging deploy.
 */
const base = (process.argv[2] ?? '').replace(/\/$/, '');
const write = process.argv.includes('--write');

if (!base) {
  console.error('Usage: node src/smoke.js https://your-site.netlify.app [--write]');
  process.exit(1);
}

let failed = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m, detail) => { failed++; console.error(`  ✗ ${m}${detail ? `\n      ${detail}` : ''}`); };

async function check(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (err) {
    fail(name, err.message);
  }
}

const get = async (path, init) => {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { res, text, json };
};

console.log(`\nSmoke testing ${base}\n`);

await check('GET /health reaches the database', async () => {
  const { res, json } = await get('/health');
  if (!res.ok || json?.ok !== true) {
    throw new Error(`expected {ok:true}, got ${res.status} ${JSON.stringify(json)}`);
  }
});

await check('nothing serves a price — the product is free', async () => {
  /*
   * Checked against a DEPLOY, so this is where a half-shipped revert shows up: a
   * build still carrying the old endpoint would quote ₹99 to real farmers on a
   * product that never charges them.
   *
   * Asserted on the CONTENT rather than the status, because /plans is no longer
   * in netlify.toml's redirect table and an unrouted path is the app's — so a
   * deploy answers 200 with the SPA shell, not a 404. Checking `res.ok` here
   * would fail on a perfectly correct deploy.
   */
  const { json, text } = await get('/plans');
  if (json?.plans || text.includes('price_monthly_paise')) {
    throw new Error('something is still serving a price list; it went in migration 0031');
  }
});

await check('the admin console renders', async () => {
  const { res, text } = await get('/admin/login');
  if (!res.ok || !text.includes('rabbitfarmers admin')) {
    throw new Error(`got ${res.status}`);
  }
});

await check('farm endpoints reject an unauthenticated caller', async () => {
  /*
   * `/api/animals`, not `/animals`.
   *
   * This asked for `/animals` and expected a 401, which only holds when pointed
   * straight at the API process. On a deploy — what this script is for —
   * `/animals` is a SCREEN: netlify.toml sends farm endpoints to the function
   * under /api and everything unrouted to the app, so `/animals` returned the SPA
   * shell with a 200 and this check reported a broken auth guard on a healthy
   * site. apps/api/test/routing.test.js has asserted `'/animals': 'app'` all
   * along; the two disagreed and nothing compared them.
   */
  const { res } = await get('/api/animals');
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
});

await check('admin endpoints reject an unauthenticated caller', async () => {
  const { res } = await get('/admin/farms?format=json');
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
});

await check('HTTPS is being used', async () => {
  if (!base.startsWith('https://') && !base.includes('localhost')) {
    throw new Error('deployed site should be served over HTTPS');
  }
});

if (write) {
  const email = `smoke${Date.now()}@example.test`;
  await check('POST /auth/signup creates a farm and starts the trial', async () => {
    const { res, json } = await get('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        farm_name: 'Smoke Test Farm', full_name: 'Smoke Test',
        email, phone: '+919000000000', password: 'smoke test password',
        city: 'Margao', state: 'Goa',
      }),
    });
    if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(json)}`);
    if (json.trial_days !== 30) throw new Error(`trial_days was ${json.trial_days}`);
    console.log(`      created ${email} — delete it from the admin console when done`);
  });
}

console.log(failed === 0
  ? '\nAll good.\n'
  : `\n${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
