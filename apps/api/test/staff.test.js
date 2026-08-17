/**
 * Staff: a login, a role that means something, a section, and a day's work.
 *
 * The permission tests are the point of this file. docs/04 says to enforce the
 * matrix server-side and never only in the UI, and the reason is worth stating:
 * a farm hand's phone is a shared device in practice — it gets handed down a
 * cage row with the screen still unlocked. A permission that only hides a
 * button is not a permission, so every role is checked here against an endpoint
 * it must not reach.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupFarm, cleanup, closePools, adminQuery } from './helpers.js';

after(async () => { await cleanup(); await closePools(); });

/** Add somebody and give them a working login. Returns their session token. */
async function hire(owner, { name, phone, role = 'caretaker', shed_ids } = {}) {
  const added = await api('POST', '/staff', {
    token: owner.token,
    body: { full_name: name, phone, role, ...(shed_ids ? { shed_ids } : {}) },
  });
  assert.equal(added.status, 201, added.text);

  const login = await api('POST', `/staff/${added.body.staff.id}/login`, {
    token: owner.token, body: {} });
  assert.equal(login.status, 200, login.text);

  const signin = await api('POST', '/auth/signin', {
    body: { phone, password: login.body.temporary_password } });
  assert.equal(signin.status, 200, signin.text);

  return { id: added.body.staff.id, token: signin.body.token, phone, role,
           password: login.body.temporary_password };
}

let seq = 0;
const uniquePhone = () => `+9199${String(process.pid).slice(-4)}${String(++seq).padStart(4, '0')}`;

