-- ============================================================================
-- 0043  The medicine chart becomes the catalogue, and the farm gets a routine
--
-- Source: the farm's own Medicine, Dosage & Administration Chart, compiled
-- from the training session at Alliance Street Organic Farms. Two sheets —
-- the chart, and a monthly preventive routine for the whole farm. Doses as
-- the trainer gave them; the report screen repeats the sheet's own caveat
-- that a vet should confirm them.
--
-- Everything curated before is replaced. Three things the old shape could not
-- say, and this one can:
--
--   1. A sickness may need MORE THAN ONE medicine, in order. Fever is
--      Gentamicin + Dexamethasone, then Belamyl exactly an hour later. The
--      catalogue kept one medicine column per sickness; it now keeps a table
--      of steps (condition_catalog_treatment), and every step becomes its own
--      medication_protocol on every farm.
--
--   2. Some medicines must NOT go to some rabbits. Hitech is never for a
--      pregnant doe or a kit under three months; the injection is adults
--      only. A step carries adults_only / min_age_days / not_when_pregnant,
--      and v_medication_schedule works out, per rabbit, whether the dose is
--      held and why. A held dose is shown as a hold, never as "give it", and
--      POST /medication refuses to record it.
--
--   3. The farm has a MONTHLY ROUTINE that hangs off the calendar, not off an
--      animal: Hitech for three days, Liv 52 for three, Gutwell for three,
--      Tetracycline in the water, all in the first week of the month. That
--      is routine_catalog + generate_routine_tasks(): one whole-farm task per
--      routine day, raised in the first week and pushed to every phone.
--
-- "Repeat after 24 hours only if not cured" needs no new machinery: the
-- course anchors on the OPEN sickness, so marking it stopped after one
-- Meriquin removes the second dose. That has been the engine's rule since
-- migration 0036.
--
-- What is deliberately NOT here: litter-wide dosing (0036 left it out, still
-- out), and per-rabbit exclusion inside a routine task — the task names who
-- to skip; enumerating them is a screen for another day.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The catalogue grows steps, advice, and a routine
-- ---------------------------------------------------------------------------

-- The single-medicine columns go. The steps table below replaces them, and
-- leaving them behind would mean two places for one fact.
ALTER TABLE condition_catalog
    DROP COLUMN IF EXISTS medicine,
    DROP COLUMN IF EXISTS treatment_days,
    DROP COLUMN IF EXISTS interval_days,
    DROP COLUMN IF EXISTS dose_note,
    DROP COLUMN IF EXISTS withdrawal_days;

-- What the report screen says alongside the medicine: "stop green fodder",
-- "nebulize if severe". The rule the farmer must act on, not the dose.
ALTER TABLE condition_catalog ADD COLUMN IF NOT EXISTS advice text;

-- How long a case may stay open before the owner is told. Supplied to a farm
-- when the sickness is NEW to it; a farm that already has its own figure
-- keeps it (0041's rule — escalation is the farm's, the catalogue only
-- stops a new farm being born with none).
ALTER TABLE condition_catalog ADD COLUMN IF NOT EXISTS escalate_after_hours int;

CREATE TABLE condition_catalog_treatment (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    catalog_id        uuid NOT NULL REFERENCES condition_catalog(id) ON DELETE CASCADE,
    step              int  NOT NULL CHECK (step BETWEEN 1 AND 10),
    medicine          text NOT NULL,
    route             text,                 -- "oral", "injection", "topical", "in feed"
    dose              text,                 -- "1 ml", "0.3 ml", "a pinch"
    doses             int  NOT NULL DEFAULT 1 CHECK (doses BETWEEN 1 AND 60),
    interval_days     int  NOT NULL DEFAULT 1 CHECK (interval_days BETWEEN 1 AND 30),
    note              text,                 -- how, when, and what to watch
    adults_only       boolean NOT NULL DEFAULT false,
    min_age_days      int CHECK (min_age_days > 0),
    not_when_pregnant boolean NOT NULL DEFAULT false,
    withdrawal_days   int,
    UNIQUE (catalog_id, step),
    UNIQUE (catalog_id, medicine)
);
-- The console is the only writer. 0006's default privileges would hand the
-- farm role a write it must never have; take it back before it exists.
GRANT SELECT, INSERT, UPDATE, DELETE ON condition_catalog_treatment TO rabbitry_admin;
REVOKE INSERT, UPDATE, DELETE ON condition_catalog_treatment FROM rabbitry_app;

-- The monthly preventive routine, whole farm. Platform-level like the
-- sickness catalogue: the trainer's sheet, not a farm's opinion.
CREATE TABLE routine_catalog (
    step        int  PRIMARY KEY,
    day         int  NOT NULL CHECK (day BETWEEN 1 AND 28),   -- of the month
    medicine    text NOT NULL,
    dose        text NOT NULL,
    title       text NOT NULL,   -- the task line on Today
    detail      text NOT NULL,   -- purpose, and who is left out
    is_active   boolean NOT NULL DEFAULT true
);
GRANT SELECT ON routine_catalog TO rabbitry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON routine_catalog TO rabbitry_admin;
REVOKE INSERT, UPDATE, DELETE ON routine_catalog FROM rabbitry_app;

