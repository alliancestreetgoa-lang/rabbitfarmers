-- ============================================================================
-- 0037  The sickness catalogue belongs to the platform, not the farm
--
-- Sicknesses and their treatments are veterinary knowledge, and the product
-- decision is that ONLY the superadmin curates them: a farmer reports what
-- they see and is TOLD what to give — they never edit the medicine cabinet,
-- and neither do their staff.
--
-- condition_type stays per-farm (RLS, history, reminders all hang off it);
-- this table is the master copy. apply_condition_catalog() presses the master
-- onto one farm, the admin console calls it for every farm after each change,
-- and seed_new_farm() calls it at signup so new farms are born current.
-- ============================================================================

CREATE TABLE condition_catalog (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code                    text NOT NULL UNIQUE,
    name                    text NOT NULL,
    colour                  text NOT NULL DEFAULT '#EA580C',
    reminder_interval_hours numeric(4,1),
    blocks_breeding         boolean NOT NULL DEFAULT true,
    is_contagious           boolean NOT NULL DEFAULT false,
    -- The treatment. NULL medicine means "reminders only" — still worth
    -- cataloguing, the way sore hocks has no bottle but has a check rhythm.
    medicine                text,
    treatment_days          int CHECK (treatment_days BETWEEN 1 AND 60),
    interval_days           int NOT NULL DEFAULT 1 CHECK (interval_days BETWEEN 1 AND 30),
    dose_note               text,
    withdrawal_days         int,
    is_active               boolean NOT NULL DEFAULT true,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- The admin console is the only writer; the app role never touches it.
GRANT SELECT, INSERT, UPDATE, DELETE ON condition_catalog TO rabbitry_admin;

CREATE OR REPLACE FUNCTION apply_condition_catalog(p_farm_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_type_id uuid;
BEGIN
    FOR r IN SELECT * FROM condition_catalog WHERE is_active LOOP
        INSERT INTO condition_type
            (farm_id, code, name, colour, reminder_interval_hours,
             blocks_breeding, is_contagious, respect_quiet_hours)
        VALUES (p_farm_id, r.code, r.name, r.colour, r.reminder_interval_hours,
                r.blocks_breeding, r.is_contagious, true)
        ON CONFLICT (farm_id, code) DO UPDATE
            SET name = EXCLUDED.name,
                colour = EXCLUDED.colour,
                reminder_interval_hours = EXCLUDED.reminder_interval_hours,
                blocks_breeding = EXCLUDED.blocks_breeding,
                is_contagious = EXCLUDED.is_contagious,
                is_active = true
        RETURNING id INTO v_type_id;

        IF r.medicine IS NOT NULL AND r.treatment_days IS NOT NULL THEN
            -- One live treatment per sickness: retire whatever else was
            -- attached, then press the current one on.
            UPDATE medication_protocol SET is_active = false
             WHERE farm_id = p_farm_id AND condition_type_id = v_type_id
               AND is_active AND name <> r.medicine || ' (' || r.name || ')';

            INSERT INTO medication_protocol
                (farm_id, name, anchor, start_offset_days, doses, interval_days,
                 dose_note, applies_to, withdrawal_days, notify, condition_type_id)
            VALUES (p_farm_id, r.medicine || ' (' || r.name || ')', 'condition', 0,
                    r.treatment_days, r.interval_days, r.dose_note, 'any',
                    r.withdrawal_days, true, v_type_id)
            ON CONFLICT (farm_id, name, anchor) DO UPDATE
                SET is_active = true,
                    doses = EXCLUDED.doses,
                    interval_days = EXCLUDED.interval_days,
                    dose_note = EXCLUDED.dose_note,
                    withdrawal_days = EXCLUDED.withdrawal_days,
                    condition_type_id = EXCLUDED.condition_type_id;
        ELSE
            UPDATE medication_protocol SET is_active = false
             WHERE farm_id = p_farm_id AND condition_type_id = v_type_id AND is_active;
        END IF;
    END LOOP;

    -- A catalogue row switched off goes quiet on the farm too. Its history
    -- stays; only the picker and the reminders forget it.
    UPDATE condition_type ct SET is_active = false
     WHERE ct.farm_id = p_farm_id
       AND ct.code IN (SELECT code FROM condition_catalog WHERE NOT is_active);
END $$;

REVOKE ALL ON FUNCTION apply_condition_catalog(uuid) FROM PUBLIC;

-- New farms are born with the catalogue already pressed on.
CREATE OR REPLACE FUNCTION seed_new_farm(p_farm_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO condition_type
        (farm_id, code, name, colour, reminder_interval_hours,
         blocks_breeding, is_contagious, escalate_after_hours, respect_quiet_hours)
    VALUES
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

    PERFORM seed_medication_protocols(p_farm_id);

    -- Whatever the superadmin has curated, this farm starts with it.
    PERFORM apply_condition_catalog(p_farm_id);
END $$;
