/**
 * Sickness -> medicine, curated by the platform, consumed by the farms.
 *
 * The superadmin defines each sickness and its treatment in the admin console;
 * every farm's report screen offers exactly that list. A farmer reports what
 * they see and is told what to give — neither they nor their staff can touch
 * the catalogue. Reporting starts the course; marking it stopped cancels what
 * is left.
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

const rabbit = async (f) =>
  (await api('POST', '/animals', {
    token: f.token, body: { name: 'Meera', sex: 'doe' } })).body.animal.id;

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
      body: { code: sick.code, name: sick.name, medicine: 'O2M', days: 3,
              dose_note: '1 bottle in drinking water' },
    });
    assert.equal(created.status, 201, created.text);

    const list = await api('GET', '/condition-types', { token: f.token });
    const t = list.body.types.find((x) => x.code === sick.code);
    assert.ok(t, 'the farm sees the new sickness');
    assert.equal(t.treatment.medicine, 'O2M');
    assert.equal(t.treatment.days, 3);
  });

  test('a farm that signs up later is born with the catalogue', async () => {
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Wet tail');
    await api('POST', '/admin/sicknesses', {
      token: admin.token,
      body: { code: sick.code, name: sick.name, medicine: 'Neblon', days: 2 } });

    const newcomer = await signupFarm();
    const list = await api('GET', '/condition-types', { token: newcomer.token });
    const t = list.body.types.find((x) => x.code === sick.code);
    assert.ok(t, 'new farms inherit the catalogue at signup');
    assert.equal(t.treatment.medicine, 'Neblon');
  });

  test('neither the farmer nor their staff can touch the catalogue', async () => {
    const f = await signupFarm();
    // The owner: the endpoint simply does not exist on the farm API.
    const owner = await api('POST', '/condition-types', {
      token: f.token, body: { name: 'Made up' } });
    assert.ok([404, 405].includes(owner.status), owner.text);

    // A support admin is not a superadmin either.
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
      body: { code: sick.code, name: sick.name, medicine: 'O2M', days: 2,
              dose_note: '1 bottle within 24 hours' } });

    const reported = await api('POST', '/conditions', {
      token: f.token, body: { rabbit_id: id, code: sick.code } });
    assert.equal(reported.status, 201, reported.text);
    // Whoever reported it is told what to give, right in the response.
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

  test('a recorded dose survives the sickness ending', async () => {
    const f = await signupFarm();
    const id = await rabbit(f);
    const admin = await makeAdmin('superadmin');
    const sick = uniqueSickness('Colic');
    await api('POST', '/admin/sicknesses', {
      token: admin.token,
      body: { code: sick.code, name: sick.name, medicine: 'Neblon', days: 2 } });
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
});

/**
 * The catalogue is the master copy and the superadmin is its only curator —
 * so pressing it onto a farm is meant to overwrite. What it must not do is
 * overwrite with values nobody chose.
 *
 * Two fields do exactly that. `reminder_interval_hours` is optional on the
 * form, and a blank one used to be written straight through, turning a
 * sickness that was checked every two hours into one with no reminder at all.
 * `blocks_breeding` is worse: the form never shows it, the column defaults to
 * true, so every catalogue row silently carries "this stops her breeding" —
 * and pressing one onto a farm whose sore hocks deliberately did not block
 * breeding takes those does out of the mating queue with nothing said.
 *
 * Tested with a code of this run's own rather than a real built-in: the
 * catalogue is platform-wide, and a test that put `loose_motion` in it would
 * be changing every other farm in the database mid-run.
 */
describe('pressing the catalogue onto a farm', () => {
  test('a blank field leaves the farm\'s own value alone', async () => {
    const f = await signupFarm();
    const sick = uniqueSickness('Snuffles');

    // A sickness this farm already has, with values somebody chose: checked
    // every two hours, and explicitly not a bar to breeding.
    await adminQuery(
      `INSERT INTO condition_type
         (farm_id, code, name, colour, reminder_interval_hours,
          blocks_breeding, is_contagious, escalate_after_hours, respect_quiet_hours)
       VALUES ($1, $2, $3, '#EA580C', 2, false, false, 24, true)`,
      [f.farm.id, sick.code, sick.name]);

    // The superadmin adds the same sickness, filling in only name and medicine.
    const created = await api('POST', '/admin/sicknesses', {
      token: (await makeAdmin('superadmin')).token,
      body: { code: sick.code, name: sick.name, medicine: 'Neblon', days: 2 },
    });
    assert.equal(created.status, 201, created.text);

    const { rows } = await adminQuery(
      `SELECT reminder_interval_hours, blocks_breeding, escalate_after_hours
         FROM condition_type WHERE farm_id = $1 AND code = $2`, [f.farm.id, sick.code]);

    assert.equal(Number(rows[0].reminder_interval_hours), 2,
      'a blank reminder box must not silence a two-hourly check');
    assert.equal(rows[0].blocks_breeding, false,
      'a field the form never shows must not decide whether she can breed');
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
              is_contagious: true },
    });
    assert.equal(created.status, 201, created.text);

    const { rows } = await adminQuery(
      `SELECT reminder_interval_hours, is_contagious
         FROM condition_type WHERE farm_id = $1 AND code = $2`, [f.farm.id, sick.code]);
    assert.equal(Number(rows[0].reminder_interval_hours), 8,
      'the curator asked for eight hours, so it is eight hours');
    assert.equal(rows[0].is_contagious, true);
  });
});
