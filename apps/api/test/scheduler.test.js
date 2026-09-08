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
  test('the farm does not palpate: no task is raised in the day 10-14 window, ever', async () => {
    const f = await farmWithDoe();
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(11) },
    });

    await runScheduler({ triggeredBy: 'test' });
    const tasks = await tasksFor(f.farm.id);
    assert.ok(!tasks.some((t) => t.kind === 'palpate'),
      '"I don\'t want to see a notification for Palpate" (0049)');
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

  test('on the 1st, the whole-farm part of the month is laid out: Tetracycline on the 16th', async () => {
    const f = await farmWithRabbits();
    await inPass(`SELECT generate_routine_tasks('2031-03-01')`);
    const tasks = await routineTasks(f.farm.id);
    assert.equal(tasks.length, 1, JSON.stringify(tasks.map((t) => t.title)));
    assert.equal(tasks[0].due_on, '2031-03-16');
    assert.match(tasks[0].title, /Tetracycline/);
    assert.match(tasks[0].notes, /Agrimin Forte/, 'the standing daily advice rides along');
    assert.ok(!tasks.some((t) => /Hitech|Liv 52|Gutwell/.test(t.title)),
      'the per-rabbit medicines are doses now, not whole-farm tasks');

    // A second pass, or the 15-minute scheduler, adds nothing.
    await inPass(`SELECT generate_routine_tasks('2031-03-01')`);
    await inPass(`SELECT generate_routine_tasks('2031-03-08')`);
    assert.equal((await routineTasks(f.farm.id)).length, 1, 'idempotent');
  });

  test('a farm that joins on the 10th still gets the 16th; one that joins on the 17th does not', async () => {
    const f = await farmWithRabbits();
    await inPass(`SELECT generate_routine_tasks('2031-03-10')`);
    assert.deepEqual((await routineTasks(f.farm.id)).map((t) => t.due_on), ['2031-03-16']);
    const g = await farmWithRabbits();
    await inPass(`SELECT generate_routine_tasks('2031-03-17')`);
    assert.equal((await routineTasks(g.farm.id)).length, 0);
  });

  test('after the 16th nothing is raised; next month it starts again', async () => {
    const f = await farmWithRabbits();
    await inPass(`SELECT generate_routine_tasks('2031-03-20')`);
    assert.equal((await routineTasks(f.farm.id)).length, 0);
    await inPass(`SELECT generate_routine_tasks('2031-04-01')`);
    const tasks = await routineTasks(f.farm.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].due_on, '2031-04-16');
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

    await inPass(`SELECT generate_routine_notifications('2031-03-15')`);
    assert.equal((await taskDue()).length, 0, 'nothing whole-farm is due before the 16th');

    await inPass(`SELECT generate_routine_notifications('2031-03-16')`);
    let notes = await taskDue();
    assert.equal(notes.length, 1, 'the 16th: Tetracycline in the water');
    assert.match(notes[0].title, /Tetracycline/);
    assert.match(notes[0].body, /Whole farm, today/);

    await inPass(`SELECT generate_routine_notifications('2031-03-16')`);
    assert.equal((await taskDue()).length, 1,
      'the scheduler runs every 15 minutes; once a day is enough');

    // Nobody ticked the 16th. On the 17th it is said again, as overdue.
    await inPass(`SELECT generate_routine_notifications('2031-03-17')`);
    notes = await taskDue();
    assert.equal(notes.length, 2);
    assert.ok(notes.some((n) => /Overdue since 2031-03-16/.test(n.body)),
      'the missed day is pushed again, and says it was missed');

    const { rows } = await adminQuery(
      `SELECT employee_id FROM notification WHERE farm_id = $1 AND kind = 'task_due'`, [f.farm.id]);
    assert.ok(rows.every((r) => r.employee_id === null),
      'the round is nobody\'s shed in particular — everyone is told');
  });

  test('a routine day nobody ticked is red on Today the next morning', async () => {
    const f = await farmWithRabbits();
    await inPass(`SELECT generate_routine_tasks('2031-03-01')`);
    const [tetra] = await routineTasks(f.farm.id);
    const hitech = tetra; // the whole-farm task; the per-rabbit rows are doses
    // Move the 16th into the real calendar: due today, then due yesterday.
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
    assert.equal(plan.body.steps.length, 10, 'the chart\'s ten steps, per rabbit or whole farm');
    assert.equal(plan.body.steps[0].day, 7);
    assert.match(plan.body.steps[0].medicine, /Hitech/);
    assert.equal(plan.body.steps[9].day, 16);
    assert.equal(plan.body.steps[9].per_rabbit, false);
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

/**
 * The routine, rabbit by rabbit. Hitech, Liv 52 and Gutwell are doses on a
 * month anchor — every rabbit in the herd gets its own row on Today, its own
 * tick, its own push, and the chart's holds apply to it alone: a pregnant doe
 * is not handed Hitech, a kit under 3 months is not handed Hitech or Liv 52.
 * Tetracycline goes into the water, so it stays one whole-farm task.
 */
describe('the monthly routine, rabbit by rabbit', () => {
  /** A pregnant doe, an open doe, a buck and a month-old kit. */
  async function farmWithHerd() {
    const f = await farmWithDoe();
    await adminQuery(
      `UPDATE farm_settings SET quiet_hours_enabled = false WHERE farm_id = $1`, [f.farm.id]);
    const mk = async (body) => (await api('POST', '/animals', { token: f.token, body })).body.animal.id;
    const open = await mk({ name: 'Meera', sex: 'doe', role: 'breeder', date_of_birth: dateAgo(400) });
    const kit = await mk({ name: 'Chotu', sex: 'unknown', role: 'grower', date_of_birth: dateAgo(30) });
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(15) },
    });
    await api('POST', '/pregnancy-checks', {
      token: f.token, body: { mating_id: m.body.mating.id, result: 'positive' },
    });
    const { rows } = await adminQuery(
      `SELECT date_trunc('month', farm_today($1))::date::text AS month_start`, [f.farm.id]);
    return { ...f, pregnant: f.doe, open, kit, monthStart: rows[0].month_start };
  }
  const plusDays = (iso, n) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const schedule = async (farmId, medicine) => (await adminQuery(
    `SELECT rabbit_id, due_on::text AS due_on, hold_reason
       FROM v_medication_schedule
      WHERE farm_id = $1 AND anchor = 'month' AND protocol_name = $2
      ORDER BY due_on, rabbit_id`, [farmId, medicine])).rows;

  test('every rabbit is on this month\'s Hitech, Liv 52 and Gutwell, with the chart\'s holds', async () => {
    const f = await farmWithHerd();
    const hitech = await schedule(f.farm.id, 'Monthly round — Hitech');
    assert.equal(hitech.length, 12, 'four rabbits, three mornings each');
    assert.deepEqual([...new Set(hitech.map((r) => r.due_on))],
      [plusDays(f.monthStart, 6), plusDays(f.monthStart, 7), plusDays(f.monthStart, 8)],
      'the 7th, 8th and 9th');
    const holdOn = (rows, id) => rows.find((r) => r.rabbit_id === id)?.hold_reason ?? null;
    assert.equal(holdOn(hitech, f.pregnant), 'she is pregnant');
    assert.equal(holdOn(hitech, f.kit), 'under 3 months old');
    assert.equal(holdOn(hitech, f.open), null);
    assert.equal(holdOn(hitech, f.buck), null);

    const liv = await schedule(f.farm.id, 'Monthly round — Liv 52');
    assert.equal(liv.length, 12);
    assert.deepEqual([...new Set(liv.map((r) => r.due_on))],
      [plusDays(f.monthStart, 12), plusDays(f.monthStart, 13), plusDays(f.monthStart, 14)],
      'the 13th, 14th and 15th');
    assert.equal(holdOn(liv, f.kit), 'under 3 months old', 'not by mouth for a kit');
    assert.equal(holdOn(liv, f.pregnant), null, 'a liver tonic is fine in pregnancy');

    const gut = await schedule(f.farm.id, 'Monthly round — Gutwell');
    assert.equal(gut.length, 12);
    assert.ok(gut.every((r) => r.hold_reason === null), 'Gutwell is safe for every rabbit');
  });

  test('GET /routine counts the herd for each day of the round', async () => {
    const f = await farmWithHerd();
    const plan = await api('GET', '/routine', { token: f.token });
    assert.equal(plan.status, 200, plan.text);
    const day7 = plan.body.steps.find((s) => s.day === 7 && /Hitech/.test(s.medicine));
    assert.ok(day7, JSON.stringify(plan.body.steps));
    assert.equal(day7.per_rabbit, true);
    assert.equal(day7.to_give, 2, 'the open doe and the buck');
    assert.equal(day7.held, 2, 'the pregnant doe and the kit');
    assert.equal(day7.given, 0);
    const gut13 = plan.body.steps.find((s) => s.day === 13 && /Gutwell/.test(s.medicine));
    assert.equal(gut13.to_give, 4);
    assert.equal(gut13.held, 0);
    const tetra = plan.body.steps.find((s) => /Tetracycline/.test(s.medicine));
    assert.equal(tetra.per_rabbit, false, 'in the water: still one job for the whole farm');
    assert.equal(tetra.day, 16);
    assert.ok(plan.body.standing.some((s) => /Agrimin/.test(s)));
  });

  /**
   * The calendar cannot be injected into a view, so a one-off month-anchored
   * course due TODAY stands in for the round: same anchor, same holds, same
   * push, whatever the date the test runs on.
   */
  async function roundDueToday(f) {
    const { rows } = await adminQuery(
      `INSERT INTO medication_protocol
         (farm_id, name, anchor, start_offset_days, doses, interval_days, dose_note,
          applies_to, notify, route, dose, not_when_pregnant, min_age_days)
       VALUES ($1, 'Test round', 'month', farm_today($1) - date_trunc('month', farm_today($1))::date,
               1, 1, 'morning, empty stomach', 'any', true, 'oral', '1 ml', true, 90)
       RETURNING id`, [f.farm.id]);
    return rows[0].id;
  }

  test('a routine dose due today is pushed to the phone, one per rabbit, never for a held one', async () => {
    const f = await farmWithHerd();
    await roundDueToday(f);
    await inPass(`SELECT generate_notifications()`);
    const { rows } = await adminQuery(
      `SELECT rabbit_id, title FROM notification
        WHERE farm_id = $1 AND kind = 'medication_due' AND title LIKE 'Test round%'
        ORDER BY title`, [f.farm.id]);
    assert.deepEqual(rows.map((r) => r.rabbit_id).sort(), [f.buck, f.open].sort(),
      'the open doe and the buck are told; the pregnant doe and the kit are held');
    assert.match(rows[0].title, /dose 1 of 1 for /);
  });

  test('given is given: the tick takes that rabbit off the list and the count moves', async () => {
    const f = await farmWithHerd();
    const protocolId = await roundDueToday(f);
    const before = await api('GET', '/medication', { token: f.token });
    const mine = (b) => b.body.due.filter((d) => d.protocol_id === protocolId);
    assert.equal(mine(before).length, 4, 'all four listed — two of them as holds');
    assert.equal(mine(before).filter((d) => d.hold_reason).length, 2);

    const given = await api('POST', '/medication', {
      token: f.token, body: { rabbit_id: f.open, protocol_id: protocolId, dose_number: 1 },
    });
    assert.equal(given.status, 201, given.text);
    const after = await api('GET', '/medication', { token: f.token });
    assert.equal(mine(after).length, 3);
    assert.ok(!mine(after).some((d) => d.rabbit_id === f.open));
  });
});

