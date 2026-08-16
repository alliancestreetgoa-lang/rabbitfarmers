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

describe('breed and cage', () => {
  test('a new farm can pick a breed and a shed without setting anything up', async () => {
    const f = await signupFarm();

    const breeds = await api('GET', '/breeds', { token: f.token });
    assert.equal(breeds.status, 200);
    assert.ok(breeds.body.breeds.length >= 3,
      'signup seeds breeds so the first rabbit does not need a setup wizard');
    assert.ok(breeds.body.breeds.some((b) => b.name === 'New Zealand White'));

    // Cages are not seeded — nobody can guess what is painted on them.
    const cages = await api('GET', '/cages', { token: f.token });
    assert.equal(cages.status, 200);
    assert.deepEqual(cages.body.cages, []);
  });

  test('naming a cage that does not exist creates it', async () => {
    const f = await signupFarm();
    const breeds = await api('GET', '/breeds', { token: f.token });
    const nzw = breeds.body.breeds.find((b) => b.name === 'New Zealand White');

    const res = await api('POST', '/animals', {
      token: f.token,
      body: { name: 'Gauri', sex: 'doe', breed_id: nzw.id, cage_code: 'A-12' },
    });
    assert.equal(res.status, 201, res.text);
    // The response carries the names back, because the app has just invented a
    // cage it had no id for.
    assert.equal(res.body.animal.breed, 'New Zealand White');
    assert.equal(res.body.animal.cage, 'A-12');

    const cages = await api('GET', '/cages', { token: f.token });
    assert.equal(cages.body.cages.length, 1);
    assert.equal(cages.body.cages[0].code, 'A-12');
    assert.equal(cages.body.cages[0].occupants, 1);
    assert.equal(cages.body.cages[0].shed, 'Shed A', 'dropped into the seeded shed');

    const herd = await api('GET', '/animals', { token: f.token });
    assert.equal(herd.body.animals[0].cage, 'A-12');
    assert.equal(herd.body.animals[0].breed, 'New Zealand White');
  });

  test('a second rabbit in the same cage reuses it rather than duplicating', async () => {
    const f = await signupFarm();
    await api('POST', '/animals', {
      token: f.token, body: { name: 'Gauri', sex: 'doe', cage_code: 'B-3' } });
    await api('POST', '/animals', {
      token: f.token, body: { name: 'Sita', sex: 'doe', cage_code: 'B-3' } });

    const cages = await api('GET', '/cages', { token: f.token });
    assert.equal(cages.body.cages.length, 1, 'one cage, not two');
    assert.equal(cages.body.cages[0].occupants, 2);
  });

  test('a breed the farm actually keeps can be typed in', async () => {
    const f = await signupFarm();
    const res = await api('POST', '/animals', {
      token: f.token,
      body: { name: 'Bhim', sex: 'buck', breed_name: 'Grey Giant', cage_code: 'A-1' },
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.animal.breed, 'Grey Giant');

    // And it is offered from then on rather than being typed again every time.
    const breeds = await api('GET', '/breeds', { token: f.token });
    const grey = breeds.body.breeds.find((b) => b.name === 'Grey Giant');
    assert.ok(grey, 'the new breed joins the list');
    assert.equal(grey.animals, 1);
    assert.equal(grey.size_class, 'medium', 'a sensible default, editable later');

    const again = await api('POST', '/animals', {
      token: f.token, body: { name: 'Arjun', sex: 'buck', breed_name: 'Grey Giant' } });
    assert.equal(again.status, 201);
    const after_ = await api('GET', '/breeds', { token: f.token });
    assert.equal(after_.body.breeds.filter((b) => b.name === 'Grey Giant').length, 1);
  });

  test('blank breed and cage are simply left unset', async () => {
    const f = await signupFarm();
    const res = await api('POST', '/animals', {
      token: f.token,
      body: { name: 'Tulsi', sex: 'doe', breed_name: '  ', cage_code: '' },
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.animal.breed, null);
    assert.equal(res.body.animal.cage, null);
    assert.deepEqual((await api('GET', '/cages', { token: f.token })).body.cages, []);
  });

  test('one farm cannot see or reuse another farm\'s cages', async () => {
    const a = await signupFarm();
    const b = await signupFarm();
    await api('POST', '/animals', {
      token: a.token, body: { name: 'Gauri', sex: 'doe', cage_code: 'A-12' } });

    assert.deepEqual((await api('GET', '/cages', { token: b.token })).body.cages, []);

    // Same code, different farm: a second cage, not a shared one.
    await api('POST', '/animals', {
      token: b.token, body: { name: 'Meera', sex: 'doe', cage_code: 'A-12' } });
    const bCages = (await api('GET', '/cages', { token: b.token })).body.cages;
    assert.equal(bCages.length, 1);
    const aCages = (await api('GET', '/cages', { token: a.token })).body.cages;
    assert.equal(aCages.length, 1);
    assert.notEqual(aCages[0].id, bCages[0].id);
  });
});

describe('a rabbit keeps her history', () => {
  /** A doe with a full working life behind her. */
  async function doeWithAPast() {
    const f = await signupFarm();
    const mk = async (body) =>
      (await api('POST', '/animals', { token: f.token, body })).body.animal.id;

    const buck = await mk({ name: 'Bhim', sex: 'buck', date_of_birth: dateAgo(700) });
    const doe = await mk({ name: 'Lakshmi', sex: 'doe', date_of_birth: dateAgo(600),
                           cage_code: 'A-1' });

    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: doe, buck_id: buck, mated_at: daysAgo(100) } });
    await api('POST', '/pregnancy-checks', {
      token: f.token,
      body: { mating_id: m.body.mating.id, result: 'positive', checked_on: dateAgo(88) } });
    const litter = await api('POST', '/litters', {
      token: f.token,
      body: { doe_id: doe, mating_id: m.body.mating.id, kindled_on: dateAgo(69),
              born_alive: 8, born_dead: 1 } });
    await api('POST', `/litters/${litter.body.litter.id}/wean`, {
      token: f.token, body: { weaned_on: dateAgo(39), weaned_count: 7 } });
    await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: doe, severity: 'moderate' } });

    return { ...f, doe, buck };
  }

  test('every event she went through is readable afterwards', async () => {
    const f = await doeWithAPast();
    const res = await api('GET', `/animals/${f.doe}/history`, { token: f.token });
    assert.equal(res.status, 200, res.text);

    const kinds = res.body.events.map((e) => e.kind);
    for (const k of ['born', 'mating', 'pregnancy_check', 'kindling', 'weaning',
                     'condition']) {
      assert.ok(kinds.includes(k), `${k} is missing from her history`);
    }

    // Newest first — the usual question is what has been happening lately.
    const dates = res.body.events.map((e) => e.on_date);
    assert.deepEqual(dates, [...dates].sort().reverse());

    const kindling = res.body.events.find((e) => e.kind === 'kindling');
    assert.match(kindling.title, /8 alive, 1 dead/);
    assert.equal(kindling.detail.born_alive, 8);

    assert.equal(res.body.lifetime.litters, 1);
    assert.equal(res.body.lifetime.born_alive, 8);
    assert.equal(res.body.lifetime.weaned, 7);
  });

  test("a buck's record is the does he served", async () => {
    const f = await doeWithAPast();
    const res = await api('GET', `/animals/${f.buck}/history`, { token: f.token });
    const service = res.body.events.find((e) => e.kind === 'service');
    assert.ok(service, 'a buck with no history of his own is a blank page');
    assert.match(service.title, /Served Lakshmi/);
    assert.equal(res.body.lifetime.services, 1);
  });

  test('selling her takes her out of the herd and nothing else', async () => {
    const f = await doeWithAPast();

    const before = await api('GET', `/animals/${f.doe}/history`, { token: f.token });
    const sold = await api('POST', `/animals/${f.doe}/status`, {
      token: f.token,
      body: { status: 'sold', reason: 'Sold to Prakash', sale_price_paise: 45000 },
    });
    assert.equal(sold.status, 201, sold.text);

    // Out of the working herd...
    const herd = await api('GET', '/animals', { token: f.token });
    assert.ok(!herd.body.animals.some((a) => a.id === f.doe));

    // ...but still there, and still complete.
    const past = await api('GET', '/animals?include=past', { token: f.token });
    assert.equal(past.body.animals.find((a) => a.id === f.doe).status, 'sold');
    assert.ok((await api('GET', '/animals?include=all', { token: f.token }))
      .body.animals.some((a) => a.id === f.doe));

    const after = await api('GET', `/animals/${f.doe}/history`, { token: f.token });
    assert.equal(after.status, 200, 'her page must still open after she is gone');
    for (const e of before.body.events) {
      assert.ok(after.body.events.some((x) => x.kind === e.kind && x.on_date === e.on_date),
        `${e.kind} disappeared when she was sold`);
    }
    const status = after.body.events.find((e) => e.kind === 'status');
    assert.equal(status.title, 'Sold');
    assert.equal(status.detail.reason, 'Sold to Prakash');
    assert.equal(status.detail.sale_price_paise, 45000);
  });

  test('every status change is kept, not overwritten', async () => {
    const f = await doeWithAPast();
    const at = async (status, reason) => api('POST', `/animals/${f.doe}/status`, {
      token: f.token, body: { status, reason } });

    await at('quarantine', 'Off feed, keeping her apart');
    await at('active', 'Eating again');
    await at('culled', 'Three failed services');

    const res = await api('GET', `/animals/${f.doe}/history`, { token: f.token });
    const changes = res.body.events.filter((e) => e.kind === 'status');
    assert.equal(changes.length, 3, 'a status column holds one fact; a farm has three');
    assert.deepEqual(changes.map((e) => e.detail.to).sort(),
      ['active', 'culled', 'quarantine']);
  });

  test('a reason is required for the changes you cannot undo', async () => {
    const f = await doeWithAPast();
    for (const status of ['sold', 'culled', 'dead']) {
      const res = await api('POST', `/animals/${f.doe}/status`, {
        token: f.token, body: { status } });
      assert.equal(res.status, 400, `${status} should need a reason`);
      assert.equal(res.body.detail.field, 'reason');
    }
    // Still active — three refusals changed nothing.
    const herd = await api('GET', '/animals', { token: f.token });
    assert.equal(herd.body.animals.find((a) => a.id === f.doe).status, 'active');
  });

  test('the database itself refuses to delete a doe who has bred', async () => {
    const f = await doeWithAPast();
    // Straight at the table as the admin role, bypassing RLS and the API — the
    // guarantee has to hold against a hand at the console, not just against a
    // missing endpoint.
    await assert.rejects(
      () => adminQuery('DELETE FROM rabbit WHERE id = $1', [f.doe]),
      /foreign key|violates/i,
      'a doe with matings and litters must not be deletable');
  });

  test('one farm cannot read another farm\'s history', async () => {
    const a = await doeWithAPast();
    const b = await signupFarm();

    const res = await api('GET', `/animals/${a.doe}/history`, { token: b.token });
    assert.equal(res.status, 404, 'not even the existence of the id leaks');

    const push = await api('POST', `/animals/${a.doe}/status`, {
      token: b.token, body: { status: 'dead', reason: 'not mine to say' } });
    assert.equal(push.status, 404);
  });
});

