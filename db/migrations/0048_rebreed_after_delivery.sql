-- ============================================================================
-- 0048  Rebreeding after delivery, on the farm's own rule
--
-- Settings offers the farm a gap after kindling — 16 days or 32 days, the two
-- the farm actually uses — held in farm_settings.rebreed_after_kindling_days
-- with rebreed_anchor = 'kindling' (both columns since 0001; v_ready_to_mate
-- has honoured them all along). What was missing is the nudge: on that day
-- the doe goes on Today to be served, and every phone is told. 0010's job 9
-- does this for the weaning anchor only. This is its twin for the kindling
-- anchor, its own function so the ten-job generator is not restated.
-- ============================================================================

CREATE OR REPLACE FUNCTION generate_rebreed_tasks(p_today date DEFAULT NULL) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    INSERT INTO task (farm_id, kind, title, due_on, priority, rabbit_id, litter_id,
                      assigned_to, generated_key)
    SELECT l.farm_id, 'breed',
           'Rebreed ' || COALESCE(r.name, r.tag) || ' — '
             || fs.rebreed_after_kindling_days || ' days after kindling',
           l.kindled_on + fs.rebreed_after_kindling_days, 'high', l.doe_id, l.id,
           caretaker_for_rabbit(l.doe_id), 'rebreed:' || l.id
    FROM litter l
    JOIN rabbit r         ON r.id = l.doe_id
    JOIN farm_settings fs ON fs.farm_id = l.farm_id
    WHERE fs.rebreed_anchor = 'kindling'
      AND r.status = 'active'
      -- The day before at the earliest, so it is on Today the morning it is due.
      AND COALESCE(p_today, farm_today(l.farm_id))
            >= l.kindled_on + fs.rebreed_after_kindling_days - 1
      -- Not if she is already back in a cycle.
      AND NOT EXISTS (SELECT 1 FROM mating m
                       WHERE m.doe_id = l.doe_id AND (m.mated_at)::date > l.kindled_on)
      -- Her latest litter only.
      AND NOT EXISTS (SELECT 1 FROM litter later
                       WHERE later.doe_id = l.doe_id AND later.kindled_on > l.kindled_on)
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- The day it is due, every phone at the farm, once a day, until it is done —
-- the same rule the monthly round follows (0043). generate_notifications()
-- pushes only critical tasks; a doe ready to be served is not an emergency,
-- but it is the whole point of the setting.
CREATE OR REPLACE FUNCTION generate_breed_notifications(p_today date DEFAULT NULL) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    INSERT INTO notification (farm_id, kind, title, body, urgency, rabbit_id, employee_id, dedupe_key)
    SELECT t.farm_id, 'task_due', t.title,
           CASE WHEN t.due_on < COALESCE(p_today, farm_today(t.farm_id))
                THEN 'Overdue since ' || t.due_on || '. ' ELSE 'Today. ' END
             || 'Take her to the buck and record the mating.',
           'high', t.rabbit_id,
           NULL,
           'task:' || t.id || ':' || COALESCE(p_today, farm_today(t.farm_id))
    FROM task t
    WHERE t.status = 'open'
      AND t.kind = 'breed'
      AND t.due_on <= COALESCE(p_today, farm_today(t.farm_id))
      AND NOT farm_is_quiet(t.farm_id)
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;
