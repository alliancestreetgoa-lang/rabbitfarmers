/**
 * Sickness -> medicines, curated by the platform, consumed by the farms.
 *
 * The superadmin defines each sickness and its treatment in the admin console;
 * every farm's report screen offers exactly that list. A treatment is one or
 * more STEPS in order — fever is a shot, then Belamyl an hour later — and a
 * step may carry who must not get it (a pregnant doe, a kit under three
 * months). A farmer reports what they see and is told what to give, and what
 * NOT to give this particular rabbit. Reporting starts every step; marking it
 * stopped cancels what is left.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupFarm, makeAdmin, cleanup, closePools, adminQuery } from './helpers.js';

after(async () => {
  // Catalogue rows are platform-wide, so scrub the ones this run created.
  await adminQuery(`DELETE FROM condition_catalog WHERE code LIKE 'tst_%'`);
  await cleanup();
  await closePools();
});

const dateAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const rabbit = async (f, body = {}) =>
  (await api('POST', '/animals', {
    token: f.token, body: { name: 'Meera', sex: 'doe', ...body } })).body.animal.id;

let seq = 0;
const uniqueSickness = (label) => {
  const code = `tst_${process.pid}_${++seq}`;
  return { code, name: `${label} ${code}` };
};

describe('the sickness catalogue', () => {
  test('the superadmin adds a sickness and every farm sees it, treatment included', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Head tilt');

    const created = await api('POST', '/admin/sicknesses', {
      token: admin.token,
      body: { code: sick.code, name: sick.name, advice: 'Keep her warm.',
              steps: [{ medicine: 'O2M', dose: '1 ml', route: 'oral', doses: 3,
                        note: '1 bottle in drinking water' }] },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.sickness.steps.length, 1);

    const list = await api('GET', '/condition-types', { token: f.token });
    const t = list.body.types.find((x) => x.code === sick.code);
    assert.ok(t, 'the farm sees the new sickness');
    assert.equal(t.advice, 'Keep her warm.');
    assert.equal(t.steps[0].medicine, 'O2M');
    assert.equal(t.steps[0].dose, '1 ml');
    assert.equal(t.steps[0].doses, 3);
    // The older single-medicine shape is still there for phones that have
    // not updated.
    assert.equal(t.treatment.medicine, 'O2M');
    assert.equal(t.treatment.days, 3);
  });

  test('the old one-medicine fields still work as a single step', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Wet tail');
    await api('POST', '/admin/sicknesses', {
      token: admin.token,
      body: { code: sick.code, name: sick.name, medicine: 'Neblon', days: 2 } });

    const list = await api('GET', '/condition-types', { token: f.token });
    const t = list.body.types.find((x) => x.code === sick.code);
    assert.equal(t.steps.length, 1);
    assert.equal(t.steps[0].medicine, 'Neblon');
    assert.equal(t.steps[0].doses, 2);
  });

  test('a farm that signs up later is born with the catalogue', async () => {
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Snuffles');
    await api('POST', '/admin/sicknesses', {
      token: admin.token,
      body: { code: sick.code, name: sick.name,
              steps: [{ medicine: 'Neblon', doses: 2 }] } });

    const newcomer = await signupFarm();
    const list = await api('GET', '/condition-types', { token: newcomer.token });
    const t = list.body.types.find((x) => x.code === sick.code);
    assert.ok(t, 'new farms inherit the catalogue at signup');
    assert.equal(t.steps[0].medicine, 'Neblon');
  });

  test('neither the farmer nor their staff can touch the catalogue', async () => {
    const f = await signupFarm();
    const owner = await api('POST', '/condition-types', {
      token: f.token, body: { name: 'Made up' } });
    assert.ok([404, 405].includes(owner.status), owner.text);

    const support = await makeAdmin('support');
    const denied = await api('POST', '/admin/sicknesses', {
      token: support.token, body: { name: 'Sneaky' } });
    assert.equal(denied.status, 403, denied.text);
  });

  test('reporting starts the course; stopping it ends the nagging', async () => {
    const f = await signupFarm();
    const id = await rabbit(f);
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Gut ache');
    await api('POST', '/admin/sicknesses', {
      token: admin.token,
      body: { code: sick.code, name: sick.name, advice: 'No greens.',
              steps: [{ medicine: 'O2M', doses: 2, note: '1 bottle within 24 hours' }] } });

    const reported = await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: id, code: sick.code } });
    assert.equal(reported.status, 201, reported.text);
    // Whoever reported it is told what to give, right in the response.
    assert.equal(reported.body.advice, 'No greens.');
    assert.equal(reported.body.steps[0].medicine, 'O2M');
    assert.equal(reported.body.steps[0].hold_reason, null, 'nothing forbids it for her');
    assert.equal(reported.body.treatment.medicine, 'O2M');
    assert.equal(reported.body.treatment.days, 2);

    // Dose 1 due today, dose 2 tomorrow.
    const due = await api('GET', '/medication', { token: f.token });
    const doses = due.body.due.filter((d) => d.rabbit_id === id);
    assert.equal(doses.length, 2, JSON.stringify(due.body.due));
    assert.equal(Number(doses[0].days_until_due), 0, 'first dose is due the day it is reported');

    // She recovers: the remaining doses vanish with the condition.
    const open = await api('GET', '/conditions', { token: f.token });
    const cond = open.body.open.find((o) => o.rabbit_id === id);
    const stop = await api('POST', `/conditions/${cond.condition_id}/check`, {
      token: f.token, body: { status: 'stopped' } });
    assert.equal(stop.status, 200, stop.text);

    const after_ = await api('GET', '/medication', { token: f.token });
    assert.equal(after_.body.due.filter((d) => d.rabbit_id === id).length, 0,
      'a stopped sickness stops its medicine reminders');
  });

  test('a two-step treatment starts both courses, in order', async () => {
    const f = await signupFarm();
    const id = await rabbit(f);
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Hot ears');
    await api('POST', '/admin/sicknesses', {
      token: admin.token,
      body: { code: sick.code, name: sick.name,
              steps: [
                { medicine: 'Genta + Dexa', dose: '0.3 ml', route: 'injection', doses: 1 },
                { medicine: 'Belamyl', dose: '0.3 ml', route: 'injection', doses: 1,
                  note: 'EXACTLY one hour after the first shot.' },
              ] } });

    const reported = await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: id, code: sick.code } });
    assert.equal(reported.status, 201, reported.text);
    assert.deepEqual(reported.body.steps.map((s) => s.medicine), ['Genta + Dexa', 'Belamyl']);

    const due = await api('GET', '/medication', { token: f.token });
    const mine = due.body.due.filter((d) => d.rabbit_id === id);
    assert.equal(mine.length, 2, 'one dose of each, both due today');
    assert.deepEqual(mine.map((d) => d.step), [1, 2], 'in the order they are given');
    assert.match(mine[1].dose_note, /one hour after/);
  });

  test('a recorded dose survives the sickness ending', async () => {
    const f = await signupFarm();
    const id = await rabbit(f);
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Colic');
    await api('POST', '/admin/sicknesses', {
      token: admin.token,
      body: { code: sick.code, name: sick.name, steps: [{ medicine: 'Neblon', doses: 2 }] } });
    await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: id, code: sick.code } });

    const due = await api('GET', '/medication', { token: f.token });
    const dose = due.body.due.find((d) => d.rabbit_id === id);
    const given = await api('POST', '/medication', {
      token: f.token,
      body: { rabbit_id: id, protocol_id: dose.protocol_id, dose_number: dose.dose_number } });
    assert.equal(given.status, 201, given.text);

    const open = await api('GET', '/conditions', { token: f.token });
    const cond = open.body.open.find((o) => o.rabbit_id === id);
    await api('POST', `/conditions/${cond.condition_id}/check`, {
      token: f.token, body: { status: 'stopped' } });

    const history = await api('GET', `/animals/${id}/history`, { token: f.token });
    assert.ok(history.body.events.some((e) => e.kind === 'health_event' && /dose 1/.test(e.title)),
      `the dose given stays on her record: ${JSON.stringify(history.body.events)}`);
  });

  test('retiring a sickness takes it off every report screen', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Passing fad');
    await api('POST', '/admin/sicknesses', {
      token: admin.token, body: { code: sick.code, name: sick.name } });

    let list = await api('GET', '/condition-types', { token: f.token });
    assert.ok(list.body.types.some((x) => x.code === sick.code));

    const retire = await api('POST', `/admin/sicknesses/${sick.code}/deactivate`, {
      token: admin.token, body: {} });
    assert.equal(retire.status, 200, retire.text);

    list = await api('GET', '/condition-types', { token: f.token });
    assert.ok(!list.body.types.some((x) => x.code === sick.code),
      'a retired sickness leaves the picker');
  });

  test('editing the steps replaces them, and the farm follows', async () => {
    const f = await signupFarm();
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Changing');
    await api('POST', '/admin/sicknesses', {
      token: admin.token,
      body: { code: sick.code, name: sick.name,
              steps: [{ medicine: 'First' }, { medicine: 'Second' }] } });
    await api('POST', '/admin/sicknesses', {
      token: admin.token,
      body: { code: sick.code, name: sick.name, steps: [{ medicine: 'Only' }] } });

    const list = await api('GET', '/condition-types', { token: f.token });
    const t = list.body.types.find((x) => x.code === sick.code);
    assert.deepEqual(t.steps.map((s) => s.medicine), ['Only'],
      'the steps that left the catalogue left the farm');
  });
});

/**
 * The chart's safety rules, applied to the rabbit in front of the farmer.
 * "DO NOT give to pregnant females or kits under 3 months" is a hold on the
 * dose, said on the report screen, on the medicine round, and at the moment
 * somebody tries to tick it off as given.
 */
