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

await check('GET /plans serves the live price list', async () => {
  const { json } = await get('/plans');
  const plan = json?.plans?.[0];
  if (!plan) throw new Error('no plan on sale — did db/seed.sql run?');
  if (plan.price_monthly_paise !== 9900 || plan.price_yearly_paise !== 99900) {
    throw new Error(`expected ₹99/₹999, got ${plan.price_monthly_paise}/${plan.price_yearly_paise} paise`);
  }
  if (!plan.is_introductory) throw new Error('plan is not flagged introductory');
});

await check('the admin console renders', async () => {
  const { res, text } = await get('/admin/login');
  if (!res.ok || !text.includes('Rabbitry admin')) {
    throw new Error(`got ${res.status}`);
  }
});

await check('farm endpoints reject an unauthenticated caller', async () => {
  const { res } = await get('/animals');
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
