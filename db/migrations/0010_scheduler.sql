-- ============================================================================
-- The scheduler
--
-- Everything the app is actually worth paying for happens here: the day-28 nest
-- box task, the 2-hourly loose-motion reminder, the separate-the-kits task on
-- day 30. Until now those were derivable but nothing created them.
--
-- Three rules shape the design:
--
--   1. SET-BASED, NOT PER-FARM. Netlify caps a scheduled function at 30
--      seconds. Looping farms in JavaScript would be fine at 10 customers and
--      would quietly start timing out at 500. Every statement below runs across
--      every farm at once.
--
--   2. IDEMPOTENT. The scheduler will run twice — retries, overlapping crons,
--      a manual trigger. Every generated row carries a deterministic key with a
--      UNIQUE constraint, so a second run inserts nothing rather than doubling
--      the farmer's task list.
--
--   3. FARM-LOCAL TIME. Netlify cron runs in UTC. "Day 28" and "quiet hours"
--      mean the farm's calendar, not the server's, so every date here is
--      computed through farm.timezone.
-- ============================================================================

-- --------------------------------------------------------------------------
-- Run log — this is what the heartbeat reads.
-- --------------------------------------------------------------------------
CREATE TABLE scheduler_run (
    id                    bigserial PRIMARY KEY,
    started_at            timestamptz NOT NULL DEFAULT now(),
    finished_at           timestamptz,
    ok                    boolean,
    tasks_created         int NOT NULL DEFAULT 0,
    notifications_created int NOT NULL DEFAULT 0,
    duration_ms           int,
    error                 text,
    triggered_by          text            -- schedule | manual | test
);
CREATE INDEX scheduler_run_recent_idx ON scheduler_run (started_at DESC);

-- --------------------------------------------------------------------------
-- Notifications
--
-- Separate from `task` because they are different things. A task is work that
-- stays open until someone does it. A notification is a nudge at a moment in
-- time — the same task can produce several as it becomes more urgent, and an
-- open health condition produces one every two hours without ever being "done".
-- --------------------------------------------------------------------------
CREATE TYPE notification_kind_t AS ENUM (
    'condition_reminder', 'condition_escalation', 'outbreak',
    'task_due', 'medication_due', 'overdue_pregnancy');

