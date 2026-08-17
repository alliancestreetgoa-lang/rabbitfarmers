/**
 * The redirect table, and the local mirror of it.
 *
 * The app and the API share an origin and their paths collide — `/daily` is a
 * screen AND an endpoint, `/billing` is a screen while `/billing/return` is a
 * server page. `netlify.toml` resolves that with an ordered, first-match-wins
 * list, and `scripts/dev-site.mjs` reimplements the same list so that running
 * locally proves what a deploy would answer.
 *
 * That last claim is only true while the two agree, and nothing made them.
 * They drifted the moment billing was added: Razorpay would have POSTed to the
 * deployed site, been handed index.html with a 200, treated the webhook as
 * delivered, and a farm that paid would never have been marked paid — with
 * nothing in any log to say so. A browser test caught it once. This catches it
 * every time.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isApi } from '../../../scripts/dev-site.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The redirect rules, in order, as Netlify reads them. */
function netlifyRules() {
  const toml = readFileSync(join(root, 'netlify.toml'), 'utf8');
  const rules = [];
  // Deliberately small rather than a TOML library: the shape here is fixed and
  // a parser would hide a malformed block instead of failing on it.
  for (const block of toml.split('[[redirects]]').slice(1)) {
    const from = /^\s*from\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const to = /^\s*to\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (from && to) rules.push({ from, to });
  }
  return rules;
}

/** Which side of the split does Netlify send this path to? */
function netlifyAnswers(pathname) {
  for (const rule of netlifyRules()) {
    const matches = rule.from.endsWith('/*')
      ? pathname === rule.from.slice(0, -2) || pathname.startsWith(rule.from.slice(0, -1))
      : pathname === rule.from;
    if (matches) return rule.to.includes('/.netlify/functions/') ? 'function' : 'app';
  }
  return 'app';
}

/*
 * Everything either side has to answer, and which. A path added to one table
 * and not the other shows up here as a disagreement rather than as a webhook
 * that silently stopped working.
 */
const PATHS = {
  // The function's.
  '/api/animals': 'function',
  '/api/auth/signin': 'function',
  '/admin': 'function',
  '/admin/login': 'function',
  '/admin/farms/abc': 'function',
  // The platform's money screen. Its name collides with the farmer's /billing
  // screen in the app, and only the /admin prefix keeps them apart.
  '/admin/billing': 'function',
  '/admin/billing/webhooks/evt_1': 'function',
  '/scheduler/run': 'function',
  '/scheduler/health': 'function',
  '/health': 'function',
  '/plans': 'function',
  '/webhooks/razorpay': 'function',
  '/webhooks/email': 'function',
  '/billing/return': 'function',

  // The app's. Every one of these is a screen whose name looks like an API.
  '/': 'app',
  '/daily': 'app',
  '/herd': 'app',
  '/breeding': 'app',
  '/billing': 'app',
  '/animals': 'app',
  '/record/mating': 'app',
  '/(app)/team': 'app',
  '/_expo/static/js/web/entry.js': 'app',
};

describe('the redirect table', () => {
  test('netlify.toml sends each path to the right side', () => {
    for (const [path, expected] of Object.entries(PATHS)) {
      assert.equal(netlifyAnswers(path), expected,
        `netlify.toml sends ${path} to the ${netlifyAnswers(path)}, expected the ${expected}`);
    }
  });

  test('the local dev site agrees with netlify.toml, path for path', () => {
    // The whole value of serving on one port locally.
    for (const path of Object.keys(PATHS)) {
      const netlify = netlifyAnswers(path);
      const local = isApi(path) ? 'function' : 'app';
      assert.equal(local, netlify,
        `${path}: netlify.toml says ${netlify}, scripts/dev-site.mjs says ${local}`);
    }
  });

  test('the catch-all is last, or it swallows everything above it', () => {
    const rules = netlifyRules();
    const catchAll = rules.findIndex((r) => r.from === '/*');
    assert.ok(catchAll >= 0, 'the SPA fallback is missing — deep links would 404');
    assert.equal(catchAll, rules.length - 1,
      'a rule after /* is unreachable: first match wins');
  });

  test('the SPA fallback is a rewrite, not a redirect', () => {
    // 200, not 301. A redirect would change the URL in the address bar and
    // break every deep link into the app.
    const toml = readFileSync(join(root, 'netlify.toml'), 'utf8');
    const last = toml.split('[[redirects]]').at(-1);
    assert.match(last, /status\s*=\s*200/);
  });

  test('every function rule points at the function that strips its own prefix', () => {
    /*
     * netlify/functions/api.mjs strips '/.netlify/functions/api' before handing
     * the request to Hono. A rule pointing anywhere else would arrive with a
     * path Hono has never heard of and 404 — while the redirect itself looked
     * perfectly correct in the file.
     */
    for (const rule of netlifyRules()) {
      if (!rule.to.includes('/.netlify/functions/')) continue;
      assert.ok(rule.to.startsWith('/.netlify/functions/api'),
        `${rule.from} points at ${rule.to}, which is not the api function`);
    }
  });
});
