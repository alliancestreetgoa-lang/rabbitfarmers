import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupFarm, cleanup, closePools } from './helpers.js';

after(async () => { await cleanup(); await closePools(); });

/**
 * The herd is named the way a farm names it — F1, F2 … F10, M1, M2 — and it
 * must list that way. Plain text order puts F10 between F1 and F2, which is
 * the first thing anyone notices on the Herd page.
 */
describe('the herd lists in number order', () => {
  test('F1, F2, F10 — not F1, F10, F2', async () => {
    const f = await signupFarm();
    for (const [name, sex] of [['F10', 'doe'], ['M2', 'buck'], ['F1', 'doe'],
                               ['F 4', 'doe'], ['M10', 'buck'], ['F2', 'doe'], ['M1', 'buck']]) {
      const res = await api('POST', '/animals', { token: f.token, body: { name, sex } });
      assert.equal(res.status, 201, res.text);
    }
    const list = await api('GET', '/animals', { token: f.token });
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.animals.map((a) => a.tag),
      ['F1', 'F2', 'F 4', 'F10', 'M1', 'M2', 'M10']);
  });
});
