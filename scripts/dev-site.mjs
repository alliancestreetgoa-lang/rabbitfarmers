#!/usr/bin/env node
/**
 * Serve the whole product on one origin, the way Netlify will.
 *
 *   npm --prefix apps/api start                    # the API on :3000
 *   npm --prefix apps/mobile run build:web         # the app into dist/
 *   node scripts/dev-site.mjs                      # both on :8080
 *
 * Why this exists: the app and the API share an origin in production and their
 * paths overlap — /daily is a screen AND an endpoint. Testing the app on one
 * port and the API on another proves nothing about which of the two answers a
 * given path. This mirrors the redirect table in netlify.toml exactly, so a
 * routing mistake shows up here rather than after a deploy.
 *
 * It is a development tool. No caching, no compression, no TLS.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
// Two single-page apps, mirroring netlify.toml exactly: the web dashboard at
// the root, the Expo export (whose baseUrl is /app) underneath /app.
const WEB_DIST = join(ROOT, 'apps/web/dist');
const APP_DIST = join(ROOT, 'apps/mobile/dist');
const API = process.env.API_ORIGIN ?? 'http://localhost:3000';
const PORT = Number(process.env.PORT ?? 8080);

// The same split netlify.toml makes, in the same order. Everything not matched
// here is a client-side route and gets the SPA shell.
const API_PREFIXES = ['/api', '/admin', '/scheduler', '/webhooks'];
// /billing/return is the one path where a screen name and a server path collide:
// `/billing` is a screen in the app, `/billing/return` is where Razorpay sends
// the browser back to. Exact, so the screen still works.
const API_EXACT = ['/health', '/billing/return'];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/**
 * Does this path belong to the function rather than the app?
 *
 * Exported so a test can check it agrees with netlify.toml. The claim this
 * whole script rests on is "running on one origin locally proves what a deploy
 * would answer", and that claim is only true while these two tables say the
 * same thing. See apps/api/test/routing.test.js.
 */
export function isApi(pathname) {
  return API_EXACT.includes(pathname)
    || API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

async function serveFile(res, path) {
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) return false;
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'content-length': s.size,
  });
  createReadStream(path).pipe(res);
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (isApi(url.pathname)) {
    // Strip /api the way the Netlify rewrite plus the function's mount handling
    // do, so the API sees the paths it actually registers.
    const path = url.pathname === '/api' ? '/'
      : url.pathname.startsWith('/api/') ? url.pathname.slice(4)
      : url.pathname;

    const body = ['GET', 'HEAD'].includes(req.method) ? undefined
      : Buffer.concat(await new Promise((resolve) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c)).on('end', () => resolve(chunks));
        }));

    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];

    let upstream;
    try {
      upstream = await fetch(API + path + url.search, {
        method: req.method, headers, body,
        // redirect: 'manual' is load-bearing. The admin console signs you in
        // with a 302 and a Set-Cookie; the default 'follow' would chase that
        // redirect here, without the cookie it just issued, and hand the
        // browser back a 401 from the page it was redirected to. The redirect
        // belongs to the browser.
        redirect: 'manual',
      });
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: `API unreachable at ${API}`, detail: String(err) }));
    }

    const out = Object.fromEntries(upstream.headers);
    delete out['content-encoding'];        // fetch already decoded it
    delete out['content-length'];
    // Set-Cookie is the one header that legitimately repeats. Flattening it
    // into a comma-joined string silently merges two cookies into one broken
    // one, so take the array form.
    const cookies = upstream.headers.getSetCookie?.() ?? [];
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(upstream.status, out);
    return res.end(Buffer.from(await upstream.arrayBuffer()));
  }

  // Which app owns this path? /app and below is the Expo export, whose files
  // are addressed /app/... because of its baseUrl; everything else is the web
  // dashboard. normalize + the prefix check keep `..` from escaping either.
  const isApp = url.pathname === '/app' || url.pathname.startsWith('/app/');
  const dist = isApp ? APP_DIST : WEB_DIST;
  const rel = isApp ? url.pathname.replace(/^\/app/, '') || '/' : url.pathname;
  const target = normalize(join(dist, rel));
  if (target.startsWith(dist) && await serveFile(res, target)) return;

  // Otherwise the owning app's shell, with a 200 so a deep link keeps its path.
  if (await serveFile(res, join(dist, 'index.html'))) return;

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end(isApp
    ? `Nothing built yet. Run: npm --prefix apps/mobile run build:web\n`
    : `Nothing built yet. Run: npm --prefix apps/web run build\n`);
});

// Only when run as a command. Importing this to check the routing table must
// not start a server on a port somebody else is using.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`site      http://localhost:${PORT}`);
    console.log(`admin     http://localhost:${PORT}/admin/login`);
    console.log(`api       proxied to ${API}`);
    console.log(`serving   / -> ${WEB_DIST}`);
    console.log(`          /app -> ${APP_DIST}`);
  });
}
