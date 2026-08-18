import { Hono } from 'hono';
import { requireAuth, requireWriteAccess } from '../middleware.js';
import { requireCan, requireInline, can } from '../permissions.js';
import { HttpError, hashPassword, newSessionToken } from '../auth.js';
import { payslipPdf } from '../pdf.js';

export const staffRoutes = new Hono();
staffRoutes.use('*', requireAuth);

const write = requireWriteAccess;

/* ------------------------------------------------------------------ sheds -- */

/**
 * Sheds exist so work can be assigned. A farm with one shed never needs to see
 * this; a farm with four needs it before staff mean anything, because "who
 * looks after this row" is the whole basis of automatic assignment.
 */
staffRoutes.get('/sheds', requireCan('animals:read'), async (c) => {
  const db = c.get('db');
  const rows = await db(async (client) => {
    const { rows } = await client.query(`
      SELECT s.id, s.name,
             (SELECT count(*)::int FROM cage c WHERE c.shed_id = s.id) AS cages,
             (SELECT count(*)::int FROM rabbit r
                JOIN cage c ON c.id = r.cage_id
               WHERE c.shed_id = s.id AND r.status = 'active')          AS animals,
             COALESCE((SELECT array_agg(e.full_name ORDER BY e.full_name)
                       FROM employee_section es
                       JOIN employee e ON e.id = es.employee_id AND e.is_active
                      WHERE es.shed_id = s.id), ARRAY[]::text[])        AS caretakers
      FROM shed s ORDER BY s.name`);
    return rows;
  });
  return c.json({ sheds: rows });
});

staffRoutes.post('/sheds', write, requireCan('staff:write'), async (c) => {
  const b = await c.req.json();
  const name = String(b.name ?? '').trim();
  if (!name) throw new HttpError(400, 'A shed needs a name', { field: 'name' });

  const db = c.get('db');
  const row = await db(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO shed (farm_id, name) VALUES (current_farm_id(), $1) RETURNING id, name`,
      [name]);
    return rows[0];
  });
  return c.json({ shed: row }, 201);
});

/* ------------------------------------------------------------------ staff -- */

const EMPLOYMENT = ['permanent', 'daily_wage', 'piece_rate', 'contract'];
const ROLES = ['owner', 'manager', 'caretaker', 'vet', 'accountant'];

/** GET /staff — the team, who is in today, and what is on their list. */
staffRoutes.get('/staff', requireCan('staff:read'), async (c) => {
  const db = c.get('db');
  const include = c.req.query('include') ?? 'active';
  // The salary column rides along only for whoever manages payroll. A manager
  // reads the team; what each person is paid is between them and the owner.
  const seesPay = can(c.get('session'), 'payroll:manage');
  const rows = await db(async (client) => {
    const { rows } = await client.query(`
      SELECT s.*, CASE WHEN $2 THEN cs.monthly_amount END AS monthly_salary
      FROM v_staff s
      LEFT JOIN v_current_salary cs ON cs.employee_id = s.id
       WHERE ($1 = 'all') OR ($1 = 'active' AND s.is_active)
          OR ($1 = 'past' AND NOT s.is_active)
       ORDER BY s.is_active DESC, s.full_name`, [include, seesPay]);
    return rows;
  });
  return c.json({ staff: rows });
});

/**
 * POST /staff — add a person.
 *
 * No password here. Somebody exists on the farm before they have a login, and
 * plenty of people never need one — a daily-wage hand whose attendance a
 * manager marks, or a vet who visits. Giving a login is a separate, deliberate
 * act: POST /staff/:id/login.
 */
staffRoutes.post('/staff', write, requireCan('staff:write'), async (c) => {
  const b = await c.req.json();
  const session = c.get('session');

  const full_name = String(b.full_name ?? '').trim();
  const phone = String(b.phone ?? '').trim();
  if (!full_name) throw new HttpError(400, 'A name is required', { field: 'full_name' });
  if (!phone) {
    throw new HttpError(400, 'A phone number is required — it is how they sign in',
      { field: 'phone' });
  }

  const role = b.role ?? 'caretaker';
  if (!ROLES.includes(role)) throw new HttpError(400, `Role must be one of ${ROLES.join(', ')}`, { field: 'role' });
  // Only an owner can make another owner. A manager promoting somebody past
  // themselves is how a farm loses control of its own account.
  if (role === 'owner' && session.role !== 'owner') {
    throw new HttpError(403, 'Only the owner can add another owner', { field: 'role' });
  }
  const employment_type = b.employment_type ?? 'permanent';
  if (!EMPLOYMENT.includes(employment_type)) {
    throw new HttpError(400, `Employment type must be one of ${EMPLOYMENT.join(', ')}`,
      { field: 'employment_type' });
  }

  // Salary is set at hire when the owner adds somebody — one form, not two
  // trips. Anybody else adding staff cannot smuggle a salary past the owner.
  let salary = null;
  if (b.monthly_salary !== undefined && b.monthly_salary !== null && b.monthly_salary !== '') {
    requireInline(session, 'payroll:manage');
    salary = Number(b.monthly_salary);
    if (!Number.isFinite(salary) || salary < 0) {
      throw new HttpError(400, 'Monthly salary should be a number of rupees',
        { field: 'monthly_salary' });
    }
  }

  const db = c.get('db');
  const row = await db(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO employee (farm_id, full_name, phone, email, role, employment_type,
                            joined_on, language, can_palpate, created_by)
      VALUES (current_farm_id(), $1, $2, NULLIF($3,'')::citext, $4::employee_role_t,
              $5::employment_type_t, COALESCE($6::date, farm_today(current_farm_id())),
              COALESCE($7,'en'), COALESCE($8,false), $9)
      RETURNING id, joined_on`,
      [full_name, phone, String(b.email ?? '').trim().toLowerCase(), role, employment_type,
       b.joined_on ?? null, b.language ?? null, b.can_palpate ?? null, session.employeeId]);

    if (salary !== null) {
      await client.query(`
        INSERT INTO staff_salary (farm_id, employee_id, monthly_amount, effective_from, set_by)
        VALUES (current_farm_id(), $1, $2,
                COALESCE($3::date, farm_today(current_farm_id())), $4)`,
        [rows[0].id, salary, rows[0].joined_on, session.employeeId]);
    }

    if (Array.isArray(b.shed_ids) && b.shed_ids.length) {
      await setSections(client, rows[0].id, b.shed_ids);
    }
    const { rows: staff } = await client.query('SELECT * FROM v_staff WHERE id = $1', [rows[0].id]);
    return staff[0];
  });

  return c.json({ staff: row }, 201);
});

