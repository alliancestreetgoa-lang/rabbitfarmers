-- ============================================================================
-- Row-level security
--
-- One database, many farms. A cross-tenant leak ends the product, so isolation
-- is enforced in Postgres rather than trusted to application code.
--
-- How it works:
--   * The API connects as `rabbitry_app`, which has NO bypassrls.
--   * On every request it runs  SELECT set_config('app.farm_id', $1, true)
--     inside the transaction. The `true` makes it transaction-local, so a
--     pooled connection cannot leak one farm's context into the next request.
--   * Policies compare farm_id against that setting.
--
--   * The admin CRM connects as `rabbitry_admin`, which DOES bypass RLS. That
--     is the whole point of it, and precisely why farm-facing code must never
--     use that role. Two roles, two connection strings, not a feature flag.
--
-- WITH CHECK matters as much as USING: without it a caller could INSERT a row
-- stamped with somebody else's farm_id.
-- ============================================================================

-- Returns NULL rather than throwing when unset, so an unauthenticated
-- connection simply sees nothing instead of erroring.
CREATE OR REPLACE FUNCTION current_farm_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.farm_id', true), '')::uuid;
$$;

DO $$
DECLARE
    -- Every table carrying a farm_id column.
    t text;
    direct text[] := ARRAY[
        'farm_settings','breed','shed','cage','employee','attendance',
        'rabbit','mating','litter','health_event','health_condition',
        'condition_type','medication_protocol','task','subscription','invoice'
    ];
BEGIN
    FOREACH t IN ARRAY direct LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I USING (farm_id = current_farm_id())
                 WITH CHECK (farm_id = current_farm_id())',
            t || '_tenant', t);
    END LOOP;
END $$;

-- `farm` keys on id rather than farm_id.
ALTER TABLE farm ENABLE ROW LEVEL SECURITY;
ALTER TABLE farm FORCE ROW LEVEL SECURITY;
CREATE POLICY farm_tenant ON farm
    USING (id = current_farm_id())
    WITH CHECK (id = current_farm_id());

-- Tables with no farm_id of their own reach it through a parent.
ALTER TABLE movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE movement FORCE ROW LEVEL SECURITY;
CREATE POLICY movement_tenant ON movement
    USING (EXISTS (SELECT 1 FROM rabbit r
                   WHERE r.id = movement.rabbit_id AND r.farm_id = current_farm_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM rabbit r
                   WHERE r.id = movement.rabbit_id AND r.farm_id = current_farm_id()));

ALTER TABLE receptivity_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE receptivity_check FORCE ROW LEVEL SECURITY;
CREATE POLICY receptivity_tenant ON receptivity_check
    USING (EXISTS (SELECT 1 FROM rabbit r
                   WHERE r.id = receptivity_check.rabbit_id AND r.farm_id = current_farm_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM rabbit r
                   WHERE r.id = receptivity_check.rabbit_id AND r.farm_id = current_farm_id()));

ALTER TABLE pregnancy_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE pregnancy_check FORCE ROW LEVEL SECURITY;
CREATE POLICY pregnancy_check_tenant ON pregnancy_check
    USING (EXISTS (SELECT 1 FROM mating m
                   WHERE m.id = pregnancy_check.mating_id AND m.farm_id = current_farm_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM mating m
                   WHERE m.id = pregnancy_check.mating_id AND m.farm_id = current_farm_id()));

ALTER TABLE condition_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE condition_check FORCE ROW LEVEL SECURITY;
CREATE POLICY condition_check_tenant ON condition_check
    USING (EXISTS (SELECT 1 FROM health_condition h
                   WHERE h.id = condition_check.condition_id AND h.farm_id = current_farm_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM health_condition h
                   WHERE h.id = condition_check.condition_id AND h.farm_id = current_farm_id()));

ALTER TABLE weight_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_record FORCE ROW LEVEL SECURITY;
CREATE POLICY weight_tenant ON weight_record
    USING (EXISTS (SELECT 1 FROM rabbit r
                   WHERE r.id = weight_record.rabbit_id AND r.farm_id = current_farm_id())
        OR EXISTS (SELECT 1 FROM litter l
                   WHERE l.id = weight_record.litter_id AND l.farm_id = current_farm_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM rabbit r
                   WHERE r.id = weight_record.rabbit_id AND r.farm_id = current_farm_id())
        OR EXISTS (SELECT 1 FROM litter l
                   WHERE l.id = weight_record.litter_id AND l.farm_id = current_farm_id()));

ALTER TABLE employee_section ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_section FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_section_tenant ON employee_section
    USING (EXISTS (SELECT 1 FROM employee e
                   WHERE e.id = employee_section.employee_id AND e.farm_id = current_farm_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM employee e
                   WHERE e.id = employee_section.employee_id AND e.farm_id = current_farm_id()));

-- Sessions are looked up BEFORE a farm context exists (that is how the farm is
-- discovered), so they are read through a SECURITY DEFINER function instead of
-- being exposed to the app role directly. See 0006_app_role.sql.
ALTER TABLE user_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_session FORCE ROW LEVEL SECURITY;
CREATE POLICY session_tenant ON user_session
    USING (EXISTS (SELECT 1 FROM employee e
                   WHERE e.id = user_session.employee_id AND e.farm_id = current_farm_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM employee e
                   WHERE e.id = user_session.employee_id AND e.farm_id = current_farm_id()));

-- `plan` is a public price list: readable by everyone, writable by nobody
-- holding the app role.
ALTER TABLE plan ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_readable ON plan FOR SELECT USING (true);