CREATE TABLE notification (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id      uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    kind         notification_kind_t NOT NULL,
    title        text NOT NULL,
    body         text,
    urgency      task_priority_t NOT NULL DEFAULT 'high',
    rabbit_id    uuid,
    -- Who should see it. NULL means everyone at the farm — used when no
    -- caretaker owns the shed, so the work cannot fall down a gap.
    employee_id  uuid REFERENCES employee(id) ON DELETE SET NULL,
    -- Deterministic. This is what makes re-running the scheduler harmless.
    dedupe_key   text UNIQUE NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- Set once a push has actually gone out. Nothing sends yet — there is no
    -- mobile app — so these stay NULL and the rows are read through the API.
    sent_at      timestamptz,
    read_at      timestamptz
);
CREATE INDEX notification_farm_idx ON notification (farm_id, created_at DESC);
CREATE INDEX notification_unsent_idx ON notification (created_at) WHERE sent_at IS NULL;

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_tenant ON notification
    USING (farm_id = current_farm_id())
    WITH CHECK (farm_id = current_farm_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON notification TO rabbitry_app, rabbitry_admin;

-- scheduler_run is platform plumbing, not a tenant table — it records runs
-- across every farm at once, so there is nothing sensible to scope it by.
--
-- The REVOKE is the point. Migration 0006 set ALTER DEFAULT PRIVILEGES granting
-- new tables to BOTH roles, which is convenient for tenant tables and wrong for
-- platform ones: without this, every new system table silently becomes readable
-- by the farmer-facing role. Any future platform table needs the same line.
REVOKE ALL ON scheduler_run FROM rabbitry_app;
GRANT SELECT, INSERT, UPDATE ON scheduler_run TO rabbitry_admin;
GRANT USAGE, SELECT ON SEQUENCE scheduler_run_id_seq TO rabbitry_admin;
REVOKE ALL ON SEQUENCE scheduler_run_id_seq FROM rabbitry_app;

-- --------------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------------

-- Today, on the farm rather than on the server.
CREATE OR REPLACE FUNCTION farm_today(p_farm_id uuid) RETURNS date
LANGUAGE sql STABLE AS $$
    SELECT (now() AT TIME ZONE COALESCE(f.timezone, 'UTC'))::date
    FROM farm f WHERE f.id = p_farm_id;
$$;

-- Is it currently quiet hours on this farm?
--
-- Quiet hours normally wrap midnight (22:00 to 06:00), which is why this is not
-- a simple BETWEEN — the window runs 22,23,0,1,…,5.
CREATE OR REPLACE FUNCTION farm_is_quiet(p_farm_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN NOT fs.quiet_hours_enabled THEN false
        WHEN fs.quiet_hours_start = fs.quiet_hours_end THEN false
        WHEN fs.quiet_hours_start < fs.quiet_hours_end
            THEN h >= fs.quiet_hours_start AND h < fs.quiet_hours_end
        ELSE h >= fs.quiet_hours_start OR h < fs.quiet_hours_end
    END
    FROM farm f
    JOIN farm_settings fs ON fs.farm_id = f.id
    CROSS JOIN LATERAL (
        SELECT EXTRACT(hour FROM now() AT TIME ZONE COALESCE(f.timezone,'UTC'))::int
    ) AS t(h)
    WHERE f.id = p_farm_id;
$$;

-- Whoever looks after the shed this animal lives in. NULL if nobody does, in
-- which case the task stays unassigned and shows on the manager's list.
CREATE OR REPLACE FUNCTION caretaker_for_rabbit(p_rabbit_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT es.employee_id
    FROM rabbit r
    JOIN cage c              ON c.id = r.cage_id
    JOIN employee_section es ON es.shed_id = c.shed_id
    JOIN employee e          ON e.id = es.employee_id AND e.is_active
    WHERE r.id = p_rabbit_id
    ORDER BY e.created_at
    LIMIT 1;
$$;

-- ============================================================================
-- generate_due_tasks()
--
-- One INSERT per kind of work, each across every farm. ON CONFLICT on the
-- deterministic key is what makes a repeat run a no-op.
--
-- Tasks are created a little BEFORE they are due (the nest box task appears on
-- day 27) so the work shows on the daily list with a day's warning rather than
-- appearing on the morning it is already critical.
-- ============================================================================
CREATE OR REPLACE FUNCTION generate_due_tasks() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    n int := 0;
    step int;
BEGIN
    -- Open cycles: a mating with no litter yet and not already ruled out.
    CREATE TEMP TABLE open_cycle ON COMMIT DROP AS
    SELECT m.id AS mating_id, m.farm_id, m.doe_id,
           (m.mated_at AT TIME ZONE 'UTC' AT TIME ZONE COALESCE(f.timezone,'UTC'))::date
               AS mated_on,
           farm_today(m.farm_id) AS today,
           farm_today(m.farm_id)
             - (m.mated_at AT TIME ZONE 'UTC' AT TIME ZONE COALESCE(f.timezone,'UTC'))::date
               AS gestation_day,
           -- Listed one by one rather than fs.*: farm_settings also has a
           -- farm_id, and a temp table cannot have the column twice.
           fs.first_check_day, fs.first_check_window_start, fs.first_check_window_end,
           fs.recheck_day, fs.gestation_window_start_day, fs.gestation_window_end_day,
           fs.gestation_overdue_day,
           chk.result AS last_check
    FROM mating m
    JOIN farm f          ON f.id = m.farm_id
    JOIN farm_settings fs ON fs.farm_id = m.farm_id
    LEFT JOIN litter l   ON l.mating_id = m.id
    LEFT JOIN LATERAL (
        SELECT result FROM pregnancy_check
        WHERE mating_id = m.id ORDER BY checked_on DESC, created_at DESC LIMIT 1
    ) chk ON true
    WHERE l.id IS NULL
      AND m.outcome NOT IN ('negative','pseudopregnant','aborted','terminated');

    -- 1. Palpate, in the day 10-14 window.
    INSERT INTO task (farm_id, kind, title, due_on, priority, rabbit_id, mating_id,
                      assigned_to, generated_key)
    SELECT c.farm_id, 'palpate',
           'Palpate ' || COALESCE(r.name, r.tag) || ' — day ' || c.first_check_day,
           c.mated_on + c.first_check_day, 'high', c.doe_id, c.mating_id,
           caretaker_for_rabbit(c.doe_id), 'palpate:' || c.mating_id
    FROM open_cycle c JOIN rabbit r ON r.id = c.doe_id
    WHERE c.last_check IS NULL
      AND c.gestation_day >= c.first_check_window_start - 1
      AND c.gestation_day <= c.first_check_window_end
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 2. Re-check before the nest box goes in — catches resorption after a
    --    day-12 positive.
    INSERT INTO task (farm_id, kind, title, due_on, priority, rabbit_id, mating_id,
                      assigned_to, generated_key)
    SELECT c.farm_id, 'recheck',
           'Re-check ' || COALESCE(r.name, r.tag) || ' before the nest box',
           c.mated_on + c.recheck_day, 'medium', c.doe_id, c.mating_id,
           caretaker_for_rabbit(c.doe_id), 'recheck:' || c.mating_id
    FROM open_cycle c JOIN rabbit r ON r.id = c.doe_id
    WHERE c.last_check = 'positive'
      AND c.gestation_day >= c.recheck_day - 1
      AND c.gestation_day <= c.recheck_day + 2
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 3. Nest box. The highest-cost detail on the farm — miss it and the litter
    --    is born on wire.
    INSERT INTO task (farm_id, kind, title, due_on, priority, rabbit_id, mating_id,
                      assigned_to, generated_key)
    SELECT c.farm_id, 'nest_box',
           'Nest box in for ' || COALESCE(r.name, r.tag) || ' — day '
             || c.gestation_window_start_day,
           c.mated_on + c.gestation_window_start_day, 'critical', c.doe_id, c.mating_id,
           caretaker_for_rabbit(c.doe_id), 'nest_box:' || c.mating_id
    FROM open_cycle c JOIN rabbit r ON r.id = c.doe_id
    WHERE c.last_check IS DISTINCT FROM 'negative'
      AND c.gestation_day >= c.gestation_window_start_day - 1
      AND c.gestation_day <= c.gestation_window_end_day
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 4. Check the nest, every morning of the kindling window. Kindling usually
    --    happens overnight, so this is a daily task rather than a one-off.
    INSERT INTO task (farm_id, kind, title, due_on, priority, rabbit_id, mating_id,
                      assigned_to, generated_key)
    SELECT c.farm_id, 'kindling_watch',
           'Check nest — ' || COALESCE(r.name, r.tag) || ', day ' || c.gestation_day
             || ' of ' || c.gestation_window_end_day,
           c.today, 'high', c.doe_id, c.mating_id,
           caretaker_for_rabbit(c.doe_id),
           'kindling_watch:' || c.mating_id || ':' || c.today
    FROM open_cycle c JOIN rabbit r ON r.id = c.doe_id
    WHERE c.last_check IS DISTINCT FROM 'negative'
      AND c.gestation_day >= c.gestation_window_start_day
      AND c.gestation_day <= c.gestation_window_end_day
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 5. Overdue. Past day 35 with nothing recorded is either a lost pregnancy
    --    or a missed record, and both need a human.
    INSERT INTO task (farm_id, kind, title, due_on, priority, rabbit_id, mating_id,
                      assigned_to, generated_key)
    SELECT c.farm_id, 'other',
           COALESCE(r.name, r.tag) || ' is overdue — day ' || c.gestation_day
             || ', no kindling recorded',
           c.today, 'critical', c.doe_id, c.mating_id,
           caretaker_for_rabbit(c.doe_id), 'overdue:' || c.mating_id
    FROM open_cycle c JOIN rabbit r ON r.id = c.doe_id
    WHERE c.gestation_day >= c.gestation_overdue_day
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- Litters still being reared.
    CREATE TEMP TABLE open_litter ON COMMIT DROP AS
    SELECT l.id AS litter_id, l.farm_id, l.doe_id, l.kindled_on, l.weaned_on,
           farm_today(l.farm_id) AS today,
           farm_today(l.farm_id) - l.kindled_on AS litter_day,
           fs.wean_at_days, fs.rebreed_after_weaning_days
    FROM litter l
    JOIN farm_settings fs ON fs.farm_id = l.farm_id;

    -- 6. Count and check the litter the morning after kindling.
    INSERT INTO task (farm_id, kind, title, due_on, priority, rabbit_id, litter_id,
                      assigned_to, generated_key)
    SELECT l.farm_id, 'litter_check',
           'Count and check the litter — ' || COALESCE(r.name, r.tag),
           l.kindled_on + 1, 'high', l.doe_id, l.litter_id,
           caretaker_for_rabbit(l.doe_id), 'litter_check:' || l.litter_id
    FROM open_litter l JOIN rabbit r ON r.id = l.doe_id
    WHERE l.weaned_on IS NULL AND l.litter_day BETWEEN 0 AND 3
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 7. Creep feed, around the time kits start on solids.
    INSERT INTO task (farm_id, kind, title, due_on, priority, rabbit_id, litter_id,
                      assigned_to, generated_key)
    SELECT l.farm_id, 'creep_feed',
           'Start creep feed — ' || COALESCE(r.name, r.tag) || '''s litter',
           l.kindled_on + 18, 'medium', l.doe_id, l.litter_id,
           caretaker_for_rabbit(l.doe_id), 'creep_feed:' || l.litter_id
    FROM open_litter l JOIN rabbit r ON r.id = l.doe_id
    WHERE l.weaned_on IS NULL AND l.litter_day BETWEEN 17 AND 22
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 8. Separate the kits. The KPI moment.
    INSERT INTO task (farm_id, kind, title, due_on, priority, rabbit_id, litter_id,
                      assigned_to, generated_key)
    SELECT l.farm_id, 'wean',
           'Separate the kits — ' || COALESCE(r.name, r.tag) || ', '
             || l.wean_at_days || ' days',
           l.kindled_on + l.wean_at_days, 'high', l.doe_id, l.litter_id,
           caretaker_for_rabbit(l.doe_id), 'wean:' || l.litter_id
    FROM open_litter l JOIN rabbit r ON r.id = l.doe_id
    WHERE l.weaned_on IS NULL
      AND l.litter_day >= l.wean_at_days - 1
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 9. Rebreed, the configured gap after separating.
    INSERT INTO task (farm_id, kind, title, due_on, priority, rabbit_id, litter_id,
                      assigned_to, generated_key)
    SELECT l.farm_id, 'breed',
           'Rebreed ' || COALESCE(r.name, r.tag) || ' — '
             || l.rebreed_after_weaning_days || ' days after separating',
           l.weaned_on + l.rebreed_after_weaning_days, 'high', l.doe_id, l.litter_id,
           caretaker_for_rabbit(l.doe_id), 'breed:' || l.litter_id
    FROM open_litter l JOIN rabbit r ON r.id = l.doe_id
    WHERE l.weaned_on IS NOT NULL
      AND l.today >= l.weaned_on + l.rebreed_after_weaning_days - 1
      -- Not if she is already back in a cycle.
      AND NOT EXISTS (SELECT 1 FROM mating m
                      WHERE m.doe_id = l.doe_id AND (m.mated_at)::date > l.weaned_on)
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 10. Cull review after N consecutive failed services.
    INSERT INTO task (farm_id, kind, title, due_on, priority, rabbit_id,
                      assigned_to, generated_key)
    SELECT f.farm_id, 'cull_review',
           'Cull review — ' || COALESCE(r.name, r.tag) || ': '
             || f.fails || ' services in a row with no litter',
           farm_today(f.farm_id), 'medium', f.doe_id, NULL,
           'cull_review:' || f.doe_id || ':' || f.fails
    FROM (
        SELECT m.farm_id, m.doe_id, count(*)::int AS fails
        FROM mating m
        JOIN farm_settings fs ON fs.farm_id = m.farm_id
        WHERE m.outcome = 'negative'
          AND m.mated_at > COALESCE(
                (SELECT max(l.kindled_on) FROM litter l WHERE l.doe_id = m.doe_id),
                '1900-01-01'::date)
        GROUP BY m.farm_id, m.doe_id
        HAVING count(*) >= (SELECT cull_failed_services_in_a_row
                            FROM farm_settings WHERE farm_id = m.farm_id)
    ) f
    JOIN rabbit r ON r.id = f.doe_id AND r.status = 'active'
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    RETURN n;
END $$;

-- ============================================================================
-- generate_notifications()
--
-- Tasks are work; these are the nudges. The one that matters most is the
-- 2-hourly loose-motion reminder, which repeats until somebody looks.
-- ============================================================================
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
      AND NOT farm_is_quiet(md.farm_id)
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    RETURN n;
END $$;

-- ============================================================================
-- Heartbeat
--
-- A reminder system that fails silently is worse than none, because people stop
-- watching for the thing themselves. Point an uptime monitor at the endpoint
-- that reads this; when the scheduler stops, the monitor pages you.
-- ============================================================================
CREATE OR REPLACE VIEW v_scheduler_health AS
SELECT
    last_ok.started_at                                   AS last_success_at,
    EXTRACT(epoch FROM now() - last_ok.started_at)::int  AS seconds_since_success,
    last_any.started_at                                  AS last_run_at,
    last_any.ok                                          AS last_run_ok,
    last_any.error                                       AS last_error,
    recent.failures_last_hour
FROM (SELECT started_at FROM scheduler_run WHERE ok ORDER BY started_at DESC LIMIT 1) last_ok
FULL JOIN (SELECT started_at, ok, error FROM scheduler_run ORDER BY started_at DESC LIMIT 1) last_any
  ON true
FULL JOIN (SELECT count(*)::int AS failures_last_hour FROM scheduler_run
           WHERE ok IS NOT TRUE AND started_at > now() - interval '1 hour') recent
  ON true;

GRANT SELECT ON v_scheduler_health TO rabbitry_admin;
ALTER VIEW v_scheduler_health SET (security_invoker = true);