const EDITABLE = ['full_name', 'phone', 'email', 'role', 'employment_type',
                  'joined_on', 'language', 'can_palpate', 'is_active'];

/** PATCH /staff/:id — edit, including deactivating. Never deleting. */
staffRoutes.patch('/staff/:id', write, requireCan('staff:write'), async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const session = c.get('session');

  const sets = [];
  const params = [id];
  for (const key of EDITABLE) {
    if (!(key in b)) continue;
    if (key === 'role') {
      if (!ROLES.includes(b.role)) throw new HttpError(400, `Role must be one of ${ROLES.join(', ')}`, { field: 'role' });
      if (b.role === 'owner' && session.role !== 'owner') {
        throw new HttpError(403, 'Only the owner can make somebody an owner', { field: 'role' });
      }
    }
    if (key === 'employment_type' && !EMPLOYMENT.includes(b.employment_type)) {
      throw new HttpError(400, `Employment type must be one of ${EMPLOYMENT.join(', ')}`,
        { field: 'employment_type' });
    }
    params.push(b[key] === '' ? null : b[key]);
    const cast = key === 'role' ? '::employee_role_t'
      : key === 'employment_type' ? '::employment_type_t'
      : key === 'email' ? '::citext'
      : key === 'joined_on' ? '::date' : '';
    sets.push(`${key} = $${params.length}${cast}`);
  }

  const db = c.get('db');
  const row = await db(async (client) => {
    // Locking yourself out of your own farm is not an edit anybody means to
    // make, and there is nobody left to undo it.
    if (b.is_active === false || (b.role && b.role !== 'owner')) {
      const { rows: self } = await client.query(
        `SELECT role FROM employee WHERE id = $1`, [id]);
      if (self[0]?.role === 'owner') {
        const { rows: owners } = await client.query(
          `SELECT count(*)::int AS n FROM employee WHERE role = 'owner' AND is_active`);
        if (owners[0].n <= 1) {
          throw new HttpError(409,
            'This is the farm’s only owner. Make somebody else an owner first.');
        }
      }
    }

    if (sets.length) {
      const { rowCount } = await client.query(
        `UPDATE employee SET ${sets.join(', ')} WHERE id = $1`, params);
      if (!rowCount) throw new HttpError(404, 'No such person on this farm');
    }

    if (Array.isArray(b.shed_ids)) await setSections(client, id, b.shed_ids);

    // Deactivating ends their sessions. Somebody who has left the farm must
    // stop being able to open it from the phone in their pocket.
    if (b.is_active === false) {
      await client.query(
        `UPDATE user_session SET revoked_at = now(), revoked_reason = 'left the farm'
          WHERE employee_id = $1 AND revoked_at IS NULL`, [id]);
    }

    const { rows } = await client.query('SELECT * FROM v_staff WHERE id = $1', [id]);
    if (!rows.length) throw new HttpError(404, 'No such person on this farm');
    return rows[0];
  });

  return c.json({ staff: row });
});

