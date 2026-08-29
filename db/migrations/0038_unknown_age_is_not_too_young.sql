-- ============================================================================
-- A doe with no birth date is of unknown age, not too young to breed
--
-- `old_enough` was written as
--
--     r.date_of_birth IS NOT NULL AND (farm_today(...) - r.date_of_birth) >= ...
--
-- which reads as "we know she is old enough". But the state machine's first
-- branch is `WHEN NOT old_enough THEN 'GROWING'`, and there it was being read
-- as "she is too young" — so a doe whose birth date nobody recorded was pinned
-- to GROWING permanently. GROWING appears in neither v_ready_to_mate nor
-- v_pregnant_does.
--
-- date_of_birth is optional when adding an animal, so this was the ordinary
-- case, not an edge case: a farm could enter thirty-five does and read
-- "Ready to mate 0". Worse, a mating recorded against such a doe was written
-- to the table and then filtered out of every view that would have displayed
-- it, so on the screen it simply vanished — no error, no row, no trace.
--
-- Unknown age now means "assume she is grown", which is what a farmer standing
-- in front of an adult rabbit already assumes. The screens flag her separately
-- (age_unknown, derived in the API from rabbit.date_of_birth) so the guess is
-- always visible and can be corrected by filling the date in.
--
-- A doe with a birth date that really is too young is unaffected: her date is
-- known, the comparison runs as before, and she stays out of the queue.
--
-- Only this one expression changes. Column names, types and order are
-- untouched, so CREATE OR REPLACE is legal here and the three dependent views
-- (v_pregnant_does, v_pregnancy_summary, v_ready_to_mate) need no change.
-- ============================================================================

