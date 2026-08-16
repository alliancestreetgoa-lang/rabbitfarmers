-- ============================================================================
-- A farm's timezone must be a timezone
--
-- `farm.timezone` is written straight from the signup body, unvalidated, and
-- `farm_today()` does `now() AT TIME ZONE f.timezone`. Postgres raises
-- `invalid_parameter_value` for a zone it does not recognise.
--
-- Before migration 0020 that was nearly harmless, because almost nothing read
-- the column. Moving the breeding engine to farm-local days made it reachable
-- from every screen, and the damage is not limited to the farm that did it:
--
--   * That farm's herd list, pregnancy counts and ready-to-mate queue all fail.
--     There is no way to fix it from the app, because nothing exposes the
--     timezone — the account is bricked from the moment it is created.
--
--   * Far worse, generate_due_tasks() and generate_notifications() are single
--     set-based statements across EVERY farm. One bad row aborts the statement,
--     so the whole scheduler run dies and nobody on the platform gets a nest
--     box task, a separation reminder or an Ostovet dose until somebody finds
--     the row. Verified: one junk signup, and the run returns 400 for everyone.
--
-- And it is reachable by anyone, unauthenticated, through POST /auth/signup.
--
-- Validation belongs here rather than only in the API. A CHECK constraint
-- cannot do it — the set of zones is not immutable — so a trigger does, which
-- covers every writer including a hand-typed UPDATE at a psql prompt.
--
-- The trigger refuses rather than silently coercing. Quietly moving a farm to
-- UTC would shift every due date by hours and nobody would know why.
-- ============================================================================

CREATE OR REPLACE FUNCTION check_farm_timezone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.timezone IS NULL OR NOT EXISTS (
        SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone
    ) THEN
        RAISE EXCEPTION 'unknown timezone: %', COALESCE(NEW.timezone, '(null)')
            USING ERRCODE = 'check_violation',
                  HINT = 'Use an IANA name such as Asia/Kolkata or UTC.';
    END IF;
    RETURN NEW;
END $$;

-- Anything already broken goes to UTC, loudly, before the trigger exists —
-- otherwise the trigger itself would block the fix.
DO $$
DECLARE f record;
BEGIN
    FOR f IN
        SELECT id, name, timezone FROM farm
        WHERE timezone IS NULL
           OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = farm.timezone)
    LOOP
        RAISE WARNING 'farm % (%) had an unusable timezone %, moved to UTC',
            f.name, f.id, COALESCE(f.timezone, '(null)');
        UPDATE farm SET timezone = 'UTC' WHERE id = f.id;
    END LOOP;
END $$;

CREATE TRIGGER farm_timezone_valid
    BEFORE INSERT OR UPDATE OF timezone ON farm
    FOR EACH ROW EXECUTE FUNCTION check_farm_timezone();

-- ----------------------------------------------------------------------------
-- Belt as well as braces
--
-- The trigger stops bad data getting in. This stops a bad row that somehow
-- exists — a restore from an older dump, a superuser bypassing triggers — from
-- taking the scheduler down for every other farm. Reading a farm's day is not
-- a place to fail hard.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION farm_today(p_farm_id uuid) RETURNS date
LANGUAGE plpgsql STABLE AS $$
DECLARE
    tz text;
BEGIN
    SELECT f.timezone INTO tz FROM farm f WHERE f.id = p_farm_id;
    IF tz IS NULL THEN RETURN NULL; END IF;
    BEGIN
        RETURN (now() AT TIME ZONE tz)::date;
    EXCEPTION WHEN OTHERS THEN
        -- One farm's bad row must not abort a statement that spans every farm.
        RETURN (now() AT TIME ZONE 'UTC')::date;
    END;
END $$;

-- Cleaning up sessions nobody can use any more.
--
-- Expired rows were already rejected at sign-in, so this is not a security fix;
-- it is that nothing ever deleted them, and user_session gains a row per device
-- per sign-in for ever. Called from the scheduler, which already runs.
CREATE OR REPLACE FUNCTION purge_expired_sessions() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int; step int;
BEGIN
    -- A week's grace after expiry, so "when did they last sign in" survives a
    -- support conversation about it.
    DELETE FROM user_session WHERE expires_at < now() - interval '7 days';
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM admin_session WHERE expires_at < now() - interval '7 days';
    GET DIAGNOSTICS step = ROW_COUNT;
    RETURN n + step;
END $$;
