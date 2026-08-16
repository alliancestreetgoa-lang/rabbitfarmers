/**
 * Netlify Functions v2 entry point.
 *
 * v2 functions receive a standard `Request` and return a standard `Response`,
 * which is exactly what Hono's `app.fetch` is — so this is a thin adapter with
 * no translation layer to go wrong.
 *
 * The app is built once at module scope. Netlify reuses a warm instance across
 * invocations, so the pg pools are reused too rather than reconnecting on every
 * request — which matters against Neon, where a cold connection is the slow part.
 *
 * Routing lives entirely in netlify.toml redirects rather than a `config.path`
 * here. The site now serves the farmer-facing app as static files, and its
 * client-side routes (/daily, /herd) collide head-on with API routes of the
 * same name. Redirects are evaluated top to bottom, first match wins, so
 * putting every rule in one ordered list is the only way to reason about which
 * of the two answers a given path.
 */
import { createApp } from '../../apps/api/src/app.js';

const app = createApp();

// Netlify rewrites /api/daily to /.netlify/functions/api/daily, so the function
// sees a path Hono knows nothing about. Strip the mount point back off before
// handing it over. Also strips a bare /api prefix, so the function still works
// if it is ever invoked directly rather than through the rewrite.
const MOUNTS = ['/.netlify/functions/api', '/api'];

export default async (request) => {
  const url = new URL(request.url);
  for (const mount of MOUNTS) {
    if (url.pathname === mount || url.pathname.startsWith(`${mount}/`)) {
      url.pathname = url.pathname.slice(mount.length) || '/';
      return app.fetch(new Request(url, request));
    }
  }
  return app.fetch(request);
};