CREATE OR REPLACE VIEW v_doe_reproductive_state AS
 WITH last_mating AS (
         SELECT DISTINCT ON (m.doe_id) m.doe_id,
            m.id AS mating_id,
            m.buck_id,
            m.mated_at,
            m.outcome
           FROM mating m
          ORDER BY m.doe_id, m.mated_at DESC
        ), last_check AS (
         SELECT DISTINCT ON (pc.mating_id) pc.mating_id,
            pc.result,
            pc.checked_on
           FROM pregnancy_check pc
          ORDER BY pc.mating_id, pc.checked_on DESC, pc.created_at DESC
        ), last_litter AS (
         SELECT DISTINCT ON (l.doe_id) l.doe_id,
            l.id AS litter_id,
            l.mating_id,
            l.kindled_on,
            l.weaned_on
           FROM litter l
          ORDER BY l.doe_id, l.kindled_on DESC
        ), last_pseudo AS (
         SELECT mating.doe_id,
            max(mating.mated_at::date) AS on_date
           FROM mating
          WHERE mating.outcome = 'pseudopregnant'::mating_outcome_t
          GROUP BY mating.doe_id
        ), last_failed AS (
         SELECT mating.doe_id,
            max(mating.mated_at::date) AS on_date
           FROM mating
          WHERE mating.outcome = ANY (ARRAY['negative'::mating_outcome_t, 'aborted'::mating_outcome_t])
          GROUP BY mating.doe_id
        ), base AS (
         SELECT r.id AS rabbit_id,
            r.farm_id,
            r.tag,
            lm.mating_id,
            lm.buck_id,
            lm.mated_at::date AS last_service_on,
            farm_today(r.farm_id) - lm.mated_at::date AS gestation_day,
            lc.result AS last_check_result,
            lc.checked_on AS last_check_on,
            ll.litter_id,
            ll.mating_id AS litter_mating_id,
            ll.kindled_on,
            ll.weaned_on,
            farm_today(r.farm_id) - ll.kindled_on AS days_since_last_kindling,
            farm_today(r.farm_id) - ll.weaned_on AS days_since_weaning,
            farm_today(r.farm_id) - lp.on_date AS days_since_pseudopregnancy,
            farm_today(r.farm_id) - lf.on_date AS days_since_failed_service,
            (r.date_of_birth IS NULL
             OR (farm_today(r.farm_id) - r.date_of_birth) >= COALESCE(b.doe_first_mating_days, 150)) AS old_enough,
            fs.gestation_window_start_day,
            fs.gestation_overdue_day,
            fs.first_check_window_end
           FROM rabbit r
             JOIN farm_settings fs ON fs.farm_id = r.farm_id
             LEFT JOIN breed b ON b.id = r.breed_id
             LEFT JOIN last_mating lm ON lm.doe_id = r.id
             LEFT JOIN last_check lc ON lc.mating_id = lm.mating_id
             LEFT JOIN last_litter ll ON ll.doe_id = r.id
             LEFT JOIN last_pseudo lp ON lp.doe_id = r.id
             LEFT JOIN last_failed lf ON lf.doe_id = r.id
          WHERE r.sex = 'doe'::sex_t AND (r.status = ANY (ARRAY['active'::rabbit_status_t, 'quarantine'::rabbit_status_t]))
        ), resolved AS (
         SELECT base.rabbit_id,
            base.farm_id,
            base.tag,
            base.mating_id,
            base.buck_id,
            base.last_service_on,
            base.gestation_day,
            base.last_check_result,
            base.last_check_on,
            base.litter_id,
            base.litter_mating_id,
            base.kindled_on,
            base.weaned_on,
            base.days_since_last_kindling,
            base.days_since_weaning,
            base.days_since_pseudopregnancy,
            base.days_since_failed_service,
            base.old_enough,
            base.gestation_window_start_day,
            base.gestation_overdue_day,
            base.first_check_window_end,
                CASE
                    WHEN NOT base.old_enough THEN 'GROWING'::text
                    WHEN base.mating_id IS NULL THEN 'READY'::text
                    WHEN base.litter_mating_id = base.mating_id AND base.weaned_on IS NULL THEN 'LACTATING'::text
                    WHEN base.litter_mating_id = base.mating_id THEN 'RESTING'::text
                    WHEN base.last_check_result = 'negative'::check_result_t THEN 'OPEN'::text
                    WHEN p.outcome_is_pseudo THEN 'PSEUDOPREGNANT'::text
                    WHEN base.gestation_day >= base.gestation_overdue_day THEN 'OVERDUE'::text
                    WHEN base.gestation_day >= base.gestation_window_start_day THEN 'NEST_BOX'::text
                    WHEN base.last_check_result = 'positive'::check_result_t THEN 'PREGNANT'::text
                    WHEN base.gestation_day <= base.first_check_window_end THEN 'MATED'::text
                    ELSE 'PREGNANT'::text
                END AS state
           FROM base
             CROSS JOIN LATERAL ( SELECT base.days_since_pseudopregnancy IS NOT NULL AND base.days_since_pseudopregnancy < 18 AS outcome_is_pseudo) p
        )
 SELECT rabbit_id,
    farm_id,
    tag,
    mating_id,
    buck_id,
    last_service_on,
    gestation_day,
    last_check_result,
    last_check_on,
    litter_id,
    litter_mating_id,
    kindled_on,
    weaned_on,
    days_since_last_kindling,
    days_since_weaning,
    days_since_pseudopregnancy,
    days_since_failed_service,
    old_enough,
    gestation_window_start_day,
    gestation_overdue_day,
    first_check_window_end,
    state,
        CASE
            WHEN (state = ANY (ARRAY['PREGNANT'::text, 'NEST_BOX'::text])) AND last_check_result = 'positive'::check_result_t THEN 'confirmed'::text
            WHEN state = ANY (ARRAY['PREGNANT'::text, 'NEST_BOX'::text]) THEN 'presumed'::text
            ELSE NULL::text
        END AS confidence,
        CASE
            WHEN state = ANY (ARRAY['PREGNANT'::text, 'NEST_BOX'::text, 'MATED'::text]) THEN last_service_on + 31
            ELSE NULL::date
        END AS expected_kindling_on,
        CASE
            WHEN state = ANY (ARRAY['PREGNANT'::text, 'NEST_BOX'::text, 'MATED'::text]) THEN last_service_on + 28
            ELSE NULL::date
        END AS window_start_on,
        CASE
            WHEN state = ANY (ARRAY['PREGNANT'::text, 'NEST_BOX'::text, 'MATED'::text]) THEN last_service_on + 34
            ELSE NULL::date
        END AS window_end_on
   FROM resolved;


-- 0008 made every view security_invoker; CREATE OR REPLACE keeps reloptions,
-- but state it outright so a fresh build from migrations cannot drift.
ALTER VIEW v_doe_reproductive_state SET (security_invoker = true);
