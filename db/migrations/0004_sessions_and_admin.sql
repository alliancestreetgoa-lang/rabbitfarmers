-- ============================================================================
-- Sessions — sign in / sign out
--
-- Only needed when running auth yourself. With Clerk or Auth0 the provider owns
-- this table's job and you can drop it.
--
-- Store a HASH of the session token, never the token. A leaked database must not
-- hand over live sessions.
-- ============================================================================
CREATE TABLE user_session (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   uuid NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    token_hash    text UNIQUE NOT NULL,
    issued_at     timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    last_seen_at  timestamptz,
    device        text,                    -- "Redmi Note 12 · Expo app"
    ip            inet,
    -- Sign out sets this. Sign out everywhere sets it for every row of the
    -- employee. Rows are kept, not deleted, so "who was signed in when" stays
    -- answerable after an incident.
    revoked_at    timestamptz,
    revoked_reason text
);
CREATE INDEX session_live_idx ON user_session (employee_id)
    WHERE revoked_at IS NULL;

CREATE OR REPLACE VIEW v_active_session AS
SELECT *
FROM user_session
WHERE revoked_at IS NULL
  AND expires_at > now();

-- ============================================================================
-- Platform administration — the super-admin CRM
--
-- Platform admins are NOT tenants. They sit outside the farm model entirely:
-- no farm_id, no employee row, a separate login. Conflating the two is how a
-- support account ends up as a back door into every customer's data.
--
-- Everything an admin does to a farm is written to admin_audit_log. That log is
-- append-only and is the only defence you have if a customer ever asks "who
-- changed my subscription".
-- ============================================================================
CREATE TYPE admin_role_t AS ENUM ('superadmin', 'support', 'billing', 'readonly');

CREATE TABLE platform_admin (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         citext UNIQUE NOT NULL,
    full_name     text NOT NULL,
    phone         text,
    auth_user_id  uuid UNIQUE,
    password_hash text,
    role          admin_role_t NOT NULL DEFAULT 'support',
    is_active     boolean NOT NULL DEFAULT true,
    last_login_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_audit_log (
    id            bigserial PRIMARY KEY,
    admin_id      uuid NOT NULL REFERENCES platform_admin(id),
    action        text NOT NULL,       -- extend_trial | change_status | comp_plan | impersonate | export …
    target_farm_id uuid REFERENCES farm(id) ON DELETE SET NULL,
    target_table  text,
    target_id     uuid,
    before_value  jsonb,
    after_value   jsonb,
    reason        text,                -- required by the UI for destructive actions
    ip            inet,
    at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_farm_idx  ON admin_audit_log (target_farm_id, at DESC);
CREATE INDEX admin_audit_admin_idx ON admin_audit_log (admin_id, at DESC);

-- Support impersonation: "view this farm as its owner". Indispensable for
-- support and dangerous, so it is time-boxed, reason-tagged and logged. The
-- customer-facing rule is that impersonation is visible to the farm owner.
CREATE TABLE admin_impersonation (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id    uuid NOT NULL REFERENCES platform_admin(id),
    farm_id     uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    reason      text NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    ended_at    timestamptz,
    read_only   boolean NOT NULL DEFAULT true
);
CREATE INDEX impersonation_farm_idx ON admin_impersonation (farm_id, started_at DESC);

-- ----------------------------------------------------------------------------
-- Admin CRM views
-- ----------------------------------------------------------------------------

-- The main console list: every farm, who owns it, what they pay, how alive they
-- are. "Last activity" is the number that matters most — a farm that has not
-- written anything in two weeks is churning whether or not it is still paying.
CREATE OR REPLACE VIEW v_admin_farm_overview AS
SELECT
    f.id                     AS farm_id,
    f.name                   AS farm_name,
    f.city,
    f.state,
    f.country,
    f.created_at             AS signed_up_at,
    owner.full_name          AS owner_name,
    owner.email              AS owner_email,
    owner.phone              AS owner_phone,
    (owner.email_verified_at IS NOT NULL) AS email_verified,
    ent.plan_code,
    ent.status,
    ent.billing_period,
    ent.access,
    ent.trial_ends_on,
    ent.current_period_end,
    ent.effective_price_paise,
    ent.is_grandfathered,
    counts.animals,
    counts.breeding_does,
    staff.staff_count,
    act.last_activity_at,
    CASE WHEN act.last_activity_at IS NULL THEN NULL
         ELSE (current_date - act.last_activity_at::date) END AS days_since_activity
FROM farm f
LEFT JOIN v_farm_entitlement ent ON ent.farm_id = f.id
LEFT JOIN LATERAL (
    SELECT full_name, email, phone, email_verified_at
    FROM employee
    WHERE farm_id = f.id AND role = 'owner'
    ORDER BY created_at LIMIT 1
) owner ON true
CROSS JOIN LATERAL (
    SELECT count(*)::int AS animals,
           count(*) FILTER (WHERE sex = 'doe'
                              AND role IN ('breeder','replacement'))::int AS breeding_does
    FROM rabbit WHERE farm_id = f.id AND status IN ('active','quarantine')
) counts
CROSS JOIN LATERAL (
    SELECT count(*)::int AS staff_count
    FROM employee WHERE farm_id = f.id AND is_active
) staff
CROSS JOIN LATERAL (
    -- Most recent write of any kind. Cheap proxy for "is this farm alive".
    SELECT max(t) AS last_activity_at FROM (
        SELECT max(created_at) FROM mating          WHERE farm_id = f.id
        UNION ALL SELECT max(created_at) FROM litter WHERE farm_id = f.id
        UNION ALL SELECT max(created_at) FROM health_condition WHERE farm_id = f.id
        UNION ALL SELECT max(created_at) FROM rabbit WHERE farm_id = f.id
    ) x(t)
) act;


-- The one screen the owner of the business looks at.
CREATE OR REPLACE VIEW v_admin_revenue_summary AS
SELECT
    count(*) FILTER (WHERE status = 'trialing')                       AS trialing,
    count(*) FILTER (WHERE status = 'active')                         AS active,
    count(*) FILTER (WHERE status IN ('past_due','grace'))            AS at_risk,
    count(*) FILTER (WHERE status = 'suspended')                      AS suspended,
    count(*) FILTER (WHERE status = 'cancelled')                      AS cancelled,
    count(*) FILTER (WHERE is_grandfathered)                          AS on_old_pricing,
    -- Normalise both cycles to a monthly figure so MRR is one number.
    COALESCE(sum(
        CASE WHEN status IN ('active','past_due','grace')
             THEN CASE billing_period
                      WHEN 'monthly' THEN effective_price_paise
                      WHEN 'yearly'  THEN round(effective_price_paise / 12.0)
                  END
        END
    ), 0)::bigint                                                     AS mrr_paise,
    count(*) FILTER (WHERE days_since_activity >= 14
                       AND status IN ('active','trialing'))           AS silent_churn_risk
FROM v_admin_farm_overview;

