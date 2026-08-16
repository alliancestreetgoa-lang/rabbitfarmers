-- ============================================================================
-- Derived state
--
-- Reproductive status is never stored. It is computed here from the event log.
-- See docs/03-breeding-engine.md for the decision tree these views implement.
--
-- NOTE: current_date is used for readability. In production, replace with
-- (now() AT TIME ZONE farm.timezone)::date so day counts follow farm-local
-- days rather than the server's.
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
        (current_date - (lm.mated_at)::date)             AS gestation_day,
        lc.result                                        AS last_check_result,
        lc.checked_on                                    AS last_check_on,
        ll.litter_id,
        ll.mating_id                                     AS litter_mating_id,
        ll.kindled_on,
        ll.weaned_on,
        (current_date - ll.kindled_on)                   AS days_since_last_kindling,
        (current_date - ll.weaned_on)                    AS days_since_weaning,
        (current_date - lp.on_date)                      AS days_since_pseudopregnancy,
        (current_date - lf.on_date)                      AS days_since_failed_service,
        (r.date_of_birth IS NOT NULL
         AND current_date - r.date_of_birth
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


-- "How many females are pregnant?" — the farmer's first question.
CREATE OR REPLACE VIEW v_pregnant_does AS
SELECT *
FROM v_doe_reproductive_state
WHERE state IN ('PREGNANT', 'NEST_BOX');

-- Dashboard counts. Confirmed and presumed are deliberately never merged.
CREATE OR REPLACE VIEW v_pregnancy_summary AS
SELECT
    farm_id,
    count(*)                                                  AS total_pregnant,
    count(*) FILTER (WHERE confidence = 'confirmed')          AS confirmed_pregnant,
    count(*) FILTER (WHERE confidence = 'presumed')           AS presumed_pregnant,
    count(*) FILTER (WHERE window_start_on <= current_date + 7) AS due_within_7_days
FROM v_pregnant_does
GROUP BY farm_id;


-- "Which females are ready for mating?" — the farmer's second question.
CREATE OR REPLACE VIEW v_ready_to_mate AS
SELECT
    s.rabbit_id,
    s.farm_id,
    s.tag,
    s.state,
    s.days_since_last_kindling,
    s.days_since_weaning,
    CASE fs.rebreed_anchor
        WHEN 'weaning'  THEN GREATEST(0, COALESCE(s.days_since_weaning, 0)
                                         - fs.rebreed_after_weaning_days)
        WHEN 'kindling' THEN GREATEST(0, COALESCE(s.days_since_last_kindling, 0)
                                         - fs.rebreed_after_kindling_days)
    END AS days_overdue,
    rc.receptivity  AS last_observed_receptivity,
    rc.checked_on   AS receptivity_checked_on
FROM v_doe_reproductive_state s
JOIN rabbit r        ON r.id = s.rabbit_id
JOIN farm_settings fs ON fs.farm_id = s.farm_id
LEFT JOIN LATERAL (
    SELECT receptivity, checked_on
    FROM receptivity_check
    WHERE rabbit_id = s.rabbit_id
    ORDER BY checked_on DESC
    LIMIT 1
) rc ON true
WHERE r.status = 'active'                       -- excludes quarantine
  AND r.role IN ('breeder', 'replacement')
  AND s.state IN ('READY', 'OPEN', 'RESTING', 'LACTATING')
  -- Rest interval, counted from whichever anchor the farm uses. With the
  -- 'weaning' anchor a nursing doe is excluded automatically, because she has
  -- no weaning date yet.
  AND (
        s.kindled_on IS NULL                       -- maiden doe: no rest to serve
     OR (fs.rebreed_anchor = 'kindling'
         AND s.days_since_last_kindling >= fs.rebreed_after_kindling_days)
     OR (fs.rebreed_anchor = 'weaning'
         AND s.days_since_weaning IS NOT NULL
         AND s.days_since_weaning >= fs.rebreed_after_weaning_days)
      )
  AND (NOT fs.require_weaning_before_rebreed OR s.state <> 'LACTATING')
  AND (s.days_since_pseudopregnancy IS NULL
       OR s.days_since_pseudopregnancy >= fs.after_pseudopregnancy_days)
  AND (s.days_since_failed_service IS NULL
       OR s.days_since_failed_service >= fs.after_failed_service_days)
  AND NOT EXISTS (
        SELECT 1 FROM health_event h
        WHERE h.rabbit_id = s.rabbit_id
          AND h.blocks_breeding
          AND (h.cleared_on IS NULL OR h.cleared_on > current_date)
      )
  -- An open condition such as loose motion keeps her out of the queue until
  -- someone marks it stopped.
  AND NOT EXISTS (
        SELECT 1
        FROM health_condition hc
        JOIN condition_type ct ON ct.id = hc.condition_type_id
        WHERE hc.rabbit_id = s.rabbit_id
          AND hc.resolved_at IS NULL
          AND ct.blocks_breeding
      );


-- Buck workload, for the service-quota rule in buck selection.
CREATE OR REPLACE VIEW v_buck_availability AS
SELECT
    r.id AS buck_id,
    r.farm_id,
    r.tag,
    count(m.id) FILTER (WHERE (m.mated_at)::date = current_date)      AS services_today,
    count(m.id) FILTER (WHERE (m.mated_at)::date > current_date - 7)  AS services_last_7d,
    count(m.id) FILTER (WHERE m.outcome IN ('pregnant', 'kindled'))   AS successes,
    count(m.id) FILTER (WHERE m.outcome IN ('pregnant', 'kindled', 'negative')) AS scored_services
FROM rabbit r
LEFT JOIN mating m ON m.buck_id = r.id
WHERE r.sex = 'buck' AND r.status = 'active'
GROUP BY r.id, r.farm_id, r.tag;


-- Every dose every protocol calls for, expanded to individual dated doses.
--
-- The pre-delivery course anchors on EXPECTED kindling (service + 31), because
-- the real kindling date is not known when the course has to start. Those rows
-- disappear the moment a litter is recorded, which is exactly the cancellation
-- behaviour wanted: if she kindles on day 29, the day 29 and 30 doses stop
-- being due. Doses already given stay recorded in health_event, so a course cut
-- short is still visible in her history.
CREATE OR REPLACE VIEW v_medication_schedule AS
WITH anchors AS (
    SELECT m.farm_id, m.doe_id AS rabbit_id, NULL::uuid AS litter_id, m.id AS mating_id,
           'expected_kindling'::protocol_anchor_t AS anchor,
           (m.mated_at)::date + fs.gestation_expected_days AS anchor_date
    FROM mating m
    JOIN farm_settings fs ON fs.farm_id = m.farm_id
    LEFT JOIN litter l    ON l.mating_id = m.id
    WHERE l.id IS NULL
      AND m.outcome NOT IN ('negative', 'pseudopregnant', 'aborted', 'terminated')
  UNION ALL
    SELECT m.farm_id, m.doe_id, NULL::uuid, m.id,
           'mating'::protocol_anchor_t, (m.mated_at)::date
    FROM mating m
  UNION ALL
    SELECT l.farm_id, l.doe_id, l.id, l.mating_id,
           'kindling'::protocol_anchor_t, l.kindled_on
    FROM litter l
  UNION ALL
    SELECT l.farm_id, l.doe_id, l.id, l.mating_id,
           'weaning'::protocol_anchor_t, l.weaned_on
    FROM litter l
    WHERE l.weaned_on IS NOT NULL
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
    p.notify
FROM medication_protocol p
JOIN anchors a
      ON a.anchor = p.anchor
     AND a.farm_id = p.farm_id
CROSS JOIN generate_series(0, p.doses - 1) AS n
WHERE p.is_active;


-- Doses still outstanding: scheduled, but with no matching dose recorded.
-- Recording the dose in health_event is what drops it off the list — this is
-- the "mark done and it disappears" behaviour, with no separate done-flag to
-- fall out of sync.
CREATE OR REPLACE VIEW v_medication_due AS
SELECT s.*,
       (s.due_on - current_date) AS days_until_due
FROM v_medication_schedule s
WHERE NOT EXISTS (
    SELECT 1 FROM health_event h
    WHERE h.protocol_id = s.protocol_id
      AND h.rabbit_id   = s.rabbit_id
      AND h.dose_number = s.dose_number
      AND h.occurred_on >= s.due_on - 2      -- tolerate a dose given a day early or late
      AND h.occurred_on <= s.due_on + 2
);


-- Every open health condition, with its colour mark and its next nag.
--
-- next_reminder_at counts from the LAST OBSERVATION, not from onset, so
-- recording "still loose" at 10:00 moves the next reminder to 12:00 rather than
-- leaving a backlog of missed 2-hourly slots to fire all at once.
--
-- Quiet-hours suppression is applied by the notification sender, not here:
-- this view answers "is a reminder due", the sender answers "may we buzz a
-- phone right now". Keeping them separate means the in-app list stays truthful
-- overnight even while pushes are held.
CREATE OR REPLACE VIEW v_open_conditions AS
SELECT
    hc.id                       AS condition_id,
    hc.farm_id,
    hc.rabbit_id,
    hc.litter_id,
    r.tag,
    r.name                      AS rabbit_name,
    ct.code                     AS condition_code,
    ct.name                     AS condition_name,
    ct.colour,
    ct.blocks_breeding,
    ct.is_contagious,
    ct.respect_quiet_hours,
    hc.severity,
    hc.started_at,
    hc.last_checked_at,
    round(EXTRACT(epoch FROM now() - hc.started_at) / 3600.0, 1)  AS hours_open,
    CASE WHEN ct.reminder_interval_hours IS NOT NULL
         THEN hc.last_checked_at
              + make_interval(mins => (ct.reminder_interval_hours * 60)::int)
    END                         AS next_reminder_at,
    CASE WHEN ct.reminder_interval_hours IS NOT NULL
          AND now() >= hc.last_checked_at
              + make_interval(mins => (ct.reminder_interval_hours * 60)::int)
         THEN true ELSE false
    END                         AS reminder_due,
    CASE WHEN ct.escalate_after_hours IS NOT NULL
          AND now() >= hc.started_at
              + make_interval(hours => ct.escalate_after_hours)
         THEN true ELSE false
    END                         AS needs_escalation
FROM health_condition hc
JOIN condition_type ct ON ct.id = hc.condition_type_id
LEFT JOIN rabbit r     ON r.id = hc.rabbit_id
WHERE hc.resolved_at IS NULL;


-- The colour marks to draw against each animal, wherever it is listed.
-- Most severe (longest open) first, so one dot can stand in when space is tight.
CREATE OR REPLACE VIEW v_rabbit_flags AS
SELECT
    rabbit_id,
    farm_id,
    count(*)                                        AS flag_count,
    (array_agg(colour         ORDER BY started_at))[1] AS primary_colour,
    (array_agg(condition_name ORDER BY started_at))[1] AS primary_condition,
    array_agg(condition_name  ORDER BY started_at)     AS conditions,
    bool_or(reminder_due)                           AS any_reminder_due
FROM v_open_conditions
WHERE rabbit_id IS NOT NULL
GROUP BY rabbit_id, farm_id;


-- Contagious conditions appearing together in one shed. Loose motion spreads
-- through shared feed, water and faeces, so two open cases in the same shed is
-- an outbreak signal worth raising before it becomes ten.
CREATE OR REPLACE VIEW v_condition_clusters AS
SELECT
    c.farm_id,
    s.id            AS shed_id,
    s.name          AS shed_name,
    c.condition_code,
    c.condition_name,
    count(*)        AS open_cases,
    min(c.started_at) AS first_case_at
FROM v_open_conditions c
JOIN rabbit r ON r.id = c.rabbit_id
JOIN cage cg  ON cg.id = r.cage_id
JOIN shed s   ON s.id = cg.shed_id
WHERE c.is_contagious
GROUP BY c.farm_id, s.id, s.name, c.condition_code, c.condition_name
HAVING count(*) >= 2;


-- The single feed behind the daily tab: everything a person must do now,
-- medication, husbandry and open health conditions together, most urgent first.
CREATE OR REPLACE VIEW v_daily_list AS
SELECT
    'medication'                          AS source,
    md.protocol_id::text                  AS ref_id,
    md.rabbit_id,
    r.tag,
    md.farm_id,
    md.due_on,
    md.due_on::timestamptz                AS due_at,
    md.protocol_name || ' — dose ' || md.dose_number || ' of ' || md.total_doses
                                          AS title,
    CASE WHEN md.due_on < current_date THEN 'critical' ELSE 'high' END AS urgency,
    NULL::text                            AS colour
FROM v_medication_due md
JOIN rabbit r ON r.id = md.rabbit_id
WHERE md.notify
  AND md.due_on <= current_date

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
    CASE WHEN t.due_on < current_date THEN 'critical' ELSE t.priority::text END,
    NULL::text
FROM task t
LEFT JOIN rabbit r ON r.id = t.rabbit_id
WHERE t.status = 'open'
  AND t.due_on <= current_date

UNION ALL

-- Open conditions sit on the list continuously, not only at the reminder
-- moment. The 2-hourly reminder is the push notification; the row itself stays
-- visible the whole time so the condition cannot be forgotten between buzzes.
SELECT
    'condition',
    oc.condition_id::text,
    oc.rabbit_id,
    oc.tag,
    oc.farm_id,
    oc.started_at::date,
    oc.next_reminder_at,
    oc.condition_name || ' — check ' || COALESCE(oc.rabbit_name, oc.tag, 'litter')
        || ' (' || oc.hours_open || 'h)',
    CASE WHEN oc.needs_escalation OR oc.reminder_due THEN 'critical' ELSE 'high' END,
    oc.colour
FROM v_open_conditions oc;


-- The headline KPI: kits weaned per doe per year.
CREATE OR REPLACE VIEW v_doe_performance AS
SELECT
    r.id AS rabbit_id,
    r.farm_id,
    r.tag,
    count(l.id)                                   AS litters,
    sum(l.born_alive)                             AS total_born_alive,
    sum(COALESCE(l.weaned_count, 0))              AS total_weaned,
    CASE WHEN sum(l.born_alive) > 0
         THEN round((sum(l.born_alive) - sum(COALESCE(l.weaned_count, 0)))::numeric
                    / sum(l.born_alive), 3)
    END                                           AS pre_weaning_mortality,
    min(l.kindled_on)                             AS first_kindling,
    max(l.kindled_on)                             AS last_kindling,
    CASE WHEN count(l.id) > 1
         THEN round((max(l.kindled_on) - min(l.kindled_on))::numeric
                    / (count(l.id) - 1), 1)
    END                                           AS avg_kindling_interval_days
FROM rabbit r
LEFT JOIN litter l ON l.doe_id = r.id
WHERE r.sex = 'doe'
GROUP BY r.id, r.farm_id, r.tag;