/** Replace somebody's sheds wholesale — the screen sends the full set. */
async function setSections(client, employeeId, shedIds) {
  await client.query('DELETE FROM employee_section WHERE employee_id = $1', [employeeId]);
  if (!shedIds.length) return;
  await client.query(`
    INSERT INTO employee_section (employee_id, shed_id)
    SELECT $1, s.id FROM shed s WHERE s.id = ANY($2::uuid[])`,
    [employeeId, shedIds]);
}

/**
 * POST /staff/:id/login — let this person sign in, or reset them.
 *
 * The password is generated and shown exactly once. A manager choosing one
 * picks the same weak thing every time, and a farm hand who cannot read it back
 * off the screen will have it written on the shed wall by Friday either way —
 * so it is short enough to say out loud and read back, and they can change it
 * from More once they are in.
 */
staffRoutes.post('/staff/:id/login', write, requireCan('staff:write'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('db');

  const person = await db(async (client) => {
    const { rows } = await client.query(
      `SELECT id, full_name, phone, is_active FROM employee WHERE id = $1`, [id]);
    return rows[0];
  });
  if (!person) throw new HttpError(404, 'No such person on this farm');
  if (!person.is_active) {
    throw new HttpError(409, 'That person has left the farm. Make them active again first.');
  }

  const temporary = newSessionToken().token.slice(0, 10);

  try {
    await db(async (client) => {
      await client.query(
        `UPDATE employee SET password_hash = $2, password_changed_at = now() WHERE id = $1`,
        [id, await hashPassword(temporary)]);
    });
  } catch (err) {
    // The partial unique index from migration 0024. Somebody works at one farm;
    // this is the moment that rule is enforced, and the message has to say what
    // to do rather than name an index.
    if (err.code === '23505') {
      throw new HttpError(409,
        `${person.phone} is already the sign-in for somebody at another farm. `
        + 'A phone number can only be a login in one place — use a different number.',
        { field: 'phone' });
    }
    throw err;
  }

  return c.json({
    staff: { id: person.id, full_name: person.full_name, phone: person.phone },
    temporary_password: temporary,
    message: `${person.full_name} signs in with their phone number, ${person.phone}, `
      + 'and this password. Read it to them once — it is not shown again.',
  });
});

/* --------------------------------------------------------------- salaries -- */

/**
 * Pay for one person and one month, straight from the attendance record.
 *
 * The convention, printed on every slip so nobody has to trust the arithmetic:
 * paid days = present + half days at half + farm holidays; absence and leave
 * are unpaid. Amount = monthly salary x paid days / days in the month. The
 * salary used is whichever was in force by the end of that month.
 */
