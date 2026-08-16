-- ============================================================================
-- Make a medication dose something a person can actually tick off
--
-- Turning the Ostovet courses on (migration 0016) put doses on the daily list
-- for the first time, and three things that had never been exercised turned out
-- to be wrong.
--
-- 1. Every dose of a course carried the same ref_id — the protocol's id, not
--    the dose's. Five rows, one identity: the app cannot tell them apart, and
--    "mark this one done" has nothing to name. There is no dose row to point
--    at, because a schedule is generated rather than stored, so the identity
--    has to be the three things that pin one down: which course, which rabbit,
--    which dose number.
--
-- 2. The title said "Ostovet (post-delivery) — dose 2 of 5" and never said
--    whose. On a farm with nine does in milk that is not a task.
--
-- 3. Nothing ever lapsed. A dose was due, was not given, and stayed on the list
--    for ever. Backfilling two existing farms produced thirteen rows, ten of
--    them from June, none of which could be cleared — because recording a dose
--    only cancels a scheduled one within ±2 days of its due date, so a dose
--    from sixty-five days ago is literally untickable. The list was offering
--    work that could not be done, which is the fastest way to teach people to
--    ignore a list.
--
--    A missed dose is a miss, not a chore. It stops being asked for after the
--    same ±2 days that decide whether a dose counts, and stays visible in the
--    animal's history where it belongs.
-- ============================================================================

-- The tolerance, in one place, so the "can this still be given" rule and the
-- "does this recorded dose count" rule cannot drift apart.
CREATE OR REPLACE FUNCTION medication_grace_days() RETURNS int
LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$;

CREATE OR REPLACE VIEW v_medication_due AS
SELECT s.*,
       (s.due_on - current_date) AS days_until_due,
       -- Past the point where giving it would still count as this dose.
       (s.due_on < current_date - medication_grace_days()) AS lapsed
FROM v_medication_schedule s
WHERE NOT EXISTS (
    SELECT 1 FROM health_event h
    WHERE h.protocol_id = s.protocol_id
      AND h.rabbit_id   = s.rabbit_id
      AND h.dose_number = s.dose_number
      AND h.occurred_on >= s.due_on - medication_grace_days()
      AND h.occurred_on <= s.due_on + medication_grace_days()
);

CREATE OR REPLACE VIEW v_daily_list AS
SELECT
    'medication'                          AS source,
    -- Course, rabbit, dose. Enough for the app to post the dose back without
    -- another round trip, and unique per row so five doses are five things.
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
    CASE WHEN md.due_on < current_date THEN 'critical' ELSE 'high' END AS urgency,
    NULL::text                            AS colour
FROM v_medication_due md
JOIN rabbit r ON r.id = md.rabbit_id
WHERE md.notify
  AND md.due_on <= current_date
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
    CASE WHEN t.due_on < current_date THEN 'critical' ELSE t.priority::text END,
    NULL::text
FROM task t
LEFT JOIN rabbit r ON r.id = t.rabbit_id
WHERE t.status = 'open'
  AND t.due_on <= current_date

UNION ALL

SELECT
    'condition',
    oc.condition_id::text,
    oc.rabbit_id,
    oc.tag,
    oc.farm_id,
    current_date,
    oc.last_checked_at,
    oc.condition_name || ' — check ' || COALESCE(oc.rabbit_name, oc.tag, 'the litter')
      || ' (' || oc.hours_open || 'h)',
    CASE WHEN oc.needs_escalation THEN 'critical' ELSE 'high' END,
    oc.colour
FROM v_open_conditions oc;

ALTER VIEW v_medication_due SET (security_invoker = true);
ALTER VIEW v_daily_list     SET (security_invoker = true);

-- The scheduler must not raise a notification for a dose nobody can give
-- either. Same rule, same place in the pipeline.
--
-- This is migration 0010's function with one arm changed. Restating it by
-- hand the first time silently renamed v_condition_clusters to a view that
-- does not exist, and took the whole scheduler down with it — plpgsql does
-- not resolve table names until the function runs, so it applied cleanly and
-- failed on every pass afterwards.
CREATE OR REPLACE FUNCTION generate_notifications() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    n int := 0;
    step int;
BEGIN
    -- 1. Open health conditions, every `reminder_interval_hours` since the LAST
    --    OBSERVATION.
    --
    --    The slot number is what makes this repeat rather than fire once:
    --    2 hours after the last look is slot 1, 4 hours is slot 2, and each
    --    slot dedupes separately. Recording "still loose" moves last_checked_at
    --    forward, which resets the slots to zero — so checking the animal is
    --    what buys the quiet, and a caretaker who just looked is not nagged
    --    again two minutes later.
    --
    --    Quiet hours are handled by NOT creating the row overnight. Because the
    --    slot advances with wall-clock time, the morning produces one
    --    notification for the then-current slot rather than a backlog of six.
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

    -- 3. Outbreak — two or more contagious cases in one shed. The second case
    --    is the one worth acting on, not the fifth.
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

    -- 4. Critical tasks due today — nest boxes and overdue pregnancies. Once
    --    per task per day, and never during quiet hours.
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

    -- 5. Medication doses due today. Ostovet and anything added later.
    INSERT INTO notification (farm_id, kind, title, body, urgency, rabbit_id,
                              employee_id, dedupe_key)
    SELECT md.farm_id, 'medication_due',
           md.protocol_name || ' — dose ' || md.dose_number || ' of ' || md.total_doses
             || ' for ' || COALESCE(r.name, r.tag),
           md.dose_note,
           CASE WHEN md.due_on < farm_today(md.farm_id) THEN 'critical' ELSE 'high' END::task_priority_t,
           md.rabbit_id, caretaker_for_rabbit(md.rabbit_id),
           'med:' || md.protocol_id || ':' || md.rabbit_id || ':' || md.dose_number
             || ':' || farm_today(md.farm_id)
    FROM v_medication_due md
    JOIN rabbit r ON r.id = md.rabbit_id
    WHERE md.notify
      AND md.due_on <= farm_today(md.farm_id)
      -- Past its grace period a dose can no longer be recorded against, so
      -- buzzing a phone about it asks for something nobody can do.
      AND NOT md.lapsed
      AND r.status NOT IN ('sold', 'culled', 'dead')
      AND NOT farm_is_quiet(md.farm_id)
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    RETURN n;
END $$;