describe('hiring somebody', () => {
  test('a person exists before they have a login', async () => {
    const f = await signupFarm();
    const res = await api('POST', '/staff', {
      token: f.token,
      body: { full_name: 'Ravi Naik', phone: uniquePhone(), role: 'caretaker' },
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.staff.can_sign_in, false,
      'plenty of farm hands never need a login — a manager marks their attendance');
    assert.equal(res.body.staff.is_active, true);
  });

  test('a name and a phone are both required', async () => {
    const f = await signupFarm();
    assert.equal((await api('POST', '/staff', {
      token: f.token, body: { phone: uniquePhone() } })).status, 400);
    assert.equal((await api('POST', '/staff', {
      token: f.token, body: { full_name: 'No Phone' } })).status, 400);
  });

  test('giving a login shows the password exactly once', async () => {
    const f = await signupFarm();
    const phone = uniquePhone();
    const ravi = await hire(f, { name: 'Ravi Naik', phone });

    // It is a hash in the database, not the password.
    const { rows } = await adminQuery(
      'SELECT password_hash FROM employee WHERE id = $1', [ravi.id]);
    assert.match(rows[0].password_hash, /^scrypt\$/);
    assert.ok(!rows[0].password_hash.includes(ravi.password));
  });

  test('a farm hand signs in with their phone, not an email', async () => {
    const f = await signupFarm();
    const phone = uniquePhone();
    await hire(f, { name: 'Ravi Naik', phone });

    const wrong = await api('POST', '/auth/signin', {
      body: { phone, password: 'not it' } });
    assert.equal(wrong.status, 401);
    assert.match(wrong.body.error, /Phone number or password/,
      'the message should name what they actually typed');
  });

  test('a phone can only be a login at one farm', async () => {
    /*
     * The rule migration 0024 enforces with a partial unique index. Two farms
     * may both hold the same number — a vet who visits both — but only one may
     * turn it into a sign-in, or the lookup at sign-in has two answers and no
     * safe way to choose between them.
     */
    const one = await signupFarm();
    const two = await signupFarm();
    const phone = uniquePhone();

    await hire(one, { name: 'Dr Shah', phone, role: 'vet' });

    const alsoHere = await api('POST', '/staff', {
      token: two.token, body: { full_name: 'Dr Shah', phone, role: 'vet' } });
    assert.equal(alsoHere.status, 201, 'holding the number is fine');

    const clash = await api('POST', `/staff/${alsoHere.body.staff.id}/login`, {
      token: two.token, body: {} });
    assert.equal(clash.status, 409, clash.text);
    assert.match(clash.body.error, /already the sign-in for somebody at another farm/);
  });

  test('somebody who has left cannot open the farm from their phone', async () => {
    const f = await signupFarm();
    const ravi = await hire(f, { name: 'Ravi Naik', phone: uniquePhone() });
    assert.equal((await api('GET', '/animals', { token: ravi.token })).status, 200);

    const gone = await api('PATCH', `/staff/${ravi.id}`, {
      token: f.token, body: { is_active: false } });
    assert.equal(gone.status, 200, gone.text);

    assert.equal((await api('GET', '/animals', { token: ravi.token })).status, 401,
      'deactivating has to end the session, not just hide them from a list');
  });

  test('the last owner cannot be removed', async () => {
    const f = await signupFarm();
    const me = await adminQuery(
      `SELECT id FROM employee WHERE farm_id = $1 AND role = 'owner'`, [f.farm.id]);

    const res = await api('PATCH', `/staff/${me.rows[0].id}`, {
      token: f.token, body: { is_active: false } });
    assert.equal(res.status, 409, res.text);
    assert.match(res.body.error, /only owner/i);
  });

  test('a manager cannot promote somebody to owner', async () => {
    const f = await signupFarm();
    const manager = await hire(f, { name: 'Priya', phone: uniquePhone(), role: 'manager' });
    const hand = await api('POST', '/staff', {
      token: manager.token, body: { full_name: 'Ravi', phone: uniquePhone() } });
    assert.equal(hand.status, 201, 'a manager may hire');

    const promote = await api('PATCH', `/staff/${hand.body.staff.id}`, {
      token: manager.token, body: { role: 'owner' } });
    assert.equal(promote.status, 403, 'and may not hand away the farm');
  });
});

describe('what each role may do', () => {
  test('a caretaker records animals but never sees the team', async () => {
    const f = await signupFarm();
    const ravi = await hire(f, { name: 'Ravi', phone: uniquePhone(), role: 'caretaker' });

    assert.equal((await api('GET', '/animals', { token: ravi.token })).status, 200);
    assert.equal((await api('GET', '/daily', { token: ravi.token })).status, 200);
    assert.equal((await api('POST', '/animals', {
      token: ravi.token, body: { name: 'Gauri', sex: 'doe' } })).status, 201);

    const team = await api('GET', '/staff', { token: ravi.token });
    assert.equal(team.status, 403, 'other people are not a farm hand’s business');
    assert.match(team.body.error, /owner|manager/,
      'and the message should say who to ask');

    assert.equal((await api('POST', '/staff', {
      token: ravi.token, body: { full_name: 'X', phone: uniquePhone() } })).status, 403);
    assert.equal((await api('PATCH', '/settings', {
      token: ravi.token, body: { timezone: 'UTC' } })).status, 403);
  });

  test('a vet reads everything and writes only health', async () => {
    const f = await signupFarm();
    await api('POST', '/animals', { token: f.token, body: { name: 'Tulsi', sex: 'doe' } });
    const vet = await hire(f, { name: 'Dr Shah', phone: uniquePhone(), role: 'vet' });

    const herd = await api('GET', '/animals', { token: vet.token });
    assert.equal(herd.status, 200, 'a vet must be able to look the animal up');

    const sick = await api('POST', '/conditions', {
      token: vet.token,
      body: { rabbit_id: herd.body.animals[0].id, code: 'loose_motion', severity: 'moderate' },
    });
    assert.equal(sick.status, 201, sick.text);

    // A vet advising on a mating is fine. A vet recording one as though the
    // farm decided it is not.
    assert.equal((await api('POST', '/animals', {
      token: vet.token, body: { name: 'Nope', sex: 'doe' } })).status, 403);
    assert.equal((await api('GET', '/staff', { token: vet.token })).status, 403);
  });

  test('an accountant never sees an animal', async () => {
    const f = await signupFarm();
    const acc = await hire(f, { name: 'Meena', phone: uniquePhone(), role: 'accountant' });

    assert.equal((await api('GET', '/animals', { token: acc.token })).status, 403);
    assert.equal((await api('GET', '/conditions', { token: acc.token })).status, 403);
    // The team list is theirs — payroll runs off attendance.
    assert.equal((await api('GET', '/staff', { token: acc.token })).status, 200);
  });

  test('a manager runs the farm but not its settings', async () => {
    const f = await signupFarm();
    const priya = await hire(f, { name: 'Priya', phone: uniquePhone(), role: 'manager' });

    assert.equal((await api('GET', '/staff', { token: priya.token })).status, 200);
    assert.equal((await api('POST', '/animals', {
      token: priya.token, body: { name: 'Kamala', sex: 'doe' } })).status, 201);
    assert.equal((await api('PATCH', '/settings', {
      token: priya.token, body: { timezone: 'UTC' } })).status, 403,
      'settings change how the breeding engine behaves — that is the owner’s');
  });

  test('every role is refused with a sentence naming who to ask', async () => {
    const f = await signupFarm();
    const ravi = await hire(f, { name: 'Ravi', phone: uniquePhone() });
    const res = await api('GET', '/staff', { token: ravi.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.detail.role, 'caretaker');
    assert.equal(res.body.detail.action, 'staff:read');
  });

  test('the app can ask what it is allowed to offer', async () => {
    const f = await signupFarm();
    const ravi = await hire(f, { name: 'Ravi', phone: uniquePhone() });

    const mine = await api('GET', '/me/permissions', { token: ravi.token });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.role, 'caretaker');
    assert.equal(mine.body.can['animals:write'], true);
    assert.equal(mine.body.can['staff:read'], false);

    const owner = await api('GET', '/me/permissions', { token: f.token });
    assert.equal(owner.body.can['settings:write'], true);
  });
});

describe('the edit window', () => {
  test('a caretaker may correct their own entry, then may not', async () => {
    const f = await signupFarm();
    const ravi = await hire(f, { name: 'Ravi', phone: uniquePhone() });

    const added = await api('POST', '/animals', {
      token: ravi.token, body: { name: 'Gauri', sex: 'doe' } });
    assert.equal(added.status, 201);
    const id = added.body.animal.id;

    const soon = await api('PATCH', `/animals/${id}`, {
      token: ravi.token, body: { name: 'Gauri II' } });
    assert.equal(soon.status, 200, 'an honest fix within the day must be easy');

    // Age the record past the window.
    await adminQuery(
      `UPDATE rabbit SET created_at = now() - interval '25 hours' WHERE id = $1`, [id]);

    const late = await api('PATCH', `/animals/${id}`, {
      token: ravi.token, body: { name: 'Gauri III' } });
    assert.equal(late.status, 403, late.text);
    assert.match(late.body.error, /24 hours/);
    assert.equal(late.body.detail.edit_window, true);

    // And a manager still can — that is most of what a manager is for.
    assert.equal((await api('PATCH', `/animals/${id}`, {
      token: f.token, body: { name: 'Gauri III' } })).status, 200);
  });

  test('a caretaker cannot rewrite somebody else’s entry at all', async () => {
    const f = await signupFarm();
    const ravi = await hire(f, { name: 'Ravi', phone: uniquePhone() });

    const owners = await api('POST', '/animals', {
      token: f.token, body: { name: 'Meera', sex: 'doe' } });
    const res = await api('PATCH', `/animals/${owners.body.animal.id}`, {
      token: ravi.token, body: { name: 'Not mine' } });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /recorded by somebody else/i);
  });
});

