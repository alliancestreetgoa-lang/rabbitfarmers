import { Hono } from 'hono';
import { requireAuth, requireWriteAccess } from '../middleware.js';
import { HttpError } from '../auth.js';

export const farmRoutes = new Hono();
farmRoutes.use('*', requireAuth);

const write = requireWriteAccess;

/* ---------------------------------------------------------------- animals -- */

/** GET /animals — the herd, with any open health condition's colour mark. */
farmRoutes.get('/animals', async (c) => {
  const db = c.get('db');
  const sex = c.req.query('sex');
  const role = c.req.query('role');
  const q = c.req.query('q');

  const rows = await db(async (client) => {
    const { rows } = await client.query(`
      SELECT r.id, r.tag, r.name, r.sex, r.role, r.status, r.date_of_birth,
             b.name AS breed, cg.code AS cage,
             st.state AS reproductive_state, st.confidence,
             st.expected_kindling_on,
             fl.primary_colour, fl.primary_condition, fl.conditions
      FROM rabbit r
      LEFT JOIN breed b   ON b.id = r.breed_id
      LEFT JOIN cage cg   ON cg.id = r.cage_id
      LEFT JOIN v_doe_reproductive_state st ON st.rabbit_id = r.id
      LEFT JOIN v_rabbit_flags fl ON fl.rabbit_id = r.id
      WHERE r.status <> 'dead'
        AND ($1::text IS NULL OR r.sex::text = $1)
        AND ($2::text IS NULL OR r.role::text = $2)
        AND ($3::text IS NULL OR r.tag ILIKE '%'||$3||'%' OR r.name ILIKE '%'||$3||'%')
      ORDER BY r.tag`, [sex ?? null, role ?? null, q ?? null]);
    return rows;
  });
  return c.json({ animals: rows });
});