describe('who must not get it', () => {
  const hitechLike = (sick) => ({
    code: sick.code, name: sick.name,
    steps: [{ medicine: 'Hitech (injection)', dose: '0.3 ml', route: 'injection', doses: 2,
              interval_days: 2, adults_only: true, min_age_days: 90, not_when_pregnant: true }],
  });

  test('a kit under three months is told so, and the dose cannot be recorded', async () => {
    const f = await signupFarm();
    const kit = await rabbit(f, { name: 'Chotu', sex: 'buck', date_of_birth: dateAgo(40) });
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Bad fungus');
    await api('POST', '/admin/sicknesses', { token: admin.token, body: hitechLike(sick) });

    const reported = await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: kit, code: sick.code } });
    assert.equal(reported.status, 201, reported.text);
    assert.equal(reported.body.steps[0].hold_reason, 'under 3 months old');

    const due = await api('GET', '/medication', { token: f.token });
    const dose = due.body.due.find((d) => d.rabbit_id === kit);
    assert.ok(dose, 'the dose is listed — with the hold on it, not hidden');
    assert.equal(dose.hold_reason, 'under 3 months old');

    const daily = await api('GET', '/daily', { token: f.token });
    const row = daily.body.items.find((i) => i.source === 'medication' && i.rabbit_id === kit);
    assert.equal(row?.hold_reason, 'under 3 months old', 'Today says it too');

    const given = await api('POST', '/medication', {
      token: f.token,
      body: { rabbit_id: kit, protocol_id: dose.protocol_id, dose_number: dose.dose_number } });
    assert.equal(given.status, 409, given.text);
    assert.match(given.body.error ?? given.text, /Do not give/);
  });

  test('a pregnant doe is held; a mating counts as pregnant', async () => {
    const f = await signupFarm();
    const doe = await rabbit(f, { name: 'Lakshmi', sex: 'doe', role: 'breeder',
                                  date_of_birth: dateAgo(400) });
    const buck = await rabbit(f, { name: 'Raja', sex: 'buck', role: 'breeder',
                                   date_of_birth: dateAgo(400) });
    await api('POST', '/matings', {
      token: f.token, body: { doe_id: doe, buck_id: buck } });
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Bad fungus');
    await api('POST', '/admin/sicknesses', { token: admin.token, body: hitechLike(sick) });

    const reported = await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: doe, code: sick.code } });
    assert.equal(reported.body.steps[0].hold_reason, 'she is pregnant');
  });

  test('a grown, open doe gets it', async () => {
    const f = await signupFarm();
    const doe = await rabbit(f, { name: 'Meera', sex: 'doe', role: 'breeder',
                                  date_of_birth: dateAgo(400) });
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Bad fungus');
    await api('POST', '/admin/sicknesses', { token: admin.token, body: hitechLike(sick) });

    const reported = await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: doe, code: sick.code } });
    assert.equal(reported.body.steps[0].hold_reason, null);

    const due = await api('GET', '/medication', { token: f.token });
    const dose = due.body.due.find((d) => d.rabbit_id === doe);
    const given = await api('POST', '/medication', {
      token: f.token,
      body: { rabbit_id: doe, protocol_id: dose.protocol_id, dose_number: dose.dose_number } });
    assert.equal(given.status, 201, given.text);
  });

  test('a rabbit with no birth date is treated as grown', async () => {
    const f = await signupFarm();
    const unknown = await rabbit(f, { name: 'Nobody knows', sex: 'doe', role: 'breeder' });
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Bad fungus');
    await api('POST', '/admin/sicknesses', { token: admin.token, body: hitechLike(sick) });

    const reported = await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: unknown, code: sick.code } });
    assert.equal(reported.body.steps[0].hold_reason, null,
      'the rule is about kits, and a rabbit nobody wrote a birthday for is not one');
  });
});

