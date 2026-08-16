-- ============================================================================
-- Application roles and the login path
--
-- Two roles, deliberately:
--
--   rabbitry_app    the farmer-facing API. NO bypassrls. Sees exactly one farm
--                   at a time, whichever app.farm_id is set to.
--   rabbitry_admin  the super-admin CRM. BYPASSRLS, because reaching across
--                   every tenant is its entire job.
--
-- Passwords are set by the deployment, not here — this migration only creates
-- the roles and grants if they are missing, so it is safe to re-run.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rabbitry_app') THEN
        CREATE ROLE rabbitry_app NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rabbitry_admin') THEN
        CREATE ROLE rabbitry_admin NOLOGIN BYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO rabbitry_app, rabbitry_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
    TO rabbitry_app, rabbitry_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
    TO rabbitry_app, rabbitry_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rabbitry_app, rabbitry_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO rabbitry_app, rabbitry_admin;

-- The app role must never write the price list or the admin tables.
REVOKE INSERT, UPDATE, DELETE ON plan FROM rabbitry_app;
REVOKE ALL ON platform_admin, admin_audit_log, admin_impersonation FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Chicken and egg: signing in needs to read employee and user_session BEFORE a
-- farm context exists, because that lookup is how the farm is discovered. RLS
-- would hide both rows.
--
-- Rather than punching a hole in the policies, sign-in goes through these two
-- SECURITY DEFINER functions. They are the only way the app role can read
-- across farms, they return the minimum needed, and they can be audited on one
-- screen.
-- ----------------------------------------------------------------------------

-- Look up a login by email. Returns the password hash for verification.
CREATE OR REPLACE FUNCTION auth_lookup_by_email(p_email text)
RETURNS TABLE (employee_id uuid, farm_id uuid, password_hash text,
               full_name text, role employee_role_t, is_active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT e.id, e.farm_id, e.password_hash, e.full_name, e.role, e.is_active
    FROM employee e
    WHERE e.email = p_email::citext
    LIMIT 1;
$$;

-- Resolve a session token hash to its farm and employee. Only live sessions.
CREATE OR REPLACE FUNCTION auth_resolve_session(p_token_hash text)
RETURNS TABLE (session_id uuid, employee_id uuid, farm_id uuid,
               full_name text, role employee_role_t)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT s.id, e.id, e.farm_id, e.full_name, e.role
    FROM user_session s
    JOIN employee e ON e.id = s.employee_id
    WHERE s.token_hash = p_token_hash
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
      AND e.is_active
    LIMIT 1;
$$;

-- Signup creates a farm plus its owner, which cannot happen under RLS because
-- there is no farm context until the farm exists. One function, one purpose,
-- returns the new ids.
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

REVOKE ALL ON FUNCTION auth_lookup_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_signup(text,text,text,text,text,text,text,text,text,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_by_email(text) TO rabbitry_app;
GRANT EXECUTE ON FUNCTION auth_resolve_session(text) TO rabbitry_app;
GRANT EXECUTE ON FUNCTION auth_signup(text,text,text,text,text,text,text,text,text,text,int) TO rabbitry_app;

-- Creating a session also predates the farm context.
CREATE OR REPLACE FUNCTION auth_create_session(
    p_employee_id uuid, p_token_hash text, p_days int, p_device text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    INSERT INTO user_session (employee_id, token_hash, expires_at, device)
    VALUES (p_employee_id, p_token_hash,
            now() + make_interval(days => COALESCE(p_days, 30)), p_device)
    RETURNING id;
$$;

CREATE OR REPLACE FUNCTION auth_revoke_session(p_token_hash text, p_all boolean)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
    IF p_all THEN
        UPDATE user_session SET revoked_at = now(), revoked_reason = 'sign out everywhere'
         WHERE revoked_at IS NULL
           AND employee_id = (SELECT employee_id FROM user_session
                              WHERE token_hash = p_token_hash);
    ELSE
        UPDATE user_session SET revoked_at = now(), revoked_reason = 'sign out'
         WHERE token_hash = p_token_hash AND revoked_at IS NULL;
    END IF;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

REVOKE ALL ON FUNCTION auth_create_session(uuid,text,int,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_revoke_session(text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_create_session(uuid,text,int,text) TO rabbitry_app;
GRANT EXECUTE ON FUNCTION auth_revoke_session(text,boolean) TO rabbitry_app;
