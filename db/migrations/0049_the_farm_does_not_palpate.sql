-- ============================================================================
-- 0049  The farm does not palpate
--
-- "I don't want to see a notification for Palpate." A doe served by two or
-- three bucks is taken as pregnant at mating (0044), and the farm does not
-- palpate the rest either: the next thing anyone does for a served doe is
-- the nest box, then the kindling watch, then "overdue" if nothing comes.
-- So job 1 of generate_due_tasks() — "Palpate <doe> — day 12" — goes, and
-- the open ones already raised are cancelled. The day-28 re-check before the
-- nest box (job 2) stays. Restated whole: plpgsql cannot be patched.
-- ============================================================================

UPDATE task SET status = 'cancelled'
 WHERE kind = 'palpate' AND status = 'open';

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

    -- (job 1, palpation, removed in 0049: the farm does not palpate)

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