/**
 * The catalogue is the master copy and the superadmin is its only curator —
 * so pressing it onto a farm is meant to overwrite. What it must not do is
 * overwrite with values nobody chose (0041).
 */
describe('pressing the catalogue onto a farm', () => {
  test('a blank field leaves the farm\'s own value alone', async () => {
    const f = await signupFarm();
    const sick = uniqueSickness('Snuffles');

    await adminQuery(
      `INSERT INTO condition_type
         (farm_id, code, name, colour, reminder_interval_hours,
          blocks_breeding, is_contagious, escalate_after_hours, respect_quiet_hours)
       VALUES ($1, $2, $3, '#EA580C', 2, false, false, 24, true)`,
      [f.farm.id, sick.code, sick.name]);

    const created = await api('POST', '/admin/sicknesses', {
      token: (await makeAdmin('superadmin')).token,
      body: { code: sick.code, name: sick.name, steps: [{ medicine: 'Neblon', doses: 2 }] },
    });
    assert.equal(created.status, 201, created.text);

    const { rows } = await adminQuery(
      `SELECT reminder_interval_hours, blocks_breeding, escalate_after_hours
         FROM condition_type WHERE farm_id = $1 AND code = $2`, [f.farm.id, sick.code]);

    assert.equal(Number(rows[0].reminder_interval_hours), 2,
      'a blank reminder box must not silence a two-hourly check');
    assert.equal(rows[0].blocks_breeding, false,
      'no opinion on breeding must not decide whether she can breed');
    assert.equal(Number(rows[0].escalate_after_hours), 24,
      'and escalation is not the catalogue\'s to touch');
  });

  test('a value the superadmin does fill in is still applied', async () => {
    const f = await signupFarm();
    const sick = uniqueSickness('Ear mites');

    await adminQuery(
      `INSERT INTO condition_type
         (farm_id, code, name, colour, reminder_interval_hours,
          blocks_breeding, is_contagious, respect_quiet_hours)
       VALUES ($1, $2, $3, '#EA580C', 2, false, false, true)`,
      [f.farm.id, sick.code, sick.name]);

    const created = await api('POST', '/admin/sicknesses', {
      token: (await makeAdmin('superadmin')).token,
      body: { code: sick.code, name: sick.name, reminder_interval_hours: 8,
              is_contagious: true, blocks_breeding: true },
    });
    assert.equal(created.status, 201, created.text);

    const { rows } = await adminQuery(
      `SELECT reminder_interval_hours, is_contagious, blocks_breeding
         FROM condition_type WHERE farm_id = $1 AND code = $2`, [f.farm.id, sick.code]);
    assert.equal(Number(rows[0].reminder_interval_hours), 8,
      'the curator asked for eight hours, so it is eight hours');
    assert.equal(rows[0].is_contagious, true);
    assert.equal(rows[0].blocks_breeding, true, 'a decision made in the console is applied');
  });

  test('a sickness somebody added to a farm by hand is retired by the next press', async () => {
    const f = await signupFarm();
    // Not in the catalogue, and nobody has tested it against a rabbit.
    await adminQuery(
      `INSERT INTO condition_type (farm_id, code, name, colour, reminder_interval_hours,
                                   blocks_breeding, is_contagious, respect_quiet_hours)
       VALUES ($1, 'tst_hand_added_${process.pid}', 'Something local', '#EA580C', 2,
               true, false, true)`, [f.farm.id]);
    let list = await api('GET', '/condition-types', { token: f.token });
    assert.ok(list.body.types.some((t) => t.code.startsWith('tst_hand_added')));

    await adminQuery('SELECT apply_condition_catalog($1)', [f.farm.id]);
    list = await api('GET', '/condition-types', { token: f.token });
    assert.ok(!list.body.types.some((t) => t.code.startsWith('tst_hand_added')),
      'only what the catalogue says exists, exists');
  });
});

