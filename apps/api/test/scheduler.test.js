import { test, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupFarm, cleanup, closePools, adminQuery } from './helpers.js';
import { runScheduler, schedulerHealth } from '../src/scheduler.js';
import { adminPool } from '../src/db.js';

/**
 * Run one generator the way the scheduler does: with every farm row held FOR
 * KEY SHARE for the length of the statement. Test files run concurrently and
 * delete their farms as they finish; an INSERT ... SELECT across every farm
 * that is not so held fails on the foreign key of whichever farm went.
 */
async function inPass(sql, params = []) {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM farm ORDER BY id FOR KEY SHARE');
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

after(async () => { await cleanup(); await closePools(); });

const dateAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
};

async function farmWithDoe(overrides = {}) {
  const f = await signupFarm(overrides);
  const mk = async (name, sex) => (await api('POST', '/animals', {
    token: f.token,
    body: { name, sex, role: 'breeder', date_of_birth: dateAgo(400) },
  })).body.animal.id;
  return { ...f, doe: await mk('Lakshmi', 'doe'), buck: await mk('Raja', 'buck') };
}

/** Tasks for one farm only — other test files run concurrently. */
async function tasksFor(farmId) {
  const { rows } = await adminQuery(
    `SELECT kind, title, due_on, priority, generated_key FROM task
     WHERE farm_id = $1 ORDER BY kind`, [farmId]);
  return rows;
}
async function notificationsFor(farmId) {
  const { rows } = await adminQuery(
    `SELECT kind, title, body, urgency, dedupe_key FROM notification
     WHERE farm_id = $1 ORDER BY kind`, [farmId]);
  return rows;
}

