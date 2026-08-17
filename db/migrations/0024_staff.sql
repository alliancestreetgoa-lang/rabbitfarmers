-- ============================================================================
-- Staff: a login, a section, and a day's attendance
--
-- The tables have been here since 0001 and nothing was ever exposed. Every farm
-- is one owner account, so a farm hand cannot be given a login, cannot be
-- assigned a shed, and cannot be the answer to "who recorded this". The
-- breeding engine has been generating work for a year and there has been nobody
-- to give it to.
--
-- The one real design decision is what a farm hand signs in WITH.
--
-- docs/04 says phone, and it is right: farm workers reliably have a phone
-- number and often no email. But `employee.email` is globally unique while
-- `phone` is unique only within a farm, so a bare phone lookup could match two
-- people at two farms and there would be no safe way to choose.
--
-- The rule that resolves it: a phone must be unique among accounts that can
-- actually sign in. Somebody works at one farm. Two farms may both have a
-- record of the same number — a vet who visits both — but only one of them may
-- turn it into a login, and the second gets told so instead of silently
-- creating an ambiguity nobody would notice until a farm hand saw another
-- farm's rabbits.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS employee_login_phone_idx
    ON employee (phone) WHERE password_hash IS NOT NULL;

COMMENT ON INDEX employee_login_phone_idx IS
    'A phone is a login identity. Unique only among accounts that have a password, so a farm may still hold a contact number another farm uses.';

