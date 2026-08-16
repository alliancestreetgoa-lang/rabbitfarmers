-- ============================================================================
-- Corrections — editing a record without losing what it said before
--
-- A farmer counts eight kits in the nest at six in the morning, writes it down,
-- and finds a ninth under the fur an hour later. The record has to be
-- correctable or it will not be trusted. But a correction that overwrites is a
-- second way to lose history, and the whole point of this schema is that events
-- are kept.
--
-- So: edits are allowed, and every one of them writes the before and after into
-- audit_log. The doe's timeline shows the correction as its own line — what
-- changed, when, and who changed it.
--
-- ---------------------------------------------------------------------------
-- audit_log had no row-level security
--
-- It was created in migration 0001 and never written to, which is the only
-- reason it was not a leak. It carries farm_id, migration 0006 grants the
-- farmer-facing role SELECT on every table in the schema, and migration 0005's
-- list of tenant tables does not mention it. The moment anything wrote a farm's
-- edits there, every other farm could read them.
--
-- Fixing that is the first thing this migration does, before the first row is
-- ever inserted.
-- ============================================================================

-- farm_id was a bare uuid with no foreign key, so deleting a farm would have
-- left its audit rows behind as orphans pointing at nothing.
ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_farm_fkey
    FOREIGN KEY (farm_id) REFERENCES farm(id) ON DELETE CASCADE;