async function monthPay(client, employeeId, month) {
  const { rows } = await client.query(`
    WITH bounds AS (
      SELECT ym, (ym || '-01')::date AS first_day,
             ((ym || '-01')::date + interval '1 month' - interval '1 day')::date AS last_day
      FROM (SELECT COALESCE($2, to_char(farm_today(current_farm_id()), 'YYYY-MM')) AS ym) m
    )
    SELECT b.ym                                             AS month,
           extract(day FROM b.last_day)::int                AS days_in_month,
           COALESCE(s.present, 0)                           AS present,
           COALESCE(s.half_days, 0)                         AS half_days,
           COALESCE(s.holiday, 0)                           AS holiday,
           COALESCE(s.absent, 0)                            AS absent,
           COALESCE(s.leave, 0)                             AS leave,
           sal.monthly_amount,
           (COALESCE(s.present, 0) + 0.5 * COALESCE(s.half_days, 0)
            + COALESCE(s.holiday, 0))::numeric(6,1)         AS paid_days,
           CASE WHEN sal.monthly_amount IS NULL THEN NULL
                ELSE round(sal.monthly_amount
                     * (COALESCE(s.present, 0) + 0.5 * COALESCE(s.half_days, 0)
                        + COALESCE(s.holiday, 0))
                     / extract(day FROM b.last_day), 2) END AS amount
    FROM bounds b
    LEFT JOIN v_attendance_summary s ON s.employee_id = $1 AND s.month = b.ym
    LEFT JOIN LATERAL (
      SELECT monthly_amount FROM staff_salary
      WHERE employee_id = $1 AND effective_from <= b.last_day
      ORDER BY effective_from DESC, created_at DESC LIMIT 1
    ) sal ON true`,
    [employeeId, month ?? null]);
  return rows[0];
}

/** POST /staff/:id/salary — set what this person is paid, from a date. */
staffRoutes.post('/staff/:id/salary', write, requireCan('payroll:manage'), async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const session = c.get('session');

  const amount = Number(b.monthly_salary ?? b.monthly_amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new HttpError(400, 'Monthly salary should be a number of rupees',
      { field: 'monthly_salary' });
  }

  const db = c.get('db');
  const row = await db(async (client) => {
    const { rows: person } = await client.query(
      'SELECT id FROM employee WHERE id = $1', [id]);
    if (!person.length) throw new HttpError(404, 'No such person on this farm');
    const { rows } = await client.query(`
      INSERT INTO staff_salary (farm_id, employee_id, monthly_amount, effective_from, set_by)
      VALUES (current_farm_id(), $1, $2,
              COALESCE($3::date, farm_today(current_farm_id())), $4)
      RETURNING id, monthly_amount, effective_from, created_at`,
      [id, amount, b.effective_from ?? null, session.employeeId]);
    return rows[0];
  });
  return c.json({ salary: row }, 201);
});

/**
 * GET /staff/:id/salary — everything the salary screen shows in one call:
 * who they are, what they are on now, every change ever made, and each month
 * since they joined with the attendance-computed amount.
 */
staffRoutes.get('/staff/:id/salary', requireCan('payroll:manage'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('db');
  const data = await db(async (client) => {
    const { rows: person } = await client.query(
      `SELECT id, full_name, phone, role, joined_on, is_active,
              (password_hash IS NOT NULL) AS can_sign_in
       FROM employee WHERE id = $1`, [id]);
    if (!person.length) throw new HttpError(404, 'No such person on this farm');

    const { rows: history } = await client.query(`
      SELECT ss.id, ss.monthly_amount, ss.effective_from, ss.created_at,
             e.full_name AS set_by_name
      FROM staff_salary ss LEFT JOIN employee e ON e.id = ss.set_by
      WHERE ss.employee_id = $1
      ORDER BY ss.effective_from DESC, ss.created_at DESC`, [id]);

    const { rows: months } = await client.query(`
      WITH span AS (
        SELECT date_trunc('month', LEAST(
                 COALESCE((SELECT min(work_date) FROM attendance WHERE employee_id = $1),
                          farm_today(current_farm_id())),
                 COALESCE((SELECT joined_on FROM employee WHERE id = $1),
                          farm_today(current_farm_id())),
                 COALESCE((SELECT min(effective_from) FROM staff_salary WHERE employee_id = $1),
                          farm_today(current_farm_id()))))::date AS a,
               date_trunc('month', farm_today(current_farm_id())::timestamp)::date AS b
      )
      SELECT to_char(gs, 'YYYY-MM')                                       AS month,
             extract(day FROM (gs + interval '1 month' - interval '1 day'))::int AS days_in_month,
             COALESCE(s.present, 0)   AS present,
             COALESCE(s.half_days, 0) AS half_days,
             COALESCE(s.holiday, 0)   AS holiday,
             COALESCE(s.absent, 0)    AS absent,
             COALESCE(s.leave, 0)     AS leave,
             sal.monthly_amount,
             (COALESCE(s.present, 0) + 0.5 * COALESCE(s.half_days, 0)
              + COALESCE(s.holiday, 0))::numeric(6,1)                     AS paid_days,
             CASE WHEN sal.monthly_amount IS NULL THEN NULL
                  ELSE round(sal.monthly_amount
                       * (COALESCE(s.present, 0) + 0.5 * COALESCE(s.half_days, 0)
                          + COALESCE(s.holiday, 0))
                       / extract(day FROM (gs + interval '1 month' - interval '1 day')), 2)
             END                                                          AS amount
      FROM span, generate_series(span.a, span.b, interval '1 month') gs
      LEFT JOIN v_attendance_summary s
             ON s.employee_id = $1 AND s.month = to_char(gs, 'YYYY-MM')
      LEFT JOIN LATERAL (
        SELECT monthly_amount FROM staff_salary
        WHERE employee_id = $1
          AND effective_from <= (gs + interval '1 month' - interval '1 day')::date
        ORDER BY effective_from DESC, created_at DESC LIMIT 1
      ) sal ON true
      ORDER BY month DESC`, [id]);

    return { person: person[0], current: history[0] ?? null, history, months };
  });
  return c.json(data);
});

