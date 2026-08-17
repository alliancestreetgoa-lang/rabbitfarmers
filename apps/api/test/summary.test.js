/**
 * GET /summary — the farm at a glance.
 *
 * The web dashboard opens on this, so the two claims worth testing are the two
 * it could get quietly wrong: a brand-new farm reads all zeros rather than
 * erroring on empty views, and kits are counted from litters rather than from
 * rabbit rows — a litter of eight with no individual kit rows yet must read as
 * eight, not zero.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupFarm, cleanup, closePools } from './helpers.js';

after(async () => { await cleanup(); await closePools(); });

describe('the farm at a glance', () => {
  test('a brand-new farm is all zeros, not an error', async () => {
    const f = await signupFarm();
    const res = await api('GET', '/summary', { token: f.token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.herd.total, 0);
    assert.equal(res.body.pregnant.total_pregnant, 0);
    assert.equal(res.body.ready.ready, 0);
    assert.equal(res.body.kits.unweaned, 0);
    assert.equal(res.body.today.open, 0);
    assert.equal(res.body.team.staff, 1, 'the owner counts as staff');
  });

  test('kits count from the litter, not from rabbit rows', async () => {
    const f = await signupFarm();
    const doe = await api('POST', '/animals', {
      token: f.token,
      body: { name: 'Lakshmi', sex: 'doe', date_of_birth: '2024-01-01' },
    });
    const buck = await api('POST', '/animals', {
      token: f.token,
      body: { name: 'Arjun', sex: 'buck', date_of_birth: '2024-01-01' },
    });
    await api('POST', '/matings', {
      token: f.token,
      body: { doe_id: doe.body.animal.id, buck_id: buck.body.animal.id,
              mated_at: '2026-07-01T06:00:00Z' },
    });
    const litter = await api('POST', '/litters', {
      token: f.token,
      body: { doe_id: doe.body.animal.id, kindled_on: '2026-08-01', born_alive: 8 },
    });
    assert.equal(litter.status, 201, litter.text);

    const res = await api('GET', '/summary', { token: f.token });
    assert.equal(res.body.herd.total, 2, 'two adults; no kit has a rabbit row');
    assert.equal(res.body.kits.unweaned, 8,
      'eight born alive and unweaned, none recorded individually — still eight');
    assert.equal(res.body.kits.litters_open, 1);
  });

  test('one farm’s summary is not another’s', async () => {
    const a = await signupFarm();
    const b = await signupFarm();
    await api('POST', '/animals', {
      token: a.token, body: { name: 'Mine', sex: 'doe' } });

    const theirs = await api('GET', '/summary', { token: b.token });
    assert.equal(theirs.body.herd.total, 0, 'farm B must not see farm A’s doe');
  });
});
