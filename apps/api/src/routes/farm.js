import { Hono } from 'hono';
import { requireAuth, requireWriteAccess } from '../middleware.js';
import { requireCan, requireInline, canEditRecord } from '../permissions.js';
import { HttpError, isKnownTimezone } from '../auth.js';

export const farmRoutes = new Hono();
farmRoutes.use('*', requireAuth);

/*
 * Two different questions, and every route answers both.
 *
 *   `write`  — is the farm's subscription live? (402 if not)
 *   `canX`   — is this person allowed to? (403 if not)
 *
 * They are separate because they fail differently: a lapsed subscription is the
 * owner's problem and reads keep working, while a permission is about who is
 * holding the phone. Collapsing them produced a "renew your subscription"
 * message for a vet who simply is not allowed to record a mating.
 */
const write = requireWriteAccess;
const canRead = requireCan('animals:read');
const canWriteAnimals = requireCan('animals:write');
const canWriteHealth = requireCan('health:write');
const canWriteSettings = requireCan('settings:write');

/**
 * The edit window, from docs/04.
 *
 * A farm hand may correct their own entry for a day; after that a manager has
 * to. The reasoning is worth keeping here rather than only in the doc: with no
 * window, mistakes are never corrected, because asking is embarrassing and the
 * wrong weight simply stays. With an unlimited one, history gets quietly
 * rewritten, which is worse. A day is long enough to notice at evening feed.
 *
 * Owners and managers pass straight through — correcting old records is most of
 * what a manager is for.
 */
async function enforceEditWindow(client, session, table, id) {
  if (session.role === 'owner' || session.role === 'manager') return;

  const column = table === 'rabbit' ? 'created_by' : 'recorded_by';
  const { rows } = await client.query(
    `SELECT ${column} AS recorded_by, created_at FROM ${table} WHERE id = $1`, [id]);
  if (!rows.length) return;

  const verdict = canEditRecord(session, {
    recordedBy: rows[0].recorded_by,
    createdAt: rows[0].created_at,
  });
  if (!verdict.ok) throw new HttpError(403, verdict.reason, { edit_window: true });
}

/* ---------------------------------------------------------------- animals -- */

/**
 * GET /animals — the herd, with any open health condition's colour mark.
 *
 * Defaults to the living herd, because that is what a farmer is standing in
 * front of. `?include=past` returns the animals that have left it and
 * `?include=all` returns both — nothing is ever dropped from the database, so
 * anything hidden here is still one query away.
 */
farmRoutes.get('/animals', canRead, async (c) => {
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
farmRoutes.get('/animals/:id/history', canRead, async (c) => {
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

    // How many of each litter exist as individuals, folded into the kindling
    // line. One query for all her litters rather than one per event, and it
    // saves changing the history view for what is really a presentation detail.
    const { rows: kitCounts } = await client.query(
      'SELECT * FROM v_litter_kits WHERE doe_id = $1', [id]);
    const byLitter = new Map(kitCounts.map((k) => [k.litter_id, k]));
    for (const e of events) {
      const k = byLitter.get(e.detail?.litter_id);
      if (k && (e.kind === 'kindling' || e.kind === 'weaning')) {
        e.detail.kits_recorded = k.recorded;
        e.detail.kits_expected = k.expected;
        e.detail.kits_not_yet_recorded = k.not_yet_recorded;
      }
    }

    return { animal: animal[0], lifetime: lifetime[0] ?? null, events, offspring };
  });

  return c.json(result);
});

/**
 * PATCH /animals/:id — fix what was written down, or fill in what was not.
 *
 * The case that forced this: kits are created unsexed, because guessing at
 * thirty days is how a buck ends up in the ready-to-mate queue. That is only
 * defensible if there is a way to say "she is a doe" at eight weeks, and there
 * was not. Renaming, moving cage and correcting a birth date come along with
 * it — the same fields the add form offers, editable afterwards.
 *
 * Audited exactly like a kindling correction: the old and new values go to
 * audit_log and the change appears on the animal's own timeline.
 *
 * Not editable here: status, which has its own endpoint because it means
 * something different, and parents, which can be filled in when blank but never
 * rewritten — changing a dam is not a typo fix, it is a different pedigree, and
 * every inbreeding decision made since would silently have been made on the
 * wrong family.
 */