/** POST /animals — you add and name every rabbit yourself. */
farmRoutes.post('/animals', write, async (c) => {
  const b = await c.req.json();
  const name = (b.name ?? '').trim();
  const sex = b.sex;
  if (!name) throw new HttpError(400, 'Give the rabbit a name', { field: 'name' });
  if (!['doe', 'buck'].includes(sex)) {
    throw new HttpError(400, 'Is it a doe or a buck?', { field: 'sex' });
  }

  const db = c.get('db');
  const session = c.get('session');
  const row = await db(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO rabbit (id, farm_id, tag, name, sex, role, breed_id, date_of_birth,
                          dam_id, sire_id, cage_id, origin, created_by)
      VALUES (COALESCE($12::uuid, gen_random_uuid()),
              current_farm_id(), $1, $2, $3, COALESCE($4,'breeder')::rabbit_role_t,
              $5, $6, $7, $8, $9, COALESCE($10,'born_here')::origin_t, $11)
      RETURNING id, tag, name, sex, role`,
      [(b.tag ?? name).trim(), name, sex, b.role ?? null, b.breed_id ?? null,
       b.date_of_birth ?? null, b.dam_id ?? null, b.sire_id ?? null,
       b.cage_id ?? null, b.origin ?? null, session.employeeId, b.id ?? null]);
    return rows[0];
  });
  return c.json({ animal: row }, 201);
});

/* ------------------------------------------------------------- the numbers -- */

/** GET /pregnant — "how many are pregnant?", confirmed and presumed kept apart. */
farmRoutes.get('/pregnant', async (c) => {
  const db = c.get('db');
  const data = await db(async (client) => {
    const summary = await client.query('SELECT * FROM v_pregnancy_summary');
    const does = await client.query(`
      SELECT s.rabbit_id, s.tag, r.name, s.state, s.confidence, s.gestation_day,
             s.expected_kindling_on, s.window_start_on, s.window_end_on
      FROM v_pregnant_does s
      JOIN rabbit r ON r.id = s.rabbit_id
      ORDER BY s.expected_kindling_on`);
    return {
      summary: summary.rows[0] ?? {
        total_pregnant: 0, confirmed_pregnant: 0, presumed_pregnant: 0, due_within_7_days: 0,
      },
      does: does.rows,
    };
  });
  return c.json(data);
});

/** GET /ready-to-mate — the queue, each row carrying the reason it is there. */
farmRoutes.get('/ready-to-mate', async (c) => {
  const db = c.get('db');
  const rows = await db(async (client) => {
    const { rows } = await client.query(`
      SELECT q.rabbit_id, q.tag, r.name, q.state, q.days_since_last_kindling,
             q.days_since_weaning, q.days_overdue,
             q.last_observed_receptivity, q.receptivity_checked_on,
             p.total_weaned, p.litters
      FROM v_ready_to_mate q
      JOIN rabbit r ON r.id = q.rabbit_id
      LEFT JOIN v_doe_performance p ON p.rabbit_id = q.rabbit_id
      ORDER BY q.days_overdue DESC NULLS LAST, r.name`);
    return rows;
  });
  return c.json({ ready: rows });
});

/** GET /bucks/suggest?doe_id= — under quota, not closely related, best first. */
farmRoutes.get('/bucks/suggest', async (c) => {
  const doeId = c.req.query('doe_id');
  if (!doeId) throw new HttpError(400, 'doe_id is required');
  const db = c.get('db');

  const rows = await db(async (client) => {
    const { rows } = await client.query(`
      WITH doe AS (SELECT id, dam_id, sire_id FROM rabbit WHERE id = $1)
      SELECT b.buck_id, b.tag, r.name,
             b.services_today, b.services_last_7d,
             CASE WHEN b.scored_services > 0
                  THEN round(b.successes::numeric / b.scored_services, 2) END AS conception_rate,
             (b.services_last_7d >= fs.buck_max_services_per_week
              OR b.services_today >= fs.buck_max_services_per_day)      AS over_quota,
             -- Two generations catches the pairings that actually happen in a
             -- small rabbitry: parent/offspring and full or half siblings.
             --
             -- COALESCE matters here. Founding stock has NULL parents, and in
             -- SQL, NULL = anything is NULL rather than false — so without it
             -- an unrelated buck comes back "related: null" and the screen has
             -- no idea whether it is safe. Unknown parentage means
             -- not-known-to-be-related.
             COALESCE(
                  r.id      = d.sire_id
               OR r.dam_id   = d.id
               OR r.sire_id  = d.id
               OR r.dam_id   = d.dam_id
               OR r.sire_id  = d.sire_id, false)                        AS blocked_related,
             COALESCE(EXISTS (
                 SELECT 1 FROM rabbit bg, rabbit dg
                 WHERE bg.id = r.dam_id AND dg.id = d.dam_id
                   AND (bg.dam_id  = dg.dam_id OR bg.sire_id = dg.sire_id)
             ), false)                                                  AS warn_related
      FROM v_buck_availability b
      JOIN rabbit r ON r.id = b.buck_id
      CROSS JOIN doe d
      CROSS JOIN farm_settings fs
      WHERE NOT EXISTS (
        SELECT 1 FROM health_condition hc
        JOIN condition_type ct ON ct.id = hc.condition_type_id
        WHERE hc.rabbit_id = r.id AND hc.resolved_at IS NULL AND ct.blocks_breeding)
      ORDER BY conception_rate DESC NULLS LAST, b.services_last_7d`, [doeId]);
    return rows;
  });
  return c.json({ bucks: rows });
});

/** GET /daily — the tab that opens on login. */
farmRoutes.get('/daily', async (c) => {
  const db = c.get('db');
  const rows = await db(async (client) => {
    const { rows } = await client.query(`
      SELECT source, ref_id, rabbit_id, tag, due_on, due_at, title, urgency, colour
      FROM v_daily_list
      ORDER BY CASE urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
               due_at NULLS FIRST`);
    return rows;
  });
  return c.json({
    date: new Date().toISOString().slice(0, 10),
    open: rows.length,
    items: rows,
  });
});

/* --------------------------------------------------------------- breeding -- */

/** POST /matings — take the doe to the buck, then record it here. */
farmRoutes.post('/matings', write, async (c) => {
  const b = await c.req.json();
  if (!b.doe_id) throw new HttpError(400, 'Which doe?', { field: 'doe_id' });
  const db = c.get('db');
  const session = c.get('session');

  const row = await db(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, service_count,
                          service_observed, receptivity, notes, recorded_by)
      VALUES (COALESCE($9::uuid, gen_random_uuid()),
              current_farm_id(), $1, $2, COALESCE($3::timestamptz, now()),
              COALESCE($4,1), COALESCE($5,true),
              COALESCE($6,'unknown')::receptivity_t, $7, $8)
      RETURNING id, doe_id, buck_id, mated_at`,
      [b.doe_id, b.buck_id ?? null, b.mated_at ?? null, b.service_count ?? null,
       b.service_observed ?? null, b.receptivity ?? null, b.notes ?? null,
       session.employeeId, b.id ?? null]);

    // Give the answer back immediately — the farmer wants the dates, not an id.
    const { rows: sched } = await client.query(`
      SELECT (m.mated_at)::date + fs.first_check_day        AS palpate_on,
             (m.mated_at)::date + fs.gestation_window_start_day AS nest_box_on,
             (m.mated_at)::date + fs.gestation_expected_days AS expected_kindling_on,
             (m.mated_at)::date + fs.gestation_window_end_day AS watch_until
      FROM mating m CROSS JOIN farm_settings fs WHERE m.id = $1`, [rows[0].id]);

    return { ...rows[0], schedule: sched[0] };
  });
  return c.json({ mating: row }, 201);
});