describe('correcting a kindling record', () => {
  async function farmWithLitter() {
    const f = await signupFarm();
    const mk = async (body) =>
      (await api('POST', '/animals', { token: f.token, body })).body.animal.id;
    const doe = await mk({ name: 'Lakshmi', sex: 'doe', date_of_birth: dateAgo(500) });
    const buck = await mk({ name: 'Bhim', sex: 'buck', date_of_birth: dateAgo(600) });
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: doe, buck_id: buck, mated_at: daysAgo(35) } });
    const litter = await api('POST', '/litters', {
      token: f.token,
      body: { doe_id: doe, mating_id: m.body.mating.id, kindled_on: dateAgo(4),
              born_alive: 8, born_dead: 1, notes: 'Good nest, all covered.' } });
    return { ...f, doe, litter: litter.body.litter.id };
  }

  test('the count and the note are saved and read back', async () => {
    const f = await farmWithLitter();
    const res = await api('GET', `/litters/${f.litter}`, { token: f.token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.litter.born_alive, 8);
    assert.equal(res.body.litter.born_dead, 1);
    assert.equal(res.body.litter.notes, 'Good nest, all covered.');
    assert.equal(res.body.litter.doe_name, 'Lakshmi');
    assert.deepEqual(res.body.litter.corrections, []);
  });

  test('a correction keeps what it said before', async () => {
    const f = await farmWithLitter();

    const patched = await api('PATCH', `/litters/${f.litter}`, {
      token: f.token,
      body: { born_alive: 9, notes: 'Found a ninth under the fur an hour later.' },
    });
    assert.equal(patched.status, 200, patched.text);
    assert.deepEqual(patched.body.litter.changed.sort(), ['born_alive', 'notes']);

    const now = await api('GET', `/litters/${f.litter}`, { token: f.token });
    assert.equal(now.body.litter.born_alive, 9);
    assert.equal(now.body.litter.corrections.length, 1);
    assert.equal(now.body.litter.corrections[0].old_values.born_alive, 8);
    assert.equal(now.body.litter.corrections[0].new_values.born_alive, 9);
    assert.equal(now.body.litter.corrections[0].changed_by, 'Farm Owner');

    // And it shows on the doe's timeline as its own event, above the kindling.
    const history = await api('GET', `/animals/${f.doe}/history`, { token: f.token });
    const fix = history.body.events.find((e) => e.kind === 'correction');
    assert.ok(fix, 'a correction must be visible, not silent');
    assert.equal(fix.detail.before.born_alive, 8);
    assert.equal(fix.detail.after.born_alive, 9);

    const kindling = history.body.events.find((e) => e.kind === 'kindling');
    assert.match(kindling.title, /9 alive/);
  });

  test('re-saving the same values records nothing', async () => {
    const f = await farmWithLitter();
    const res = await api('PATCH', `/litters/${f.litter}`, {
      token: f.token, body: { born_alive: 8, born_dead: 1 } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.litter.changed, []);
    assert.match(res.body.message, /Nothing changed/);

    const now = await api('GET', `/litters/${f.litter}`, { token: f.token });
    assert.equal(now.body.litter.corrections.length, 0,
      'an untouched form must not litter the timeline');
  });

  test('the doe cannot be moved to another rabbit by editing', async () => {
    const f = await farmWithLitter();
    const other = (await api('POST', '/animals', {
      token: f.token, body: { name: 'Rani', sex: 'doe' } })).body.animal.id;

    const res = await api('PATCH', `/litters/${f.litter}`, {
      token: f.token, body: { doe_id: other } });
    assert.equal(res.status, 400, 'reassigning a litter is a new record, not a correction');

    const now = await api('GET', `/litters/${f.litter}`, { token: f.token });
    assert.equal(now.body.litter.doe_id, f.doe);
  });

  test('nonsense counts are refused', async () => {
    const f = await farmWithLitter();
    for (const body of [{ born_alive: -1 }, { born_dead: 2.5 }, { born_alive: 'lots' }]) {
      const res = await api('PATCH', `/litters/${f.litter}`, { token: f.token, body });
      assert.equal(res.status, 400, `${JSON.stringify(body)} should be refused`);
    }
    assert.equal((await api('GET', `/litters/${f.litter}`, { token: f.token }))
      .body.litter.born_alive, 8);
  });

  test('one farm cannot read or correct another farm\'s record', async () => {
    const a = await farmWithLitter();
    const b = await signupFarm();

    assert.equal((await api('GET', `/litters/${a.litter}`, { token: b.token })).status, 404);
    assert.equal((await api('PATCH', `/litters/${a.litter}`, {
      token: b.token, body: { born_alive: 99 } })).status, 404);

    // The correction trail is tenant-scoped too. audit_log had no row-level
    // security until migration 0013 — it was only safe because nothing wrote to
    // it, and this is what makes sure it stays safe now that something does.
    await api('PATCH', `/litters/${a.litter}`, {
      token: a.token, body: { born_alive: 9 } });
    const mine = await api('GET', `/litters/${a.litter}`, { token: a.token });
    assert.equal(mine.body.litter.corrections.length, 1);
  });
});

