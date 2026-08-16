import { Hono } from 'hono';
import { authRoutes } from './routes/auth.js';
import { farmRoutes } from './routes/farm.js';
import { adminRoutes } from './routes/admin.js';
import { schedulerRoutes } from './routes/scheduler.js';
import { errorHandler } from './middleware.js';
import { appQuery } from './db.js';

export function createApp() {
  const app = new Hono();

  app.onError(errorHandler);
  app.notFound((c) => c.json({ error: 'No such endpoint' }, 404));

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

  // Public price list — the pricing page reads this rather than hard-coding ₹99.
  app.get('/plans', async (c) => {
    const { rows } = await appQuery(`
      SELECT code, name, price_monthly_paise, price_yearly_paise, is_introductory
      FROM v_current_public_plan`);
    return c.json({ plans: rows, trial_days: Number(process.env.TRIAL_DAYS ?? 30) });
  });

  app.route('/auth', authRoutes);
  // Admin must be mounted BEFORE the farm routes. Those are mounted at '/' and
  // carry a use('*') auth guard, which would otherwise run for /admin/* too and
  // reject platform admins with a farmer-facing "sign in" error.
  app.route('/admin', adminRoutes);
  // Also before the farm routes: the scheduler authenticates with a shared
  // secret, not a farm session, so it must not hit the farm auth guard.
  app.route('/scheduler', schedulerRoutes);
  app.route('/', farmRoutes);

  return app;
}
