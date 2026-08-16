-- ============================================================================
-- Corrections to a rabbit's own details show on her timeline
--
-- Migration 0013 added a correction line for litters, keyed on
-- `table_name = 'litter'`. Rabbits are now editable too — a kit recorded as
-- unsexed at thirty days gets sexed at eight weeks, a name is fixed, an animal
-- moves cage — and every one of those edits was landing in audit_log and
-- appearing nowhere.
--
-- Rather than adding a second hardcoded arm and a third one later, the
-- correction branch now covers both tables from one join, so anything the API
-- decides to audit turns up on the right animal's timeline without another
-- migration.
--
-- CREATE OR REPLACE VIEW cannot change the shape of a UNION, so the whole
-- definition is restated. This supersedes 0013's.
-- ============================================================================

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

-- Corrections, whatever was corrected.
--
-- A litter's correction belongs on the doe's timeline; a rabbit's belongs on
-- her own. One LATERAL resolves which, so a third auditable table needs a row
-- here and not another migration.
--
-- ord 10 puts a correction above the record it corrects when both land on the
-- same day, which is the common case — eight at dawn, nine an hour later.
SELECT al.farm_id, subj.rabbit_id, al.changed_at::date, 10, 'correction',
       CASE al.table_name
           WHEN 'litter' THEN 'Kindling record corrected'
           WHEN 'rabbit' THEN 'Details corrected'
           ELSE initcap(al.table_name) || ' corrected'
       END,
       jsonb_strip_nulls(jsonb_build_object(
           'table', al.table_name,
           'litter_id', CASE WHEN al.table_name = 'litter' THEN al.record_id END,
           'at', al.changed_at,
           'by', e.full_name,
           'before', al.old_values,
           'after', al.new_values))
FROM audit_log al
CROSS JOIN LATERAL (
    SELECT CASE al.table_name
               WHEN 'litter' THEN (SELECT l.doe_id FROM litter l WHERE l.id = al.record_id)
               WHEN 'rabbit' THEN al.record_id
           END AS rabbit_id
) subj
LEFT JOIN employee e ON e.id = al.changed_by
WHERE al.action = 'update'
  AND subj.rabbit_id IS NOT NULL;

ALTER VIEW v_rabbit_history SET (security_invoker = true);