/** GET /staff/:id/payslip?month=YYYY-MM — the month's slip, as a PDF. */
staffRoutes.get('/staff/:id/payslip', requireCan('payroll:manage'), async (c) => {
  const id = c.req.param('id');
  const month = c.req.query('month');
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    throw new HttpError(400, 'month should look like 2026-08', { field: 'month' });
  }

  const db = c.get('db');
  const { farm, person, pay } = await db(async (client) => {
    const { rows: farm } = await client.query(
      'SELECT name FROM farm WHERE id = current_farm_id()');
    const { rows: person } = await client.query(
      'SELECT full_name, phone, role FROM employee WHERE id = $1', [id]);
    if (!person.length) throw new HttpError(404, 'No such person on this farm');
    return { farm: farm[0], person: person[0], pay: await monthPay(client, id, month) };
  });

  if (pay.monthly_amount == null) {
    throw new HttpError(409,
      'No salary is set for this person yet. Set one on the Team page first.');
  }

  const slug = person.full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  c.header('content-type', 'application/pdf');
  c.header('content-disposition', `attachment; filename="payslip-${slug}-${pay.month}.pdf"`);
  return c.body(payslipPdf({ farmName: farm.name, person, pay }));
});

/* ------------------------------------------------------------- attendance -- */

const ATTENDANCE_STATUS = ['present', 'absent', 'leave', 'holiday', 'half_day'];

/**
 * POST /attendance/check-in — one tap, from the shed.
 *
 * No geofence and no QR yet; docs/04 lists them as options a farm picks, and
 * neither is worth building before anybody is using the plain version. The
 * coordinates are recorded when the phone offers them so that a farm which
 * later turns on a geofence has history to set it from.
 */
staffRoutes.post('/attendance/check-in', requireCan('attendance:self'), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const session = c.get('session');
  const db = c.get('db');
  const row = await db(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM attendance_check_in(current_farm_id(), $1, $2, $3)`,
      [session.employeeId, b.lat ?? null, b.lng ?? null]);
    return rows[0];
  });
  return c.json({ attendance: row });
});

staffRoutes.post('/attendance/check-out', requireCan('attendance:self'), async (c) => {
  const session = c.get('session');
  const db = c.get('db');
  const row = await db(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM attendance_check_out(current_farm_id(), $1)`, [session.employeeId]);
    return rows[0];
  });
  return c.json({ attendance: row });
});

/**
 * POST /attendance — a manager marking somebody.
 *
 * The fallback docs/04 calls for, and the common case on a real farm: half the
 * staff have no smartphone, and the manager marks the board in the morning.
 */