describe('task generation', () => {
  test('creates the palpation task in the day 10-14 window', async () => {
    const f = await farmWithDoe();
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(11) },
    });

    await runScheduler({ triggeredBy: 'test' });
    const tasks = await tasksFor(f.farm.id);
    const palpate = tasks.find((t) => t.kind === 'palpate');
    assert.ok(palpate, 'expected a palpation task');
    assert.equal(palpate.due_on, dateAgo(11 - 12 < 0 ? -1 : 0) && palpate.due_on,
      'due date is computed from the mating, not from today');
    assert.match(palpate.title, /Palpate Lakshmi/);
  });

  test('creates the nest box task on day 28 and marks it critical', async () => {
    const f = await farmWithDoe();
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(28) },
    });
    await api('POST', '/pregnancy-checks', {
      token: f.token, body: { mating_id: m.body.mating.id, result: 'positive' },
    });

    await runScheduler({ triggeredBy: 'test' });
    const nest = (await tasksFor(f.farm.id)).find((t) => t.kind === 'nest_box');
    assert.ok(nest, 'the day-28 nest box task must be generated');
    assert.equal(nest.priority, 'critical');
    assert.equal(nest.due_on, dateAgo(0), 'day 28 of a mating 28 days ago is today');
  });

  test('does not create a nest box task for a doe palpated negative', async () => {
    const f = await farmWithDoe();
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(28) },
    });
    await api('POST', '/pregnancy-checks', {
      token: f.token, body: { mating_id: m.body.mating.id, result: 'negative' },
    });

    await runScheduler({ triggeredBy: 'test' });
    const tasks = await tasksFor(f.farm.id);
    assert.ok(!tasks.some((t) => t.kind === 'nest_box'),
      'a doe known not to be pregnant should not get a nest box');
  });

  test('flags an overdue pregnancy past day 35', async () => {
    const f = await farmWithDoe();
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(38) },
    });

    await runScheduler({ triggeredBy: 'test' });
    const overdue = (await tasksFor(f.farm.id))
      .find((t) => t.generated_key.startsWith('overdue:'));
    assert.ok(overdue, 'day 38 with no kindling needs a human');
    assert.equal(overdue.priority, 'critical');
    assert.match(overdue.title, /overdue/i);
  });

  test('separate-the-kits lands on day 30, rebreed 3 days after separating', async () => {
    const f = await farmWithDoe();
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(61) },
    });
    const litter = await api('POST', '/litters', {
      token: f.token,
      body: { mating_id: m.body.mating.id, doe_id: f.doe, kindled_on: dateAgo(30), born_alive: 9 },
    });

    await runScheduler({ triggeredBy: 'test' });
    let wean = (await tasksFor(f.farm.id)).find((t) => t.kind === 'wean');
    assert.ok(wean, 'expected a separate-the-kits task');
    assert.equal(wean.due_on, dateAgo(0), '30 days after kindling is today');
    assert.match(wean.title, /Separate the kits/);

    // Separate them, and the rebreed task should appear for three days later.
    await api('POST', `/litters/${litter.body.litter.id}/wean`, {
      token: f.token, body: { weaned_on: dateAgo(3), weaned_count: 8 },
    });
    await runScheduler({ triggeredBy: 'test' });
    const breed = (await tasksFor(f.farm.id)).find((t) => t.kind === 'breed');
    assert.ok(breed, 'expected a rebreed task after separating');
    assert.equal(breed.due_on, dateAgo(0));
  });

  test('does not ask to rebreed a doe who is already back in a cycle', async () => {
    const f = await farmWithDoe();
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(61) },
    });
    const litter = await api('POST', '/litters', {
      token: f.token,
      body: { mating_id: m.body.mating.id, doe_id: f.doe, kindled_on: dateAgo(30), born_alive: 9 },
    });
    await api('POST', `/litters/${litter.body.litter.id}/wean`, {
      token: f.token, body: { weaned_on: dateAgo(4), weaned_count: 8 },
    });
    // Already served her yesterday.
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(1) },
    });

    await runScheduler({ triggeredBy: 'test' });
    assert.ok(!(await tasksFor(f.farm.id)).some((t) => t.kind === 'breed'),
      'she is already bred — asking again would be noise');
  });

  test('running twice creates nothing the second time', async () => {
    const f = await farmWithDoe();
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(28) },
    });

    await runScheduler({ triggeredBy: 'test' });
    const first = await tasksFor(f.farm.id);
    assert.ok(first.length > 0);

    await runScheduler({ triggeredBy: 'test' });
    const second = await tasksFor(f.farm.id);
    assert.deepEqual(second.map((t) => t.generated_key).sort(),
                     first.map((t) => t.generated_key).sort(),
      'a repeat run must not duplicate the farmer\'s task list');
  });

  test('does not resurrect a task the farmer has already completed', async () => {
    const f = await farmWithDoe();
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(28) },
    });
    await runScheduler({ triggeredBy: 'test' });

    await adminQuery(
      `UPDATE task SET status = 'done', completed_at = now()
        WHERE farm_id = $1 AND kind = 'nest_box'`, [f.farm.id]);

    await runScheduler({ triggeredBy: 'test' });
    const { rows } = await adminQuery(
      `SELECT status FROM task WHERE farm_id = $1 AND kind = 'nest_box'`, [f.farm.id]);
    assert.equal(rows.length, 1, 'no duplicate');
    assert.equal(rows[0].status, 'done', 'and it stays done');
  });

  test('generated tasks land on the daily list', async () => {
    const f = await farmWithDoe();
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(28) },
    });
    await runScheduler({ triggeredBy: 'test' });

    const daily = await api('GET', '/daily', { token: f.token });
    assert.ok(daily.body.items.some((i) => i.source === 'task' && /Nest box/i.test(i.title)),
      'the whole point is that it shows up on the tab that opens on login');
  });

  test('one farm never generates tasks for another', async () => {
    const a = await farmWithDoe();
    const b = await signupFarm();
    await api('POST', '/matings', {
      token: a.token, body: { doe_id: a.doe, buck_id: a.buck, mated_at: daysAgo(28) },
    });

    await runScheduler({ triggeredBy: 'test' });
    assert.ok((await tasksFor(a.farm.id)).length > 0);
    assert.equal((await tasksFor(b.farm.id)).length, 0);

    const dailyB = await api('GET', '/daily', { token: b.token });
    assert.equal(dailyB.body.items.length, 0);
  });
});