const ANIMAL_EDITABLE = ['name', 'tag', 'sex', 'role', 'date_of_birth', 'notes'];

farmRoutes.patch('/animals/:id', write, canWriteAnimals, async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const session = c.get('session');

  if ('sex' in b && !['doe', 'buck', 'unknown'].includes(b.sex)) {
    throw new HttpError(400, 'Sex must be doe, buck or unknown', { field: 'sex' });
  }
  if ('status' in b) {
    throw new HttpError(400,
      'Sold, culled and died go through their own screen so the reason is kept',
      { field: 'status' });
  }

  const result = await c.get('db')(async (client) => {
    const { rows: before } = await client.query(`
      SELECT r.${ANIMAL_EDITABLE.join(', r.')}, r.breed_id, r.cage_id,
             r.dam_id, r.sire_id,
             bd.name AS breed, cg.code AS cage
      FROM rabbit r
      LEFT JOIN breed bd ON bd.id = r.breed_id
      LEFT JOIN cage cg  ON cg.id = r.cage_id
      WHERE r.id = $1`, [id]);
    if (!before.length) throw new HttpError(404, 'No such rabbit');
    const was = before[0];

    await enforceEditWindow(client, session, 'rabbit', id);

    const sets = [];
    const values = [];
    const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length + 1}`); };

    for (const k of ANIMAL_EDITABLE) {
      if (!(k in b)) continue;
      const v = typeof b[k] === 'string' ? b[k].trim() : b[k];
      if (k === 'name' && !v) throw new HttpError(400, 'A rabbit needs a name', { field: 'name' });
      push(k, v === '' ? null : v);
    }

    // Breed and cage by id or by name, resolving-or-creating the same way the
    // add form does, so the two screens cannot drift apart.
    if ('breed_id' in b || 'breed_name' in b) {
      push('breed_id', await resolveBreed(client, { id: b.breed_id, name: b.breed_name }));
    }
    let movedTo = null;
    if ('cage_id' in b || 'cage_code' in b) {
      movedTo = await resolveCage(client, { id: b.cage_id, code: b.cage_code });
      push('cage_id', movedTo);
    }

    // Parents may be filled in, never overwritten. Learning who the mother was
    // is new information; changing her is a different animal's pedigree.
    for (const [k, existing] of [['dam_id', was.dam_id], ['sire_id', was.sire_id]]) {
      if (!(k in b)) continue;
      if (existing) {
        throw new HttpError(409,
          `${k === 'dam_id' ? 'Mother' : 'Father'} is already recorded and cannot be `
          + 'changed — every mating decision since was made on it.', { field: k });
      }
      if (b[k]) push(k, b[k]);
    }

    if (!sets.length) throw new HttpError(400, 'Nothing to change');

    let row;
    try {
      const { rows } = await client.query(
        `UPDATE rabbit SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, tag, name, sex, role, status, date_of_birth, notes,
                   breed_id, cage_id`,
        [id, ...values]);
      row = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw new HttpError(409, `There is already a rabbit called ${b.tag ?? b.name}`,
          { field: 'tag' });
      }
      throw err;
    }

    // Names for the audit entry and the response, not ids — "breed_id:
    // 8f3c… → 91a2…" is unreadable six months later, which is exactly when it
    // gets read.
    const { rows: named } = await client.query(`
      SELECT bd.name AS breed, cg.code AS cage
      FROM rabbit r
      LEFT JOIN breed bd ON bd.id = r.breed_id
      LEFT JOIN cage cg  ON cg.id = r.cage_id
      WHERE r.id = $1`, [id]);
    const now = { ...row, ...named[0] };

    const changed = {};
    const prev = {};
    for (const k of [...ANIMAL_EDITABLE, 'breed', 'cage']) {
      if (String(was[k] ?? '') !== String(now[k] ?? '')) {
        prev[k] = was[k];
        changed[k] = now[k];
      }
    }

    if (Object.keys(changed).length) {
      await client.query(`
        INSERT INTO audit_log (farm_id, table_name, record_id, action, changed_by,
                               old_values, new_values)
        VALUES (current_farm_id(), 'rabbit', $1, 'update', $2, $3, $4)`,
        [id, session.employeeId, JSON.stringify(prev), JSON.stringify(changed)]);
    }

    // A cage change is a move, and a move is a thing that happened rather than
    // a field that differs. The movement table is what the timeline reads.
    if (movedTo && movedTo !== was.cage_id) {
      await client.query(`
        INSERT INTO movement (rabbit_id, from_cage_id, to_cage_id, reason, recorded_by)
        VALUES ($1, $2, $3, $4, $5)`,
        [id, was.cage_id, movedTo, b.move_reason ?? null, session.employeeId]);
    }

    return { ...now, changed: Object.keys(changed) };
  });

  return c.json({
    animal: result,
    message: result.changed.length
      ? `Updated. The previous ${result.changed.length === 1 ? 'value is' : 'values are'} kept on the record.`
      : 'Nothing changed.',
  });
});

/**
 * DELETE /animals/:id — for the rabbit that should never have existed.
 *
 * NOT the way an animal leaves the herd — that is the status route below, and
 * the difference matters for the numbers: a mistyped test row recorded as
 * "died" pollutes the mortality figures for ever. This is erasure, for the
 * mistake noticed a minute after tapping Add.
 *
 * The database draws the line about who can be erased. Operational leftovers
 * (tasks, weights, health records, status changes) CASCADE away with her, but
 * matings, litters and offspring RESTRICT — so an animal with any breeding
 * history cannot be deleted even by the owner, and the 409 says to record a
 * status instead. Owner only, like every permanent exit: employees are told
 * who to ask.
 */
farmRoutes.delete('/animals/:id', write, canWriteAnimals, async (c) => {
  requireInline(c.get('session'), 'animals:remove');
  const id = c.req.param('id');

  const result = await c.get('db')(async (client) => {
    const { rows } = await client.query(
      'SELECT tag, name FROM rabbit WHERE id = $1', [id]);
    if (!rows.length) throw new HttpError(404, 'No such rabbit');
    const who = rows[0].name ?? rows[0].tag;

    try {
      await client.query('DELETE FROM rabbit WHERE id = $1', [id]);
    } catch (err) {
      if (err.code === '23503') {
        throw new HttpError(409,
          `${who} has breeding history — matings, litters or offspring. `
          + 'That record outlives her: mark her sold, culled or died instead.',
          { has_history: true });
      }
      throw err;
    }
    return { deleted: true, name: who };
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
/*
 * The permanent three are the owner's call alone. Quarantine and a return to
 * active are ordinary husbandry — a caretaker who spots snuffles must be able
 * to isolate the animal on the spot. But sold, culled and dead end a breeding
 * line, and on a shared phone in a shed, "anyone who can record can remove"
 * is how a herd shrinks by mistap. animals:remove is granted to owner only.
 */
const PERMANENT = ['sold', 'culled', 'dead'];

farmRoutes.post('/animals/:id/status', write, canWriteAnimals, async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const to = b.status;

  if (!STATUSES.includes(to)) {
    throw new HttpError(400, `Status must be one of ${STATUSES.join(', ')}`,
      { field: 'status' });
  }
  if (PERMANENT.includes(to)) requireInline(c.get('session'), 'animals:remove');
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
              COALESCE($4::date, farm_today(current_farm_id())), $5, $6, $8)
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
farmRoutes.get('/breeds', canRead, async (c) => {
  const rows = await c.get('db')(async (client) => (await client.query(`
    SELECT b.id, b.name, b.size_class, b.doe_first_mating_days,
           b.buck_first_mating_days,
           count(r.id) FILTER (WHERE r.status <> 'dead') AS animals
    FROM breed b LEFT JOIN rabbit r ON r.breed_id = b.id
    GROUP BY b.id ORDER BY count(r.id) DESC, b.name`)).rows);
  return c.json({ breeds: rows });
});

farmRoutes.get('/cages', canRead, async (c) => {
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
farmRoutes.post('/animals', write, canWriteAnimals, async (c) => {
  const b = await c.req.json();
  const name = (b.name ?? '').trim();
  const sex = b.sex;
  if (!name) throw new HttpError(400, 'Give the rabbit a name', { field: 'name' });
  // 'unknown' is allowed and is the right answer for a young grower. Every view
  // that picks breeding stock filters on 'doe' or 'buck', so an unsexed rabbit
  // stays out of the mating queue until somebody says which it is.
  if (!['doe', 'buck', 'unknown'].includes(sex)) {
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
/**
 * GET /summary — the farm at a glance, in one round trip.
 *
 * Built for the web dashboard, which opens on this. Everything here is
 * answerable from existing views except kits, which nothing could answer
 * before: kits are counted from litter.born_alive rather than rabbit rows,
 * because kits only become individual rabbit rows when somebody records them
 * one by one, which most farms do late or never — counting rabbit rows would
 * report zero for every young litter.
 *
 * Computed in SQL inside the farm's RLS context, so this and every other
 * screen give identical answers to "who is pregnant". One request, because a
 * dashboard that fires seven is a dashboard that renders in pieces.
 */
farmRoutes.get('/summary', canRead, async (c) => {
  const db = c.get('db');
  const data = await db(async (client) => {
    const [herd, preg, ready, kits, health, today, team] = await Promise.all([
      client.query(`
        SELECT count(*)::int                                   AS total,
               count(*) FILTER (WHERE sex = 'buck')::int       AS bucks,
               count(*) FILTER (WHERE sex = 'doe')::int        AS does,
               count(*) FILTER (WHERE role = 'grower')::int    AS growers
        FROM rabbit WHERE status IN ('active', 'quarantine')`),
      client.query('SELECT * FROM v_pregnancy_summary'),
      client.query(`
        SELECT count(*)::int AS ready,
               count(*) FILTER (WHERE days_overdue > 0)::int AS overdue
        FROM v_ready_to_mate`),
      client.query(`
        SELECT COALESCE(sum(born_alive) FILTER (WHERE weaned_on IS NULL), 0)::int AS unweaned,
               count(*) FILTER (WHERE weaned_on IS NULL)::int                     AS litters_open,
               COALESCE(sum(weaned_count), 0)::int                                AS weaned_total
        FROM litter`),
      client.query(`
        SELECT (SELECT count(*)::int FROM v_open_conditions)  AS open_conditions,
               -- Rabbits, not cases: one animal with two conditions is one
               -- sick rabbit on the dashboard, not two.
               (SELECT count(DISTINCT rabbit_id)::int FROM v_open_conditions) AS sick_rabbits,
               -- The same filter GET /medication applies: lapsed doses cannot
               -- be recorded any more and doses for a rabbit already gone are
               -- nobody's job, so a card counting them reads as a broken list.
               (SELECT count(*)::int FROM v_medication_due md
                 JOIN rabbit r ON r.id = md.rabbit_id
                WHERE NOT md.lapsed
                  AND md.due_on <= farm_today(md.farm_id) + 2
                  AND r.status NOT IN ('sold', 'culled', 'dead')) AS doses_due`),
      client.query(`
        SELECT count(*)::int                                          AS open,
               count(*) FILTER (WHERE urgency = 'critical')::int      AS urgent
        FROM v_daily_list`),
      client.query(`SELECT count(*)::int AS staff FROM employee WHERE is_active`),
    ]);
    return {
      herd: herd.rows[0],
      pregnant: preg.rows[0] ?? {
        total_pregnant: 0, confirmed_pregnant: 0, presumed_pregnant: 0, due_within_7_days: 0,
      },
      ready: ready.rows[0],
      kits: kits.rows[0],
      health: health.rows[0],
      today: today.rows[0],
      team: team.rows[0],
    };
  });
  return c.json(data);
});

farmRoutes.get('/pregnant', canRead, async (c) => {
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
farmRoutes.get('/ready-to-mate', canRead, async (c) => {
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
farmRoutes.get('/bucks/suggest', canRead, async (c) => {
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
farmRoutes.get('/daily', canRead, async (c) => {
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
farmRoutes.post('/matings', write, canWriteAnimals, async (c) => {
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
farmRoutes.post('/pregnancy-checks', write, canWriteAnimals, async (c) => {
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
              $1, COALESCE($2::date, farm_today(current_farm_id())),
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
farmRoutes.post('/litters', write, canWriteAnimals, async (c) => {
  const b = await c.req.json();
  if (!b.doe_id) throw new HttpError(400, 'Which doe?', { field: 'doe_id' });
  const db = c.get('db');
  const session = c.get('session');

  const row = await db(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO litter (id, farm_id, mating_id, doe_id, nest_box_placed_on, kindled_on,
                          born_alive, born_dead, notes, recorded_by)
      VALUES (COALESCE($9::uuid, gen_random_uuid()),
              current_farm_id(), $1, $2, $3, COALESCE($4::date, farm_today(current_farm_id())),
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

/**
 * GET /litters — every litter, newest first, with the doe's name and the kit
 * arithmetic from v_litter_kits. The web dashboard's litters screen reads this;
 * until it existed, "how many litters do I have" had no collection answer.
 */
farmRoutes.get('/litters', canRead, async (c) => {
  const rows = await c.get('db')(async (client) => {
    const { rows } = await client.query(`
      SELECT l.id, l.doe_id, d.name AS doe_name, d.tag AS doe_tag,
             l.kindled_on, l.born_alive, l.born_dead,
             l.weaned_on, l.weaned_count,
             k.recorded, k.not_yet_recorded
      FROM litter l
      JOIN rabbit d ON d.id = l.doe_id
      LEFT JOIN v_litter_kits k ON k.litter_id = l.id
      ORDER BY l.kindled_on DESC`);
    return rows;
  });
  return c.json({ litters: rows });
});

/** GET /litters/:id — one kindling record, for reading it back or editing it. */
farmRoutes.get('/litters/:id', canRead, async (c) => {
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

    // How many of this litter exist as individual animals, and how many the
    // farm still believes are out there unrecorded.
    const { rows: kits } = await client.query(
      'SELECT expected, recorded, not_yet_recorded FROM v_litter_kits WHERE litter_id = $1',
      [id]);

    return { ...rows[0], corrections: edits, kits: kits[0] };
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

farmRoutes.patch('/litters/:id', write, canWriteAnimals, async (c) => {
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

    await enforceEditWindow(client, session, 'litter', id);

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

/**
 * POST /litters/:id/kits — turn a litter's counts into individual rabbits.
 *
 * Up to this point a litter is a number. That is right for the first thirty
 * days; it stops being right the moment one kit is kept back for breeding,
 * because her mother is a count in a row and the inbreeding check has nothing
 * to look at. Her pedigree would otherwise begin on whatever day somebody typed
 * her name in by hand.
 *
 * Each kit is created with the doe as dam, the buck from the mating as sire,
 * the litter's kindling date as its birthday, and the litter itself as a link —
 * so the buck suggestion can see the whole family from the day they are
 * separated.
 *
 * Sex defaults to unknown. At thirty days sexing is fiddly and often wrong, and
 * a buck filed as a doe sits in the ready-to-mate queue for two months waiting
 * to kindle. Better a blank the farmer fills in at eight weeks than a guess
 * recorded as a fact.
 */
farmRoutes.post('/litters/:id/kits', write, canWriteAnimals, async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const session = c.get('session');

  const sex = b.sex ?? 'unknown';
  if (!['doe', 'buck', 'unknown'].includes(sex)) {
    throw new HttpError(400, 'Sex must be doe, buck or unknown', { field: 'sex' });
  }

  const result = await c.get('db')(async (client) => {
    const { rows: lit } = await client.query(`
      SELECT l.id, l.doe_id, l.kindled_on, l.mating_id,
             k.expected, k.recorded, k.not_yet_recorded,
             d.name AS doe_name, d.tag AS doe_tag,
             m.buck_id
      FROM litter l
      JOIN v_litter_kits k ON k.litter_id = l.id
      JOIN rabbit d        ON d.id = l.doe_id
      LEFT JOIN mating m   ON m.id = l.mating_id
      WHERE l.id = $1`, [id]);
    if (!lit.length) throw new HttpError(404, 'No such kindling record');
    const l = lit[0];

    const names = Array.isArray(b.names)
      ? b.names.map((n) => String(n).trim()).filter(Boolean) : null;
    const want = names ? names.length : Number(b.count ?? l.not_yet_recorded);

    if (!Number.isInteger(want) || want < 1) {
      throw new HttpError(400, 'How many kits?', { field: 'count' });
    }
    // Deliberately capped at what the litter says it produced. Asking for nine
    // when eight were recorded is a disagreement worth surfacing, not padding —
    // and the kindling record is editable now, so fixing it is one screen away.
    if (want > l.not_yet_recorded) {
      throw new HttpError(400,
        l.not_yet_recorded === 0
          ? `All ${l.recorded} of this litter are already recorded.`
          : `This litter has ${l.expected} kit(s) and ${l.recorded} already recorded, `
            + `so there ${l.not_yet_recorded === 1 ? 'is' : 'are'} `
            + `${l.not_yet_recorded} left. Correct the kindling if that is wrong.`,
        { field: 'count', not_yet_recorded: l.not_yet_recorded });
    }

    // Names default to the mother's, numbered. Tags are unique per farm, so
    // pick up after whatever already exists rather than colliding — a doe on her
    // fourth litter should not fail because Lakshmi-1 was born last spring.
    const base = String(b.prefix ?? l.doe_name ?? l.doe_tag).trim();
    const { rows: taken } = await client.query(
      // Both the numbered series and any names asked for by hand. Without the
      // second half an explicit duplicate falls through to the unique index and
      // comes back as a generic constraint error nobody can act on.
      `SELECT tag FROM rabbit WHERE tag LIKE $1 || '-%' OR tag = ANY($2::text[])`,
      [base, names ?? []]);
    const used = new Set(taken.map((r) => r.tag));

    const created = [];
    let n = 0;
    for (let i = 0; i < want; i++) {
      let tag = names ? names[i] : null;
      if (!tag) {
        do { n += 1; tag = `${base}-${n}`; } while (used.has(tag));
      }
      if (used.has(tag)) {
        throw new HttpError(409, `There is already a rabbit called ${tag}`,
          { field: 'names' });
      }
      used.add(tag);

      const { rows } = await client.query(`
        INSERT INTO rabbit (farm_id, tag, name, sex, role, date_of_birth,
                            dam_id, sire_id, litter_id, origin, created_by)
        VALUES (current_farm_id(), $1, $1, $2::sex_t, 'grower', $3,
                $4, $5, $6, 'born_here', $7)
        RETURNING id, tag, name, sex, date_of_birth`,
        [tag, sex, l.kindled_on, l.doe_id, l.buck_id ?? null, l.id,
         session.employeeId]);
      created.push(rows[0]);
    }

    const { rows: after } = await client.query(
      'SELECT * FROM v_litter_kits WHERE litter_id = $1', [id]);

    return { kits: created, litter: after[0] };
  });

  return c.json({
    ...result,
    message: `${result.kits.length} kit(s) added, `
      + `with their mother and father on the record.`,
  }, 201);
});

/** GET /litters/:id/kits — the individuals recorded from one litter. */
farmRoutes.get('/litters/:id/kits', canRead, async (c) => {
  const id = c.req.param('id');
  const result = await c.get('db')(async (client) => {
    const { rows: summary } = await client.query(
      'SELECT * FROM v_litter_kits WHERE litter_id = $1', [id]);
    if (!summary.length) throw new HttpError(404, 'No such kindling record');

    const { rows: kits } = await client.query(`
      SELECT r.id, r.tag, r.name, r.sex, r.role, r.status, r.date_of_birth,
             cg.code AS cage
      FROM rabbit r
      LEFT JOIN cage cg ON cg.id = r.cage_id
      WHERE r.litter_id = $1
      ORDER BY r.tag`, [id]);

    return { litter: summary[0], kits };
  });
  return c.json(result);
});

/** POST /litters/:id/wean — separating the kits. The KPI moment. */
farmRoutes.post('/litters/:id/wean', write, canWriteAnimals, async (c) => {
  const b = await c.req.json();
  const db = c.get('db');

  const row = await db(async (client) => {
    const { rows } = await client.query(`
      UPDATE litter
         SET weaned_on = COALESCE($2::date, farm_today(current_farm_id())),
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
farmRoutes.get('/conditions', canRead, async (c) => {
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

/**
 * GET /condition-types — every sickness this farm knows, with its treatment.
 * This is what the report screen's picker shows, so it is readable by anyone.
 * There is deliberately no POST: the catalogue is veterinary knowledge and
 * only the superadmin curates it, from the admin console.
 */
farmRoutes.get('/condition-types', canRead, async (c) => {
  const db = c.get('db');
  const rows = await db(async (client) => {
    const { rows } = await client.query(`
      SELECT ct.id, ct.code, ct.name, ct.colour, ct.reminder_interval_hours,
             ct.blocks_breeding, ct.is_contagious,
             p.id   AS protocol_id,
             regexp_replace(p.name, '\\s*\\([^)]*\\)$', '') AS medicine,
             p.doses AS treatment_days,
             p.interval_days,
             p.dose_note,
             p.withdrawal_days
      FROM condition_type ct
      LEFT JOIN medication_protocol p
             ON p.condition_type_id = ct.id AND p.is_active
      WHERE ct.is_active
      ORDER BY ct.name`);
    return rows;
  });
  return c.json({
    types: rows.map((r) => ({
      id: r.id, code: r.code, name: r.name, colour: r.colour,
      reminder_interval_hours: r.reminder_interval_hours,
      blocks_breeding: r.blocks_breeding, is_contagious: r.is_contagious,
      treatment: r.protocol_id ? {
        protocol_id: r.protocol_id, medicine: r.medicine,
        days: r.treatment_days, interval_days: r.interval_days,
        dose_note: r.dose_note, withdrawal_days: r.withdrawal_days,
      } : null,
    })),
  });
});

/** POST /conditions — anyone can report loose motion, no permission needed. */
farmRoutes.post('/conditions', write, canWriteHealth, async (c) => {
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

    // Tell whoever just reported it what to give. The course itself is already
    // running — v_medication_schedule anchors on the open condition.
    const { rows: rx } = await client.query(`
      SELECT regexp_replace(name, '\\s*\\([^)]*\\)$', '') AS medicine,
             doses AS days, interval_days, dose_note
      FROM medication_protocol
      WHERE condition_type_id = $1 AND is_active
      LIMIT 1`, [types[0].id]);
    return { ...rows[0], treatment: rx[0] ?? null };
  });
  return c.json({ condition: row, treatment: row.treatment }, 201);
});

/**
 * POST /conditions/:id/check — "still loose" or "stopped".
 *
 * "Still loose" restarts the 2-hour clock from this observation rather than
 * from onset, so checking the animal is what buys the quiet.
 */
farmRoutes.post('/conditions/:id/check', write, canWriteHealth, async (c) => {
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

/* ----------------------------------------------------------- medication -- */

/**
 * GET /medication — every dose outstanding, soonest first.
 *
 * `days_until_due` is negative for one that is late. A missed calcium dose
 * around kindling is not catastrophic on its own, but a farm that has stopped
 * giving them has usually stopped doing several things.
 */
farmRoutes.get('/medication', canRead, async (c) => {
  // Lapsed doses are excluded by default, the same way they are on Today.
  // A dose past its grace period cannot be recorded any more, so listing it as
  // outstanding invites a tap that will not work. `?include=lapsed` is there
  // for the question "what did we miss", which is a different question.
  const includeLapsed = c.req.query('include') === 'lapsed';

  const rows = await c.get('db')(async (client) => (await client.query(`
    SELECT md.protocol_id, md.protocol_name, md.rabbit_id, md.dose_number,
           md.total_doses, md.due_on, md.days_until_due, md.dose_note, md.lapsed,
           r.name AS rabbit_name, r.tag
    FROM v_medication_due md
    JOIN rabbit r ON r.id = md.rabbit_id
    -- farm_today, not current_date. The view moved to the farm's day in
    -- migration 0019 and a window computed in the server's would quietly cut a
    -- dose off the end for any farm not sitting on UTC.
    WHERE md.due_on <= farm_today(md.farm_id) + 2
      AND r.status NOT IN ('sold', 'culled', 'dead')
      AND ($1 OR NOT md.lapsed)
    ORDER BY md.due_on, r.tag`, [includeLapsed])).rows);

  return c.json({
    due: rows.filter((r) => !r.lapsed),
    missed: rows.filter((r) => r.lapsed),
  });
});

/**
 * POST /medication — a dose was given.
 *
 * Recording it is what takes it off the list: v_medication_due is the schedule
 * minus whatever has been recorded, so there is no done-flag to drift out of
 * step with reality. Without this endpoint the whole medication feature could
 * only ever accumulate — the reminders had no way to be answered, which is why
 * they were never turned on for a real farm.
 *
 * A dose given a day early or late still counts; the view allows ±2 days,
 * because a farm hand doing the round at six in the morning is not going to
 * care which side of midnight it fell.
 */
farmRoutes.post('/medication', write, canWriteHealth, async (c) => {
  const b = await c.req.json();
  const session = c.get('session');

  if (!b.rabbit_id) throw new HttpError(400, 'Which rabbit?', { field: 'rabbit_id' });
  if (!b.protocol_id) throw new HttpError(400, 'Which course?', { field: 'protocol_id' });
  const doseNumber = Number(b.dose_number);
  if (!Number.isInteger(doseNumber) || doseNumber < 1) {
    throw new HttpError(400, 'Which dose?', { field: 'dose_number' });
  }

  const row = await c.get('db')(async (client) => {
    const { rows: p } = await client.query(
      'SELECT name, doses, withdrawal_days FROM medication_protocol WHERE id = $1',
      [b.protocol_id]);
    if (!p.length) throw new HttpError(404, 'No such course');
    if (doseNumber > p[0].doses) {
      throw new HttpError(400, `${p[0].name} is ${p[0].doses} doses`, { field: 'dose_number' });
    }

    const { rows } = await client.query(`
      INSERT INTO health_event (id, farm_id, rabbit_id, occurred_on, category,
                                medicine, dose, protocol_id, dose_number,
                                withdrawal_until, recorded_by)
      VALUES (COALESCE($8::uuid, gen_random_uuid()), current_farm_id(), $1,
              COALESCE($2::date, farm_today(current_farm_id())), 'medication',
              $3, $4, $5, $6,
              CASE WHEN $7::int IS NOT NULL
                   THEN COALESCE($2::date, farm_today(current_farm_id())) + $7::int END,
              $9)
      RETURNING id, occurred_on, medicine, dose_number`,
      [b.rabbit_id, b.given_on ?? null, p[0].name, b.dose ?? null, b.protocol_id,
       doseNumber, p[0].withdrawal_days, b.id ?? null, session.employeeId]);

    return rows[0];
  });

  return c.json({
    dose: row,
    message: `${row.medicine}, dose ${row.dose_number} recorded.`,
  }, 201);
});

/* ---------------------------------------------------------- notifications -- */

/**
 * GET /notifications — what the scheduler has raised for this farm.
 *
 * Deliberately unaffected by subscription status. A farm that has stopped
 * paying still gets told its doe is due to kindle; billing failure must not
 * cost a litter.
 */
farmRoutes.get('/notifications', canRead, async (c) => {
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
farmRoutes.post('/notifications/read', canRead, async (c) => {
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

farmRoutes.get('/settings', canRead, async (c) => {
  const db = c.get('db');
  const row = await db(async (client) => {
    const { rows } = await client.query('SELECT * FROM farm_settings');
    return rows[0];
  });
  return c.json({ settings: row });
});

/** PATCH /settings — every breeding constant is the farmer's to change. */
farmRoutes.patch('/settings', write, canWriteSettings, async (c) => {
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

  /*
   * Timezone lives on `farm`, not `farm_settings`, and until now nothing
   * exposed it at all. That mattered more than it looks: every day count in the
   * breeding engine is computed in it, and a farm that got it wrong at signup
   * had no way to correct it from anywhere in the product.
   */
  const timezone = typeof b.timezone === 'string' ? b.timezone.trim() : null;
  if (timezone !== null) {
    if (!isKnownTimezone(timezone)) {
      throw new HttpError(400, 'Use a timezone name like Asia/Kolkata',
        { field: 'timezone' });
    }
  } else if (!keys.length) {
    throw new HttpError(400, 'Nothing to update');
  }

  const db = c.get('db');
  const row = await db(async (client) => {
    if (timezone !== null) {
      await client.query(
        'UPDATE farm SET timezone = $1 WHERE id = current_farm_id()', [timezone]);
    }
    if (!keys.length) {
      const { rows } = await client.query(`
        SELECT fs.*, f.timezone FROM farm_settings fs
        JOIN farm f ON f.id = fs.farm_id WHERE fs.farm_id = current_farm_id()`);
      return rows[0];
    }
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    await client.query(
      `UPDATE farm_settings SET ${sets} WHERE farm_id = current_farm_id()`,
      keys.map((k) => b[k]));
    const { rows } = await client.query(`
      SELECT fs.*, f.timezone FROM farm_settings fs
      JOIN farm f ON f.id = fs.farm_id WHERE fs.farm_id = current_farm_id()`);
    return rows[0];
  });
  return c.json({ settings: row });
});
