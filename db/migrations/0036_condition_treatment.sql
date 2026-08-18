-- ============================================================================
-- 0036  Treatments: sickness -> medicine, for as long as it lasts
--
-- A protocol may now belong to a condition type. Reporting that condition
-- starts the course: dose 1 is due the day it is reported ("give O2M within
-- 24 hours"), dose 2 the next day, and so on — but the anchor row only exists
-- WHILE THE CONDITION IS OPEN, so marking it stopped cancels every remaining
-- dose the same way an early kindling cancels the pre-delivery course. Doses
-- already given stay in health_event, so a course cut short is still history.
-- ============================================================================

ALTER TABLE medication_protocol
    ADD COLUMN condition_type_id uuid REFERENCES condition_type(id) ON DELETE CASCADE;

CREATE INDEX medication_protocol_condition_idx
    ON medication_protocol (condition_type_id) WHERE condition_type_id IS NOT NULL;

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
    -- Open sickness on a single rabbit. Litter-wide conditions are left out
    -- until somebody needs litter dosing; a NULL rabbit would make dose
    -- matching in v_medication_due ambiguous.
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
    p.notify
FROM medication_protocol p
JOIN anchors a
      ON a.anchor = p.anchor
     AND a.farm_id = p.farm_id
     -- A treatment fires only for its own sickness; breeding courses have no
     -- condition_type_id and match as before.
     AND (p.condition_type_id IS NULL OR p.condition_type_id = a.condition_type_id)
CROSS JOIN generate_series(0, p.doses - 1) AS n
WHERE p.is_active;

ALTER VIEW v_medication_schedule SET (security_invoker = true);