/** POST /pregnancy-checks — palpation result. The latest check wins. */
farmRoutes.post('/pregnancy-checks', write, async (c) => {
  const b = await c.req.json();
  if (!b.mating_id) throw new HttpError(400, 'Which mating?', { field: 'mating_id' });
  if (!['positive', 'negative', 'uncertain'].includes(b.result)) {
    throw new HttpError(400, 'Result must be positive, negative or uncertain');
  }
  const db = c.get('db');
  const session = c.get('session');

  const row = await db(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO pregnancy_check (id, mating_id, checked_on, method, result, checked_by, notes)
      VALUES (COALESCE($7::uuid, gen_random_uuid()),
              $1, COALESCE($2::date, current_date),
              COALESCE($3,'palpation')::check_method_t, $4::check_result_t, $5, $6)
      RETURNING id, checked_on, result`,
      [b.mating_id, b.checked_on ?? null, b.method ?? null, b.result,
       session.employeeId, b.notes ?? null, b.id ?? null]);

    // Keep the cached projection on mating in step with the check just written.
    await client.query(`
      UPDATE mating SET outcome = CASE $2
          WHEN 'positive' THEN 'pregnant'::mating_outcome_t
          WHEN 'negative' THEN 'negative'::mating_outcome_t
          ELSE outcome END
      WHERE id = $1 AND outcome NOT IN ('kindled','aborted','terminated')`,
      [b.mating_id, b.result]);

    return rows[0];
  });
  return c.json({ check: row }, 201);
});

/** POST /litters — she kindled. */
farmRoutes.post('/litters', write, async (c) => {
  const b = await c.req.json();
  if (!b.doe_id) throw new HttpError(400, 'Which doe?', { field: 'doe_id' });
  const db = c.get('db');
  const session = c.get('session');

  const row = await db(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO litter (id, farm_id, mating_id, doe_id, nest_box_placed_on, kindled_on,
                          born_alive, born_dead, notes, recorded_by)
      VALUES (COALESCE($9::uuid, gen_random_uuid()),
              current_farm_id(), $1, $2, $3, COALESCE($4::date, current_date),
              COALESCE($5,0), COALESCE($6,0), $7, $8)
      RETURNING id, kindled_on, born_alive, born_dead`,
      [b.mating_id ?? null, b.doe_id, b.nest_box_placed_on ?? null, b.kindled_on ?? null,
       b.born_alive ?? null, b.born_dead ?? null, b.notes ?? null, session.employeeId,
       b.id ?? null]);

    if (b.mating_id) {
      await client.query(
        `UPDATE mating SET outcome = 'kindled' WHERE id = $1`, [b.mating_id]);
    }

    const { rows: sched } = await client.query(`
      SELECT l.kindled_on + fs.wean_at_days AS separate_kits_on,
             l.kindled_on + fs.wean_at_days + fs.rebreed_after_weaning_days AS rebreed_on
      FROM litter l CROSS JOIN farm_settings fs WHERE l.id = $1`, [rows[0].id]);

    return { ...rows[0], schedule: sched[0] };
  });
  return c.json({ litter: row }, 201);
});

