-- ============================================================================
-- A recorded mating counts as a pregnancy straight away
--
-- Requested by the farm owner, and this migration is the whole of that change.
--
-- What it changes, and the trade being made deliberately:
--
-- MATED is the window between the service and the palpation, roughly day 0 to
-- day 12. The engine kept it apart from PREGNANT because until somebody puts
-- hands on her nobody actually knows she caught, and a count that says
-- "pregnant" when it means "served" will overstate the herd every time a
-- service fails. Migration 0038 surfaced MATED as its own list for that reason.
--
-- The farm wants the numeral to move when the work is done, not twelve days
-- later, so MATED now counts as a pregnancy of confidence 'presumed'. Nothing
-- about the underlying record changes: she is still MATED, palpation is still
-- the thing that confirms her, and a negative palpation still takes her out and
-- puts her back in the mating queue. What changes is only which bucket the
-- dashboard counts her in before that happens.
--
-- The honesty that was in the state split now lives in the confirmed/presumed
-- split, which the app already never merges: 'presumed' means exactly "not
-- palpated", and the breeding screen already says out loud that presumed
-- pregnancies are where losses hide.
--
-- Column names, types and order are unchanged in both views, so CREATE OR
-- REPLACE is legal and v_pregnancy_summary — which reads v_pregnant_does and
-- therefore starts counting these does automatically — needs no change.
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
            r.date_of_birth IS NULL OR (farm_today(r.farm_id) - r.date_of_birth) >= COALESCE(b.doe_first_mating_days, 150) AS old_enough,
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
            WHEN (state = ANY (ARRAY['PREGNANT'::text, 'NEST_BOX'::text, 'MATED'::text])) AND last_check_result = 'positive'::check_result_t THEN 'confirmed'::text
            WHEN state = ANY (ARRAY['PREGNANT'::text, 'NEST_BOX'::text, 'MATED'::text]) THEN 'presumed'::text
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

ALTER VIEW v_doe_reproductive_state SET (security_invoker = true);


-- The pregnancy list itself. MATED joins PREGNANT and NEST_BOX; the three
-- states it excludes are still excluded, so a doe who lost it, was found
-- empty, or has already kindled does not reappear here.
CREATE OR REPLACE VIEW v_pregnant_does AS
SELECT *
FROM v_doe_reproductive_state
WHERE state IN ('PREGNANT', 'NEST_BOX', 'MATED');

ALTER VIEW v_pregnant_does SET (security_invoker = true);
