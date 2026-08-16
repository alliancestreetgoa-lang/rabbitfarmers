import { Hono } from 'hono';
import { requireAuth, requireWriteAccess } from '../middleware.js';
import { HttpError } from '../auth.js';

export const farmRoutes = new Hono();
farmRoutes.use('*', requireAuth);

const write = requireWriteAccess;

/* ---------------------------------------------------------------- animals -- */

/**
 * GET /animals — the herd, with any open health condition's colour mark.
 *
 * Defaults to the living herd, because that is what a farmer is standing in
 * front of. `?include=past` returns the animals that have left it and
 * `?include=all` returns both — nothing is ever dropped from the database, so
 * anything hidden here is still one query away.
 */
farmRoutes.get('/animals', async (c) => {
  const db = c.get('db');
  const sex = c.req.query('sex');
  const role = c.req.query('role');
  const q = c.req.query('q');
  const include = c.req.query('include') ?? 'herd';
  if (!['herd', 'past', 'all'].includes(include)) {
    throw new HttpError(400, 'include must be herd, past or all');
  }

  const rows = await db(async (client) => {
    const { rows } = await client.query(`
      SELECT r.id, r.tag, r.name, r.sex, r.role, r.status, r.date_of_birth,
             r.status_changed_on,
             b.name AS breed, cg.code AS cage,
             st.state AS reproductive_state, st.confidence,
             st.expected_kindling_on,
             fl.primary_colour, fl.primary_condition, fl.conditions
      FROM rabbit r
      LEFT JOIN breed b   ON b.id = r.breed_id
      LEFT JOIN cage cg   ON cg.id = r.cage_id
      LEFT JOIN v_doe_reproductive_state st ON st.rabbit_id = r.id
      LEFT JOIN v_rabbit_flags fl ON fl.rabbit_id = r.id
      WHERE CASE $4
              WHEN 'herd' THEN r.status NOT IN ('sold','culled','dead')
              WHEN 'past' THEN r.status IN ('sold','culled','dead')
              ELSE true
            END
        AND ($1::text IS NULL OR r.sex::text = $1)
        AND ($2::text IS NULL OR r.role::text = $2)
        AND ($3::text IS NULL OR r.tag ILIKE '%'||$3||'%' OR r.name ILIKE '%'||$3||'%')
      ORDER BY r.tag`, [sex ?? null, role ?? null, q ?? null, include]);
    return rows;
  });
  return c.json({ animals: rows });
});

/**
 * GET /animals/:id/history — everything ever recorded about one rabbit.
 *
 * The farm has been storing all of this from the first day: matings,
 * palpations, kindlings, weanings, weights, treatments, illnesses, cage moves.
 * None of it was readable, which from a farmer's side is the same as not
 * keeping it. This is the endpoint that makes the record a record.
 *
 * Works for an animal that has been sold, culled or died — especially then,
 * because that is when someone wants to know what her line produced.
 */
farmRoutes.get('/animals/:id/history', async (c) => {
  const id = c.req.param('id');

  const result = await c.get('db')(async (client) => {
    const { rows: animal } = await client.query(`
      SELECT r.id, r.tag, r.name, r.sex, r.role, r.status, r.date_of_birth,
             r.origin, r.notes,
             b.name AS breed, cg.code AS cage,
             dam.name AS dam, dam.id AS dam_id,
             sire.name AS sire, sire.id AS sire_id
      FROM rabbit r
      LEFT JOIN breed b    ON b.id = r.breed_id
      LEFT JOIN cage cg    ON cg.id = r.cage_id
      LEFT JOIN rabbit dam  ON dam.id = r.dam_id
      LEFT JOIN rabbit sire ON sire.id = r.sire_id
      WHERE r.id = $1`, [id]);
    if (!animal.length) throw new HttpError(404, 'No such rabbit');

    const { rows: lifetime } = await client.query(
      'SELECT * FROM v_rabbit_lifetime WHERE rabbit_id = $1', [id]);

    // Newest first: the question is nearly always "what has been happening to
    // her lately", not "what happened the day she was born".
    const { rows: events } = await client.query(`
      SELECT on_date, kind, title, detail
      FROM v_rabbit_history
      WHERE rabbit_id = $1 AND on_date IS NOT NULL
      ORDER BY on_date DESC, ord DESC`, [id]);

    // Her offspring, which is the other half of what a breeding record is for.
    const { rows: offspring } = await client.query(`
      SELECT r.id, r.tag, r.name, r.sex, r.status, r.date_of_birth
      FROM rabbit r
      WHERE r.dam_id = $1 OR r.sire_id = $1
      ORDER BY r.date_of_birth DESC NULLS LAST, r.tag`, [id]);

    return { animal: animal[0], lifetime: lifetime[0] ?? null, events, offspring };
  });

  return c.json(result);
});