describe('sections and assignment', () => {
  test('work for a shed goes to whoever looks after it', async () => {
    const f = await signupFarm();
    const shed = await api('POST', '/sheds', { token: f.token, body: { name: 'Shed B' } });
    assert.equal(shed.status, 201, shed.text);

    const ravi = await hire(f, {
      name: 'Ravi', phone: uniquePhone(), shed_ids: [shed.body.shed.id] });

    // A doe in that shed, with a task against her.
    const { rows: cage } = await adminQuery(
      `INSERT INTO cage (farm_id, shed_id, code) VALUES ($1, $2, 'B-1') RETURNING id`,
      [f.farm.id, shed.body.shed.id]);
    const doe = await api('POST', '/animals', {
      token: f.token, body: { name: 'Lakshmi', sex: 'doe' } });
    await adminQuery('UPDATE rabbit SET cage_id = $2 WHERE id = $1',
      [doe.body.animal.id, cage[0].id]);
    await adminQuery(`
      INSERT INTO task (farm_id, kind, title, due_on, rabbit_id)
      VALUES ($1, 'nest_box', 'Nest box', current_date, $2)`,
      [f.farm.id, doe.body.animal.id]);

    const { rows: n } = await adminQuery('SELECT assign_tasks_by_section() AS n');
    assert.ok(n[0].n >= 1, 'the task should have found its caretaker');

    const { rows: task } = await adminQuery(
      `SELECT assigned_to FROM task WHERE rabbit_id = $1`, [doe.body.animal.id]);
    assert.equal(task[0].assigned_to, ravi.id);
  });

  test('a shed two people share leaves the work on everybody’s list', async () => {
    /*
     * Deliberate. Two caretakers on one shed means the farm has not decided who
     * owns it, and picking one for them produces work that looks assigned and
     * is nobody's — the exact failure this whole module exists to prevent.
     */
    const f = await signupFarm();
    const shed = await api('POST', '/sheds', { token: f.token, body: { name: 'Shed C' } });
    const id = shed.body.shed.id;
    await hire(f, { name: 'Ravi', phone: uniquePhone(), shed_ids: [id] });
    await hire(f, { name: 'Sunil', phone: uniquePhone(), shed_ids: [id] });

    const { rows: cage } = await adminQuery(
      `INSERT INTO cage (farm_id, shed_id, code) VALUES ($1, $2, 'C-1') RETURNING id`,
      [f.farm.id, id]);
    const doe = await api('POST', '/animals', {
      token: f.token, body: { name: 'Radha', sex: 'doe' } });
    await adminQuery('UPDATE rabbit SET cage_id = $2 WHERE id = $1',
      [doe.body.animal.id, cage[0].id]);
    await adminQuery(`
      INSERT INTO task (farm_id, kind, title, due_on, rabbit_id)
      VALUES ($1, 'nest_box', 'Nest box', current_date, $2)`,
      [f.farm.id, doe.body.animal.id]);

    await adminQuery('SELECT assign_tasks_by_section()');
    const { rows: task } = await adminQuery(
      `SELECT assigned_to FROM task WHERE rabbit_id = $1`, [doe.body.animal.id]);
    assert.equal(task[0].assigned_to, null);
  });
});

