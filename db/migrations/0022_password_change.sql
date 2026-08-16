-- ============================================================================
-- Changing a password
--
-- There was no way to. Not from the app, not from the admin console, and there
-- is no email verification to hang a reset link on. A farmer who forgot their
-- password lost the farm and every record in it, permanently — on a product
-- sold by monthly subscription.
--
-- Two halves, and this migration is the plumbing for both:
--
--   the farmer knows the old one   → POST /auth/password
--   the farmer is locked out       → support sets a temporary one, and the
--                                    farm owner is told it happened
--
-- Both go through SECURITY DEFINER functions for the same reason the rest of
-- auth does: the farmer-facing role cannot read employee.password_hash under
-- RLS, and it should not be able to. These functions are the only doorway, they
-- take an employee id rather than a predicate, and they are granted to nothing
-- else.
-- ============================================================================

CREATE OR REPLACE FUNCTION auth_lookup_by_id(p_employee_id uuid)
RETURNS TABLE (employee_id uuid, password_hash text, is_active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT e.id, e.password_hash, e.is_active
    FROM employee e
    WHERE e.id = p_employee_id;
$$;

CREATE OR REPLACE FUNCTION auth_set_password(p_employee_id uuid, p_hash text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    -- Hashing happens in the application; this refuses anything that is not
    -- already a hash, so a bug upstream cannot store a plaintext password.
    IF p_hash IS NULL OR p_hash NOT LIKE 'scrypt$%' THEN
        RAISE EXCEPTION 'password must be hashed before it gets here'
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE employee
       SET password_hash = p_hash,
           password_changed_at = now()
     WHERE id = p_employee_id;
END $$;

-- When it last changed, so support can answer "did anyone reset this?" and so a
-- future policy could expire old ones.
ALTER TABLE employee ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;

REVOKE ALL ON FUNCTION auth_lookup_by_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_set_password(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_by_id(uuid) TO rabbitry_app;
GRANT EXECUTE ON FUNCTION auth_set_password(uuid, text) TO rabbitry_app;
