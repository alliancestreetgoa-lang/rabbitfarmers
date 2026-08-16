-- ============================================================================
-- Count days in the farm's day, not the server's
--
-- Migration 0002 says so at the top of the file:
--
--     NOTE: current_date is used for readability. In production, replace with
--     (now() AT TIME ZONE farm.timezone)::date so day counts follow farm-local
--     days rather than the server's.
--
-- That never happened, and migration 0019 only fixed the two views the daily
-- list reads. The rest of the breeding engine still counts in UTC.
--
-- It matters most in the one place the whole product turns on. `gestation_day`
-- is current_date minus the mating date, and it decides PALPATE, NEST_BOX and
-- OVERDUE. For a farm in Asia/Kolkata, from midnight to 05:30 local the server
-- is still on yesterday, so a doe on day 28 reads as day 27 — no nest box, on
-- the morning the nest box is the entire job. West of UTC it advances a day
-- early instead and calls a healthy doe overdue.
--
-- Same for how old a rabbit is (which gates first mating), how long since she
-- kindled or weaned (which gates rebreeding), and how many services a buck has
-- had today (which gates his quota — a buck could be worked twice over a
-- five-hour window where "today" had not started yet).
--
-- farm_today(farm_id) is STABLE and reads one row from farm; every one of these
-- views already joins the farm or carries farm_id, so nothing gains a join.
--
-- Deliberately NOT changed: the billing views in migration 0003. A trial ending
-- and a period rolling over are platform events, not farm events, and every
-- farm's subscription should turn over at the same instant rather than
-- fourteen different local midnights.
-- ============================================================================