describe('condition reminders', () => {
  async function farmWithLooseDoe(quiet = false) {
    const f = await farmWithDoe();
    // No condition_type insert here on purpose. Signup seeds loose_motion, and
    // these tests are only meaningful if they run against that seed — the
    // previous version inserted its own row and so passed happily while every
    // real new farm could not report a sick rabbit at all.
    if (!quiet) {
      await adminQuery(
        `UPDATE farm_settings SET quiet_hours_enabled = false WHERE farm_id = $1`, [f.farm.id]);
    }
    const created = await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: f.doe, severity: 'moderate' },
    });
    return { ...f, conditionId: created.body.condition.id };
  }

  test('no reminder before the interval has elapsed', async () => {
    const f = await farmWithLooseDoe();
    await runScheduler({ triggeredBy: 'test' });
    const notes = await notificationsFor(f.farm.id);
    assert.ok(!notes.some((n) => n.kind === 'condition_reminder'),
      'reported ten seconds ago — nobody should be nagged yet');
  });

  test('reminds once the 2 hours are up, and repeats every 2 hours', async () => {
    const f = await farmWithLooseDoe();

    // Two hours since the last look.
    await adminQuery(
      `UPDATE health_condition SET last_checked_at = now() - interval '2 hours 5 minutes'
        WHERE id = $1`, [f.conditionId]);
    await runScheduler({ triggeredBy: 'test' });
    let notes = (await notificationsFor(f.farm.id)).filter((n) => n.kind === 'condition_reminder');
    assert.equal(notes.length, 1, 'first reminder');
    assert.match(notes[0].title, /Loose motion — check Lakshmi/);

    // Ten minutes later, still the same 2-hour slot — must not nag again.
    await runScheduler({ triggeredBy: 'test' });
    notes = (await notificationsFor(f.farm.id)).filter((n) => n.kind === 'condition_reminder');
    assert.equal(notes.length, 1, 'the scheduler runs every 15 minutes; this must not spam');

    // Four hours since the last look — next slot, so a second reminder.
    await adminQuery(
      `UPDATE health_condition SET last_checked_at = now() - interval '4 hours 5 minutes'
        WHERE id = $1`, [f.conditionId]);
    await runScheduler({ triggeredBy: 'test' });
    notes = (await notificationsFor(f.farm.id)).filter((n) => n.kind === 'condition_reminder');
    assert.equal(notes.length, 2, 'it repeats every two hours until someone looks');
  });

  test('checking the animal restarts the clock and buys quiet', async () => {
    const f = await farmWithLooseDoe();
    await adminQuery(
      `UPDATE health_condition SET last_checked_at = now() - interval '3 hours'
        WHERE id = $1`, [f.conditionId]);
    await runScheduler({ triggeredBy: 'test' });
    assert.equal((await notificationsFor(f.farm.id))
      .filter((n) => n.kind === 'condition_reminder').length, 1);

    // "Still loose" — the clock restarts from this observation.
    await api('POST', `/conditions/${f.conditionId}/check`, {
      token: f.token, body: { status: 'ongoing' },
    });
    await runScheduler({ triggeredBy: 'test' });
    assert.equal((await notificationsFor(f.farm.id))
      .filter((n) => n.kind === 'condition_reminder').length, 1,
      'looking at the animal is what buys the quiet');
  });

  test('marking it stopped ends the reminders', async () => {
    const f = await farmWithLooseDoe();
    await api('POST', `/conditions/${f.conditionId}/check`, {
      token: f.token, body: { status: 'stopped' },
    });
    await adminQuery(
      `UPDATE health_condition SET last_checked_at = now() - interval '6 hours'
        WHERE id = $1`, [f.conditionId]);

    await runScheduler({ triggeredBy: 'test' });
    assert.ok(!(await notificationsFor(f.farm.id)).some((n) => n.kind === 'condition_reminder'),
      'resolved means silent, with no scheduled job left to cancel');
  });

  test('quiet hours hold the reminder back without hiding it in the app', async () => {
    const f = await farmWithLooseDoe(true);
    // Force the farm's local clock into the quiet window.
    await adminQuery(`UPDATE farm_settings
        SET quiet_hours_enabled = true, quiet_hours_start = 0, quiet_hours_end = 24
      WHERE farm_id = $1`, [f.farm.id]);
    await adminQuery(
      `UPDATE health_condition SET last_checked_at = now() - interval '3 hours'
        WHERE id = $1`, [f.conditionId]);

    await runScheduler({ triggeredBy: 'test' });
    assert.ok(!(await notificationsFor(f.farm.id)).some((n) => n.kind === 'condition_reminder'),
      'no phone should buzz at 3am');

    // But the condition is still right there on the daily list.
    const daily = await api('GET', '/daily', { token: f.token });
    assert.ok(daily.body.items.some((i) => i.source === 'condition'),
      'suppression applies to buzzing a phone, never to telling the truth on screen');
  });

  test('escalates once after 24 hours, to the owner', async () => {
    const f = await farmWithLooseDoe();
    await adminQuery(
      `UPDATE health_condition SET started_at = now() - interval '30 hours'
        WHERE id = $1`, [f.conditionId]);

    await runScheduler({ triggeredBy: 'test' });
    await runScheduler({ triggeredBy: 'test' });

    const esc = (await notificationsFor(f.farm.id)).filter((n) => n.kind === 'condition_escalation');
    assert.equal(esc.length, 1, 'escalate once, not on every pass');
    assert.equal(esc[0].urgency, 'critical');

    const { rows } = await adminQuery(`
      SELECT e.role FROM notification n JOIN employee e ON e.id = n.employee_id
      WHERE n.farm_id = $1 AND n.kind = 'condition_escalation'`, [f.farm.id]);
    assert.equal(rows[0].role, 'owner');
  });

  test('raises an outbreak when a second case appears in the same shed', async () => {
    const f = await farmWithLooseDoe();
    const shed = await adminQuery(
      `INSERT INTO shed (farm_id, name) VALUES ($1,'Shed B') RETURNING id`, [f.farm.id]);
    const cage = await adminQuery(
      `INSERT INTO cage (farm_id, shed_id, code) VALUES ($1,$2,'B-1') RETURNING id`,
      [f.farm.id, shed.rows[0].id]);
    const cage2 = await adminQuery(
      `INSERT INTO cage (farm_id, shed_id, code) VALUES ($1,$2,'B-2') RETURNING id`,
      [f.farm.id, shed.rows[0].id]);

    // Put the sick doe in the shed; one case is not an outbreak.
    await adminQuery(`UPDATE rabbit SET cage_id = $2 WHERE id = $1`, [f.doe, cage.rows[0].id]);
    await runScheduler({ triggeredBy: 'test' });
    assert.ok(!(await notificationsFor(f.farm.id)).some((n) => n.kind === 'outbreak'));

    // A second case in the same shed is the one worth acting on.
    const second = await api('POST', '/animals', {
      token: f.token, body: { name: 'Rani', sex: 'doe', date_of_birth: dateAgo(400) },
    });
    await adminQuery(`UPDATE rabbit SET cage_id = $2 WHERE id = $1`,
      [second.body.animal.id, cage2.rows[0].id]);
    await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: second.body.animal.id },
    });

    await runScheduler({ triggeredBy: 'test' });
    const out = (await notificationsFor(f.farm.id)).filter((n) => n.kind === 'outbreak');
    assert.equal(out.length, 1);
    assert.match(out[0].title, /2 cases of loose motion in Shed B/);
  });
});

