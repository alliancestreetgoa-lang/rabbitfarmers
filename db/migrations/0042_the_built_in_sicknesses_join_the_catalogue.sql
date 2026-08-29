-- ============================================================================
-- The five built-in sicknesses become curatable
--
-- Every farm is born with loose motion, off feed, injury, sore hocks and
-- mastitis. They were written by seed_new_farm() straight into condition_type
-- and existed nowhere else — so the admin console, which is the one place
-- sicknesses are supposed to be curated from, could not see them. The farm's
-- report screen offered six sicknesses while "The catalogue" listed one, and
-- the superadmin could not say what to give for any of the five. Loose motion
-- kills a young rabbit in a day and had no medicine attached to it anywhere.
--
-- They are inserted here with exactly the values the farms already hold, so
-- pressing the catalogue afterwards is a no-op: same colours, same reminder
-- rhythms, same contagious and blocks_breeding flags. Nothing about any farm
-- changes today. What changes is that tomorrow the superadmin can edit them.
--
-- medicine is deliberately left NULL on all five. Setting one here would start
-- a course on every farm in the world at once, which is a decision for a
-- person in the console, not for a migration.
--
-- ON CONFLICT DO NOTHING: on a database where somebody has already added one
-- of these codes by hand, theirs wins. This migration introduces rows, it does
-- not reset them.
-- ============================================================================

INSERT INTO condition_catalog
    (code, name, colour, reminder_interval_hours, blocks_breeding, is_contagious)
VALUES
    ('loose_motion', 'Loose motion', '#EA580C',  2, true,  true),
    ('off_feed',     'Off feed',     '#A16207', 12, true,  false),
    ('injury',       'Injury',       '#B45309', 24, true,  false),
    ('sore_hocks',   'Sore hocks',   '#92400E', NULL, false, false),
    ('mastitis',     'Mastitis',     '#9F1239',  6, true,  false)
ON CONFLICT (code) DO NOTHING;

-- Prove the claim that this is a no-op rather than asserting it in a comment.
-- escalate_after_hours is not the catalogue's to set and must survive: loose
-- motion escalates at 24h, mastitis at 12h, and those are the farm's.
DO $$
DECLARE bad int;
BEGIN
    PERFORM apply_condition_catalog(id) FROM farm;

    SELECT count(*) INTO bad
      FROM condition_type ct
     WHERE ct.code = 'loose_motion'
       AND (ct.reminder_interval_hours IS DISTINCT FROM 2
            OR ct.escalate_after_hours IS DISTINCT FROM 24);
    IF bad > 0 THEN
        RAISE EXCEPTION 'loose motion changed on % farm(s) — it must not', bad;
    END IF;

    SELECT count(*) INTO bad
      FROM condition_type ct
     WHERE ct.code = 'sore_hocks' AND ct.blocks_breeding IS DISTINCT FROM false;
    IF bad > 0 THEN
        RAISE EXCEPTION 'sore hocks started blocking breeding on % farm(s)', bad;
    END IF;
END $$;