-- Per-farm protocols carry the step's rules with them, so the schedule view
-- can apply them without reaching back into the catalogue.
ALTER TABLE medication_protocol
    ADD COLUMN IF NOT EXISTS step              int     NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS route             text,
    ADD COLUMN IF NOT EXISTS dose              text,
    ADD COLUMN IF NOT EXISTS adults_only       boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS min_age_days      int,
    ADD COLUMN IF NOT EXISTS not_when_pregnant boolean NOT NULL DEFAULT false;

-- The advice travels with the sickness onto the farm, so the report screen
-- reads it under RLS from the farm's own row and never touches the catalogue.
ALTER TABLE condition_type ADD COLUMN IF NOT EXISTS advice text;

-- A routine task needs somewhere to say who is left out. The title is what
-- fits on a row; this is what opens under it.
ALTER TABLE task ADD COLUMN IF NOT EXISTS notes text;

-- ---------------------------------------------------------------------------
-- 2. Pressing the catalogue onto a farm, step by step
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_condition_catalog(p_farm_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; s record; v_type_id uuid;
BEGIN
    FOR r IN SELECT * FROM condition_catalog WHERE is_active LOOP
        INSERT INTO condition_type
            (farm_id, code, name, colour, reminder_interval_hours,
             blocks_breeding, is_contagious, respect_quiet_hours, advice,
             escalate_after_hours)
        VALUES (p_farm_id, r.code, r.name, r.colour, r.reminder_interval_hours,
                COALESCE(r.blocks_breeding, true), r.is_contagious, true, r.advice,
                r.escalate_after_hours)
        ON CONFLICT (farm_id, code) DO UPDATE
            SET name = EXCLUDED.name,
                colour = EXCLUDED.colour,
                advice = EXCLUDED.advice,
                -- The farm's own figure first; the catalogue's only fills a blank.
                escalate_after_hours = COALESCE(
                    condition_type.escalate_after_hours, EXCLUDED.escalate_after_hours),
                -- A blank in the catalogue is "no opinion" (0041), and the
                -- farm's existing rhythm outranks no opinion.
                reminder_interval_hours = COALESCE(
                    EXCLUDED.reminder_interval_hours,
                    condition_type.reminder_interval_hours),
                blocks_breeding = COALESCE(
                    r.blocks_breeding, condition_type.blocks_breeding),
                is_contagious = EXCLUDED.is_contagious,
                is_active = true
        RETURNING id INTO v_type_id;

        -- Steps that left the catalogue go quiet on the farm. Doses already
        -- given stay in health_event; only the schedule forgets them.
        UPDATE medication_protocol SET is_active = false
         WHERE farm_id = p_farm_id AND condition_type_id = v_type_id AND is_active
           AND name NOT IN (SELECT t.medicine || ' (' || r.name || ')'
                              FROM condition_catalog_treatment t
                             WHERE t.catalog_id = r.id);

        FOR s IN SELECT * FROM condition_catalog_treatment
                  WHERE catalog_id = r.id ORDER BY step LOOP
            -- "medicine (sickness)": the suffix is what keeps two sicknesses
            -- that share a bottle (Xone for wounds AND for retained kits)
            -- apart under UNIQUE (farm_id, name, anchor). The API strips it
            -- back off with a regex, so a sickness NAME must not contain
            -- parentheses of its own.
            INSERT INTO medication_protocol
                (farm_id, name, anchor, start_offset_days, doses, interval_days,
                 dose_note, applies_to, withdrawal_days, notify, condition_type_id,
                 step, route, dose, adults_only, min_age_days, not_when_pregnant)
            VALUES (p_farm_id, s.medicine || ' (' || r.name || ')', 'condition', 0,
                    s.doses, s.interval_days, s.note, 'any', s.withdrawal_days, true,
                    v_type_id, s.step, s.route, s.dose, s.adults_only, s.min_age_days,
                    s.not_when_pregnant)
            ON CONFLICT (farm_id, name, anchor) DO UPDATE
                SET is_active = true,
                    doses = EXCLUDED.doses,
                    interval_days = EXCLUDED.interval_days,
                    dose_note = EXCLUDED.dose_note,
                    withdrawal_days = EXCLUDED.withdrawal_days,
                    condition_type_id = EXCLUDED.condition_type_id,
                    step = EXCLUDED.step,
                    route = EXCLUDED.route,
                    dose = EXCLUDED.dose,
                    adults_only = EXCLUDED.adults_only,
                    min_age_days = EXCLUDED.min_age_days,
                    not_when_pregnant = EXCLUDED.not_when_pregnant;
        END LOOP;
    END LOOP;

    -- Only what the catalogue says exists, exists. A sickness switched off in
    -- the console, or one somebody once added to a farm by hand, leaves the
    -- picker and stops its reminders. History stays.
    UPDATE condition_type ct SET is_active = false
     WHERE ct.farm_id = p_farm_id AND ct.is_active
       AND ct.code NOT IN (SELECT code FROM condition_catalog WHERE is_active);

    UPDATE medication_protocol p SET is_active = false
     WHERE p.farm_id = p_farm_id AND p.is_active AND p.condition_type_id IS NOT NULL
       AND p.condition_type_id IN (SELECT id FROM condition_type
                                    WHERE farm_id = p_farm_id AND NOT is_active);
END $$;

REVOKE ALL ON FUNCTION apply_condition_catalog(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_condition_catalog(uuid) TO rabbitry_admin;

-- ---------------------------------------------------------------------------
-- 3. Around delivery: Calcium Ostovet + Vimeral, mixed together
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_medication_protocols(p_farm_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO medication_protocol
        (farm_id, name, anchor, start_offset_days, doses, interval_days,
         dose_note, applies_to, withdrawal_days, notify, route, dose)
    VALUES
        (p_farm_id, 'Calcium Ostovet + Vimeral (pre-delivery)', 'expected_kindling', -5, 5, 1,
         'Mix the two together. Orally or in her feed, five days, finishing the day before she is due.',
         'doe', NULL, true, 'oral or in feed', '1 ml (0.5 ml of each)'),
        (p_farm_id, 'Calcium Ostovet + Vimeral (post-delivery)', 'kindling', 1, 5, 1,
         'Mix the two together. Orally or in her feed, five days from the day after she kindles.',
         'doe', NULL, true, 'oral or in feed', '1 ml (0.5 ml of each)')
    ON CONFLICT (farm_id, name, anchor) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION seed_medication_protocols(uuid) FROM PUBLIC;

-- The farms that already have the plain Ostovet rows: same course, new name,
-- new dose line. Renamed in place so doses already recorded against the
-- protocol id stay attached to it.
UPDATE medication_protocol
   SET name = 'Calcium Ostovet + Vimeral (pre-delivery)',
       dose_note = 'Mix the two together. Orally or in her feed, five days, finishing the day before she is due.',
       route = 'oral or in feed', dose = '1 ml (0.5 ml of each)'
 WHERE name = 'Ostovet (pre-delivery)' AND anchor = 'expected_kindling';
UPDATE medication_protocol
   SET name = 'Calcium Ostovet + Vimeral (post-delivery)',
       dose_note = 'Mix the two together. Orally or in her feed, five days from the day after she kindles.',
       route = 'oral or in feed', dose = '1 ml (0.5 ml of each)'
 WHERE name = 'Ostovet (post-delivery)' AND anchor = 'kindling';

-- ---------------------------------------------------------------------------
-- 4. New farms: the catalogue, not a hard-coded five
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_new_farm(p_farm_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO shed (farm_id, name) VALUES (p_farm_id, 'Shed A')
    ON CONFLICT (farm_id, name) DO NOTHING;

    INSERT INTO breed (farm_id, name, size_class, doe_first_mating_days, buck_first_mating_days)
    VALUES (p_farm_id, 'New Zealand White', 'medium', 150, 180),
           (p_farm_id, 'Californian',       'medium', 150, 180),
           (p_farm_id, 'Soviet Chinchilla', 'large',  180, 210)
    ON CONFLICT (farm_id, name) DO NOTHING;

    PERFORM seed_medication_protocols(p_farm_id);

    -- Every sickness and every treatment, straight from the chart.
    PERFORM apply_condition_catalog(p_farm_id);
END $$;

-- ---------------------------------------------------------------------------
-- 5. The schedule learns who must not get a dose
-- ---------------------------------------------------------------------------
-- v_medication_due is `SELECT s.*` over the schedule with two columns after,
-- so new schedule columns cannot be appended through CREATE OR REPLACE — they
-- would land in the middle. Drop and rebuild both, and v_daily_list with them.
DROP VIEW IF EXISTS v_daily_list;
DROP VIEW IF EXISTS v_medication_due;

CREATE OR REPLACE VIEW v_medication_schedule AS
WITH anchors AS (
    SELECT m.farm_id, m.doe_id AS rabbit_id, NULL::uuid AS litter_id, m.id AS mating_id,
           'expected_kindling'::protocol_anchor_t AS anchor,
           (m.mated_at)::date + fs.gestation_expected_days AS anchor_date,
           NULL::uuid AS condition_type_id
    FROM mating m
    JOIN farm_settings fs ON fs.farm_id = m.farm_id
    LEFT JOIN litter l    ON l.mating_id = m.id
    WHERE l.id IS NULL
      AND m.outcome NOT IN ('negative', 'pseudopregnant', 'aborted', 'terminated')
  UNION ALL
    SELECT m.farm_id, m.doe_id, NULL::uuid, m.id,
           'mating'::protocol_anchor_t, (m.mated_at)::date, NULL::uuid
    FROM mating m
  UNION ALL
    SELECT l.farm_id, l.doe_id, l.id, l.mating_id,
           'kindling'::protocol_anchor_t, l.kindled_on, NULL::uuid
    FROM litter l
  UNION ALL
    SELECT l.farm_id, l.doe_id, l.id, l.mating_id,
           'weaning'::protocol_anchor_t, l.weaned_on, NULL::uuid
    FROM litter l
    WHERE l.weaned_on IS NOT NULL
  UNION ALL
    SELECT hc.farm_id, hc.rabbit_id, NULL::uuid, NULL::uuid,
           'condition'::protocol_anchor_t, (hc.started_at)::date, hc.condition_type_id
    FROM health_condition hc
    WHERE hc.resolved_at IS NULL AND hc.rabbit_id IS NOT NULL
)
SELECT
    p.id            AS protocol_id,
    p.name          AS protocol_name,
    a.farm_id,
    a.rabbit_id,
    a.litter_id,
    a.mating_id,
    a.anchor,
    a.anchor_date,
    (n + 1)         AS dose_number,
    p.doses         AS total_doses,
    a.anchor_date + p.start_offset_days + (n * p.interval_days) AS due_on,
    p.dose_note,
    p.withdrawal_days,
    p.notify,
    p.step,
    p.route,
    p.dose,
    -- Why this rabbit must NOT be given this dose, or NULL when she may.
    -- The chart's rules, in the order a farmer would ask them.
    CASE
        WHEN p.not_when_pregnant AND r.sex = 'doe'
             AND (SELECT d.state FROM v_doe_reproductive_state d
                   WHERE d.rabbit_id = a.rabbit_id)
                 IN ('MATED', 'PREGNANT', 'NEST_BOX', 'OVERDUE')
            THEN 'she is pregnant'
        -- An unknown birth date means grown (0038): the rule is about kits,
        -- and a rabbit nobody wrote a birthday for is not one.
        WHEN p.min_age_days IS NOT NULL AND r.date_of_birth IS NOT NULL
             AND farm_today(a.farm_id) - r.date_of_birth < p.min_age_days
            THEN 'under ' || (p.min_age_days / 30) || ' months old'
        WHEN p.adults_only
             AND (r.role = 'grower'
                  OR (r.date_of_birth IS NOT NULL
                      AND farm_today(a.farm_id) - r.date_of_birth < 90))
            THEN 'not an adult yet'
    END             AS hold_reason
FROM medication_protocol p
JOIN anchors a
      ON a.anchor = p.anchor
     AND a.farm_id = p.farm_id
     AND (p.condition_type_id IS NULL OR p.condition_type_id = a.condition_type_id)
LEFT JOIN rabbit r ON r.id = a.rabbit_id
CROSS JOIN generate_series(0, p.doses - 1) AS n
WHERE p.is_active;

ALTER VIEW v_medication_schedule SET (security_invoker = true);

CREATE VIEW v_medication_due AS
SELECT s.*,
       (s.due_on - farm_today(s.farm_id)) AS days_until_due,
       (s.due_on < farm_today(s.farm_id) - medication_grace_days()) AS lapsed
FROM v_medication_schedule s
WHERE NOT EXISTS (
    SELECT 1 FROM health_event h
    WHERE h.protocol_id = s.protocol_id
      AND h.rabbit_id   = s.rabbit_id
      AND h.dose_number = s.dose_number
      AND h.occurred_on >= s.due_on - medication_grace_days()
      AND h.occurred_on <= s.due_on + medication_grace_days()
);

CREATE VIEW v_daily_list AS
SELECT
    'medication'                          AS source,
    md.protocol_id::text || ':' || md.rabbit_id::text || ':' || md.dose_number
                                          AS ref_id,
    md.rabbit_id,
    r.tag,
    md.farm_id,
    md.due_on,
    md.due_on::timestamptz                AS due_at,
    md.protocol_name || ' — dose ' || md.dose_number || ' of ' || md.total_doses
      || ' for ' || COALESCE(r.name, r.tag)
                                          AS title,
    CASE WHEN md.due_on < farm_today(md.farm_id) THEN 'critical' ELSE 'high' END AS urgency,
    NULL::text                            AS colour,
    NULL::text                            AS kind,
    md.dose_note                          AS notes,
    md.hold_reason
FROM v_medication_due md
JOIN rabbit r ON r.id = md.rabbit_id
WHERE md.notify
  AND md.due_on <= farm_today(md.farm_id)
  AND NOT md.lapsed
  AND r.status NOT IN ('sold', 'culled', 'dead')

UNION ALL

SELECT
    'task',
    t.id::text,
    t.rabbit_id,
    r.tag,
    t.farm_id,
    t.due_on,
    t.due_on::timestamptz,
    t.title,
    CASE WHEN t.due_on < farm_today(t.farm_id) THEN 'critical' ELSE t.priority::text END,
    NULL::text,
    t.kind::text,
    t.notes,
    NULL::text
FROM task t
LEFT JOIN rabbit r ON r.id = t.rabbit_id
WHERE t.status = 'open'
  AND t.due_on <= farm_today(t.farm_id)

UNION ALL

SELECT
    'condition',
    oc.condition_id::text,
    oc.rabbit_id,
    oc.tag,
    oc.farm_id,
    farm_today(oc.farm_id),
    oc.last_checked_at,
    oc.condition_name || ' — check ' || COALESCE(oc.rabbit_name, oc.tag, 'the litter')
      || ' (' || oc.hours_open || 'h)',
    CASE WHEN oc.needs_escalation THEN 'critical' ELSE 'high' END,
    oc.colour,
    NULL::text,
    NULL::text,
    NULL::text
FROM v_open_conditions oc;

ALTER VIEW v_medication_due SET (security_invoker = true);
ALTER VIEW v_daily_list     SET (security_invoker = true);

-- ---------------------------------------------------------------------------
-- 6. The monthly routine: tasks in the first week, pushed to every phone
-- ---------------------------------------------------------------------------
-- Separate from generate_due_tasks() on purpose: that function is ten jobs
-- long and restating it to add an eleventh is exactly how 0017 once took the
-- scheduler down. The scheduler calls both.
-- p_today is for tests only: the scheduler passes nothing and the farm's own
-- day applies. A test cannot wait for the 5th of the month to find out what
-- happens on the 5th.
CREATE OR REPLACE FUNCTION generate_routine_tasks(p_today date DEFAULT NULL) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    INSERT INTO task (farm_id, kind, title, notes, due_on, priority, generated_key)
    SELECT f.id, 'medicate',
           rc.title,
           rc.detail
             || ' Every day: Agrimin Forte 1 g per adult breeder in the morning feed;'
             || ' Calcium Ostovet + Vimeral may go into the daily feed for the whole herd.',
           ms.month_start + (rc.day - 1),
           'high',
           'routine:' || f.id || ':' || to_char(ms.month_start, 'YYYY-MM') || ':' || rc.step
    FROM farm f
    CROSS JOIN LATERAL (
        SELECT date_trunc('month', COALESCE(p_today, farm_today(f.id)))::date AS month_start,
               COALESCE(p_today, farm_today(f.id)) AS today
    ) ms
    JOIN routine_catalog rc ON rc.is_active
    -- Raised in the first week only. A farm that joins on the 5th gets days
    -- 5 to 7 of this month; one that joins on the 20th waits for next month
    -- rather than being handed a week of overdue work on its first morning.
    WHERE ms.today - ms.month_start BETWEEN 0 AND 6
      AND ms.month_start + (rc.day - 1) >= ms.today
      -- No rabbits, no round.
      AND EXISTS (SELECT 1 FROM rabbit r
                   WHERE r.farm_id = f.id AND r.status IN ('active', 'quarantine'))
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- Routine days are told to the phone the morning they are due, once, outside
-- quiet hours. generate_notifications() only pushes CRITICAL tasks; a routine
-- day is not an emergency, but it is the whole point of the routine, so it
-- gets its own arm rather than a promotion to critical.
CREATE OR REPLACE FUNCTION generate_routine_notifications(p_today date DEFAULT NULL) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    INSERT INTO notification (farm_id, kind, title, body, urgency, employee_id, dedupe_key)
    SELECT t.farm_id, 'task_due', t.title,
           CASE WHEN t.due_on < COALESCE(p_today, farm_today(t.farm_id))
                THEN 'Overdue since ' || t.due_on || '. ' ELSE 'Whole farm, today. ' END
             || COALESCE(t.notes, ''),
           'high',
           NULL,   -- everyone at the farm: the round is nobody's shed in particular
           'task:' || t.id || ':' || COALESCE(p_today, farm_today(t.farm_id))
    FROM task t
    WHERE t.status = 'open'
      AND t.generated_key LIKE 'routine:%'
      AND t.due_on <= COALESCE(p_today, farm_today(t.farm_id))
      AND NOT farm_is_quiet(t.farm_id)
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;


-- A held dose must not buzz the phone either. This is 0017's function with
-- one line added to the medication arm (`AND md.hold_reason IS NULL`);
-- restated whole, because plpgsql cannot be patched.
CREATE OR REPLACE FUNCTION generate_notifications() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    n int := 0;
    step int;
BEGIN
    -- 1. Open health conditions, every `reminder_interval_hours` since the LAST
    --    OBSERVATION. See 0017 for the slot arithmetic.
    INSERT INTO notification (farm_id, kind, title, body, urgency, rabbit_id,
                              employee_id, dedupe_key)
    SELECT oc.farm_id, 'condition_reminder',
           oc.condition_name || ' — check ' || COALESCE(oc.rabbit_name, oc.tag, 'the litter'),
           'Open ' || oc.hours_open || ' hours. Still going, or stopped?',
           CASE WHEN oc.needs_escalation THEN 'critical' ELSE 'high' END::task_priority_t,
           oc.rabbit_id,
           caretaker_for_rabbit(oc.rabbit_id),
           'cond:' || oc.condition_id || ':' || extract(epoch from oc.last_checked_at)::bigint
             || ':' || slot.n
    FROM v_open_conditions oc
    CROSS JOIN LATERAL (
        SELECT floor(
            EXTRACT(epoch FROM now() - oc.last_checked_at)
            / NULLIF(EXTRACT(epoch FROM oc.next_reminder_at - oc.last_checked_at), 0)
        )::int AS n
    ) slot
    WHERE oc.reminder_due
      AND slot.n >= 1
      AND NOT (oc.respect_quiet_hours AND farm_is_quiet(oc.farm_id))
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 2. Escalation — open past the threshold, told once, to the manager.
    INSERT INTO notification (farm_id, kind, title, body, urgency, rabbit_id,
                              employee_id, dedupe_key)
    SELECT oc.farm_id, 'condition_escalation',
           COALESCE(oc.rabbit_name, oc.tag, 'A litter') || ' still has '
             || lower(oc.condition_name) || ' after ' || oc.hours_open || ' hours',
           'Nobody has resolved this. It may need a vet.',
           'critical', oc.rabbit_id,
           (SELECT id FROM employee
            WHERE farm_id = oc.farm_id AND role IN ('manager','owner') AND is_active
            ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END LIMIT 1),
           'escalate:' || oc.condition_id
    FROM v_open_conditions oc
    WHERE oc.needs_escalation
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 3. Outbreak — two or more contagious cases in one shed.
    INSERT INTO notification (farm_id, kind, title, body, urgency, employee_id, dedupe_key)
    SELECT cc.farm_id, 'outbreak',
           cc.open_cases || ' cases of ' || lower(cc.condition_name)
             || ' in ' || cc.shed_name,
           'This spreads through shared feed, water and bedding. Check the whole row.',
           'critical',
           (SELECT id FROM employee
            WHERE farm_id = cc.farm_id AND role IN ('manager','owner') AND is_active
            ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END LIMIT 1),
           'outbreak:' || cc.shed_id || ':' || cc.condition_code || ':'
             || farm_today(cc.farm_id)
    FROM v_condition_clusters cc
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 4. Critical tasks due today. Once per task per day, never in quiet hours.
    INSERT INTO notification (farm_id, kind, title, body, urgency, rabbit_id,
                              employee_id, dedupe_key)
    SELECT t.farm_id, 'task_due', t.title,
           CASE WHEN t.due_on < farm_today(t.farm_id) THEN 'Overdue since ' || t.due_on
                ELSE 'Due today' END,
           t.priority, t.rabbit_id, t.assigned_to,
           'task:' || t.id || ':' || farm_today(t.farm_id)
    FROM task t
    WHERE t.status = 'open'
      AND t.priority = 'critical'
      AND t.due_on <= farm_today(t.farm_id)
      AND NOT farm_is_quiet(t.farm_id)
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 5. Medication doses due today — except one the rules hold back. A phone
    --    that buzzes "give Hitech to Lakshmi" while the screen says she is
    --    pregnant is the exact contradiction this migration exists to remove.
    INSERT INTO notification (farm_id, kind, title, body, urgency, rabbit_id,
                              employee_id, dedupe_key)
    SELECT md.farm_id, 'medication_due',
           md.protocol_name || ' — dose ' || md.dose_number || ' of ' || md.total_doses
             || ' for ' || COALESCE(r.name, r.tag),
           COALESCE(md.dose || '. ', '') || COALESCE(md.dose_note, ''),
           CASE WHEN md.due_on < farm_today(md.farm_id) THEN 'critical' ELSE 'high' END::task_priority_t,
           md.rabbit_id, caretaker_for_rabbit(md.rabbit_id),
           'med:' || md.protocol_id || ':' || md.rabbit_id || ':' || md.dose_number
             || ':' || farm_today(md.farm_id)
    FROM v_medication_due md
    JOIN rabbit r ON r.id = md.rabbit_id
    WHERE md.notify
      AND md.due_on <= farm_today(md.farm_id)
      AND NOT md.lapsed
      AND md.hold_reason IS NULL
      AND r.status NOT IN ('sold', 'culled', 'dead')
      AND NOT farm_is_quiet(md.farm_id)
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- 7. The chart itself
-- ---------------------------------------------------------------------------
-- "Whatever we had set before, remove it." Rows, not just flags: the old
-- catalogue is gone, and the farms find out through apply_condition_catalog
-- below, which retires anything not on this list.
DELETE FROM condition_catalog;

INSERT INTO condition_catalog
    (code, name, colour, reminder_interval_hours, blocks_breeding, is_contagious,
     escalate_after_hours, advice)
VALUES
 ('loose_motion',  'Loose motion',
  '#EA580C', 2,  true,  true, 24,
  'Dysentery — sticky, watery stool. Stop green fodder immediately. Give one dose; if it persists the next day, wait and see — it usually clears in two doses.'),
 ('cold',          'Cold — sneezing or a wet, runny nose',
  '#2563EB', 12, true,  true, 48,
  'Give once. If not cured after 24 hours, repeat the dose. For a severe cold, also nebulize (steam) 2–3 times a day.'),
 ('fungus',        'Fungus on the skin — ears, nose or paws',
  '#7C3AED', 24, true,  true, NULL,
  'Dip a toothbrush into the lotion and apply it directly onto the affected patch, once a day for 2–3 days.'),
 ('fungus_severe', 'Severe fungus — ears, nose or paws',
  '#5B21B6', 24, true,  true, 48,
  'ADULTS ONLY — never for kits or a pregnant doe. Inject under the skin, horizontally behind the neck. Never on consecutive days: wait 48 hours before a second dose if not cured.'),
 ('fever',         'Fever / dullness — not eating, sitting in a corner, hot ears',
  '#DC2626', 6,  true,  false, 12,
  'Inject when the ears feel hot. Belamyl MUST follow exactly one hour after the Gentamicin + Dexamethasone shot.'),
 ('injury',        'Wound — wire cut or a fight',
  '#B45309', 24, true,  false, 48,
  'Xone must be mixed before injecting — combine the powder with distilled water.'),
 ('retained_kits', 'Failed to deliver after 35 days — kits retained in the womb',
  '#9F1239', 12, true,  false, 12,
  'Retained or dead kits. Xone must be mixed before injecting — combine the powder with distilled water.'),
 ('drooling',      'Drooling / water from the mouth — ate something wrong',
  '#0891B2', 12, true,  false, 24,
  'Give the Taxim injection. Check what she has been eating.'),
 ('infertile',     'Not fertile / not coming into heat',
  '#A16207', NULL, true, false, NULL,
  'Adult breeders only. Mix the powder into the morning feed every day until she comes into heat or he covers.'),
 ('stress',        'Shifting stress or new feed — digestion upset',
  '#65A30D', 24, false, false, NULL,
  'A pinch straight into the mouth, in the morning on an empty stomach. Safe for all rabbits.'),
 ('sudden_deaths', 'EMERGENCY — sudden deaths on the farm, 3 or 4 at once',
  '#7F1D1D', 6,  true,  true, 6,
  'Mix Lexin into the drinking water for the WHOLE farm immediately. Suspect the feed or the water.');

INSERT INTO condition_catalog_treatment
    (catalog_id, step, medicine, route, dose, doses, interval_days, note,
     adults_only, min_age_days, not_when_pregnant)
SELECT c.id, t.step, t.medicine, t.route, t.dose, t.doses, t.interval_days, t.note,
       t.adults_only, t.min_age_days, t.not_when_pregnant
FROM (VALUES
 ('loose_motion',  1, 'O2 M',                       'oral',                 '1 ml',
    2, 1, 'Give one dose now. If loose motion persists tomorrow, give the second; it usually clears in two.',
    false, NULL, false),
 ('cold',          1, 'Meriquin',                   'oral',                 '1 ml',
    2, 1, 'Give once. Repeat after 24 hours only if not cured.',
    false, NULL, false),
 ('fungus',        1, 'Gamma Scab Lotion',          'topical',              'as needed',
    3, 1, 'Once a day for 2–3 days, on the affected area, with a toothbrush dipped in the lotion.',
    false, NULL, false),
 ('fungus_severe', 1, 'Hitech (injection)',         'subcutaneous, behind the neck', '0.3 ml',
    2, 2, 'Single dose. Repeat after 48 hours only if not cured — never on consecutive days.',
    true, 90, true),
 ('fever',         1, 'Gentamicin + Dexamethasone', 'injection',            '0.3 ml (0.15 ml + 0.15 ml)',
    1, 1, 'Inject when the ears feel hot. Belamyl follows exactly one hour later.',
    false, NULL, false),
 ('fever',         2, 'Belamyl (B-complex)',        'injection',            '0.3 ml',
    1, 1, 'EXACTLY one hour after the Gentamicin + Dexamethasone shot.',
    false, NULL, false),
 ('injury',        1, 'Xone / X1 / C1',             'injection (reconstituted)', '0.3 ml',
    1, 1, 'Reconstitute the powder with distilled water first.',
    false, NULL, false),
 ('retained_kits', 1, 'Xone / X1 / C1',             'injection (reconstituted)', '0.3 ml',
    1, 1, 'Reconstitute the powder with distilled water first.',
    false, NULL, false),
 ('drooling',      1, 'Taxim',                      'injection',            '0.3 ml',
    1, 1, NULL,
    false, NULL, false),
 ('infertile',     1, 'Agrimin Forte',              'powder in morning feed', '1 g',
    30, 1, 'Every morning, in the feed, until she comes into heat or he covers.',
    true, NULL, false),
 ('stress',        1, 'Gutwell',                    'powder into the mouth', 'a pinch',
    3, 1, 'Morning, on an empty stomach, three days running.',
    false, NULL, false),
 ('sudden_deaths', 1, 'Lexin / Mix Powder',         'in the drinking water, whole farm', '20 g per 100 litres',
    1, 1, 'Immediately, for the whole farm.',
    false, NULL, false)
) AS t (code, step, medicine, route, dose, doses, interval_days, note,
        adults_only, min_age_days, not_when_pregnant)
JOIN condition_catalog c ON c.code = t.code;

-- The Monthly Routine sheet, day by day. Gutwell's "any 3 days" lands on
-- days 4–6 beside Liv 52: both are morning rounds, but only Hitech and Gutwell
-- want an empty stomach, so they must not share a morning with each other.
INSERT INTO routine_catalog (step, day, medicine, dose, title, detail) VALUES
 (1, 1, 'Hitech (oral)', '1 ml, oral, morning, empty stomach',
  'Monthly round — Hitech (oral) 1 ml, day 1 of 3: every rabbit, morning, empty stomach',
  'De-worming and fungus. SKIP pregnant does and kits under 3 months.'),
 (2, 2, 'Hitech (oral)', '1 ml, oral, morning, empty stomach',
  'Monthly round — Hitech (oral) 1 ml, day 2 of 3: every rabbit, morning, empty stomach',
  'Second consecutive day. SKIP pregnant does and kits under 3 months.'),
 (3, 3, 'Hitech (oral)', '1 ml, oral, morning, empty stomach',
  'Monthly round — Hitech (oral) 1 ml, day 3 of 3: every rabbit, morning, empty stomach',
  'Third and final day. SKIP pregnant does and kits under 3 months.'),
 (4, 4, 'Liv 52', '1 ml, oral',
  'Monthly round — Liv 52 1 ml oral, day 1 of 3: liver tonic after the Hitech course',
  'Not orally for kits under 3 months — mixed into their feed is fine.'),
 (5, 5, 'Liv 52', '1 ml, oral',
  'Monthly round — Liv 52 1 ml oral, day 2 of 3',
  'Second consecutive day. Not orally for kits under 3 months — in feed is fine.'),
 (6, 6, 'Liv 52', '1 ml, oral',
  'Monthly round — Liv 52 1 ml oral, day 3 of 3',
  'Third and final day. Not orally for kits under 3 months — in feed is fine.'),
 (7, 4, 'Gutwell', 'a pinch, into the mouth, morning, empty stomach',
  'Monthly round — Gutwell, a pinch into the mouth, day 1 of 3: morning, empty stomach',
  'Probiotic. Safe for every rabbit.'),
 (8, 5, 'Gutwell', 'a pinch, into the mouth, morning, empty stomach',
  'Monthly round — Gutwell, a pinch into the mouth, day 2 of 3: morning, empty stomach',
  'Second consecutive day. Safe for every rabbit.'),
 (9, 6, 'Gutwell', 'a pinch, into the mouth, morning, empty stomach',
  'Monthly round — Gutwell, a pinch into the mouth, day 3 of 3: morning, empty stomach',
  'Third and final day. Safe for every rabbit.'),
 (10, 7, 'Tetracycline', '1 g per litre of drinking water',
  'Monthly round — Tetracycline in the drinking water, 1 g per litre (100 g per 100 L)',
  'Water purification. Critical in the rainy season.');

-- ---------------------------------------------------------------------------
-- 8. Onto every farm, and prove it
-- ---------------------------------------------------------------------------
DO $$
DECLARE bad int; f record;
BEGIN
    FOR f IN SELECT id FROM farm LOOP
        PERFORM apply_condition_catalog(f.id);
    END LOOP;

    -- Every farm offers exactly the chart, nothing else.
    SELECT count(*) INTO bad
      FROM condition_type ct
     WHERE ct.is_active
       AND ct.code NOT IN (SELECT code FROM condition_catalog WHERE is_active);
    IF bad > 0 THEN
        RAISE EXCEPTION '% sickness(es) still active on farms that are not on the chart', bad;
    END IF;

    SELECT count(*) INTO bad
      FROM farm fm
     CROSS JOIN condition_catalog c
     WHERE NOT EXISTS (SELECT 1 FROM condition_type ct
                        WHERE ct.farm_id = fm.id AND ct.code = c.code AND ct.is_active);
    IF bad > 0 THEN
        RAISE EXCEPTION '% chart sickness(es) missing from some farm', bad;
    END IF;

    -- Fever is two steps on every farm; a single-medicine press would give one.
    SELECT count(*) INTO bad
      FROM farm fm
     WHERE (SELECT count(*) FROM medication_protocol p
              JOIN condition_type ct ON ct.id = p.condition_type_id
             WHERE p.farm_id = fm.id AND ct.code = 'fever' AND p.is_active) <> 2;
    IF bad > 0 THEN
        RAISE EXCEPTION 'fever is not a two-step treatment on % farm(s)', bad;
    END IF;

    -- Loose motion keeps its two-hourly check on every farm that had one.
    SELECT count(*) INTO bad
      FROM condition_type ct
     WHERE ct.code = 'loose_motion' AND ct.reminder_interval_hours IS DISTINCT FROM 2;
    IF bad > 0 THEN
        RAISE EXCEPTION 'loose motion lost its two-hourly check on % farm(s)', bad;
    END IF;

    -- No farm is left with a protocol pointing at a retired sickness.
    SELECT count(*) INTO bad
      FROM medication_protocol p
      JOIN condition_type ct ON ct.id = p.condition_type_id
     WHERE p.is_active AND NOT ct.is_active;
    IF bad > 0 THEN
        RAISE EXCEPTION '% live protocol(s) hang off a retired sickness', bad;
    END IF;
END $$;
