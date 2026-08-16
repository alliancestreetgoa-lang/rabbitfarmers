-- ============================================================================
-- Give a brand-new farm the rows it needs to be usable
--
-- Signup created the farm, its settings, the owner and the trial — but not a
-- single condition_type. So the very first thing a farmer might do, report a
-- rabbit with loose motion, failed with "Unknown condition". The whole
-- health-alert feature was dead on arrival for every new account, and nothing
-- caught it because the tests all inserted a condition_type by hand.
--
-- Loose motion is seeded because it is the one that kills. The farmer can add
-- more in settings; these are defaults, not a fixed list.
-- ============================================================================

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

    -- One shed and a default breed, so the first rabbit can be added without a
    -- setup wizard first.
    INSERT INTO shed (farm_id, name) VALUES (p_farm_id, 'Shed A')
    ON CONFLICT (farm_id, name) DO NOTHING;

    INSERT INTO breed (farm_id, name, size_class, doe_first_mating_days, buck_first_mating_days)
    VALUES (p_farm_id, 'New Zealand White', 'medium', 150, 180),
           (p_farm_id, 'Californian',       'medium', 150, 180),
           (p_farm_id, 'Soviet Chinchilla', 'large',  180, 210)
    ON CONFLICT (farm_id, name) DO NOTHING;
END $$;

-- Backfill anyone who signed up before this existed.
DO $$
DECLARE f record;
BEGIN
    FOR f IN SELECT id FROM farm LOOP
        PERFORM seed_new_farm(f.id);
    END LOOP;
END $$;

-- Wire it into signup.
CREATE OR REPLACE FUNCTION auth_signup(
    p_farm_name text, p_full_name text, p_email text, p_phone text,
    p_password_hash text, p_address_line text, p_city text, p_state text,
    p_pincode text, p_timezone text, p_trial_days int)
RETURNS TABLE (farm_id uuid, employee_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_farm uuid;
    v_emp  uuid;
    v_plan uuid;
BEGIN
    INSERT INTO farm (name, timezone, address_line, city, state, pincode)
    VALUES (p_farm_name, COALESCE(p_timezone, 'Asia/Kolkata'),
            p_address_line, p_city, p_state, p_pincode)
    RETURNING id INTO v_farm;

    -- Defaults come from the settings table's own defaults, which encode the
    -- gentle rhythm: separate at 30 days, rebreed 3 days later.
    INSERT INTO farm_settings (farm_id) VALUES (v_farm);

    INSERT INTO employee (farm_id, full_name, email, phone, role, password_hash)
    VALUES (v_farm, p_full_name, p_email::citext, p_phone, 'owner', p_password_hash)
    RETURNING id INTO v_emp;

    -- Condition types, a shed and some breeds, so the app works from the first
    -- screen rather than after a setup wizard.
    PERFORM seed_new_farm(v_farm);

    -- Start the trial on whichever plan is currently on sale, and snapshot its
    -- price so an introductory rate is kept even after the list price rises.
    SELECT id INTO v_plan FROM v_current_public_plan LIMIT 1;
    IF v_plan IS NOT NULL THEN
        INSERT INTO subscription (farm_id, plan_id, status, billing_period,
                                  trial_ends_on, locked_price_monthly_paise,
                                  locked_price_yearly_paise, price_locked_at)
        SELECT v_farm, p.id, 'trialing', 'yearly',
               current_date + COALESCE(p_trial_days, 30),
               p.price_monthly_paise, p.price_yearly_paise, now()
        FROM plan p WHERE p.id = v_plan;
    END IF;

    RETURN QUERY SELECT v_farm, v_emp;
END $$;

REVOKE ALL ON FUNCTION seed_new_farm(uuid) FROM PUBLIC;
