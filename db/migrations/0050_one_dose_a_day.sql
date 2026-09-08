-- ============================================================================
-- 0050  The round, one dose a day
--
-- "The second dose should be on the next day, and the third on the third
-- day." The round's dates are the calendar's (7th, 8th, 9th), but the 7th
-- was missed before the round existed, so on the 8th a rabbit's first dose
-- was given and its second appeared the same morning, because the 8th is
-- the second dose's date too. Wrong: a course is one dose a day, in order.
--
-- So, for month-anchored doses only: a dose beyond the first is asked for
-- only once the previous one was given on an earlier day (or is a miss,
-- past its grace with nothing recorded), and its date slides to the day
-- after the previous dose — so a late start shows "today", not red.
-- Sickness courses keep their own timing; a two-shots-an-hour-apart
-- treatment must not be forced onto separate days.
--
-- 0017's v_medication_due, restated whole: a view cannot be patched.
-- ============================================================================

CREATE OR REPLACE VIEW v_medication_due AS
WITH sched AS (
    SELECT s.*,
           p.interval_days,
           prev.given_on AS prev_given_on,
           CASE WHEN s.anchor = 'month' AND prev.given_on IS NOT NULL
                THEN GREATEST(s.due_on, prev.given_on + 1)
                ELSE s.due_on
           END AS eff_due_on
    FROM v_medication_schedule s
    JOIN medication_protocol p ON p.id = s.protocol_id
    LEFT JOIN LATERAL (
        SELECT max(h.occurred_on) AS given_on
        FROM health_event h
        WHERE s.anchor = 'month' AND s.dose_number > 1
          AND h.protocol_id = s.protocol_id
          AND h.rabbit_id   = s.rabbit_id
          AND h.dose_number = s.dose_number - 1
    ) prev ON true
)
SELECT s.protocol_id, s.protocol_name, s.farm_id, s.rabbit_id, s.litter_id, s.mating_id,
       s.anchor, s.anchor_date, s.dose_number, s.total_doses,
       s.eff_due_on                                                     AS due_on,
       s.dose_note, s.withdrawal_days, s.notify, s.step, s.route, s.dose, s.hold_reason,
       (s.eff_due_on - farm_today(s.farm_id))                           AS days_until_due,
       (s.eff_due_on < farm_today(s.farm_id) - medication_grace_days()) AS lapsed
FROM sched s
WHERE NOT EXISTS (
    SELECT 1 FROM health_event h
    WHERE h.protocol_id = s.protocol_id
      AND h.rabbit_id   = s.rabbit_id
      AND h.dose_number = s.dose_number
      AND h.occurred_on >= s.eff_due_on - medication_grace_days()
      AND h.occurred_on <= s.eff_due_on + medication_grace_days()
)
AND (
       s.anchor <> 'month'
    OR s.dose_number = 1
    -- The previous dose was given, on an earlier day.
    OR s.prev_given_on < farm_today(s.farm_id)
    -- Or it is a miss: its own date is past the grace period with nothing
    -- recorded, and the course moves on rather than stalling for ever.
    OR (s.prev_given_on IS NULL
        AND s.due_on - s.interval_days < farm_today(s.farm_id) - medication_grace_days())
);

ALTER VIEW v_medication_due SET (security_invoker = true);