-- Who added this person, for the same reason every other record has it.
ALTER TABLE employee ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES employee(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- Signing in by phone
--
-- Same shape and the same reasoning as auth_lookup_by_email: sign-in has to
-- read across farms before a farm context exists, so it goes through one
-- SECURITY DEFINER function that returns the minimum rather than a hole in the
-- policies.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_lookup_by_phone(p_phone text)
RETURNS TABLE (employee_id uuid, farm_id uuid, password_hash text,
               full_name text, role employee_role_t, is_active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT e.id, e.farm_id, e.password_hash, e.full_name, e.role, e.is_active
    FROM employee e
    WHERE e.phone = p_phone
      AND e.password_hash IS NOT NULL
    LIMIT 1;
$$;

REVOKE ALL ON FUNCTION auth_lookup_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_by_phone(text) TO rabbitry_app;

-- ----------------------------------------------------------------------------
-- Attendance
--
-- The date is the farm's, not the server's. A farm hand checking in at 06:10 in
-- Goa is checking in on today's card; computed from the server's clock in UTC
-- that is still yesterday, and the day's attendance lands on the wrong row.
-- Same reasoning as everything else since 0020.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION attendance_check_in(
    p_farm uuid, p_employee uuid, p_lat numeric DEFAULT NULL, p_lng numeric DEFAULT NULL)
RETURNS attendance
LANGUAGE plpgsql AS $$
DECLARE row attendance;
BEGIN
    INSERT INTO attendance (farm_id, employee_id, work_date, status,
                            checked_in_at, check_in_lat, check_in_lng, recorded_by)
    VALUES (p_farm, p_employee, farm_today(p_farm), 'present',
            now(), p_lat, p_lng, p_employee)
    -- Checking in twice is a tap, not an event. Keep the first time: that is
    -- when they arrived, and overwriting it would quietly shorten the day.
    ON CONFLICT (employee_id, work_date) DO UPDATE
        SET checked_in_at = COALESCE(attendance.checked_in_at, EXCLUDED.checked_in_at),
            status = CASE WHEN attendance.status = 'absent' THEN 'present'
                          ELSE attendance.status END,
            check_in_lat = COALESCE(attendance.check_in_lat, EXCLUDED.check_in_lat),
            check_in_lng = COALESCE(attendance.check_in_lng, EXCLUDED.check_in_lng)
    RETURNING * INTO row;
    RETURN row;
END $$;

CREATE OR REPLACE FUNCTION attendance_check_out(p_farm uuid, p_employee uuid)
RETURNS attendance
LANGUAGE plpgsql AS $$
DECLARE row attendance;
BEGIN
    -- Checking out without having checked in is a real thing — the phone was
    -- flat this morning — so this creates the row rather than refusing.
    INSERT INTO attendance (farm_id, employee_id, work_date, status,
                            checked_out_at, recorded_by)
    VALUES (p_farm, p_employee, farm_today(p_farm), 'present', now(), p_employee)
    ON CONFLICT (employee_id, work_date) DO UPDATE
        SET checked_out_at = EXCLUDED.checked_out_at,
            status = CASE WHEN attendance.status = 'absent' THEN 'present'
                          ELSE attendance.status END
    RETURNING * INTO row;
    RETURN row;
END $$;

-- ----------------------------------------------------------------------------
-- Assigning generated work to whoever looks after that shed
--
-- The breeding engine knows which doe needs a nest box. It does not know who
-- walks that row. This joins the two: an open, unassigned task for an animal
-- housed in a shed with exactly one caretaker goes to that caretaker.
--
-- Exactly one, deliberately. Two people on a shed means the farm has not
-- decided who owns it, and picking one for them produces work that looks
-- assigned and is nobody's. Those stay unassigned and appear on everybody's
-- list, which is the honest outcome.
--
-- Separate from generate_due_tasks() rather than folded into it: that function
-- is one large set-based statement per task kind, and this runs after all of
-- them in one pass over whatever is still unassigned.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assign_tasks_by_section() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    WITH sole_caretaker AS (
        -- [1] rather than min(): there is no min(uuid) in Postgres, and the
        -- HAVING below already guarantees the array holds exactly one.
        SELECT es.shed_id, (array_agg(es.employee_id))[1] AS employee_id
        FROM employee_section es
        JOIN employee e ON e.id = es.employee_id AND e.is_active
        GROUP BY es.shed_id
        HAVING count(*) = 1
    )
    UPDATE task t
       SET assigned_to = sc.employee_id
      FROM rabbit r
      JOIN cage c        ON c.id = r.cage_id
      JOIN sole_caretaker sc ON sc.shed_id = c.shed_id
     WHERE t.rabbit_id = r.id
       AND t.status = 'open'
       AND t.assigned_to IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- ----------------------------------------------------------------------------
-- What the team screen shows
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_staff AS
SELECT
    e.id, e.farm_id, e.full_name, e.phone, e.email::text AS email,
    e.role, e.employment_type, e.joined_on, e.left_on, e.language,
    e.can_palpate, e.is_active, e.created_at,
    (e.password_hash IS NOT NULL)          AS can_sign_in,
    e.password_changed_at,
    COALESCE(sheds.names, ARRAY[]::text[]) AS sheds,
    COALESCE(sheds.ids,   ARRAY[]::uuid[]) AS shed_ids,
    today.status                           AS today_status,
    today.checked_in_at                    AS today_checked_in_at,
    today.checked_out_at                   AS today_checked_out_at,
    open_tasks.n                           AS open_tasks
FROM employee e
LEFT JOIN LATERAL (
    SELECT array_agg(s.name ORDER BY s.name) AS names,
           array_agg(s.id   ORDER BY s.name) AS ids
    FROM employee_section es JOIN shed s ON s.id = es.shed_id
    WHERE es.employee_id = e.id
) sheds ON true
LEFT JOIN LATERAL (
    SELECT a.status, a.checked_in_at, a.checked_out_at
    FROM attendance a
    WHERE a.employee_id = e.id AND a.work_date = farm_today(e.farm_id)
) today ON true
LEFT JOIN LATERAL (
    SELECT count(*)::int AS n FROM task t
    WHERE t.assigned_to = e.id AND t.status = 'open'
) open_tasks ON true;

ALTER VIEW v_staff SET (security_invoker = true);

-- A month per person, which is what whoever runs payroll actually needs. Not
-- wages — see docs/04 on why that is deliberately deferred — just the days.
CREATE OR REPLACE VIEW v_attendance_summary AS
SELECT
    a.farm_id,
    a.employee_id,
    e.full_name,
    to_char(a.work_date, 'YYYY-MM')                                     AS month,
    count(*) FILTER (WHERE a.status = 'present')::int                   AS present,
    count(*) FILTER (WHERE a.status = 'half_day')::int                  AS half_days,
    count(*) FILTER (WHERE a.status = 'absent')::int                    AS absent,
    count(*) FILTER (WHERE a.status = 'leave')::int                     AS leave,
    count(*) FILTER (WHERE a.status = 'holiday')::int                   AS holiday,
    COALESCE(sum(a.overtime_minutes), 0)::int                           AS overtime_minutes,
    -- Half a day is half a day. Whoever runs payroll should not have to
    -- re-derive this from two columns and guess the convention.
    (count(*) FILTER (WHERE a.status = 'present')
     + 0.5 * count(*) FILTER (WHERE a.status = 'half_day'))::numeric(6,1) AS days_worked
FROM attendance a
JOIN employee e ON e.id = a.employee_id
GROUP BY a.farm_id, a.employee_id, e.full_name, to_char(a.work_date, 'YYYY-MM');

ALTER VIEW v_attendance_summary SET (security_invoker = true);