describe('kits as individuals', () => {
  async function farmWithWeanedLitter() {
    const f = await signupFarm();
    const mk = async (body) =>
      (await api('POST', '/animals', { token: f.token, body })).body.animal.id;
    const doe = await mk({ name: 'Lakshmi', sex: 'doe', date_of_birth: dateAgo(500) });
    const buck = await mk({ name: 'Bhim', sex: 'buck', date_of_birth: dateAgo(600) });
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: doe, buck_id: buck, mated_at: daysAgo(100) } });
    const litter = await api('POST', '/litters', {
      token: f.token,
      body: { doe_id: doe, mating_id: m.body.mating.id, kindled_on: dateAgo(69),
              born_alive: 8, born_dead: 1 } });
    await api('POST', `/litters/${litter.body.litter.id}/wean`, {
      token: f.token, body: { weaned_on: dateAgo(39), weaned_count: 7 } });
    return { ...f, doe, buck, litter: litter.body.litter.id };
  }

  test('a litter starts as a count and says so', async () => {
    const f = await farmWithWeanedLitter();
    const res = await api('GET', `/litters/${f.litter}/kits`, { token: f.token });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.kits, []);
    assert.equal(res.body.litter.expected, 7, 'the weaned count, not the birth count');
    assert.equal(res.body.litter.not_yet_recorded, 7);
  });

  test('adding them links each one to both parents', async () => {
    const f = await farmWithWeanedLitter();
    const res = await api('POST', `/litters/${f.litter}/kits`, { token: f.token, body: {} });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.kits.length, 7, 'defaults to however many are still a count');
    assert.deepEqual(res.body.kits.map((k) => k.tag),
      Array.from({ length: 7 }, (_, i) => `Lakshmi-${i + 1}`));

    // Unsexed by default. A guess at 30 days is a guess recorded as a fact.
    assert.ok(res.body.kits.every((k) => k.sex === 'unknown'));

    const kid = await api('GET', `/animals/${res.body.kits[0].id}/history`,
      { token: f.token });
    assert.equal(kid.body.animal.dam, 'Lakshmi');
    assert.equal(kid.body.animal.sire, 'Bhim');
    assert.equal(kid.body.animal.date_of_birth, dateAgo(69), 'born when she kindled');

    const born = kid.body.events.find((e) => e.kind === 'born');
    assert.equal(born.detail.dam, 'Lakshmi');
    assert.equal(born.detail.sire, 'Bhim');

    // And they show up on the mother's page.
    const mum = await api('GET', `/animals/${f.doe}/history`, { token: f.token });
    assert.equal(mum.body.offspring.length, 7);
  });

  test('unsexed kits stay out of the breeding queues', async () => {
    const f = await farmWithWeanedLitter();
    await api('POST', `/litters/${f.litter}/kits`, { token: f.token, body: {} });

    const ready = await api('GET', '/ready-to-mate', { token: f.token });
    assert.ok(!ready.body.ready.some((r) => r.tag.startsWith('Lakshmi-')),
      'a rabbit nobody has sexed must not be queued for mating');

    const bucks = await api('GET', `/bucks/suggest?doe_id=${f.doe}`, { token: f.token });
    assert.ok(!bucks.body.bucks.some((b) => b.tag.startsWith('Lakshmi-')));
  });

  test('this is what makes the inbreeding check work', async () => {
    const f = await farmWithWeanedLitter();
    // Sexed at eight weeks, as a farm actually does it.
    const kits = await api('POST', `/litters/${f.litter}/kits`, {
      token: f.token, body: { count: 2, sex: 'doe' } });
    const daughter = kits.body.kits[0].id;

    const suggestions = await api('GET', `/bucks/suggest?doe_id=${daughter}`,
      { token: f.token });
    const father = suggestions.body.bucks.find((b) => b.buck_id === f.buck);
    assert.ok(father, 'her father should be listed');
    assert.equal(father.blocked_related, true,
      'a daughter must not be offered her own father — the whole point of '
      + 'giving kits records rather than leaving the litter as a number');
  });

  test('it will not invent more kits than the litter had', async () => {
    const f = await farmWithWeanedLitter();
    const tooMany = await api('POST', `/litters/${f.litter}/kits`, {
      token: f.token, body: { count: 9 } });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /7 kit|left/i);
    assert.match(tooMany.body.error, /Correct the kindling/);

    await api('POST', `/litters/${f.litter}/kits`, { token: f.token, body: { count: 7 } });
    const again = await api('POST', `/litters/${f.litter}/kits`, {
      token: f.token, body: { count: 1 } });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already recorded/);
  });

  test('adding them in two goes numbers on rather than colliding', async () => {
    const f = await farmWithWeanedLitter();
    const first = await api('POST', `/litters/${f.litter}/kits`, {
      token: f.token, body: { count: 3 } });
    const second = await api('POST', `/litters/${f.litter}/kits`, {
      token: f.token, body: { count: 4 } });

    assert.deepEqual(first.body.kits.map((k) => k.tag),
      ['Lakshmi-1', 'Lakshmi-2', 'Lakshmi-3']);
    assert.deepEqual(second.body.kits.map((k) => k.tag),
      ['Lakshmi-4', 'Lakshmi-5', 'Lakshmi-6', 'Lakshmi-7']);

    const all = await api('GET', `/litters/${f.litter}/kits`, { token: f.token });
    assert.equal(all.body.kits.length, 7);
    assert.equal(all.body.litter.not_yet_recorded, 0);
  });

  test('names can be given instead of numbers', async () => {
    const f = await farmWithWeanedLitter();
    const res = await api('POST', `/litters/${f.litter}/kits`, {
      token: f.token, body: { names: ['Chotu', 'Kali'], sex: 'buck' } });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.body.kits.map((k) => k.name), ['Chotu', 'Kali']);
    assert.ok(res.body.kits.every((k) => k.sex === 'buck'));

    const clash = await api('POST', `/litters/${f.litter}/kits`, {
      token: f.token, body: { names: ['Chotu'] } });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /already a rabbit called Chotu/);
  });

  test('a second litter from the same doe carries on the numbering', async () => {
    const f = await farmWithWeanedLitter();
    await api('POST', `/litters/${f.litter}/kits`, { token: f.token, body: { count: 7 } });

    const m2 = await api('POST', '/matings', {
      token: f.token, body: { doe_id: f.doe, buck_id: f.buck, mated_at: daysAgo(35) } });
    const l2 = await api('POST', '/litters', {
      token: f.token,
      body: { doe_id: f.doe, mating_id: m2.body.mating.id, kindled_on: dateAgo(4),
              born_alive: 6 } });

    const res = await api('POST', `/litters/${l2.body.litter.id}/kits`, {
      token: f.token, body: { count: 2 } });
    assert.deepEqual(res.body.kits.map((k) => k.tag), ['Lakshmi-8', 'Lakshmi-9'],
      'her spring litter must not collide with her autumn one');
  });

  test('one farm cannot add kits to another farm\'s litter', async () => {
    const a = await farmWithWeanedLitter();
    const b = await signupFarm();
    assert.equal((await api('POST', `/litters/${a.litter}/kits`, {
      token: b.token, body: {} })).status, 404);
    assert.equal((await api('GET', `/litters/${a.litter}/kits`, { token: b.token })).status, 404);
  });
});