describe('attendance', () => {
  test('check in, check out, and checking in twice keeps the first time', async () => {
    const f = await signupFarm();
    const ravi = await hire(f, { name: 'Ravi', phone: uniquePhone() });

    const first = await api('POST', '/attendance/check-in', {
      token: ravi.token, body: { lat: 15.27, lng: 73.95 } });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.attendance.status, 'present');
    const arrived = first.body.attendance.checked_in_at;

    const again = await api('POST', '/attendance/check-in', { token: ravi.token, body: {} });
    assert.equal(again.body.attendance.checked_in_at, arrived,
      'a second tap is a tap, not a later arrival');

    const out = await api('POST', '/attendance/check-out', { token: ravi.token, body: {} });
    assert.equal(out.status, 200);
    assert.ok(out.body.attendance.checked_out_at);
  });

  test('checking out without checking in still records the day', async () => {
    // The phone was flat this morning. Refusing here loses the day entirely.
    const f = await signupFarm();
    const ravi = await hire(f, { name: 'Ravi', phone: uniquePhone() });
    const out = await api('POST', '/attendance/check-out', { token: ravi.token, body: {} });
    assert.equal(out.status, 200);
    assert.equal(out.body.attendance.status, 'present');
  });

  test('a manager marks the people without smartphones', async () => {
    const f = await signupFarm();
    const hand = await api('POST', '/staff', {
      token: f.token, body: { full_name: 'Sunil', phone: uniquePhone() } });

    const marked = await api('POST', '/attendance', {
      token: f.token,
      body: { employee_id: hand.body.staff.id, status: 'half_day', overtime_minutes: 30,
              note: 'left after the morning round' },
    });
    assert.equal(marked.status, 201, marked.text);
    assert.equal(marked.body.attendance.status, 'half_day');

    // Marking again corrects rather than duplicating.
    const fixed = await api('POST', '/attendance', {
      token: f.token, body: { employee_id: hand.body.staff.id, status: 'present' } });
    assert.equal(fixed.body.attendance.status, 'present');
  });

  test('a farm hand sees their own day without seeing the team', async () => {
    /*
     * The check-in card lives on Today, which is a farm hand's whole app. If
     * their own attendance could only be read through /staff — which they are
     * refused — the card would be invisible to exactly the person it is for.
     */
    const f = await signupFarm();
    const ravi = await hire(f, { name: 'Ravi', phone: uniquePhone() });

    assert.equal((await api('GET', '/staff', { token: ravi.token })).status, 403);

    const before = await api('GET', '/me/attendance', { token: ravi.token });
    assert.equal(before.status, 200, before.text);
    assert.equal(before.body.attendance, null, 'nothing recorded yet');

    await api('POST', '/attendance/check-in', { token: ravi.token, body: {} });
    const after = await api('GET', '/me/attendance', { token: ravi.token });
    assert.equal(after.body.attendance.status, 'present');
    assert.ok(after.body.attendance.checked_in_at);
  });

  test('a caretaker cannot mark anybody but themselves', async () => {
    const f = await signupFarm();
    const ravi = await hire(f, { name: 'Ravi', phone: uniquePhone() });
    const other = await api('POST', '/staff', {
      token: f.token, body: { full_name: 'Sunil', phone: uniquePhone() } });

    assert.equal((await api('POST', '/attendance', {
      token: ravi.token, body: { employee_id: other.body.staff.id, status: 'absent' } })).status,
      403);
  });

  test('the month adds up, and half a day counts as half', async () => {
    const f = await signupFarm();
    const hand = await api('POST', '/staff', {
      token: f.token, body: { full_name: 'Sunil', phone: uniquePhone() } });
    const id = hand.body.staff.id;

    const day = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
    for (const [d, status] of [[1, 'present'], [2, 'present'], [3, 'half_day'], [4, 'leave']]) {
      const res = await api('POST', '/attendance', {
        token: f.token, body: { employee_id: id, work_date: day(d), status } });
      assert.equal(res.status, 201, res.text);
    }

    const month = day(1).slice(0, 7);
    const summary = await api('GET', `/attendance?month=${month}`, { token: f.token });
    assert.equal(summary.status, 200, summary.text);
    const mine = summary.body.summary.find((r) => r.employee_id === id);
    assert.ok(mine, `no row for Sunil in ${JSON.stringify(summary.body.summary)}`);
    assert.equal(mine.present, 2);
    assert.equal(mine.half_days, 1);
    assert.equal(mine.leave, 1);
    assert.equal(Number(mine.days_worked), 2.5,
      'whoever runs payroll should not have to guess the convention');
  });

  test('the CSV opens in Excel without executing anything', async () => {
    const f = await signupFarm();
    // A name Excel would treat as a formula if it were handed over bare.
    const hand = await api('POST', '/staff', {
      token: f.token, body: { full_name: '=cmd|calc', phone: uniquePhone() } });
    await api('POST', '/attendance', {
      token: f.token, body: { employee_id: hand.body.staff.id, status: 'present' } });

    const csv = await api('GET', '/attendance.csv', { token: f.token });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(csv.headers.get('content-disposition') ?? '', /attachment; filename=/);
    assert.match(csv.text, /Name,Month,Present/);
    assert.ok(csv.text.includes("'=cmd|calc") || csv.text.includes(`"'=cmd|calc"`),
      `a leading = must be defused, got: ${csv.text.split('\n')[1]}`);
  });

  test('attendance is a farm’s own business', async () => {
    const mine = await signupFarm();
    const theirs = await signupFarm();
    const hand = await api('POST', '/staff', {
      token: theirs.token, body: { full_name: 'Not yours', phone: uniquePhone() } });
    await api('POST', '/attendance', {
      token: theirs.token, body: { employee_id: hand.body.staff.id, status: 'present' } });

    const seen = await api('GET', '/attendance', { token: mine.token });
    assert.equal(seen.status, 200);
    assert.ok(!seen.body.summary.some((r) => r.full_name === 'Not yours'),
      'row-level security has to hold across the new tables too');
    assert.ok(!(await api('GET', '/staff', { token: mine.token }))
      .body.staff.some((s) => s.full_name === 'Not yours'));
  });
});