-- Who made the change. ON DELETE SET NULL rather than CASCADE: a farm hand
-- leaving must not take the record of their corrections with them.
ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_changed_by_fkey
    FOREIGN KEY (changed_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant ON audit_log
    USING (farm_id = current_farm_id())
    WITH CHECK (farm_id = current_farm_id());

-- Append-only from the farm's side. A farm may write a correction and read its
-- own history; it may not rewrite or erase one, which is the only property that
-- makes an audit trail worth having.
REVOKE UPDATE, DELETE ON audit_log FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Corrections in a rabbit's timeline
--
-- v_rabbit_history is replaced rather than altered — CREATE OR REPLACE VIEW
-- cannot add a branch to a UNION, so the whole definition is restated here with
-- one more arm. This is the current definition; 0012's is superseded.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_rabbit_history;

CREATE VIEW v_rabbit_history AS

SELECT r.farm_id, r.id AS rabbit_id, r.date_of_birth AS on_date, 0 AS ord,
       'born'::text AS kind,
       CASE WHEN r.origin = 'purchased' THEN 'Bought in' ELSE 'Born here' END AS title,
       jsonb_strip_nulls(jsonb_build_object(
           'origin', r.origin,
           'dam', (SELECT d.name FROM rabbit d WHERE d.id = r.dam_id),
           'sire', (SELECT s.name FROM rabbit s WHERE s.id = r.sire_id)
       )) AS detail
FROM rabbit r
WHERE r.date_of_birth IS NOT NULL

UNION ALL

SELECT m.farm_id, m.doe_id, m.mated_at::date, 1, 'mating',
       'Mated with ' || COALESCE(b.name, b.tag, 'an unrecorded buck'),
       jsonb_strip_nulls(jsonb_build_object(
           'buck', COALESCE(b.name, b.tag),
           'outcome', m.outcome::text,
           'services', m.service_count,
           'receptivity', nullif(m.receptivity::text, 'unknown'),
           'notes', m.notes))
FROM mating m LEFT JOIN rabbit b ON b.id = m.buck_id

UNION ALL

SELECT m.farm_id, m.buck_id, m.mated_at::date, 1, 'service',
       'Served ' || COALESCE(d.name, d.tag),
       jsonb_strip_nulls(jsonb_build_object(
           'doe', COALESCE(d.name, d.tag),
           'outcome', m.outcome::text,
           'services', m.service_count))
FROM mating m JOIN rabbit d ON d.id = m.doe_id
WHERE m.buck_id IS NOT NULL

UNION ALL

SELECT m.farm_id, m.doe_id, pc.checked_on, 2, 'pregnancy_check',
       CASE pc.result
           WHEN 'positive'  THEN 'Palpated — pregnant'
           WHEN 'negative'  THEN 'Palpated — not pregnant'
           ELSE 'Palpated — uncertain'
       END,
       jsonb_strip_nulls(jsonb_build_object(
           'result', pc.result::text, 'method', pc.method::text, 'notes', pc.notes))
FROM pregnancy_check pc JOIN mating m ON m.id = pc.mating_id

UNION ALL

SELECT l.farm_id, l.doe_id, l.kindled_on, 3, 'kindling',
       'Kindled — ' || l.born_alive || ' alive'
         || CASE WHEN l.born_dead > 0 THEN ', ' || l.born_dead || ' dead' ELSE '' END,
       jsonb_strip_nulls(jsonb_build_object(
           'litter_id', l.id,
           'born_alive', l.born_alive, 'born_dead', l.born_dead,
           'fostered_in', nullif(l.fostered_in, 0),
           'fostered_out', nullif(l.fostered_out, 0),
           'notes', l.notes))
FROM litter l

UNION ALL

SELECT l.farm_id, l.doe_id, l.weaned_on, 4, 'weaning',
       'Kits separated — ' || COALESCE(l.weaned_count, 0) || ' weaned',
       jsonb_strip_nulls(jsonb_build_object(
           'litter_id', l.id,
           'weaned_count', l.weaned_count,
           'avg_weaning_weight_g', l.avg_weaning_weight_g,
           'days_to_wean', l.weaned_on - l.kindled_on))
FROM litter l
WHERE l.weaned_on IS NOT NULL

UNION ALL

SELECT r.farm_id, w.rabbit_id, w.weighed_on, 5, 'weight',
       w.weight_g || ' g',
       jsonb_build_object('weight_g', w.weight_g)
FROM weight_record w
JOIN rabbit r ON r.id = w.rabbit_id

UNION ALL

SELECT h.farm_id, h.rabbit_id, h.occurred_on, 6, 'health_event',
       COALESCE(h.medicine, h.diagnosis, initcap(h.category))
         || CASE WHEN h.dose_number IS NOT NULL
                 THEN ' — dose ' || h.dose_number ELSE '' END,
       jsonb_strip_nulls(jsonb_build_object(
           'category', h.category, 'medicine', h.medicine, 'dose', h.dose,
           'diagnosis', h.diagnosis, 'dose_number', h.dose_number,
           'withdrawal_until', h.withdrawal_until))
FROM health_event h
WHERE h.rabbit_id IS NOT NULL

UNION ALL

SELECT hc.farm_id, hc.rabbit_id, hc.started_at::date, 7, 'condition',
       ct.name || CASE WHEN hc.resolved_at IS NULL THEN ' — still open' ELSE '' END,
       jsonb_strip_nulls(jsonb_build_object(
           'condition', ct.name, 'severity', hc.severity, 'notes', hc.notes,
           'started_at', hc.started_at,
           'resolved_at', hc.resolved_at,
           'hours_open', round(EXTRACT(epoch FROM
               COALESCE(hc.resolved_at, now()) - hc.started_at) / 3600.0, 1),
           'checks', (SELECT count(*) FROM condition_check cc
                       WHERE cc.condition_id = hc.id)))
FROM health_condition hc
JOIN condition_type ct ON ct.id = hc.condition_type_id
WHERE hc.rabbit_id IS NOT NULL

UNION ALL

SELECT r.farm_id, mv.rabbit_id, mv.moved_at::date, 8, 'moved',
       'Moved to ' || COALESCE(tc.code, 'another cage'),
       jsonb_strip_nulls(jsonb_build_object(
           'from', fc.code, 'to', tc.code, 'reason', mv.reason))
FROM movement mv
JOIN rabbit r      ON r.id  = mv.rabbit_id
LEFT JOIN cage fc  ON fc.id = mv.from_cage_id
LEFT JOIN cage tc  ON tc.id = mv.to_cage_id

UNION ALL

SELECT sc.farm_id, sc.rabbit_id, sc.changed_on, 9, 'status',
       CASE sc.to_status
           WHEN 'sold'       THEN 'Sold'
           WHEN 'culled'     THEN 'Culled'
           WHEN 'dead'       THEN 'Died'
           WHEN 'quarantine' THEN 'Put in quarantine'
           ELSE 'Back in service'
       END,
       jsonb_strip_nulls(jsonb_build_object(
           'from', sc.from_status::text, 'to', sc.to_status::text,
           'reason', sc.reason, 'sale_price_paise', sc.sale_price_paise))
FROM rabbit_status_change sc

UNION ALL

-- Corrections to a litter. Shown against the doe, because that is whose
-- timeline the record belongs to.
--
-- ord 10 puts it above the kindling it corrects when both fall on the same day,
-- which is the common case: you write eight at dawn and fix it to nine an hour
-- later.
SELECT al.farm_id, l.doe_id, al.changed_at::date, 10, 'correction',
       'Kindling record corrected',
       jsonb_strip_nulls(jsonb_build_object(
           'litter_id', l.id,
           'at', al.changed_at,
           'by', e.full_name,
           'before', al.old_values,
           'after', al.new_values))
FROM audit_log al
JOIN litter l ON l.id = al.record_id AND al.table_name = 'litter'
LEFT JOIN employee e ON e.id = al.changed_by
WHERE al.action = 'update';

ALTER VIEW v_rabbit_history SET (security_invoker = true);
