import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes } from './routes/auth.js';
import { farmRoutes } from './routes/farm.js';
import { staffRoutes } from './routes/staff.js';
import { billingRoutes } from './routes/billing.js';
import { adminRoutes } from './routes/admin.js';
import { schedulerRoutes } from './routes/scheduler.js';
import { errorHandler } from './middleware.js';
import { appQuery } from './db.js';

export function createApp() {
  const app = new Hono();

  app.onError(errorHandler);
  app.notFound((c) => c.json({ error: 'No such endpoint' }, 404));

  /**
   * CORS.
   *
   * On Netlify the app and the API are the same origin and this is a no-op.
   * It matters everywhere else: the Expo dev server runs on :8081, a web build
   * gets served from :8080, and without these headers the browser blocks every
   * request and the app just says "no connection" — which looks exactly like
   * being offline and is maddening to debug.
   *
   * Origins are an allowlist, never a wildcard, because these requests carry a
   * session token.
   */
  const configured = (process.env.CORS_ORIGINS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  app.use('*', cors({
    origin: (origin) => {
      if (!origin) return origin;                   // same-origin or a native app
      if (configured.includes(origin)) return origin;
      // Local development only. Never in production, where an attacker could
      // run a page on localhost and read a farmer's data.
      if (process.env.NODE_ENV !== 'production'
          && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return origin;
      }
      return null;
    },
    allowHeaders: ['content-type', 'authorization', 'accept', 'x-scheduler-secret'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    maxAge: 86400,
  }));

  // Liveness plus a real database round-trip. A health check that does not
  // touch the database will happily report green while every request fails.
  app.get('/health', async (c) => {
    try {
      await appQuery('SELECT 1');
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, error: 'database unreachable' }, 503);
    }
  });

  /*
   * There is no GET /plans any more. The product is free (migration 0031), and a
   * price list that answers ₹99 while nothing charges it is worse than a 404 —
   * anything still reading it would render a price that is not real.
   *
   * The plan table, v_current_public_plan and the payment routes below all
   * remain: they carry accounting history and are what charging again would be
   * built back on. Restoring the endpoint is a paste of five lines.
   */

  app.route('/auth', authRoutes);
  // Admin must be mounted BEFORE the farm routes. Those are mounted at '/' and
  // carry a use('*') auth guard, which would otherwise run for /admin/* too and
  // reject platform admins with a farmer-facing "sign in" error.
  app.route('/admin', adminRoutes);
  // Also before the farm routes: the scheduler authenticates with a shared
  // secret, not a farm session, so it must not hit the farm auth guard.
  app.route('/scheduler', schedulerRoutes);
  // Billing before the farm routes, and this one is not tidiness: the Razorpay
  // webhook and the payment-return page have no session, and the farm routes
  // carry a use('*') auth guard that would reject Razorpay's servers with a
  // farmer-facing "sign in" error and then be retried for a day.
  app.route('/', billingRoutes);
  // Staff before the farm routes only for tidiness — their paths do not
  // overlap. Both are mounted at '/' and both carry their own auth guard.
  app.route('/', staffRoutes);
  app.route('/', farmRoutes);

  return app;
}
