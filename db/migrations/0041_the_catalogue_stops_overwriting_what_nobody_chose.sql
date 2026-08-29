-- ============================================================================
-- The catalogue may overwrite what the curator chose, not what they left blank
--
-- apply_condition_catalog() presses the master catalogue onto a farm, and on a
-- code the farm already has it does DO UPDATE. That is the intended design —
-- sicknesses are veterinary knowledge and the superadmin is their only curator.
-- The defect is narrower: it wrote through values nobody ever chose.
--
--   reminder_interval_hours is optional on the admin form. Left blank it
--   arrived as NULL and was written straight over the farm's own figure, so
--   adding "Loose motion" to the catalogue without filling the reminder box
--   turned a two-hourly check into no check at all. Loose motion kills young
--   rabbits in a day; that is the difference between catching it and not.
--
--   blocks_breeding is worse, because the form has never shown it at all. The
--   column defaults to true, so every catalogue row silently carries "this
--   stops her breeding". Pressing one onto a farm whose sore hocks was
--   deliberately seeded as NOT blocking breeding would take every affected doe
--   out of the mating queue, with nothing on any screen to say why.
--
-- Both now mean "not specified": a NULL in the catalogue leaves the farm's
-- existing value alone, and only supplies a default when the row is new. A
-- figure the curator actually types is still applied everywhere, immediately,
-- exactly as before.
--
-- The cost of this shape is that a blank can no longer be used to CLEAR a
-- reminder that already exists. That is the right way round: clearing one is
-- rare and can be done by setting a long interval, whereas blanking one by
-- accident is a silence nobody notices until an animal is lost.
--
-- escalate_after_hours and respect_quiet_hours were never in the catalogue's
-- SET list and stay that way — they are the farm's, not the platform's.
-- ============================================================================

-- NULL becomes sayable. Existing rows carry the old column default rather than
-- a decision — the form never offered the field — so they are reset to NULL,
-- which reproduces today's behaviour on insert (COALESCE supplies true) while
-- giving up the power to silently flip a farm that already differs.
ALTER TABLE condition_catalog ALTER COLUMN blocks_breeding DROP NOT NULL;
ALTER TABLE condition_catalog ALTER COLUMN blocks_breeding DROP DEFAULT;
UPDATE condition_catalog SET blocks_breeding = NULL;

CREATE OR REPLACE FUNCTION apply_condition_catalog(p_farm_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_type_id uuid;
BEGIN
    FOR r IN SELECT * FROM condition_catalog WHERE is_active LOOP
        INSERT INTO condition_type
            (farm_id, code, name, colour, reminder_interval_hours,
             blocks_breeding, is_contagious, respect_quiet_hours)
        VALUES (p_farm_id, r.code, r.name, r.colour, r.reminder_interval_hours,
                COALESCE(r.blocks_breeding, true), r.is_contagious, true)
        ON CONFLICT (farm_id, code) DO UPDATE
            SET name = EXCLUDED.name,
                colour = EXCLUDED.colour,
                -- COALESCE, not EXCLUDED: a blank box is "no opinion", and a
                -- farm's existing rhythm outranks no opinion.
                reminder_interval_hours = COALESCE(
                    EXCLUDED.reminder_interval_hours,
                    condition_type.reminder_interval_hours),
                blocks_breeding = COALESCE(
                    r.blocks_breeding, condition_type.blocks_breeding),
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
-- Kept from 0040: the admin console calls this directly as rabbitry_admin, and
-- CREATE OR REPLACE above does not disturb the grant, but say it outright so a
-- rebuild from migrations cannot lose it again.
GRANT EXECUTE ON FUNCTION apply_condition_catalog(uuid) TO rabbitry_admin;
