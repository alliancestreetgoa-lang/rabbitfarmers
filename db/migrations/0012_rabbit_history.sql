-- ============================================================================
-- A rabbit's history, and the guarantee that it survives her
--
-- Everything a farm records about an animal was already being stored — matings,
-- palpations, kindlings, weanings, weights, treatments, illnesses, cage moves.
-- Two things were missing, and together they meant the history might as well
-- not have existed:
--
--   1. Nothing could read it back. The animal's page showed her tag, breed,
--      birth date and cage. Her thirty matings were in the database and
--      invisible.
--
--   2. The end of her life could not be recorded at all. There was no way to
--      mark a rabbit sold, culled or dead — and `GET /animals` filtered dead
--      animals out, so the moment one was marked dead by hand she vanished,
--      taking every readable trace with her.
--
-- This migration adds the missing event table and the view that assembles a
-- single timeline. It deletes nothing and it changes no existing column.
--
-- The standing rule, which the rest of the schema already follows: an animal is
-- never deleted. She is marked sold, culled or dead, and everything recorded
-- about her stays. `mating.doe_id`, `litter.doe_id` and `rabbit.dam_id` are
-- deliberately NOT `ON DELETE CASCADE` — Postgres will physically refuse to
-- delete a rabbit that has ever bred, which is the guarantee written into the
-- keys rather than into a policy document.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Status changes as events, not as a single overwritten field
--
-- `rabbit.status_changed_on` holds the latest change and nothing else. A doe
-- who was quarantined in March, returned to service in April and sold in
-- November has three facts worth keeping, and the column can hold one.
-- ----------------------------------------------------------------------------
CREATE TABLE rabbit_status_change (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id      uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    rabbit_id    uuid NOT NULL,
    from_status  rabbit_status_t,
    to_status    rabbit_status_t NOT NULL,
    changed_on   date NOT NULL DEFAULT current_date,
    -- Why. "Sold to Prakash", "third failed service", "found dead in the nest".
    -- Free text on purpose: a farm's reasons are its own.
    reason       text,
    -- Set when to_status = 'sold'. Paise, like every other money column here,
    -- because floating point and money do not belong together.
    sale_price_paise int,
    recorded_by  uuid REFERENCES employee(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT price_only_when_sold
        CHECK (sale_price_paise IS NULL OR to_status = 'sold'),
    CONSTRAINT price_non_negative
        CHECK (sale_price_paise IS NULL OR sale_price_paise >= 0)
);

CREATE INDEX rabbit_status_change_idx
    ON rabbit_status_change (rabbit_id, changed_on DESC);

-- Tenant-scoped, per migration 0007: a plain rabbit_id FK is checked as the
-- table owner and bypasses RLS, so farm A could file a status change against
-- farm B's animal.
ALTER TABLE rabbit_status_change ADD CONSTRAINT rabbit_status_change_same_farm
    FOREIGN KEY (farm_id, rabbit_id) REFERENCES rabbit (farm_id, id) ON DELETE CASCADE;

ALTER TABLE rabbit_status_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE rabbit_status_change FORCE ROW LEVEL SECURITY;
CREATE POLICY rabbit_status_change_tenant ON rabbit_status_change
    USING (farm_id = current_farm_id())
    WITH CHECK (farm_id = current_farm_id());

-- ----------------------------------------------------------------------------
-- Keep rabbit.status honest
--
-- The status column is a cache of the latest event. A trigger keeps the two in
-- step so no caller can write one without the other, which is the same rule the
-- rest of the schema follows: record the event, derive the state.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_rabbit_status_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE rabbit
       SET status = NEW.to_status,
           status_changed_on = NEW.changed_on
     WHERE id = NEW.rabbit_id;
    RETURN NEW;
END $$;

CREATE TRIGGER rabbit_status_change_applies
    AFTER INSERT ON rabbit_status_change
    FOR EACH ROW EXECUTE FUNCTION apply_rabbit_status_change();

-- ----------------------------------------------------------------------------
-- v_rabbit_history — one animal's whole life, in order
--
-- A UNION rather than a join: these are different kinds of event with different
-- shapes, and forcing them into one table would have meant a nullable column
-- per event type. Each branch answers the same four questions — when, what
-- kind, what happened, and what else is worth knowing — and `detail` carries
-- whatever is specific to that kind.
--
-- `at` is a date because that is the resolution a farm works at, except for
-- health conditions and treatments where the hour genuinely matters; those keep
-- their timestamp in `detail`.
--
-- Ordered newest first, because the question is almost always "what has been
-- happening to her lately" rather than "what happened at birth".
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_rabbit_history AS

-- Born / acquired. Always the last line of the timeline.
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

-- Her own matings, as a doe.
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

-- The same matings from the buck's side, so his record is not empty. A buck's
-- working life is entirely other animals' events.
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
           'born_alive', l.born_alive, 'born_dead', l.born_dead,
           'fostered_in', nullif(l.fostered_in, 0),
           'fostered_out', nullif(l.fostered_out, 0),
           'notes', l.notes))
