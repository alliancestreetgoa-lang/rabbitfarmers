/**
 * A full breeding cycle through the API, plus the two questions the whole app
 * exists to answer.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupFarm, cleanup, closePools, adminQuery } from './helpers.js';

after(async () => { await cleanup(); await closePools(); });

const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
};
const dateAgo = (n) => daysAgo(n).slice(0, 10);

async function farmWithStock() {
  const farm = await signupFarm();
  const mk = async (name, sex, dob = 400) => {
    const r = await api('POST', '/animals', {
      token: farm.token,
      body: { name, sex, role: 'breeder', date_of_birth: dateAgo(dob) },
    });
    assert.equal(r.status, 201, r.text);
    return r.body.animal.id;
  };
  return {
    ...farm,
    doe: await mk('Lakshmi', 'doe'),
    doe2: await mk('Rani', 'doe'),
    buck: await mk('Raja', 'buck'),
  };
}

describe('breeding cycle', () => {
  test('recording a mating returns the dates the farmer actually wants', async () => {
    const f = await farmWithStock();
    const res = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck },
    });
    assert.equal(res.status, 201, res.text);

    const s = res.body.mating.schedule;
    const day0 = new Date(res.body.mating.mated_at);
    const plus = (n) => new Date(Date.UTC(
      day0.getUTCFullYear(), day0.getUTCMonth(), day0.getUTCDate() + n))
      .toISOString().slice(0, 10);

    assert.equal(s.palpate_on, plus(12));
    assert.equal(s.nest_box_on, plus(28));
    assert.equal(s.expected_kindling_on, plus(31));
    assert.equal(s.watch_until, plus(34), 'kindling is a window, not a date');
  });

  test('counts presumed and confirmed pregnancies separately', async () => {
    const f = await farmWithStock();

    // Palpated positive.
    const m1 = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(12) },
    });
    await api('POST', '/pregnancy-checks', {
      token: f.token, body: { mating_id: m1.body.mating.id, result: 'positive' },
    });

    // Mated 20 days ago, never checked.
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe2, buck_id: f.buck, mated_at: daysAgo(20) },
    });

    const res = await api('GET', '/pregnant', { token: f.token });
    assert.equal(res.body.summary.total_pregnant, 2);
    assert.equal(res.body.summary.confirmed_pregnant, 1);
    assert.equal(res.body.summary.presumed_pregnant, 1,
      'the presumed bucket is where losses hide — it must stay visible');
  });

  test('a negative palpation puts her back in the queue, not in the count', async () => {
    const f = await farmWithStock();
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(20) },
    });
    assert.equal((await api('GET', '/pregnant', { token: f.token })).body.summary.total_pregnant, 1);

    await api('POST', '/pregnancy-checks', {
      token: f.token, body: { mating_id: m.body.mating.id, result: 'negative' },
    });
    assert.equal((await api('GET', '/pregnant', { token: f.token })).body.summary.total_pregnant, 0);
  });

  test('an overdue pregnancy stops being counted and asks for attention', async () => {
    const f = await farmWithStock();
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(40) },
    });
    await api('POST', '/pregnancy-checks', {
      token: f.token, body: { mating_id: m.body.mating.id, result: 'positive' },
    });

    const res = await api('GET', '/pregnant', { token: f.token });
    assert.equal(res.body.summary.total_pregnant, 0,
      'day 40 with no kindling is a problem to surface, not a pregnancy to count');

    const animals = await api('GET', '/animals', { token: f.token });
    const doe = animals.body.animals.find((a) => a.id === f.doe);
    assert.equal(doe.reproductive_state, 'OVERDUE');
  });

  test('kindling to separating to rebreeding follows this farm rhythm', async () => {
    const f = await farmWithStock();
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(31) },
    });

    const litter = await api('POST', '/litters', {
      token: f.token,
      body: { mating_id: m.body.mating.id, doe_id: f.doe, born_alive: 9, born_dead: 1 },
    });
    assert.equal(litter.status, 201, litter.text);

    const kindled = litter.body.litter.kindled_on;
    const plus = (n) => {
      const d = new Date(kindled + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    assert.equal(litter.body.litter.schedule.separate_kits_on, plus(30));
    assert.equal(litter.body.litter.schedule.rebreed_on, plus(33));

    // Nursing does are out of the queue.
    const queue = await api('GET', '/ready-to-mate', { token: f.token });
    assert.ok(!queue.body.ready.some((r) => r.rabbit_id === f.doe));

    const weaned = await api('POST', `/litters/${litter.body.litter.id}/wean`, {
      token: f.token, body: { weaned_count: 8, avg_weaning_weight_g: 620 },
    });
    assert.equal(weaned.status, 200, weaned.text);
    assert.equal(weaned.body.litter.weaned_count, 8);
  });

  test('ready-to-mate holds her back until the 3-day gap is served', async () => {
    const f = await farmWithStock();
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(66) },
    });
    const litter = await api('POST', '/litters', {
      token: f.token,
      body: { mating_id: m.body.mating.id, doe_id: f.doe,
              kindled_on: dateAgo(35), born_alive: 9 },
    });

    // Separated today: the rebreed gap has not been served.
    await api('POST', `/litters/${litter.body.litter.id}/wean`, {
      token: f.token, body: { weaned_on: dateAgo(0), weaned_count: 8 },
    });
    let queue = await api('GET', '/ready-to-mate', { token: f.token });
    assert.ok(!queue.body.ready.some((r) => r.rabbit_id === f.doe),
      'separated today means not ready for another 3 days');

    // Separated 5 days ago: she is up.
    await adminQuery(`UPDATE litter SET weaned_on = current_date - 5 WHERE id = $1`,
      [litter.body.litter.id]);
    queue = await api('GET', '/ready-to-mate', { token: f.token });
    const row = queue.body.ready.find((r) => r.rabbit_id === f.doe);
    assert.ok(row, 'five days after separating she should be in the queue');
    assert.equal(row.days_since_weaning, 5);
    assert.equal(row.days_overdue, 2, 'and 2 days overdue against the 3-day gap');
  });
});

describe('buck suggestion', () => {
  test('blocks a buck that shares a parent with the doe', async () => {
    const f = await signupFarm();
    const mk = async (body) => (await api('POST', '/animals', { token: f.token, body })).body.animal.id;

    const sire = await mk({ name: 'Old Raja', sex: 'buck', date_of_birth: dateAgo(900) });
    const dam = await mk({ name: 'Old Lakshmi', sex: 'doe', date_of_birth: dateAgo(900) });
    const doe = await mk({ name: 'Daughter', sex: 'doe', date_of_birth: dateAgo(400),
                           dam_id: dam, sire_id: sire });
    const brother = await mk({ name: 'Brother', sex: 'buck', date_of_birth: dateAgo(400),
                               dam_id: dam, sire_id: sire });
    const unrelated = await mk({ name: 'Stranger', sex: 'buck', date_of_birth: dateAgo(400) });

    const res = await api('GET', `/bucks/suggest?doe_id=${doe}`, { token: f.token });
    assert.equal(res.status, 200, res.text);
    const byId = Object.fromEntries(res.body.bucks.map((b) => [b.buck_id, b]));

    assert.equal(byId[brother].blocked_related, true, 'full sibling must be blocked');
    assert.equal(byId[sire].blocked_related, true, 'her own sire must be blocked');
    assert.equal(byId[unrelated].blocked_related, false);
  });
});

describe('loose motion', () => {
  test('marks the animal, reminds, and clears when stopped', async () => {
    const f = await farmWithStock();
    // loose_motion comes from the signup seed, not from this test.
    const created = await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: f.doe, severity: 'moderate' },
    });
    assert.equal(created.status, 201, created.text);

    // Colour mark shows against the animal.
    const animals = await api('GET', '/animals', { token: f.token });
    const doe = animals.body.animals.find((a) => a.id === f.doe);
    assert.equal(doe.primary_colour, '#EA580C');
    assert.equal(doe.primary_condition, 'Loose motion');

    // Open conditions ride the daily list continuously, not only at reminder time.
    const daily = await api('GET', '/daily', { token: f.token });
    assert.ok(daily.body.items.some((i) => i.source === 'condition' && i.tag === 'Lakshmi'));

    // She is held out of breeding while it is open.
    const queue = await api('GET', '/ready-to-mate', { token: f.token });
    assert.ok(!queue.body.ready.some((r) => r.rabbit_id === f.doe));

    // Not yet due — the clock counts from the last look.
    let open = await api('GET', '/conditions', { token: f.token });
    assert.equal(open.body.open[0].reminder_due, false);

    // Two hours pass.
    await adminQuery(
      `UPDATE health_condition SET last_checked_at = now() - interval '3 hours' WHERE id = $1`,
      [created.body.condition.id]);
    open = await api('GET', '/conditions', { token: f.token });
    assert.equal(open.body.open[0].reminder_due, true);

    // "Still loose" restarts the clock rather than leaving a backlog.
    const still = await api('POST', `/conditions/${created.body.condition.id}/check`, {
      token: f.token, body: { status: 'ongoing' },
    });
    assert.equal(still.body.resolved, false);
    open = await api('GET', '/conditions', { token: f.token });
    assert.equal(open.body.open[0].reminder_due, false, 'checking buys two hours of quiet');

    // Stopped: mark gone, condition gone, back in the queue.
    const stopped = await api('POST', `/conditions/${created.body.condition.id}/check`, {
      token: f.token, body: { status: 'stopped' },
    });
    assert.equal(stopped.body.resolved, true);

    open = await api('GET', '/conditions', { token: f.token });
    assert.equal(open.body.open.length, 0);

    const after = await api('GET', '/animals', { token: f.token });
    assert.equal(after.body.animals.find((a) => a.id === f.doe).primary_colour, null);
  });

  test('the clock runs from when it was seen, not when it was typed in', async () => {
    const f = await farmWithStock();
    const seen = new Date(Date.now() - 3 * 3600_000).toISOString();

    const created = await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: f.doe, observed_at: seen },
    });
    assert.equal(created.status, 201, created.text);

    // Three hours on a two-hourly reminder: already overdue on arrival, rather
    // than starting a fresh two-hour wait because of when the phone came out.
    const open = await api('GET', '/conditions', { token: f.token });
    const row = open.body.open[0];
    assert.equal(row.reminder_due, true);
    assert.ok(row.hours_open >= 3, `expected at least 3 hours open, got ${row.hours_open}`);
  });

  test('refuses a sighting from the future', async () => {
    const f = await farmWithStock();
    const res = await api('POST', '/conditions', {
      token: f.token,
      body: { rabbit_id: f.doe, observed_at: new Date(Date.now() + 86_400_000).toISOString() },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /future/i);
  });
});