/**
 * POST /animals/:id/status — sold, culled, died, quarantined, or back in.
 *
 * The only way an animal leaves the herd. There is deliberately no endpoint
 * that deletes one: her matings, her litters and her line are part of the
 * farm's record and outlive her. Postgres agrees — mating.doe_id and
 * litter.doe_id are not ON DELETE CASCADE, so a doe who has ever bred cannot be
 * removed even by hand.
 *
 * Every change is appended, so a doe quarantined in March, returned to service
 * in April and sold in November keeps all three facts.
 */
const STATUSES = ['active', 'quarantine', 'sold', 'culled', 'dead'];

farmRoutes.post('/animals/:id/status', write, async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const to = b.status;

  if (!STATUSES.includes(to)) {
    throw new HttpError(400, `Status must be one of ${STATUSES.join(', ')}`,
      { field: 'status' });
  }
  // A reason is required for the three that are permanent. "Culled" with no
  // reason six months later tells nobody whether she was barren or sick.
  const reason = String(b.reason ?? '').trim();
  if (!reason && ['sold', 'culled', 'dead'].includes(to)) {
    throw new HttpError(400, 'Say why — it is the part you will want later',
      { field: 'reason' });
  }
  if (b.sale_price_paise != null && to !== 'sold') {
    throw new HttpError(400, 'A price only makes sense on a sale',
      { field: 'sale_price_paise' });
  }

  const session = c.get('session');
  const row = await c.get('db')(async (client) => {
    const { rows: current } = await client.query(
      'SELECT status, name, tag FROM rabbit WHERE id = $1', [id]);
    if (!current.length) throw new HttpError(404, 'No such rabbit');
    if (current[0].status === to) {
      throw new HttpError(409, `Already marked ${to}`);
    }

    const { rows } = await client.query(`
      INSERT INTO rabbit_status_change
        (id, farm_id, rabbit_id, from_status, to_status, changed_on, reason,
         sale_price_paise, recorded_by)
      VALUES (COALESCE($7::uuid, gen_random_uuid()), current_farm_id(), $1, $2, $3,
              COALESCE($4::date, current_date), $5, $6, $8)
      RETURNING id, from_status, to_status, changed_on`,
      [id, current[0].status, to, b.changed_on ?? null, reason || null,
       b.sale_price_paise ?? null, b.id ?? null, session.employeeId]);

    return { ...rows[0], name: current[0].name ?? current[0].tag };
  });

  return c.json({
    change: row,
    message: `${row.name} marked ${to}. Her record stays.`,
  }, 201);
});

/**
 * GET /breeds and GET /cages — what the "add a rabbit" form offers.
 *
 * Two small calls rather than one bundled one: the herd screen wants cages
 * without breeds soon enough, and a joined payload would have to be pulled
 * apart again.
 */
farmRoutes.get('/breeds', async (c) => {
  const rows = await c.get('db')(async (client) => (await client.query(`
    SELECT b.id, b.name, b.size_class, b.doe_first_mating_days,
           b.buck_first_mating_days,
           count(r.id) FILTER (WHERE r.status <> 'dead') AS animals
    FROM breed b LEFT JOIN rabbit r ON r.breed_id = b.id
    GROUP BY b.id ORDER BY count(r.id) DESC, b.name`)).rows);
  return c.json({ breeds: rows });
});