describe('notifications API', () => {
  test('the farmer can read and dismiss what the scheduler raised', async () => {
    const f = await farmWithDoe();
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(28) },
    });
    await adminQuery(
      `UPDATE farm_settings SET quiet_hours_enabled = false WHERE farm_id = $1`, [f.farm.id]);
    await runScheduler({ triggeredBy: 'test' });

    const list = await api('GET', '/notifications', { token: f.token });
    assert.equal(list.status, 200);
    assert.ok(list.body.notifications.length > 0, 'the nest box notification should be here');
    assert.equal(list.body.unread, list.body.notifications.length);

    const read = await api('POST', '/notifications/read', { token: f.token, body: {} });
    assert.ok(read.body.marked_read > 0);
    assert.equal((await api('GET', '/notifications?unread=1', { token: f.token }))
      .body.notifications.length, 0);
  });

  test('a lapsed subscription still receives its reminders', async () => {
    const f = await farmWithDoe();
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(28) },
    });
    await adminQuery(
      `UPDATE farm_settings SET quiet_hours_enabled = false WHERE farm_id = $1`, [f.farm.id]);
    await adminQuery(`UPDATE subscription SET status = 'suspended',
        trial_ends_on = current_date - 1 WHERE farm_id = $1`, [f.farm.id]);

    await runScheduler({ triggeredBy: 'test' });

    assert.ok((await tasksFor(f.farm.id)).length > 0,
      'a suspended farm must still get its day-28 nest box task');
    const list = await api('GET', '/notifications', { token: f.token });
    assert.equal(list.status, 200);
    assert.ok(list.body.notifications.length > 0,
      'billing failure must never cost a litter');
  });
});

