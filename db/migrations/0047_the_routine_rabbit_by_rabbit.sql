-- ============================================================================
-- 0047  The monthly routine, rabbit by rabbit
--
-- "Don't consider the whole farm — we cannot give Hitech to a pregnant
-- female." One task for the whole farm cannot say which rabbits to skip, so
-- Hitech, Liv 52 and Gutwell stop being tasks and become what a medicine
-- already is here: a per-rabbit dose on a schedule, with the chart's holds
-- applied to each rabbit alone, its own row and tick on Today, its own push
-- to the phone. The mechanism is 0017's medication protocol with a new anchor
-- (0046): the first of the current month, for every rabbit in the herd.
--
-- Tetracycline goes into the drinking water. It stays one whole-farm task.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The catalogue says which steps are per rabbit, and the rules for each
-- ---------------------------------------------------------------------------
ALTER TABLE routine_catalog
    ADD COLUMN IF NOT EXISTS per_rabbit        boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS route             text,
    ADD COLUMN IF NOT EXISTS not_when_pregnant boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS min_age_days      int,
    ADD COLUMN IF NOT EXISTS adults_only       boolean NOT NULL DEFAULT false;

-- Hitech: de-worming; never in pregnancy, never under 3 months.
UPDATE routine_catalog
   SET per_rabbit = true, route = 'oral', not_when_pregnant = true, min_age_days = 90
 WHERE step IN (1, 2, 3);
-- Liv 52: fine in pregnancy; not by mouth for a kit (in its feed is fine,
-- which the hold text says).
UPDATE routine_catalog
   SET per_rabbit = true, route = 'oral', min_age_days = 90
 WHERE step IN (4, 5, 6);
-- Gutwell: a probiotic, safe for every rabbit.
UPDATE routine_catalog
   SET per_rabbit = true, route = 'oral'
 WHERE step IN (7, 8, 9);
-- Tetracycline (step 10) stays whole-farm: per_rabbit false.

-- ---------------------------------------------------------------------------
-- 2. Pressing the per-rabbit steps onto a farm as month-anchored protocols
-- ---------------------------------------------------------------------------
-- One protocol per medicine ("Monthly round — Hitech"), its doses on the
-- consecutive days the catalogue lists. The parenthetical after a medicine
-- name is dropped: the API reads "medicine (sickness)" as a sickness suffix.
CREATE OR REPLACE FUNCTION apply_routine_catalog(p_farm_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m record;
BEGIN
    FOR m IN
        SELECT regexp_replace(medicine, '\s*\(.*\)\s*$', '') AS medicine,
               min(day) AS first_day, count(*) AS doses, min(step) AS step,
               (array_agg(dose ORDER BY step))[1]            AS dose,
               (array_agg(detail ORDER BY step))[1]          AS detail,
               (array_agg(route ORDER BY step))[1]           AS route,
               bool_or(not_when_pregnant)                     AS not_when_pregnant,
               max(min_age_days)                              AS min_age_days,
               bool_or(adults_only)                           AS adults_only
        FROM routine_catalog
        WHERE is_active AND per_rabbit
        GROUP BY 1
    LOOP
        INSERT INTO medication_protocol
            (farm_id, name, anchor, start_offset_days, doses, interval_days,
             dose_note, applies_to, withdrawal_days, notify,
             step, route, dose, adults_only, min_age_days, not_when_pregnant)
        VALUES (p_farm_id, 'Monthly round — ' || m.medicine, 'month', m.first_day - 1,
                m.doses, 1, m.detail, 'any', NULL, true,
                m.step, m.route, m.dose, m.adults_only, m.min_age_days, m.not_when_pregnant)
        ON CONFLICT (farm_id, name, anchor) DO UPDATE
            SET is_active = true,
                start_offset_days = EXCLUDED.start_offset_days,
                doses = EXCLUDED.doses,
                interval_days = EXCLUDED.interval_days,
                dose_note = EXCLUDED.dose_note,
                notify = true,
                step = EXCLUDED.step,
                route = EXCLUDED.route,
                dose = EXCLUDED.dose,
                adults_only = EXCLUDED.adults_only,
                min_age_days = EXCLUDED.min_age_days,
                not_when_pregnant = EXCLUDED.not_when_pregnant;
    END LOOP;

    -- A medicine that left the routine goes quiet. Doses given stay in
    -- health_event; only the schedule forgets them.
    UPDATE medication_protocol SET is_active = false
     WHERE farm_id = p_farm_id AND anchor = 'month' AND is_active
       AND name NOT IN (SELECT 'Monthly round — ' || regexp_replace(medicine, '\s*\(.*\)\s*$', '')
                          FROM routine_catalog WHERE is_active AND per_rabbit);
END $$;
GRANT EXECUTE ON FUNCTION apply_routine_catalog(uuid) TO rabbitry_admin;

-- ---------------------------------------------------------------------------
-- 3. The schedule: every rabbit in the herd, anchored to the first of the month
-- ---------------------------------------------------------------------------
-- 0043's view with one more anchor in the CTE. Restated whole, because a view
-- cannot be patched.
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
  UNION ALL
    -- The monthly round: every rabbit in the herd, this month. The holds
    -- below decide, rabbit by rabbit, who is left out.
    SELECT r.farm_id, r.id, NULL::uuid, NULL::uuid,
           'month'::protocol_anchor_t,
           date_trunc('month', farm_today(r.farm_id))::date, NULL::uuid
    FROM rabbit r
    WHERE r.status IN ('active', 'quarantine')
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

-- ---------------------------------------------------------------------------
-- 4. Whole-farm tasks only for the steps that are whole-farm
-- ---------------------------------------------------------------------------
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
    JOIN routine_catalog rc ON rc.is_active AND NOT rc.per_rabbit
    -- Only the days still ahead. A farm that joins on the 20th waits for next
    -- month rather than being handed the month's missed rounds as overdue work.
    WHERE ms.month_start + (rc.day - 1) >= ms.today
      -- No rabbits, no round.
      AND EXISTS (SELECT 1 FROM rabbit r
                   WHERE r.farm_id = f.id AND r.status IN ('active', 'quarantine'))
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- Whole-farm tasks already raised this month for steps that are now per
-- rabbit would sit on Today beside the per-rabbit rows. They go.
DELETE FROM task t
 USING routine_catalog rc
 WHERE t.status = 'open'
   AND rc.per_rabbit
   AND t.generated_key LIKE 'routine:%:' || rc.step;

-- ---------------------------------------------------------------------------
-- 5. New farms get the routine with the catalogue; existing farms get it now
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
    -- And the monthly round, rabbit by rabbit.
    PERFORM apply_routine_catalog(p_farm_id);
END $$;

DO $$
BEGIN
    -- Held FOR KEY SHARE first, or this deadlocks against a farm delete.
    PERFORM id FROM farm ORDER BY id FOR KEY SHARE;
    PERFORM apply_routine_catalog(id) FROM farm;
END $$;