/**
 * Rebreeding after delivery, on the farm's own rule. Settings offers two
 * gaps — 16 days or 32 days after kindling — and on that day the doe is on
 * the list to be served again, and every phone is told.
 */
describe('rebreeding after delivery', () => {
  async function farmWithLitter(kindledDaysAgo, { gap = 32, anchor = 'kindling' } = {}) {
    const f = await farmWithDoe();
    await adminQuery(
      `UPDATE farm_settings SET quiet_hours_enabled = false WHERE farm_id = $1`, [f.farm.id]);
    const set = await api('PATCH', '/settings', {
      token: f.token, body: { rebreed_anchor: anchor, rebreed_after_kindling_days: gap },
    });
    assert.equal(set.status, 200, set.text);
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(kindledDaysAgo + 31) },
    });
    const litter = await api('POST', '/litters', {
      token: f.token,
      body: { mating_id: m.body.mating.id, doe_id: f.doe, kindled_on: dateAgo(kindledDaysAgo), born_alive: 8 },
    });
    assert.equal(litter.status, 201, litter.text);
    return { ...f, kindledOn: dateAgo(kindledDaysAgo) };
  }
  const breedTasks = async (farmId) => (await adminQuery(
    `SELECT title, due_on::text AS due_on, status, generated_key FROM task
      WHERE farm_id = $1 AND kind = 'breed' ORDER BY due_on`, [farmId])).rows;

  test('the setting is the farm\'s to choose: 16 or 32 days after kindling', async () => {
    const f = await farmWithDoe();
    const set = await api('PATCH', '/settings', {
      token: f.token, body: { rebreed_anchor: 'kindling', rebreed_after_kindling_days: 16 },
    });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.body.settings.rebreed_anchor, 'kindling');
    assert.equal(set.body.settings.rebreed_after_kindling_days, 16);
    const got = await api('GET', '/settings', { token: f.token });
    assert.equal(got.body.settings.rebreed_after_kindling_days, 16);
  });

  test('on the 32nd day after kindling, she is on the list to be served', async () => {
    const f = await farmWithLitter(32);
    await inPass(`SELECT generate_rebreed_tasks()`);
    const tasks = await breedTasks(f.farm.id);
    assert.equal(tasks.length, 1, JSON.stringify(tasks));
    assert.match(tasks[0].title, /Rebreed Lakshmi — 32 days after kindling/);
    assert.equal(tasks[0].due_on, dateAgo(0), '32 days after the kindling is today');
  });

  test('16 days when the farm says 16', async () => {
    const f = await farmWithLitter(16, { gap: 16 });
    await inPass(`SELECT generate_rebreed_tasks()`);
    const tasks = await breedTasks(f.farm.id);
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /16 days after kindling/);
  });

  test('not before the day, and not for a doe already served again', async () => {
    const early = await farmWithLitter(20);
    await inPass(`SELECT generate_rebreed_tasks()`);
    assert.equal((await breedTasks(early.farm.id)).length, 0, 'day 20 of 32: nothing yet');

    const served = await farmWithLitter(40);
    await api('POST', '/matings', {
      token: served.token, body: { doe_id: served.doe, buck_id: served.buck, mated_at: daysAgo(5) },
    });
    await inPass(`SELECT generate_rebreed_tasks()`);
    assert.equal((await breedTasks(served.farm.id)).length, 0, 'she is back in a cycle');
  });

  test('a farm on the separate-then-rebreed rule is left to that rule', async () => {
    const f = await farmWithLitter(32, { anchor: 'weaning' });
    await inPass(`SELECT generate_rebreed_tasks()`);
    assert.equal((await breedTasks(f.farm.id)).length, 0);
  });

  test('the day it is due, every phone is told, once', async () => {
    const f = await farmWithLitter(32);
    await inPass(`SELECT generate_rebreed_tasks()`);
    await inPass(`SELECT generate_breed_notifications()`);
    await inPass(`SELECT generate_breed_notifications()`);
    const notes = (await notificationsFor(f.farm.id)).filter((n) => /Rebreed/.test(n.title));
    assert.equal(notes.length, 1, JSON.stringify(notes));
    assert.equal(notes[0].kind, 'task_due');
  });
});

