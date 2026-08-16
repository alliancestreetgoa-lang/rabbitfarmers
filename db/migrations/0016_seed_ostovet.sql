-- ============================================================================
-- Give every farm the two Ostovet courses
--
-- The medication engine has worked since migration 0002. The protocol table,
-- the schedule expansion, the outstanding-doses view, the daily list entry and
-- the scheduler notification are all built and all tested in db/verify.sql.
--
-- No farm has ever had a protocol row.
--
-- verify.sql creates the two courses as fixtures and rolls them back, so the
-- assertions pass on data that never existed outside that transaction, and
-- seed_new_farm() — which does hand out condition types, a shed and breeds —
-- was never told about medication. The result: a farmer signs up, the app never
-- mentions Ostovet again, and the first thing they asked for silently does
-- nothing. Exactly the failure migration 0011 fixed for condition types.
--
-- The doses, from docs/03-breeding-engine.md:
--
--   before delivery  anchor expected kindling, offset -5, 5 doses, daily
--                    → gestation days 26–30, last dose the day before she is due
--   after delivery   anchor actual kindling,   offset +1, 5 doses, daily
--                    → the five days after she kindles
--
-- The pre-delivery course cancels itself if she kindles early: the
-- expected-kindling anchor only exists while a mating has no litter, so doses
-- 4 and 5 disappear rather than nagging about a delivery that has happened.
--
-- Ostovet (Virbac) is a calcium / phosphorus / D3 / B12 feed supplement, not a
-- drug, so withdrawal_days stays NULL — no meat withdrawal period applies.
-- ============================================================================

CREATE OR REPLACE FUNCTION seed_medication_protocols(p_farm_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO medication_protocol
        (farm_id, name, anchor, start_offset_days, doses, interval_days,
         dose_note, applies_to, withdrawal_days, notify)
    VALUES
        (p_farm_id, 'Ostovet (pre-delivery)', 'expected_kindling', -5, 5, 1,
         'In her drinking water. Five days, finishing the day before she is due.',
         'doe', NULL, true),
        (p_farm_id, 'Ostovet (post-delivery)', 'kindling', 1, 5, 1,
         'In her drinking water. Five days from the day after she kindles.',
         'doe', NULL, true)
    ON CONFLICT (farm_id, name, anchor) DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION seed_medication_protocols(uuid) FROM PUBLIC;

-- Every farm that signed up before this existed.
DO $$
DECLARE f record;
BEGIN
    FOR f IN SELECT id FROM farm LOOP
        PERFORM seed_medication_protocols(f.id);
    END LOOP;
END $$;

-- And into signup. seed_new_farm() is what auth_signup() calls, so adding it
-- here covers every new farm without touching the signup function again.
CREATE OR REPLACE FUNCTION seed_new_farm(p_farm_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO condition_type
        (farm_id, code, name, colour, reminder_interval_hours,
         blocks_breeding, is_contagious, escalate_after_hours, respect_quiet_hours)
    VALUES
        -- Enteritis is among the biggest killers in a rabbitry and can take a
        -- kit from loose to dead in a day, so: two-hourly, contagious, and it
        -- keeps her out of the breeding queue until it stops.
        (p_farm_id, 'loose_motion', 'Loose motion', '#EA580C', 2, true, true, 24, true),
        (p_farm_id, 'off_feed',     'Off feed',     '#A16207', 12, true, false, 48, true),
        (p_farm_id, 'injury',       'Injury',       '#B45309', 24, true, false, 48, true),
        (p_farm_id, 'sore_hocks',   'Sore hocks',   '#92400E', NULL, false, false, NULL, true),
        (p_farm_id, 'mastitis',     'Mastitis',     '#9F1239', 6, true, false, 12, false)
    ON CONFLICT (farm_id, code) DO NOTHING;

    INSERT INTO shed (farm_id, name) VALUES (p_farm_id, 'Shed A')
    ON CONFLICT (farm_id, name) DO NOTHING;

    INSERT INTO breed (farm_id, name, size_class, doe_first_mating_days, buck_first_mating_days)
    VALUES (p_farm_id, 'New Zealand White', 'medium', 150, 180),
           (p_farm_id, 'Californian',       'medium', 150, 180),
           (p_farm_id, 'Soviet Chinchilla', 'large',  180, 210)
    ON CONFLICT (farm_id, name) DO NOTHING;

    -- The medication rounds. Without this the whole reminder feature is dead on
    -- arrival for every new account, which is what it was.
    PERFORM seed_medication_protocols(p_farm_id);
END $$;