/** POST /litters/:id/wean — separating the kits. The KPI moment. */
farmRoutes.post('/litters/:id/wean', write, async (c) => {
  const b = await c.req.json();
  const db = c.get('db');

  const row = await db(async (client) => {
    const { rows } = await client.query(`
      UPDATE litter
         SET weaned_on = COALESCE($2::date, current_date),
             weaned_count = $3,
             avg_weaning_weight_g = $4
       WHERE id = $1
       RETURNING id, weaned_on, weaned_count, born_alive`,
      [c.req.param('id'), b.weaned_on ?? null, b.weaned_count ?? null,
       b.avg_weaning_weight_g ?? null]);
    if (!rows.length) throw new HttpError(404, 'Litter not found');

    const { rows: next } = await client.query(`
      SELECT l.weaned_on + fs.rebreed_after_weaning_days AS rebreed_on
      FROM litter l CROSS JOIN farm_settings fs WHERE l.id = $1`, [rows[0].id]);
    return { ...rows[0], schedule: next[0] };
  });
  return c.json({ litter: row });
});

/* ------------------------------------------------------------- conditions -- */

/** GET /conditions — what is currently marked, and what needs looking at now. */
farmRoutes.get('/conditions', async (c) => {
  const db = c.get('db');
  const data = await db(async (client) => {
    const open = await client.query(`
      SELECT condition_id, rabbit_id, tag, rabbit_name, condition_name, colour,
             severity, hours_open, next_reminder_at, reminder_due, needs_escalation
      FROM v_open_conditions ORDER BY started_at`);
    const clusters = await client.query('SELECT * FROM v_condition_clusters');
    return { open: open.rows, clusters: clusters.rows };
  });
  return c.json(data);
});

/** POST /conditions — anyone can report loose motion, no permission needed. */
farmRoutes.post('/conditions', write, async (c) => {
  const b = await c.req.json();
  const db = c.get('db');
  const session = c.get('session');

  // When it was actually seen, which is not when it was typed in. Someone
  // notices wet fur at first feed and records it when they come off the shed
  // floor an hour later; the 2-hourly reminder clock has to run from the
  // observation or every reminder is an hour late all day.
  const observedAt = b.observed_at ?? null;
  if (observedAt !== null) {
    const t = Date.parse(observedAt);
    if (Number.isNaN(t)) throw new HttpError(400, 'observed_at is not a date');
    if (t > Date.now() + 60_000) {
      throw new HttpError(400, 'That is in the future', { field: 'observed_at' });
    }
  }

  const row = await db(async (client) => {
    const { rows: types } = await client.query(
      'SELECT id FROM condition_type WHERE code = $1 AND is_active',
      [b.code ?? 'loose_motion']);
    if (!types.length) throw new HttpError(400, `Unknown condition "${b.code}"`);

    const { rows } = await client.query(`
      INSERT INTO health_condition (id, farm_id, condition_type_id, rabbit_id, litter_id,
                                    severity, notes, reported_by,
                                    started_at, last_checked_at)
      VALUES (COALESCE($7::uuid, gen_random_uuid()),
              current_farm_id(), $1, $2, $3, $4, $5, $6,
              COALESCE($8::timestamptz, now()), COALESCE($8::timestamptz, now()))
      RETURNING id, started_at`,
      [types[0].id, b.rabbit_id ?? null, b.litter_id ?? null,
       b.severity ?? 'moderate', b.notes ?? null, session.employeeId, b.id ?? null,
       observedAt]);
    return rows[0];
  });
  return c.json({ condition: row }, 201);
});

/**
 * POST /conditions/:id/check — "still loose" or "stopped".
 *
 * "Still loose" restarts the 2-hour clock from this observation rather than
 * from onset, so checking the animal is what buys the quiet.
 */
