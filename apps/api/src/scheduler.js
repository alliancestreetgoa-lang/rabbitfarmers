import { adminPool } from './db.js';

/**
 * Run one scheduling pass across every farm.
 *
 * All the work is set-based SQL — see db/migrations/0010_scheduler.sql. Netlify
 * caps a scheduled function at 30 seconds, and looping farms in JavaScript
 * would be fine at ten customers and start timing out at five hundred.
 *
 * Safe to run concurrently and safe to run twice: every generated row carries a
 * deterministic unique key, so a duplicate pass inserts nothing rather than
 * doubling somebody's task list.
 */
export async function runScheduler({ triggeredBy = 'manual' } = {}) {
  const client = await adminPool.connect();
  const started = Date.now();
  let runId = null;

  try {
    const { rows } = await client.query(
      `INSERT INTO scheduler_run (triggered_by) VALUES ($1) RETURNING id`, [triggeredBy]);
    runId = rows[0].id;

    // One transaction: the temp tables inside generate_due_tasks() are declared
    // ON COMMIT DROP, and a half-generated task list is worse than none.
    await client.query('BEGIN');

    /*
     * Hold the farms still for the length of the pass.
     *
     * Generation is INSERT ... SELECT across every farm. Under READ COMMITTED
     * each statement reads a snapshot taken when it starts, but the foreign key
     * is checked against the state at insert time — so a farm deleted after the
     * snapshot and before the insert makes the whole statement fail with
     * `task_farm_id_fkey`, and the entire run dies for every farm rather than
     * skipping the one that went.
     *
     * That is not hypothetical: a superadmin deleting a farm is a supported
     * action, and the scheduler fires every fifteen minutes. It surfaced first
     * as an intermittent test failure, which is exactly what it would look like
     * in production — a red run every few weeks with no obvious cause.
     *
     * FOR KEY SHARE blocks DELETE without blocking ordinary updates to a farm
     * row, so a deletion issued mid-pass waits for the pass to finish. The pass
     * is sub-second; the delete is rare. Nothing here holds a lock across a
     * round trip to anywhere else.
     */
    await client.query('SELECT id FROM farm ORDER BY id FOR KEY SHARE');

    const tasks = await client.query('SELECT generate_due_tasks() AS n');
    // The engine knows which doe needs a nest box; it does not know who walks
    // that row. This hands each new task to whoever looks after the shed the
    // animal is in — and leaves it unassigned where a shed has nobody, or more
    // than one person, because work that looks assigned and is nobody's is
    // worse than work on everybody's list.
    const assigned = await client.query('SELECT assign_tasks_by_section() AS n');
    const notes = await client.query('SELECT generate_notifications() AS n');
    // Sessions nobody can use any more. Expired ones were always rejected at
    // sign-in, so this is housekeeping rather than a fix — but nothing ever
    // deleted them, and user_session grows by a row per device per sign-in for
    // ever. The scheduler is already awake every fifteen minutes.
    const purged = await client.query('SELECT purge_expired_sessions() AS n');
    await client.query('COMMIT');

    const result = {
      ok: true,
      tasksCreated: tasks.rows[0].n,
      tasksAssigned: assigned.rows[0].n,
      notificationsCreated: notes.rows[0].n,
      sessionsPurged: purged.rows[0].n,
      durationMs: Date.now() - started,
    };

    await client.query(`
      UPDATE scheduler_run
         SET finished_at = now(), ok = true, tasks_created = $2,
             notifications_created = $3, duration_ms = $4
       WHERE id = $1`,
      [runId, result.tasksCreated, result.notificationsCreated, result.durationMs]);

    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (runId) {
      // Record the failure on its own connection state — this is what the
      // heartbeat reads, so losing it would hide the outage.
      await client.query(`
        UPDATE scheduler_run
           SET finished_at = now(), ok = false, error = $2, duration_ms = $3
         WHERE id = $1`,
        [runId, String(err.message ?? err).slice(0, 2000), Date.now() - started])
        .catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Is the scheduler alive?
 *
 * Returns unhealthy when nothing has succeeded within the window. Point an
 * uptime monitor at the endpoint that serves this: a reminder system that fails
 * silently is worse than no reminder system, because everyone has stopped
 * watching for the thing themselves.
 */
export async function schedulerHealth() {
  const staleAfter = Number(process.env.SCHEDULER_STALE_SECONDS ?? 3600);
  const { rows } = await adminPool.query('SELECT * FROM v_scheduler_health');
  const h = rows[0] ?? {};

  const neverRun = h.last_success_at == null;
  const stale = !neverRun && h.seconds_since_success > staleAfter;

  return {
    healthy: !neverRun && !stale,
    reason: neverRun ? 'the scheduler has never completed a run'
      : stale ? `no successful run for ${Math.round(h.seconds_since_success / 60)} minutes`
      : null,
    last_success_at: h.last_success_at ?? null,
    seconds_since_success: h.seconds_since_success ?? null,
    last_run_at: h.last_run_at ?? null,
    last_run_ok: h.last_run_ok ?? null,
    last_error: h.last_error ?? null,
    failures_last_hour: h.failures_last_hour ?? 0,
    stale_after_seconds: staleAfter,
  };
}
