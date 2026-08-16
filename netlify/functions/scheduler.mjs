/**
 * Netlify Scheduled Function — the thing that actually fires the reminders.
 *
 * NOT pg_cron. Neon suspends an idle compute, pg_cron only runs while the
 * compute is awake, and there is no wake-on-cron — so a farm that goes quiet
 * overnight would silently stop getting its day-28 nest box task, with no error
 * anywhere. An external scheduler both drives the work and wakes the database.
 *
 * Cadence: every 15 minutes.
 *
 *   - Loose-motion reminders repeat every 2 hours from the last observation, so
 *     15 minutes is comfortably fine-grained enough to hit each slot promptly.
 *   - Daily tasks only need to exist by morning, so this is generous for them.
 *   - Netlify caps a scheduled function at 30 seconds. All the work is
 *     set-based SQL across every farm in one pass, so this stays well inside
 *     that even with a lot of customers — but keep an eye on duration_ms in
 *     scheduler_run as the farm count grows.
 *
 * Netlify cron is UTC. That is fine: nothing here assumes the server's day.
 * Farm-local dates and quiet hours are computed from farm.timezone in SQL.
 */
import { runScheduler } from '../../apps/api/src/scheduler.js';

export default async () => {
  try {
    const result = await runScheduler({ triggeredBy: 'schedule' });
    console.log(
      `scheduler: ${result.tasksCreated} task(s), ` +
      `${result.notificationsCreated} notification(s), ${result.durationMs}ms`);
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    // Log loudly and return 500 so the failure is visible in Netlify's function
    // logs. The run is already recorded as failed in scheduler_run, which is
    // what /scheduler/health reports on — that is the alerting path.
    console.error('scheduler failed:', err);
    return new Response(JSON.stringify({ ok: false, error: String(err.message ?? err) }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
};

export const config = {
  schedule: '*/15 * * * *',
};