farmRoutes.get('/cages', async (c) => {
  const rows = await c.get('db')(async (client) => (await client.query(`
    SELECT cg.id, cg.code, cg.row_label, cg.capacity, s.name AS shed,
           count(r.id) FILTER (WHERE r.status <> 'dead') AS occupants
    FROM cage cg
    JOIN shed s ON s.id = cg.shed_id
    LEFT JOIN rabbit r ON r.cage_id = cg.id
    WHERE cg.is_active
    GROUP BY cg.id, s.name
    ORDER BY cg.code`)).rows);
  return c.json({ cages: rows });
});

/**
 * A breed or a cage the farmer named but that does not exist yet.
 *
 * Created here, inside the same transaction as the rabbit, rather than making
 * the app do it first. Two reasons. The obvious one is that a cage code is
 * whatever is painted on the card — the farmer puts a rabbit in A-12 and A-12
 * is now a cage, no setup screen involved. The one that actually forced it is
 * the offline outbox: two dependent writes would have to be queued in order
 * with the first one's id threaded into the second, and a partial replay would
 * leave a rabbit pointing at a cage that never got created.
 *
 * ON CONFLICT ... DO UPDATE rather than DO NOTHING, because DO NOTHING returns
 * no row on conflict and this needs the id either way.
 */
async function resolveBreed(client, { id, name }) {
  if (id) return id;
  const clean = (name ?? '').trim();
  if (!clean) return null;
  const { rows } = await client.query(`
    INSERT INTO breed (farm_id, name) VALUES (current_farm_id(), $1)
    ON CONFLICT (farm_id, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id`, [clean]);
  return rows[0].id;
}

async function resolveCage(client, { id, code }) {
  if (id) return id;
  const clean = (code ?? '').trim();
  if (!clean) return null;

  // A cage has to live in a shed. Use whichever the farm already has — signup
  // seeds one — and only invent a shed if somebody deleted them all.
  let shed = (await client.query('SELECT id FROM shed ORDER BY name LIMIT 1')).rows[0]?.id;
  if (!shed) {
    shed = (await client.query(
      `INSERT INTO shed (farm_id, name) VALUES (current_farm_id(), 'Shed A')
       RETURNING id`)).rows[0].id;
  }

  const { rows } = await client.query(`
    INSERT INTO cage (farm_id, shed_id, code) VALUES (current_farm_id(), $1, $2)
    ON CONFLICT (farm_id, code) DO UPDATE SET code = EXCLUDED.code
    RETURNING id`, [shed, clean]);
  return rows[0].id;
}

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
    const breedId = await resolveBreed(client, { id: b.breed_id, name: b.breed_name });
    const cageId = await resolveCage(client, { id: b.cage_id, code: b.cage_code });

    const { rows } = await client.query(`
      INSERT INTO rabbit (id, farm_id, tag, name, sex, role, breed_id, date_of_birth,
                          dam_id, sire_id, cage_id, origin, created_by)
      VALUES (COALESCE($12::uuid, gen_random_uuid()),
              current_farm_id(), $1, $2, $3, COALESCE($4,'breeder')::rabbit_role_t,
              $5, $6, $7, $8, $9, COALESCE($10,'born_here')::origin_t, $11)
      RETURNING id, tag, name, sex, role`,
      [(b.tag ?? name).trim(), name, sex, b.role ?? null, breedId,
       b.date_of_birth ?? null, b.dam_id ?? null, b.sire_id ?? null,
       cageId, b.origin ?? null, session.employeeId, b.id ?? null]);

    // Hand back the resolved names, not just ids — the app has just created a
    // breed or a cage it did not know about and needs them for its next render.
    const { rows: named } = await client.query(`
      SELECT b.name AS breed, cg.code AS cage
      FROM rabbit r
      LEFT JOIN breed b ON b.id = r.breed_id
      LEFT JOIN cage cg ON cg.id = r.cage_id
      WHERE r.id = $1`, [rows[0].id]);

    return { ...rows[0], ...named[0] };
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

