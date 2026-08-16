import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { runScheduler, schedulerHealth } from '../scheduler.js';
import { HttpError } from '../auth.js';

export const schedulerRoutes = new Hono();

/**
 * The trigger is a plain HTTP endpoint so anything can drive it — Netlify's
 * scheduler, a GitHub Action, curl from a laptop. That means it needs a secret;
 * otherwise anyone who finds the URL can hammer the database.
 */
function assertSecret(c) {
  const expected = process.env.SCHEDULER_SECRET;
  if (!expected) {
    throw new HttpError(503, 'SCHEDULER_SECRET is not configured on the server');
  }
  const given = c.req.header('x-scheduler-secret')
    ?? (c.req.header('authorization') ?? '').replace(/^Bearer /, '');

  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  // Constant-time, and length-safe: timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, 'Bad scheduler secret');
  }
}

/** POST /scheduler/run — generate everything due right now. */
schedulerRoutes.post('/run', async (c) => {
  assertSecret(c);
  const result = await runScheduler({
    triggeredBy: c.req.query('by') ?? 'manual',
  });
  return c.json(result);
});

/**
 * GET /scheduler/health — for an uptime monitor.
 *
 * Returns 503 when the scheduler has gone quiet, so a monitor that only
 * understands status codes still pages you. This is the alerting.
 */
schedulerRoutes.get('/health', async (c) => {
  const health = await schedulerHealth();
  return c.json(health, health.healthy ? 200 : 503);
});