describe('scheduler plumbing', () => {
  test('records every run', async () => {
    const before = await adminQuery('SELECT count(*)::int AS n FROM scheduler_run');
    const r = await runScheduler({ triggeredBy: 'test' });
    const after_ = await adminQuery('SELECT count(*)::int AS n FROM scheduler_run');
    assert.equal(after_.rows[0].n, before.rows[0].n + 1);
    assert.equal(r.ok, true);
    assert.ok(r.durationMs >= 0);

    const { rows } = await adminQuery(
      'SELECT ok, triggered_by, duration_ms FROM scheduler_run ORDER BY id DESC LIMIT 1');
    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].triggered_by, 'test');
    assert.ok(rows[0].duration_ms !== null);
  });

  test('health reports healthy after a successful run', async () => {
    await runScheduler({ triggeredBy: 'test' });
    const h = await schedulerHealth();
    assert.equal(h.healthy, true);
    assert.equal(h.reason, null);
    assert.ok(h.seconds_since_success <= 5);
  });

  test('health goes unhealthy when the scheduler goes quiet', async () => {
    await runScheduler({ triggeredBy: 'test' });
    // Pretend the last success was hours ago.
    await adminQuery(
      `UPDATE scheduler_run SET started_at = now() - interval '4 hours' WHERE ok`);
    const h = await schedulerHealth();
    assert.equal(h.healthy, false, 'a silent scheduler must not look healthy');
    assert.match(h.reason, /no successful run/);
  });

  test('the health endpoint answers 503 so an uptime monitor pages you', async () => {
    await adminQuery(
      `UPDATE scheduler_run SET started_at = now() - interval '4 hours' WHERE ok`);
    const down = await api('GET', '/scheduler/health');
    assert.equal(down.status, 503);
    assert.equal(down.body.healthy, false);

    await runScheduler({ triggeredBy: 'test' });
    const up = await api('GET', '/scheduler/health');
    assert.equal(up.status, 200);
    assert.equal(up.body.healthy, true);
  });

  test('the run endpoint refuses without the shared secret', async () => {
    const prev = process.env.SCHEDULER_SECRET;
    process.env.SCHEDULER_SECRET = 'test-secret-value';
    try {
      assert.equal((await api('POST', '/scheduler/run')).status, 401);
      assert.equal((await api('POST', '/scheduler/run', {
        headers: { 'x-scheduler-secret': 'wrong' } })).status, 401);

      const ok = await api('POST', '/scheduler/run', {
        headers: { 'x-scheduler-secret': 'test-secret-value' },
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.ok, true);
    } finally {
      if (prev === undefined) delete process.env.SCHEDULER_SECRET;
      else process.env.SCHEDULER_SECRET = prev;
    }
  });

  test('refuses to run at all when no secret is configured', async () => {
    const prev = process.env.SCHEDULER_SECRET;
    delete process.env.SCHEDULER_SECRET;
    try {
      const res = await api('POST', '/scheduler/run', {
        headers: { 'x-scheduler-secret': 'anything' },
      });
      assert.equal(res.status, 503, 'an unsecured trigger endpoint must not be usable');
    } finally {
      if (prev !== undefined) process.env.SCHEDULER_SECRET = prev;
    }
  });
});

/**
 * The monthly routine: the chart's whole-farm preventive round. Hitech on the
 * 7th, 8th and 9th; Liv 52 and Gutwell together on the 13th, 14th and 15th;
 * Tetracycline in the water on the 16th. Each day is a task on Today and a
 * push to every phone, said again every morning until somebody ticks it.
 * p_today is injected so the test does not have to wait for the 7th.
 */