farmRoutes.post('/conditions/:id/check', write, async (c) => {
  const b = await c.req.json();
  const status = b.status ?? 'ongoing';
  if (!['ongoing', 'improving', 'worse', 'stopped'].includes(status)) {
    throw new HttpError(400, 'Status must be ongoing, improving, worse or stopped');
  }
  const db = c.get('db');
  const session = c.get('session');
  const id = c.req.param('id');

  const row = await db(async (client) => {
    await client.query(`
      INSERT INTO condition_check (condition_id, status, note, checked_by)
      VALUES ($1,$2,$3,$4)`, [id, status, b.note ?? null, session.employeeId]);

    const { rows } = await client.query(`
      UPDATE health_condition
         SET last_checked_at = now(),
             resolved_at = CASE WHEN $2 = 'stopped' THEN now() ELSE resolved_at END,
             resolved_by = CASE WHEN $2 = 'stopped' THEN $3 ELSE resolved_by END
       WHERE id = $1
       RETURNING id, last_checked_at, resolved_at`,
      [id, status, session.employeeId]);
    if (!rows.length) throw new HttpError(404, 'Condition not found');
    return rows[0];
  });

  return c.json({
    condition: row,
    resolved: row.resolved_at !== null,
    message: row.resolved_at
      ? 'Marked stopped. The reminder and the colour mark are gone.'
      : 'Logged. Next reminder in 2 hours.',
  });
});

/* ---------------------------------------------------------- notifications -- */

/**
 * GET /notifications — what the scheduler has raised for this farm.
 *
 * Deliberately unaffected by subscription status. A farm that has stopped
 * paying still gets told its doe is due to kindle; billing failure must not
 * cost a litter.
 */
farmRoutes.get('/notifications', async (c) => {
  const db = c.get('db');
  const session = c.get('session');
  const unreadOnly = c.req.query('unread') === '1';

  const rows = await db(async (client) => {
    const { rows } = await client.query(`
      SELECT n.id, n.kind, n.title, n.body, n.urgency, n.rabbit_id,
             r.name AS rabbit_name, n.created_at, n.read_at
      FROM notification n
      LEFT JOIN rabbit r ON r.id = n.rabbit_id
      WHERE (n.employee_id IS NULL OR n.employee_id = $1)
        AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
        AND n.created_at > now() - interval '7 days'
      ORDER BY CASE n.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
               n.created_at DESC
      LIMIT 100`, [session.employeeId, unreadOnly]);
    return rows;
  });

  return c.json({ notifications: rows, unread: rows.filter((r) => !r.read_at).length });
});

/** POST /notifications/read — dismiss, either one or everything. */
farmRoutes.post('/notifications/read', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const db = c.get('db');
  const session = c.get('session');

  const n = await db(async (client) => {
    const { rowCount } = await client.query(`
      UPDATE notification SET read_at = now()
       WHERE read_at IS NULL
         AND (employee_id IS NULL OR employee_id = $1)
         AND ($2::uuid IS NULL OR id = $2)`,
      [session.employeeId, b.id ?? null]);
    return rowCount;
  });
  return c.json({ marked_read: n });
});

/* --------------------------------------------------------------- settings -- */

farmRoutes.get('/settings', async (c) => {
  const db = c.get('db');
  const row = await db(async (client) => {
    const { rows } = await client.query('SELECT * FROM farm_settings');
    return rows[0];
  });
  return c.json({ settings: row });
});

/** PATCH /settings — every breeding constant is the farmer's to change. */
farmRoutes.patch('/settings', write, async (c) => {
  const b = await c.req.json();
  const allowed = new Set([
    'gestation_expected_days', 'gestation_window_start_day', 'gestation_window_end_day',
    'gestation_overdue_day', 'first_check_day', 'recheck_day', 'rhythm',
    'rebreed_anchor', 'rebreed_after_weaning_days', 'rebreed_after_kindling_days',
    'wean_at_days', 'after_failed_service_days', 'after_pseudopregnancy_days',
    'buck_max_services_per_day', 'buck_max_services_per_week',
    'quiet_hours_enabled', 'quiet_hours_start', 'quiet_hours_end',
  ]);
  const keys = Object.keys(b).filter((k) => allowed.has(k));
  if (!keys.length) throw new HttpError(400, 'Nothing to update');

  const db = c.get('db');
  const row = await db(async (client) => {
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows } = await client.query(
      `UPDATE farm_settings SET ${sets} WHERE farm_id = current_farm_id() RETURNING *`,
      keys.map((k) => b[k]));
    return rows[0];
  });
  return c.json({ settings: row });
});
