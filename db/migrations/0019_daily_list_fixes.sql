-- ============================================================================
-- Two bugs in what the farmer actually reads
--
-- ---------------------------------------------------------------------------
-- 1. "Today" was the server's today, not the farm's
--
-- v_daily_list and v_medication_due compare due dates against `current_date`,
-- which on Netlify is UTC. The scheduler was careful about this — it uses
-- farm_today(farm_id) everywhere — but the view that opens when a farmer signs
-- in was not.
--
-- For a farm in Asia/Kolkata that means every task and dose due today is
-- invisible until 05:30 local, because until then UTC is still on yesterday.
-- Farmers start at six. It is a five-and-a-half hour window in which the app
-- says there is nothing to do, every single morning, and the first feed round
-- is exactly when someone opens it.
--
-- West of UTC it fails the other way: at 21:00 in São Paulo the server is
-- already on tomorrow, so tomorrow's work appears tonight and today's reads as
-- overdue.
--
-- `urgency` had the same fault, so a task due today could be painted red purely
-- because of where the server happens to run.
--
-- ---------------------------------------------------------------------------
-- 2. A kit dying made the app offer to replace it
--
-- v_litter_kits counted only living kits as "recorded", so when one of eight
-- died the count dropped to seven and not_yet_recorded went to one — and the
-- doe's page offered "+ 1 kits", inviting the farmer to create a ninth record
-- for a rabbit that was never born.
--
-- A kit that has been recorded stays recorded. That it later died is a fact
-- about that kit, on its own page, not a hole in the litter.
-- ============================================================================

CREATE OR REPLACE VIEW v_medication_due AS
SELECT s.*,
       (s.due_on - farm_today(s.farm_id)) AS days_until_due,
       (s.due_on < farm_today(s.farm_id) - medication_grace_days()) AS lapsed
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
    CASE WHEN md.due_on < farm_today(md.farm_id) THEN 'critical' ELSE 'high' END AS urgency,
    NULL::text                            AS colour
FROM v_medication_due md
JOIN rabbit r ON r.id = md.rabbit_id
WHERE md.notify
  AND md.due_on <= farm_today(md.farm_id)
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
    CASE WHEN t.due_on < farm_today(t.farm_id) THEN 'critical' ELSE t.priority::text END,
    NULL::text
FROM task t
LEFT JOIN rabbit r ON r.id = t.rabbit_id
WHERE t.status = 'open'
  AND t.due_on <= farm_today(t.farm_id)

UNION ALL

SELECT
    'condition',
    oc.condition_id::text,
    oc.rabbit_id,
    oc.tag,
    oc.farm_id,
    farm_today(oc.farm_id),
    oc.last_checked_at,
    oc.condition_name || ' — check ' || COALESCE(oc.rabbit_name, oc.tag, 'the litter')
      || ' (' || oc.hours_open || 'h)',
    CASE WHEN oc.needs_escalation THEN 'critical' ELSE 'high' END,
    oc.colour
FROM v_open_conditions oc;

CREATE OR REPLACE VIEW v_litter_kits AS
SELECT
    l.id                                    AS litter_id,
    l.farm_id,
    l.doe_id,
    l.kindled_on,
    l.born_alive,
    l.weaned_on,
    l.weaned_count,
    COALESCE(l.weaned_count, l.born_alive)  AS expected,
    -- Every kit ever given a record, alive or not. One that died is still
    -- recorded; treating it as missing invites a replacement for a rabbit that
    -- never existed.
    count(k.id)                             AS recorded,
    GREATEST(COALESCE(l.weaned_count, l.born_alive) - count(k.id), 0) AS not_yet_recorded,
    -- Appended, not inserted: CREATE OR REPLACE VIEW may only add columns at
    -- the end. Reordering means dropping the view, and dropping it means
    -- dropping whatever comes to depend on it later.
    count(k.id) FILTER (WHERE k.status = 'dead') AS died
FROM litter l
LEFT JOIN rabbit k ON k.litter_id = l.id
GROUP BY l.id;

ALTER VIEW v_medication_due SET (security_invoker = true);
ALTER VIEW v_daily_list     SET (security_invoker = true);
ALTER VIEW v_litter_kits    SET (security_invoker = true);