/**
 * The chart. Every farm offers exactly these, with exactly these steps.
 */
describe('the medicine chart', () => {
  const CHART = ['loose_motion', 'cold', 'fungus', 'fungus_severe', 'fever', 'injury',
                 'retained_kits', 'drooling', 'infertile', 'stress', 'sudden_deaths'];
  const RETIRED = ['off_feed', 'sore_hocks', 'mastitis'];

  test('is the catalogue, and the console can edit every row of it', async () => {
    const admin = await makeAdmin('superadmin');
    const res = await api('GET', '/admin/sicknesses?format=json', { token: admin.token });
    assert.equal(res.status, 200, res.text);

    const byCode = new Map(res.body.sicknesses.filter((s) => s.is_active).map((s) => [s.code, s]));
    for (const code of CHART) assert.ok(byCode.has(code), `${code} must be on the chart`);
    for (const code of RETIRED) assert.ok(!byCode.has(code), `${code} was replaced by the chart`);

    assert.equal(Number(byCode.get('loose_motion').reminder_interval_hours), 2,
      'loose motion is a two-hourly check and must stay one');
    assert.deepEqual(byCode.get('fever').steps.map((s) => s.medicine),
      ['Gentamicin + Dexamethasone', 'Belamyl (B-complex)']);
    const hitech = byCode.get('fungus_severe').steps[0];
    assert.equal(hitech.adults_only, true);
    assert.equal(hitech.min_age_days, 90);
    assert.equal(hitech.not_when_pregnant, true);
    assert.equal(hitech.interval_days, 2, 'never on consecutive days');

    assert.equal(res.body.routine.length, 10, 'the monthly routine is shown beside it');
  });

  test('a new farm gets exactly the chart', async () => {
    const f = await signupFarm();
    const list = await api('GET', '/condition-types', { token: f.token });
    const codes = new Set(list.body.types.map((t) => t.code));
    for (const code of CHART) assert.ok(codes.has(code), `${code} missing from the report screen`);
    for (const code of RETIRED) assert.ok(!codes.has(code), `${code} must be gone`);

    const fever = list.body.types.find((t) => t.code === 'fever');
    assert.equal(fever.steps.length, 2);
    assert.match(fever.steps[1].note, /one hour after/);
    assert.match(list.body.types.find((t) => t.code === 'loose_motion').advice, /green fodder/i);
  });

  test('around delivery, Calcium Ostovet + Vimeral, five days each side', async () => {
    const f = await signupFarm();
    const { rows } = await adminQuery(
      `SELECT name, anchor, start_offset_days, doses, dose FROM medication_protocol
        WHERE farm_id = $1 AND condition_type_id IS NULL ORDER BY anchor`, [f.farm.id]);
    assert.deepEqual(rows.map((r) => [r.name, r.anchor, r.start_offset_days, r.doses]), [
      ['Calcium Ostovet + Vimeral (pre-delivery)', 'expected_kindling', -5, 5],
      ['Calcium Ostovet + Vimeral (post-delivery)', 'kindling', 1, 5],
    ]);
    assert.equal(rows[0].dose, '1 ml (0.5 ml of each)');
  });
});
