-- ============================================================================
-- 0045  The monthly routine moves to the 7th, and runs to the 16th
--
-- The farm's rotation, as it is actually done: Hitech (oral) on the 7th, 8th
-- and 9th; a three-day gap; then Liv 52 on the 13th, 14th and 15th. Gutwell
-- keeps riding with Liv 52 (both morning rounds, only one wants an empty
-- stomach, so they do not fight), and Tetracycline goes into the water the
-- day after the course, the 16th. 0043 laid the same steps over days 1–7.
--
-- With the round no longer confined to the first week, generate_routine_tasks()
-- stops asking whether today is in it. It raises every step of the current
-- month that is still ahead, so a farm always has its next dates queued and a
-- farm that joins mid-month gets what is left of the month, never what it
-- missed. A day nobody ticks is already red on Today the next morning
-- (v_daily_list promotes any overdue task to critical) and is pushed again
-- every morning by generate_routine_notifications(); neither changes here.
-- ============================================================================

UPDATE routine_catalog SET day = 7  WHERE step = 1;
UPDATE routine_catalog SET day = 8  WHERE step = 2;
UPDATE routine_catalog SET day = 9  WHERE step = 3;
UPDATE routine_catalog SET day = 13 WHERE step IN (4, 7);
UPDATE routine_catalog SET day = 14 WHERE step IN (5, 8);
UPDATE routine_catalog SET day = 15 WHERE step IN (6, 9);
UPDATE routine_catalog SET day = 16 WHERE step = 10;

CREATE OR REPLACE FUNCTION generate_routine_tasks(p_today date DEFAULT NULL) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    INSERT INTO task (farm_id, kind, title, notes, due_on, priority, generated_key)
    SELECT f.id, 'medicate',
           rc.title,
           rc.detail
             || ' Every day: Agrimin Forte 1 g per adult breeder in the morning feed;'
             || ' Calcium Ostovet + Vimeral may go into the daily feed for the whole herd.',
           ms.month_start + (rc.day - 1),
           'high',
           'routine:' || f.id || ':' || to_char(ms.month_start, 'YYYY-MM') || ':' || rc.step
    FROM farm f
    CROSS JOIN LATERAL (
        SELECT date_trunc('month', COALESCE(p_today, farm_today(f.id)))::date AS month_start,
               COALESCE(p_today, farm_today(f.id)) AS today
    ) ms
    JOIN routine_catalog rc ON rc.is_active
    -- Only the days still ahead. A farm that joins on the 10th gets the 13th
    -- onward; one that joins on the 20th waits for next month rather than
    -- being handed the month's missed rounds as overdue work on day one.
    WHERE ms.month_start + (rc.day - 1) >= ms.today
      -- No rabbits, no round.
      AND EXISTS (SELECT 1 FROM rabbit r
                   WHERE r.farm_id = f.id AND r.status IN ('active', 'quarantine'))
    ON CONFLICT (generated_key) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;