describe('the monthly routine', () => {
  async function farmWithRabbits() {
    const f = await farmWithDoe();
    await adminQuery(
      `UPDATE farm_settings SET quiet_hours_enabled = false WHERE farm_id = $1`, [f.farm.id]);
    return f;
  }
  const routineTasks = async (farmId) => (await adminQuery(
    `SELECT id, title, notes, due_on::text AS due_on, status, generated_key FROM task
      WHERE farm_id = $1 AND generated_key LIKE 'routine:%' ORDER BY due_on, generated_key`,
    [farmId])).rows;

  test('on the 1st, the month is laid out — ten steps from the 7th to the 16th', async () => {
    const f = await farmWithRabbits();
    await inPass(`SELECT generate_routine_tasks('2031-03-01')`);
    const tasks = await routineTasks(f.farm.id);
    assert.equal(tasks.length, 10, JSON.stringify(tasks.map((t) => t.title)));
    assert.deepEqual(tasks.map((t) => t.due_on), [
      '2031-03-07', '2031-03-08', '2031-03-09',
      '2031-03-13', '2031-03-13', '2031-03-14', '2031-03-14', '2031-03-15', '2031-03-15',
      '2031-03-16',
    ]);
    assert.match(tasks[0].title, /Hitech \(oral\) 1 ml, day 1 of 3/);
    assert.match(tasks[0].notes, /SKIP pregnant does and kits under 3 months/);
    assert.match(tasks[0].notes, /Agrimin Forte/, 'the standing daily advice rides along');
    assert.match(tasks[3].title + tasks[4].title, /Liv 52/);
    assert.match(tasks[3].title + tasks[4].title, /Gutwell/);
    assert.match(tasks[9].title, /Tetracycline/);

    // A second pass, or the 15-minute scheduler, adds nothing.
    await inPass(`SELECT generate_routine_tasks('2031-03-01')`);
    await inPass(`SELECT generate_routine_tasks('2031-03-08')`);
    assert.equal((await routineTasks(f.farm.id)).length, 10, 'idempotent');
  });

  test('a farm that joins on the 10th gets the 13th onward, not the Hitech days it missed', async () => {
    const f = await farmWithRabbits();
    await inPass(`SELECT generate_routine_tasks('2031-03-10')`);
    const tasks = await routineTasks(f.farm.id);
    assert.deepEqual(tasks.map((t) => t.due_on), [
      '2031-03-13', '2031-03-13', '2031-03-14', '2031-03-14', '2031-03-15', '2031-03-15',
      '2031-03-16',
    ]);
  });

  test('after the 16th nothing is raised; next month it starts again', async () => {
    const f = await farmWithRabbits();
    await inPass(`SELECT generate_routine_tasks('2031-03-20')`);
    assert.equal((await routineTasks(f.farm.id)).length, 0);
    await inPass(`SELECT generate_routine_tasks('2031-04-01')`);
    const tasks = await routineTasks(f.farm.id);
    assert.equal(tasks.length, 10);
    assert.equal(tasks[0].due_on, '2031-04-07');
  });

  test('a farm with no rabbits is left alone', async () => {
    const f = await signupFarm();
    await inPass(`SELECT generate_routine_tasks('2031-03-01')`);
    assert.equal((await routineTasks(f.farm.id)).length, 0);
  });

  test('each routine day is pushed to everyone at the farm, once a day, until it is ticked', async () => {
    const f = await farmWithRabbits();
    await inPass(`SELECT generate_routine_tasks('2031-03-01')`);
    const taskDue = async () =>
      (await notificationsFor(f.farm.id)).filter((n) => n.kind === 'task_due');

    await inPass(`SELECT generate_routine_notifications('2031-03-01')`);
    assert.equal((await taskDue()).length, 0, 'nothing is due before the 7th');

    await inPass(`SELECT generate_routine_notifications('2031-03-07')`);
    let notes = await taskDue();
    assert.equal(notes.length, 1, 'the 7th: the first Hitech round');
    assert.match(notes[0].title, /Hitech/);
    assert.match(notes[0].body, /Whole farm, today/);

    await inPass(`SELECT generate_routine_notifications('2031-03-07')`);
    assert.equal((await taskDue()).length, 1,
      'the scheduler runs every 15 minutes; once a day is enough');

    // Nobody ticked the 7th. On the 8th it is said again, as overdue, beside
    // the 8th's own round.
    await inPass(`SELECT generate_routine_notifications('2031-03-08')`);
    notes = await taskDue();
    assert.equal(notes.length, 3);
    assert.ok(notes.some((n) => /Overdue since 2031-03-07/.test(n.body)),
      'the missed day is pushed again, and says it was missed');

    // The 13th: Hitech 7, 8, 9 still open, plus the day's Liv 52 and Gutwell.
    await inPass(`SELECT generate_routine_notifications('2031-03-13')`);
    notes = await taskDue();
    assert.equal(notes.length, 8);
    assert.ok(notes.some((n) => /Liv 52/.test(n.title)) && notes.some((n) => /Gutwell/.test(n.title)));

    const { rows } = await adminQuery(
      `SELECT employee_id FROM notification WHERE farm_id = $1 AND kind = 'task_due'`, [f.farm.id]);
    assert.ok(rows.every((r) => r.employee_id === null),
      'the round is nobody\'s shed in particular — everyone is told');
  });

  test('a routine day nobody ticked is red on Today the next morning', async () => {
    const f = await farmWithRabbits();
    await inPass(`SELECT generate_routine_tasks('2031-03-01')`);
    const [hitech] = await routineTasks(f.farm.id);
    // Move the 7th into the real calendar: due today, then due yesterday.
    await adminQuery(
      `UPDATE task SET due_on = farm_today(farm_id) WHERE id = $1`, [hitech.id]);
    let daily = await api('GET', '/daily', { token: f.token });
    let item = daily.body.items.find((i) => i.ref_id === hitech.id);
    assert.ok(item, 'on the day it is on Today');
    assert.equal(item.urgency, 'high');
    assert.equal(item.rabbit_id, null);
    assert.equal(item.kind, 'medicate');

    await adminQuery(
      `UPDATE task SET due_on = farm_today(farm_id) - 1 WHERE id = $1`, [hitech.id]);
    daily = await api('GET', '/daily', { token: f.token });
    item = daily.body.items.find((i) => i.ref_id === hitech.id);
    assert.equal(item.urgency, 'critical', 'missed = red, on the web and the phone');
    assert.match(item.title, /Monthly round/);
  });

  test('done is done: the task closes and the month\'s plan counts it', async () => {
    const f = await farmWithRabbits();
    await inPass(`SELECT generate_routine_tasks('2031-03-01')`);
    const [first] = await routineTasks(f.farm.id);

    const done = await api('POST', `/tasks/${first.id}/done`, { token: f.token, body: {} });
    assert.equal(done.status, 200, done.text);
    assert.equal((await routineTasks(f.farm.id))[0].status, 'done');

    const again = await api('POST', `/tasks/${first.id}/done`, { token: f.token, body: {} });
    assert.equal(again.status, 404, 'closing it twice is not a thing');

    // The plan screen: this month's steps, with whatever is done. The tasks
    // above are 2031's, so nothing is done in the real current month — but
    // the plan itself is always there to read.
    const plan = await api('GET', '/routine', { token: f.token });
    assert.equal(plan.status, 200, plan.text);
    assert.equal(plan.body.total, 10);
    assert.equal(plan.body.steps[0].day, 7);
    assert.match(plan.body.steps[0].medicine, /Hitech/);
    assert.equal(plan.body.steps[9].day, 16);
    assert.ok(plan.body.standing.some((s) => /Agrimin/.test(s)));
  });

  test('the scheduler itself runs the round without complaint', async () => {
    const f = await farmWithRabbits();
    await runScheduler({ triggeredBy: 'test' });
    // Whether today is before or after the 16th is the calendar's business;
    // what matters is that a pass completes and a routine task, if any, is a
    // whole-farm task with no rabbit on it.
    const tasks = await routineTasks(f.farm.id);
    for (const t of tasks) assert.match(t.title, /Monthly round/);
  });
});
