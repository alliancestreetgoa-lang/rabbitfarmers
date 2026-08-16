#!/usr/bin/env node
/**
 * Run the scheduler once, from a shell.
 *
 *   ADMIN_DATABASE_URL='postgres://…' node src/run-scheduler.js
 *
 * Useful for a first run after deploying, for backfilling after downtime, and
 * for watching what it does before trusting a cron with it.
 */
import { runScheduler } from './scheduler.js';
import { closePools } from './db.js';

try {
  const r = await runScheduler({ triggeredBy: 'cli' });
  console.log(`created ${r.tasksCreated} task(s) and ${r.notificationsCreated} notification(s) in ${r.durationMs}ms`);
  process.exitCode = 0;
} catch (err) {
  console.error(`scheduler failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePools();
}