CREATE OR REPLACE VIEW v_doe_reproductive_state AS
WITH last_mating AS (
    SELECT DISTINCT ON (m.doe_id)
           m.doe_id, m.id AS mating_id, m.buck_id, m.mated_at, m.outcome
    FROM mating m
    ORDER BY m.doe_id, m.mated_at DESC
),
last_check AS (
    SELECT DISTINCT ON (pc.mating_id)
           pc.mating_id, pc.result, pc.checked_on
    FROM pregnancy_check pc
    ORDER BY pc.mating_id, pc.checked_on DESC, pc.created_at DESC
),
last_litter AS (
    SELECT DISTINCT ON (l.doe_id)
           l.doe_id, l.id AS litter_id, l.mating_id, l.kindled_on, l.weaned_on
    FROM litter l
    ORDER BY l.doe_id, l.kindled_on DESC
),
last_pseudo AS (
    SELECT doe_id, max((mated_at)::date) AS on_date
    FROM mating WHERE outcome = 'pseudopregnant' GROUP BY doe_id
),
last_failed AS (
    SELECT doe_id, max((mated_at)::date) AS on_date
    FROM mating WHERE outcome IN ('negative', 'aborted') GROUP BY doe_id
),
base AS (
    SELECT
        r.id          AS rabbit_id,
        r.farm_id,
        r.tag,
        lm.mating_id,
        lm.buck_id,
        (lm.mated_at)::date                              AS last_service_on,
        (farm_today(r.farm_id) - (lm.mated_at)::date)             AS gestation_day,
        lc.result                                        AS last_check_result,
        lc.checked_on                                    AS last_check_on,
        ll.litter_id,
        ll.mating_id                                     AS litter_mating_id,
        ll.kindled_on,
        ll.weaned_on,
        (farm_today(r.farm_id) - ll.kindled_on)                   AS days_since_last_kindling,
        (farm_today(r.farm_id) - ll.weaned_on)                    AS days_since_weaning,
        (farm_today(r.farm_id) - lp.on_date)                      AS days_since_pseudopregnancy,
        (farm_today(r.farm_id) - lf.on_date)                      AS days_since_failed_service,
        (r.date_of_birth IS NOT NULL
         AND farm_today(r.farm_id) - r.date_of_birth
             >= COALESCE(b.doe_first_mating_days, 150))  AS old_enough,
        fs.gestation_window_start_day,
        fs.gestation_overdue_day,
        fs.first_check_window_end
    FROM rabbit r
    JOIN farm_settings fs      ON fs.farm_id = r.farm_id
    LEFT JOIN breed b          ON b.id = r.breed_id
    LEFT JOIN last_mating lm   ON lm.doe_id = r.id
    LEFT JOIN last_check lc    ON lc.mating_id = lm.mating_id
    LEFT JOIN last_litter ll   ON ll.doe_id = r.id
    LEFT JOIN last_pseudo lp   ON lp.doe_id = r.id
    LEFT JOIN last_failed lf   ON lf.doe_id = r.id
    WHERE r.sex = 'doe'
      AND r.status IN ('active', 'quarantine')
),
resolved AS (
    SELECT base.*,
        CASE
            WHEN NOT old_enough                                THEN 'GROWING'
            WHEN mating_id IS NULL                             THEN 'READY'
            -- The latest mating already produced a litter
            WHEN litter_mating_id = mating_id
                 AND weaned_on IS NULL                         THEN 'LACTATING'
            WHEN litter_mating_id = mating_id                  THEN 'RESTING'
            WHEN last_check_result = 'negative'                THEN 'OPEN'
            WHEN outcome_is_pseudo                             THEN 'PSEUDOPREGNANT'
            WHEN gestation_day >= gestation_overdue_day        THEN 'OVERDUE'
            WHEN gestation_day >= gestation_window_start_day   THEN 'NEST_BOX'
            WHEN last_check_result = 'positive'                THEN 'PREGNANT'
            WHEN gestation_day <= first_check_window_end       THEN 'MATED'
            ELSE 'PREGNANT'
        END AS state
    FROM base
    -- pseudopregnancy flag pulled forward for readability
    CROSS JOIN LATERAL (
        SELECT (days_since_pseudopregnancy IS NOT NULL
                AND days_since_pseudopregnancy < 18) AS outcome_is_pseudo
    ) p
)
SELECT
    resolved.*,
    CASE
        WHEN state IN ('PREGNANT', 'NEST_BOX') AND last_check_result = 'positive'
            THEN 'confirmed'
        WHEN state IN ('PREGNANT', 'NEST_BOX')
            THEN 'presumed'
    END AS confidence,
    CASE WHEN state IN ('PREGNANT', 'NEST_BOX', 'MATED')
         THEN last_service_on + 31 END AS expected_kindling_on,
    CASE WHEN state IN ('PREGNANT', 'NEST_BOX', 'MATED')
         THEN last_service_on + 28 END AS window_start_on,
    CASE WHEN state IN ('PREGNANT', 'NEST_BOX', 'MATED')
         THEN last_service_on + 34 END AS window_end_on
FROM resolved;

CREATE OR REPLACE VIEW v_pregnancy_summary AS
SELECT
    farm_id,
    count(*)                                                  AS total_pregnant,
    count(*) FILTER (WHERE confidence = 'confirmed')          AS confirmed_pregnant,
    count(*) FILTER (WHERE confidence = 'presumed')           AS presumed_pregnant,
    count(*) FILTER (WHERE window_start_on <= farm_today(farm_id) + 7) AS due_within_7_days
FROM v_pregnant_does
GROUP BY farm_id;

CREATE OR REPLACE VIEW v_buck_availability AS
SELECT
    r.id AS buck_id,
    r.farm_id,
    r.tag,
    count(m.id) FILTER (WHERE (m.mated_at)::date = farm_today(r.farm_id))      AS services_today,
    count(m.id) FILTER (WHERE (m.mated_at)::date > farm_today(r.farm_id) - 7)  AS services_last_7d,
    count(m.id) FILTER (WHERE m.outcome IN ('pregnant', 'kindled'))   AS successes,
    count(m.id) FILTER (WHERE m.outcome IN ('pregnant', 'kindled', 'negative')) AS scored_services
FROM rabbit r
LEFT JOIN mating m ON m.buck_id = r.id
WHERE r.sex = 'buck' AND r.status = 'active'
GROUP BY r.id, r.farm_id, r.tag;

ALTER VIEW v_doe_reproductive_state SET (security_invoker = true);
ALTER VIEW v_pregnancy_summary      SET (security_invoker = true);
ALTER VIEW v_buck_availability      SET (security_invoker = true);