staffRoutes.post('/attendance', write, requireCan('attendance:mark'), async (c) => {
  const b = await c.req.json();
  const session = c.get('session');

  if (!b.employee_id) throw new HttpError(400, 'Who is this for?', { field: 'employee_id' });
  const status = b.status ?? 'present';
  if (!ATTENDANCE_STATUS.includes(status)) {
    throw new HttpError(400, `Status must be one of ${ATTENDANCE_STATUS.join(', ')}`,
      { field: 'status' });
  }

  const db = c.get('db');
  const row = await db(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO attendance (farm_id, employee_id, work_date, status,
                              overtime_minutes, note, recorded_by)
      VALUES (current_farm_id(), $1,
              COALESCE($2::date, farm_today(current_farm_id())),
              $3::attendance_status_t, COALESCE($4,0), $5, $6)
      ON CONFLICT (employee_id, work_date) DO UPDATE
        SET status = EXCLUDED.status,
            overtime_minutes = EXCLUDED.overtime_minutes,
            note = COALESCE(EXCLUDED.note, attendance.note),
            recorded_by = EXCLUDED.recorded_by
      RETURNING *`,
      [b.employee_id, b.work_date ?? null, status,
       b.overtime_minutes ?? null, b.note ?? null, session.employeeId]);
    return rows[0];
  });
  return c.json({ attendance: row }, 201);
});

/** GET /attendance?month=YYYY-MM — the month, per person. */
staffRoutes.get('/attendance', requireCan('staff:read'), async (c) => {
  const month = c.req.query('month');
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    throw new HttpError(400, 'month should look like 2026-08', { field: 'month' });
  }

  const db = c.get('db');
  const data = await db(async (client) => {
    const { rows: which } = await client.query(
      `SELECT COALESCE($1, to_char(farm_today(current_farm_id()), 'YYYY-MM')) AS month`,
      [month ?? null]);
    const m = which[0].month;

    const { rows: summary } = await client.query(
      `SELECT * FROM v_attendance_summary WHERE month = $1 ORDER BY full_name`, [m]);
    const { rows: days } = await client.query(`
      SELECT a.employee_id, e.full_name, a.work_date, a.status,
             a.checked_in_at, a.checked_out_at, a.overtime_minutes, a.note
      FROM attendance a JOIN employee e ON e.id = a.employee_id
      WHERE to_char(a.work_date, 'YYYY-MM') = $1
      ORDER BY a.work_date DESC, e.full_name`, [m]);
    return { month: m, summary, days };
  });

  return c.json(data);
});

/**
 * GET /attendance.csv — for whoever runs payroll.
 *
 * docs/04 defers payroll on purpose and does the useful 20% instead: the days,
 * in a file that opens in Excel, so the person who does this today keeps doing
 * it with better inputs than a paper register.
 */
staffRoutes.get('/attendance.csv', requireCan('staff:read'), async (c) => {
  const month = c.req.query('month');
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    throw new HttpError(400, 'month should look like 2026-08', { field: 'month' });
  }

  const db = c.get('db');
  const { m, rows } = await db(async (client) => {
    const { rows: which } = await client.query(
      `SELECT COALESCE($1, to_char(farm_today(current_farm_id()), 'YYYY-MM')) AS month`,
      [month ?? null]);
    const { rows } = await client.query(
      `SELECT full_name, month, present, half_days, absent, leave, holiday,
              days_worked, overtime_minutes
       FROM v_attendance_summary WHERE month = $1 ORDER BY full_name`, [which[0].month]);
    return { m: which[0].month, rows };
  });

  const head = ['Name', 'Month', 'Present', 'Half days', 'Absent', 'Leave',
                'Holiday', 'Days worked', 'Overtime (minutes)'];
  // Excel decides a field is a formula if it starts with =, + or @, so a name
  // like "=Ravi" would execute. Prefixing with an apostrophe is the standard
  // defence and survives the round trip.
  const cell = (v) => {
    const s = String(v ?? '');
    const safe = /^[=+@\-]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const csv = [head.join(','),
    ...rows.map((r) => [r.full_name, r.month, r.present, r.half_days, r.absent,
                        r.leave, r.holiday, r.days_worked, r.overtime_minutes]
      .map(cell).join(','))].join('\n');

  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', `attachment; filename="attendance-${m}.csv"`);
  return c.body(csv + '\n');
});

/**
 * GET /me/attendance — my own day.
 *
 * Separate from /staff on purpose. A farm hand cannot read the team — other
 * people are not their business — but they must be able to see their own
 * attendance, or the check-in card would be invisible to exactly the person it
 * exists for. Everybody may see themselves.
 */
staffRoutes.get('/me/attendance', requireCan('attendance:self'), async (c) => {
  const session = c.get('session');
  const db = c.get('db');
  const row = await db(async (client) => {
    const { rows } = await client.query(`
      SELECT a.id, a.work_date, a.status, a.checked_in_at, a.checked_out_at,
             a.overtime_minutes, a.note
      FROM attendance a
      WHERE a.employee_id = $1 AND a.work_date = farm_today(current_farm_id())`,
      [session.employeeId]);
    return rows[0] ?? null;
  });
  return c.json({ attendance: row });
});

/** What the signed-in person may do, so the app can stop offering the rest. */
staffRoutes.get('/me/permissions', async (c) => {
  const session = c.get('session');
  const allowed = {};
  for (const action of (await import('../permissions.js')).ACTIONS) {
    allowed[action] = can(session, action);
  }
  return c.json({ role: session.role, can: allowed });
});

/* ------------------------------------------------------------------ push -- */

const PLATFORMS = ['android', 'ios', 'web'];

/**
 * POST /devices — this phone would like to be told things.
 *
 * Called after sign-in and whenever the token changes, which the OS does on its
 * own schedule. Upserting on the token rather than inserting is what makes that
 * safe: the same phone re-registering is one row, and a phone that changed
 * hands moves to the new person instead of quietly pushing one farm hand's
 * reminders to another's.
 *
 * Needs no permission beyond being signed in. Every role gets notifications —
 * a vet is told about the sick rabbit, an accountant is not told anything
 * because nothing generates finance notifications yet.
 */
staffRoutes.post('/devices', async (c) => {
  const b = await c.req.json();
  const session = c.get('session');

  const token = String(b.token ?? '').trim();
  if (!token) throw new HttpError(400, 'A push token is required', { field: 'token' });
  const platform = b.platform ?? 'android';
  if (!PLATFORMS.includes(platform)) {
    throw new HttpError(400, `Platform must be one of ${PLATFORMS.join(', ')}`,
      { field: 'platform' });
  }

  const db = c.get('db');
  const row = await db(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO push_device (farm_id, employee_id, token, platform, device_name)
      VALUES (current_farm_id(), $1, $2, $3::push_platform_t, $4)
      ON CONFLICT (token) DO UPDATE
        SET employee_id = EXCLUDED.employee_id,
            farm_id     = EXCLUDED.farm_id,
            device_name = COALESCE(EXCLUDED.device_name, push_device.device_name),
            last_seen_at = now(),
            -- Re-registering is the phone telling us it is alive. Whatever
            -- went wrong before is over, or it would not be here.
            failures = 0, disabled_at = NULL, disabled_reason = NULL
      RETURNING id, platform, created_at`,
      [session.employeeId, token, platform, b.device_name ?? null]);
    return rows[0];
  });

  return c.json({ device: row }, 201);
});

/**
 * DELETE /devices — stop telling this phone things.
 *
 * Called on sign-out. A farm hand who hands the phone back must stop receiving
 * the farm's reminders on it, and that has to happen even though the session is
 * about to end, which is why it takes the token in the body rather than
 * inferring the device from the session.
 */
staffRoutes.delete('/devices', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const token = String(b.token ?? '').trim();
  if (!token) throw new HttpError(400, 'Which token?', { field: 'token' });

  const db = c.get('db');
  const gone = await db(async (client) => {
    const { rowCount } = await client.query(
      'DELETE FROM push_device WHERE token = $1', [token]);
    return rowCount > 0;
  });
  return c.json({ ok: true, removed: gone });
});

/** GET /devices — which phones this farm is pushing to, and which have died. */
staffRoutes.get('/devices', requireCan('staff:read'), async (c) => {
  const db = c.get('db');
  const rows = await db(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM v_push_device ORDER BY active DESC, last_seen_at DESC');
    return rows;
  });
  return c.json({ devices: rows });
});
