-- ============================================================================
-- Admin sessions in the database, not in memory
--
-- The first cut held admin sessions in a Map inside the process. That works on
-- one long-lived server and breaks completely on serverless: each invocation
-- may land on a different instance, so an admin signs in, gets a token, and the
-- next request hits a cold instance that has never heard of it. The symptom is
-- an admin console that logs you out at random.
--
-- Same rules as farm sessions: store the HASH of the token, revoke rather than
-- delete, and expire fast — this account can read every farm.
-- ============================================================================
CREATE TABLE admin_session (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id     uuid NOT NULL REFERENCES platform_admin(id) ON DELETE CASCADE,
    token_hash   text UNIQUE NOT NULL,
    issued_at    timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    ip           inet,
    user_agent   text,
    revoked_at   timestamptz
);
CREATE INDEX admin_session_live_idx ON admin_session (admin_id)
    WHERE revoked_at IS NULL;

-- Platform admins are not tenants, so this table is reachable only through the
-- admin role. The farmer-facing role must not see it at all.
REVOKE ALL ON admin_session FROM rabbitry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_session TO rabbitry_admin;
