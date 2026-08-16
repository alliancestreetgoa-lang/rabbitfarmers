-- ============================================================================
-- Support impersonation, wired up
--
-- `admin_impersonation` has existed since 0004 and nothing ever read it. The
-- console wrote a row saying "this admin may view this farm for an hour,
-- read-only, because X" and then had no way to actually show them anything. A
-- record of permission that grants nothing is not a safety feature; it is a
-- promise in the docs that the code does not keep.
--
-- What makes this safe is that support does not get a special kind of access.
-- They get an ordinary farm session — same table, same RLS, same farm scoping —
-- that is *bound* to the impersonation row. Everything hangs off that binding:
--
--   * the session dies when the impersonation ends or its hour runs out,
--     checked on every single request rather than when the token expires
--   * it is visible to the farmer, in the same "signed-in devices" list as
--     their own phone, with the support person's name on it
--   * ending it from either side ends it for both
--
-- Read-only is enforced in the API (see requireAuth), not here, because the
-- database cannot tell the difference between the owner's session and this one
-- without a second role — and a second role is a second way to get RLS wrong.
-- The binding is what this migration is for.
-- ============================================================================

ALTER TABLE user_session
    ADD COLUMN IF NOT EXISTS impersonation_id uuid
        REFERENCES admin_impersonation(id) ON DELETE CASCADE;

COMMENT ON COLUMN user_session.impersonation_id IS
    'Set only on sessions minted for support impersonation. NULL is a real person signing in.';

CREATE INDEX IF NOT EXISTS session_impersonation_idx
    ON user_session (impersonation_id) WHERE impersonation_id IS NOT NULL;

-- The farm is told. Not by email — there is no mail sender — but by the same
-- notification list the nest-box reminders arrive in, which is the one place a
-- farmer already looks.
ALTER TYPE notification_kind_t ADD VALUE IF NOT EXISTS 'support_access';

-- ----------------------------------------------------------------------------
-- Resolving a session now also answers "is this support, and is that still
-- true?".
--
-- Return type changes, so this is a DROP and CREATE rather than a REPLACE.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS auth_resolve_session(text);

CREATE FUNCTION auth_resolve_session(p_token_hash text)
RETURNS TABLE (session_id uuid, employee_id uuid, farm_id uuid,
               full_name text, role employee_role_t,
               impersonation_id uuid, impersonated_by text,
               impersonation_expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT s.id, e.id, e.farm_id, e.full_name, e.role,
           i.id, a.full_name, i.expires_at
    FROM user_session s
    JOIN employee e ON e.id = s.employee_id
    LEFT JOIN admin_impersonation i ON i.id = s.impersonation_id
    LEFT JOIN platform_admin a       ON a.id = i.admin_id
    WHERE s.token_hash = p_token_hash
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
      AND e.is_active
      -- The whole point of the binding. An hour is an hour: the check is here,
      -- on the read path, so revoking from the console or simply waiting shuts
      -- the door on the very next request.
      AND (s.impersonation_id IS NULL
           OR (i.ended_at IS NULL AND i.expires_at > now()))
    LIMIT 1;
$$;

REVOKE ALL ON FUNCTION auth_resolve_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_session(text) TO rabbitry_app;

-- ----------------------------------------------------------------------------
-- Ending it, from either side.
--
-- Support signs out; the farmer signs every device out; the admin closes the
-- tab and the hour passes. All three land here, and all three both close the
-- impersonation record and revoke the session it minted — otherwise "ended" and
-- "still usable" could disagree, and the audit trail would be the one lying.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_end_impersonation(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE admin_impersonation
       SET ended_at = now()
     WHERE id = p_id AND ended_at IS NULL;

    UPDATE user_session
       SET revoked_at = now(), revoked_reason = 'support access ended'
     WHERE impersonation_id = p_id AND revoked_at IS NULL;
END $$;

REVOKE ALL ON FUNCTION auth_end_impersonation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_end_impersonation(uuid) TO rabbitry_app, rabbitry_admin;

-- Live support access, for the console and for anyone asking "who is in my farm
-- right now". Deliberately not farm-scoped: it is an admin view, and the app
-- role has no privileges on admin_impersonation at all.
CREATE OR REPLACE VIEW v_active_impersonation AS
SELECT i.id, i.farm_id, f.name AS farm_name, i.admin_id,
       a.full_name AS admin_name, a.email AS admin_email,
       i.reason, i.started_at, i.expires_at,
       EXTRACT(epoch FROM (i.expires_at - now()))::int AS seconds_left,
       (SELECT count(*) FROM user_session s
         WHERE s.impersonation_id = i.id AND s.revoked_at IS NULL) AS live_sessions
FROM admin_impersonation i
JOIN farm f           ON f.id = i.farm_id
JOIN platform_admin a ON a.id = i.admin_id
WHERE i.ended_at IS NULL AND i.expires_at > now();

-- Both, not either. security_invoker keeps the rule every other view follows —
-- and without it this one would be a definer view over admin_impersonation, the
-- table the app role is explicitly revoked from, handed back to it by the
-- default privileges that grant SELECT on anything new.
ALTER VIEW v_active_impersonation SET (security_invoker = true);
REVOKE ALL ON v_active_impersonation FROM rabbitry_app;