FROM litter l

UNION ALL

SELECT l.farm_id, l.doe_id, l.weaned_on, 4, 'weaning',
       'Kits separated — ' || COALESCE(l.weaned_count, 0) || ' weaned',
       jsonb_strip_nulls(jsonb_build_object(
           'weaned_count', l.weaned_count,
           'avg_weaning_weight_g', l.avg_weaning_weight_g,
           'days_to_wean', l.weaned_on - l.kindled_on))
FROM litter l
WHERE l.weaned_on IS NOT NULL

UNION ALL

-- weight_record carries no farm_id of its own; it reaches one through the
-- rabbit, which is also how its RLS policy works.
SELECT r.farm_id, w.rabbit_id, w.weighed_on, 5, 'weight',
       w.weight_g || ' g',
       jsonb_build_object('weight_g', w.weight_g)
FROM weight_record w
JOIN rabbit r ON r.id = w.rabbit_id

UNION ALL

-- Treatments and one-off health events: a dose given, a vaccination, an injury.
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

-- An illness that ran for a while: when it started, and when it stopped.
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
FROM rabbit_status_change sc;

-- ----------------------------------------------------------------------------
-- v_rabbit_lifetime — the summary that sits above the timeline
--
-- Kits weaned per doe per year is the number that decides whether a doe earns
-- her cage, so it is computed here rather than left for each caller to get
-- subtly wrong.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_rabbit_lifetime AS
SELECT
    r.farm_id,
    r.id AS rabbit_id,
    r.status,
    r.date_of_birth,
    CASE WHEN r.date_of_birth IS NOT NULL
         THEN (COALESCE(gone.changed_on, current_date) - r.date_of_birth)
    END AS age_days,
    gone.changed_on                                   AS left_herd_on,
    (SELECT count(*) FROM mating m WHERE m.doe_id = r.id)  AS matings,
    (SELECT count(*) FROM mating m WHERE m.buck_id = r.id) AS services,
    litters.litters,
    litters.born_alive,
    litters.weaned,
    -- Kits weaned per doe per year — the number that decides whether a doe
    -- earns her cage.
    --
    -- NULL until she has been in service half a year. Annualising a single
    -- litter gives a real division and a useless answer: seven kits over the 66
    -- days since her first kindling reads as 38.7 a year, which is an
    -- extrapolation from one event dressed up as a track record. Culling a doe
    -- on that, or keeping one, is worse than having no number at all.
    CASE WHEN litters.first_kindled IS NOT NULL
          AND COALESCE(gone.changed_on, current_date) - litters.first_kindled >= 180
         THEN round(litters.weaned::numeric * 365
              / (COALESCE(gone.changed_on, current_date) - litters.first_kindled), 1)
    END AS weaned_per_year,
    -- So a caller can say "too early to tell" rather than showing a blank.
    CASE WHEN litters.first_kindled IS NOT NULL
         THEN COALESCE(gone.changed_on, current_date) - litters.first_kindled
    END AS days_in_service,
    (SELECT count(*) FROM health_condition hc WHERE hc.rabbit_id = r.id) AS illnesses,
    (SELECT count(*) FROM health_event he WHERE he.rabbit_id = r.id)     AS treatments
FROM rabbit r
LEFT JOIN LATERAL (
    SELECT count(*)                                   AS litters,
           COALESCE(sum(l.born_alive), 0)             AS born_alive,
           COALESCE(sum(l.weaned_count), 0)           AS weaned,
           min(l.kindled_on)                          AS first_kindled
    FROM litter l WHERE l.doe_id = r.id
) litters ON true
LEFT JOIN LATERAL (
    SELECT sc.changed_on FROM rabbit_status_change sc
    WHERE sc.rabbit_id = r.id AND sc.to_status IN ('sold', 'culled', 'dead')
    ORDER BY sc.changed_on DESC LIMIT 1
) gone ON true;

-- Views run as their owner unless told otherwise, which would hand every farm
-- every other farm's history. See migration 0008.
ALTER VIEW v_rabbit_history  SET (security_invoker = true);
ALTER VIEW v_rabbit_lifetime SET (security_invoker = true);

-- Backfill: every rabbit already carries a status, and for most of them it is
-- 'active' and uninteresting. The ones worth a history entry are those somebody
-- had already moved off active by hand before this table existed.
INSERT INTO rabbit_status_change (farm_id, rabbit_id, from_status, to_status,
                                  changed_on, reason)
SELECT r.farm_id, r.id, 'active', r.status,
       COALESCE(r.status_changed_on, r.created_at::date),
       'Recorded before the app kept status history'
FROM rabbit r
WHERE r.status <> 'active';