describe('editing a rabbit', () => {
  test('a kit can be sexed once somebody has actually looked', async () => {
    const f = await signupFarm();
    const kit = (await api('POST', '/animals', {
      token: f.token, body: { name: 'Chotu', sex: 'unknown', role: 'grower' } })).body.animal.id;

    // Unsexed: out of every breeding queue, which is the point of allowing it.
    assert.ok(!(await api('GET', '/ready-to-mate', { token: f.token }))
      .body.ready.some((r) => r.rabbit_id === kit));

    const res = await api('PATCH', `/animals/${kit}`, {
      token: f.token, body: { sex: 'doe', role: 'breeder' } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.animal.sex, 'doe');
    assert.deepEqual(res.body.animal.changed.sort(), ['role', 'sex']);

    const history = await api('GET', `/animals/${kit}/history`, { token: f.token });
    const fix = history.body.events.find((e) => e.kind === 'correction');
    assert.ok(fix, 'the change must be on her record');
    assert.equal(fix.detail.before.sex, 'unknown');
    assert.equal(fix.detail.after.sex, 'doe');
  });

  test('moving her cage is recorded as a move, not just a different value', async () => {
    const f = await signupFarm();
    const r = (await api('POST', '/animals', {
      token: f.token, body: { name: 'Gauri', sex: 'doe', cage_code: 'A-1' } })).body.animal.id;

    await api('PATCH', `/animals/${r}`, {
      token: f.token, body: { cage_code: 'B-3', move_reason: 'Making room for a nest box' } });

    const history = await api('GET', `/animals/${r}/history`, { token: f.token });
    const moved = history.body.events.find((e) => e.kind === 'moved');
    assert.ok(moved, 'a cage change is a thing that happened');
    assert.equal(moved.detail.from, 'A-1');
    assert.equal(moved.detail.to, 'B-3');
    assert.equal(moved.detail.reason, 'Making room for a nest box');
  });

  test('a parent can be filled in when blank but never rewritten', async () => {
    const f = await signupFarm();
    const mk = async (b) => (await api('POST', '/animals', { token: f.token, body: b })).body.animal.id;
    const dam = await mk({ name: 'Radha', sex: 'doe' });
    const other = await mk({ name: 'Meera', sex: 'doe' });
    const kid = await mk({ name: 'Ganga', sex: 'unknown' });

    assert.equal((await api('PATCH', `/animals/${kid}`, {
      token: f.token, body: { dam_id: dam } })).status, 200, 'blank may be filled in');

    const rewrite = await api('PATCH', `/animals/${kid}`, {
      token: f.token, body: { dam_id: other } });
    assert.equal(rewrite.status, 409);
    assert.match(rewrite.body.error, /already recorded/);

    const h = await api('GET', `/animals/${kid}/history`, { token: f.token });
    assert.equal(h.body.animal.dam, 'Radha');
  });

  test('status cannot be smuggled through the edit', async () => {
    const f = await signupFarm();
    const r = (await api('POST', '/animals', {
      token: f.token, body: { name: 'Sita', sex: 'doe' } })).body.animal.id;
    const res = await api('PATCH', `/animals/${r}`, {
      token: f.token, body: { status: 'dead' } });
    assert.equal(res.status, 400, 'that path exists so the reason is kept');
  });

  test('one farm cannot edit another farm\'s rabbit', async () => {
    const a = await signupFarm();
    const b = await signupFarm();
    const r = (await api('POST', '/animals', {
      token: a.token, body: { name: 'Gauri', sex: 'doe' } })).body.animal.id;
    assert.equal((await api('PATCH', `/animals/${r}`, {
      token: b.token, body: { name: 'Mine now' } })).status, 404);
  });
});

describe('Ostovet', () => {
  test('a brand-new farm has both courses without setting anything up', async () => {
    const f = await signupFarm();
    const { rows } = await adminQuery(
      `SELECT name, anchor::text, start_offset_days, doses, withdrawal_days
       FROM medication_protocol WHERE farm_id = $1 ORDER BY name`, [f.farm.id]);
    assert.equal(rows.length, 2,
      'the whole feature was dead on arrival for every farm without this');
    assert.deepEqual(rows[0], { name: 'Ostovet (post-delivery)', anchor: 'kindling',
      start_offset_days: 1, doses: 5, withdrawal_days: null });
    assert.deepEqual(rows[1], { name: 'Ostovet (pre-delivery)', anchor: 'expected_kindling',
      start_offset_days: -5, doses: 5, withdrawal_days: null });
  });

  test('the five pre-delivery doses land on days 26 to 30', async () => {
    const f = await signupFarm();
    const mk = async (b) => (await api('POST', '/animals', { token: f.token, body: b })).body.animal.id;
    const doe = await mk({ name: 'Lakshmi', sex: 'doe', date_of_birth: dateAgo(400) });
    const buck = await mk({ name: 'Bhim', sex: 'buck', date_of_birth: dateAgo(400) });
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: doe, buck_id: buck, mated_at: daysAgo(28) } });

    const due = await api('GET', '/medication', { token: f.token });
    const pre = due.body.due.filter((d) => d.protocol_name.includes('pre-delivery'));
    assert.equal(pre.length, 5);
    // Mated 28 days ago, expected kindling is day 31, so the course runs from
    // gestation day 26 — three days ago — to day 30.
    assert.equal(pre[0].days_until_due, -2);
    assert.equal(pre[4].days_until_due, 2);
    assert.ok(pre.every((d) => d.rabbit_name === 'Lakshmi'));
  });

  test('giving a dose takes it off the list and puts it on her record', async () => {
    const f = await signupFarm();
    const mk = async (b) => (await api('POST', '/animals', { token: f.token, body: b })).body.animal.id;
    const doe = await mk({ name: 'Lakshmi', sex: 'doe', date_of_birth: dateAgo(400) });
    await api('POST', '/matings', { token: f.token, body: { doe_id: doe, mated_at: daysAgo(28) } });

    const before = (await api('GET', '/medication', { token: f.token })).body.due;
    const dose = before.find((d) => d.days_until_due === 0);
    assert.ok(dose, 'one dose should be due today');

    const given = await api('POST', '/medication', {
      token: f.token,
      body: { rabbit_id: dose.rabbit_id, protocol_id: dose.protocol_id,
              dose_number: dose.dose_number },
    });
    assert.equal(given.status, 201, given.text);

    const after = (await api('GET', '/medication', { token: f.token })).body.due;
    assert.equal(after.length, before.length - 1, 'recording it is what clears it');
    assert.ok(!after.some((d) => d.dose_number === dose.dose_number
      && d.protocol_id === dose.protocol_id));

    const h = await api('GET', `/animals/${doe}/history`, { token: f.token });
    const ev = h.body.events.find((e) => e.kind === 'health_event');
    assert.match(ev.title, /Ostovet.*dose/);
  });

  test('the daily list names the doe and identifies the dose', async () => {
    const f = await signupFarm();
    const doe = (await api('POST', '/animals', {
      token: f.token, body: { name: 'Lakshmi', sex: 'doe', date_of_birth: dateAgo(400) },
    })).body.animal.id;
    await api('POST', '/matings', { token: f.token, body: { doe_id: doe, mated_at: daysAgo(28) } });

    const daily = await api('GET', '/daily', { token: f.token });
    const meds = daily.body.items.filter((i) => i.source === 'medication');
    assert.ok(meds.length > 0);
    assert.match(meds[0].title, /for Lakshmi$/, 'a dose with no name is not a task');

    // protocol:rabbit:dose — a generated schedule has no row to point at.
    const ids = new Set(meds.map((m) => m.ref_id));
    assert.equal(ids.size, meds.length, 'every dose must be its own item');
    for (const m of meds) {
      const [protocol, rabbit, n] = m.ref_id.split(':');
      assert.match(protocol, /^[0-9a-f-]{36}$/);
      assert.equal(rabbit, doe);
      assert.ok(Number(n) >= 1);
    }
  });

  test('a dose too old to record stops being asked for', async () => {
    const f = await signupFarm();
    const doe = (await api('POST', '/animals', {
      token: f.token, body: { name: 'Meera', sex: 'doe', date_of_birth: dateAgo(400) },
    })).body.animal.id;
    // Kindled sixty days ago: the whole post-delivery course is long past.
    await api('POST', '/litters', {
      token: f.token, body: { doe_id: doe, kindled_on: dateAgo(60), born_alive: 7 } });

    const daily = await api('GET', '/daily', { token: f.token });
    assert.equal(daily.body.items.filter((i) => i.source === 'medication').length, 0,
      'a dose that can no longer be recorded must not sit on the list for ever');

    // Still visible as outstanding for reporting, marked lapsed.
    const { rows } = await adminQuery(
      `SELECT count(*)::int AS n FROM v_medication_due
       WHERE farm_id = $1 AND lapsed`, [f.farm.id]);
    assert.ok(rows[0].n > 0, 'it is a miss, and a miss is worth knowing about');
  });

  test('an early kindling cancels the rest of the pre-delivery course', async () => {
    const f = await signupFarm();
    const doe = (await api('POST', '/animals', {
      token: f.token, body: { name: 'Radha', sex: 'doe', date_of_birth: dateAgo(400) },
    })).body.animal.id;
    const m = await api('POST', '/matings', {
      token: f.token, body: { doe_id: doe, mated_at: daysAgo(28) } });
    assert.ok((await api('GET', '/medication', { token: f.token }))
      .body.due.some((d) => d.protocol_name.includes('pre-delivery')));

    await api('POST', '/litters', {
      token: f.token,
      body: { doe_id: doe, mating_id: m.body.mating.id, kindled_on: dateAgo(0),
              born_alive: 8 } });

    const due = (await api('GET', '/medication', { token: f.token })).body.due;
    assert.ok(!due.some((d) => d.protocol_name.includes('pre-delivery')),
      'she has kindled — the run-up doses are not owed any more');
    assert.ok(due.some((d) => d.protocol_name.includes('post-delivery')),
      'and the five after start');
  });
});