/** GET /litters/:id — one kindling record, for reading it back or editing it. */
farmRoutes.get('/litters/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.get('db')(async (client) => {
    const { rows } = await client.query(`
      SELECT l.*, r.name AS doe_name, r.tag AS doe_tag,
             l.kindled_on + fs.wean_at_days AS separate_kits_on,
             l.kindled_on + fs.wean_at_days + fs.rebreed_after_weaning_days AS rebreed_on
      FROM litter l
      JOIN rabbit r ON r.id = l.doe_id
      CROSS JOIN farm_settings fs
      WHERE l.id = $1`, [id]);
    if (!rows.length) throw new HttpError(404, 'No such kindling record');

    // What it said before, if it has been corrected.
    const { rows: edits } = await client.query(`
      SELECT al.changed_at, al.old_values, al.new_values, e.full_name AS changed_by
      FROM audit_log al
      LEFT JOIN employee e ON e.id = al.changed_by
      WHERE al.table_name = 'litter' AND al.record_id = $1 AND al.action = 'update'
      ORDER BY al.changed_at DESC`, [id]);

    return { ...rows[0], corrections: edits };
  });
  return c.json({ litter: row });
});

/**
 * PATCH /litters/:id — correcting what was written down.
 *
 * A farmer counts eight kits at six in the morning and finds a ninth under the
 * fur an hour later. A record that cannot be corrected stops being trusted, and
 * an untrusted record sends everyone back to the paper card.
 *
 * The correction is not an overwrite. The old and new values go into audit_log
 * and the doe's timeline gains a line saying what changed and who changed it,
 * so "she had eight, no wait, nine" survives as a fact about the record rather
 * than quietly replacing one.
 *
 * Only the fields a person could get wrong in a shed are editable. doe_id and
 * mating_id are not: pointing a litter at a different doe is not a correction,
 * it is a different record.
 */
const LITTER_EDITABLE = ['kindled_on', 'born_alive', 'born_dead', 'notes',
                         'nest_box_placed_on', 'fostered_in', 'fostered_out'];

farmRoutes.patch('/litters/:id', write, async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const session = c.get('session');

  const fields = LITTER_EDITABLE.filter((k) => k in b);
  if (!fields.length) {
    throw new HttpError(400, `Nothing to change. Editable: ${LITTER_EDITABLE.join(', ')}`);
  }
  for (const k of ['born_alive', 'born_dead', 'fostered_in', 'fostered_out']) {
    if (k in b && (!Number.isInteger(Number(b[k])) || Number(b[k]) < 0)) {
      throw new HttpError(400, `${k.replace(/_/g, ' ')} must be a whole number`,
        { field: k });
    }
  }

  const row = await c.get('db')(async (client) => {
    const { rows: before } = await client.query(
      `SELECT ${LITTER_EDITABLE.join(', ')}, doe_id FROM litter WHERE id = $1`, [id]);
    if (!before.length) throw new HttpError(404, 'No such kindling record');

    const sets = fields.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = fields.map((k) => (b[k] === '' ? null : b[k]));
    const { rows } = await client.query(
      `UPDATE litter SET ${sets} WHERE id = $1
       RETURNING id, kindled_on, born_alive, born_dead, notes,
                 nest_box_placed_on, fostered_in, fostered_out`,
      [id, ...values]);

    // Only what actually moved. Re-saving a form untouched should not litter
    // the timeline with corrections that corrected nothing.
    const changed = {};
    const was = {};
    for (const k of fields) {
      if (String(before[0][k] ?? '') !== String(rows[0][k] ?? '')) {
        was[k] = before[0][k];
        changed[k] = rows[0][k];
      }
    }

    if (Object.keys(changed).length) {
      await client.query(`
        INSERT INTO audit_log (farm_id, table_name, record_id, action, changed_by,
                               old_values, new_values)
        VALUES (current_farm_id(), 'litter', $1, 'update', $2, $3, $4)`,
        [id, session.employeeId, JSON.stringify(was), JSON.stringify(changed)]);
    }

    return { ...rows[0], changed: Object.keys(changed) };
  });

  return c.json({
    litter: row,
    message: row.changed.length
      ? `Corrected. The previous ${row.changed.length === 1 ? 'value is' : 'values are'} kept on her record.`
      : 'Nothing changed.',
  });
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