/**
 * One dose a day, in order. The round's dates are the calendar's, but a
 * rabbit's second dose is not asked for until the day after its first was
 * given, and its third the day after that — "the second dose should be on
 * the next day, and the third on the third day". A late start slides the
 * course rather than stacking it.
 */
describe('the round, one dose a day', () => {
  async function farmWithBuck() {
    const f = await farmWithDoe();
    await adminQuery(
      `UPDATE farm_settings SET quiet_hours_enabled = false WHERE farm_id = $1`, [f.farm.id]);
    return f;
  }
  /** A three-dose month-anchored course whose first dose fell due yesterday. */
  async function courseStartedYesterday(f) {
    const { rows } = await adminQuery(
      `INSERT INTO medication_protocol
         (farm_id, name, anchor, start_offset_days, doses, interval_days, dose_note,
          applies_to, notify, route, dose)
       VALUES ($1, 'Test course', 'month',
               farm_today($1) - date_trunc('month', farm_today($1))::date - 1,
               3, 1, 'one a day', 'any', true, 'oral', '1 ml')
       RETURNING id`, [f.farm.id]);
    return rows[0].id;
  }
  const listed = async (f, protocolId, rabbitId) =>
    (await api('GET', '/medication', { token: f.token })).body.due
      .filter((d) => d.protocol_id === protocolId && d.rabbit_id === rabbitId)
      .map((d) => [d.dose_number, Number(d.days_until_due)]);

  test('only the next dose is asked for, never two of the same course at once', async () => {
    const f = await farmWithBuck();
    const p = await courseStartedYesterday(f);
    // Dose 1 fell due yesterday and dose 2 today, but nobody has given dose 1.
    assert.deepEqual(await listed(f, p, f.buck), [[1, -1]],
      'dose 1, overdue; dose 2 waits for it even though its date has come');
  });

  test('given today, the next dose is for tomorrow — and tomorrow it is "today", not overdue', async () => {
    const f = await farmWithBuck();
    const p = await courseStartedYesterday(f);
    const given = await api('POST', '/medication', {
      token: f.token, body: { rabbit_id: f.buck, protocol_id: p, dose_number: 1 },
    });
    assert.equal(given.status, 201, given.text);
    assert.deepEqual(await listed(f, p, f.buck), [],
      'dose 2 is not asked for on the day dose 1 was given');

    // Turn the clock: dose 1 was given yesterday.
    await adminQuery(
      `UPDATE health_event SET occurred_on = occurred_on - 1
        WHERE protocol_id = $1 AND rabbit_id = $2 AND dose_number = 1`, [p, f.buck]);
    assert.deepEqual(await listed(f, p, f.buck), [[2, 0]],
      'dose 2 is due today — its date slid with the late start, so it is not red');

    // And the daily list says the same.
    const daily = await api('GET', '/daily', { token: f.token });
    const mine = daily.body.items.filter((i) => i.source === 'medication' && i.rabbit_id === f.buck
      && /Test course/.test(i.title));
    assert.deepEqual(mine.map((i) => [i.title.replace(/ for .*$/, ''), i.urgency]),
      [['Test course — dose 2 of 3', 'high']]);
  });

  test('a first dose nobody ever gave lapses, and the course moves on', async () => {
    const f = await farmWithBuck();
    const p = await courseStartedYesterday(f);
    // Push the whole course back four days: dose 1 is past its grace, dose 2 and 3 too.
    await adminQuery(
      `UPDATE medication_protocol SET start_offset_days = start_offset_days - 4 WHERE id = $1`, [p]);
    const { rows } = await adminQuery(
      `SELECT dose_number, lapsed FROM v_medication_due
        WHERE protocol_id = $1 AND rabbit_id = $2 ORDER BY dose_number`, [p, f.buck]);
    assert.ok(rows.length >= 1 && rows[0].dose_number === 1 && rows[0].lapsed,
      'dose 1 is a miss, and a miss is worth knowing about');
  });
});
