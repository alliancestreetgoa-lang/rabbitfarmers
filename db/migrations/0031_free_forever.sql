-- ============================================================================
-- Everything is free
--
-- The product stopped being sold. It is now given away, because its purpose
-- changed: the value is the data farms record, and a farm that cannot write is
-- a farm that stopped contributing it.
--
-- That is the whole argument for this migration. Under the old rules a farm
-- whose trial ended went `read_only` — it kept every record and every reminder,
-- but could add nothing new. Read-only farms are silent farms. Removing the
-- paywall is not generosity here, it is the collection strategy.
--
-- ONE THING CHANGES: `v_farm_entitlement.access` is now the constant 'full'.
--
-- Everything downstream already reads that column and needs no edit —
-- middleware.js, auth.js /me, admin-ui.js, the mobile app. This is deliberately
-- a single point of change rather than thirty.
--
-- WHAT IS NOT REMOVED, and why:
--
--   The subscription and plan tables, the payment and refund history, and
--   razorpay.js all stay. Three reasons. Deciding to charge later is common and
--   should cost an afternoon, not a rebuild — Razorpay was chosen because
--   Stripe India does not support UPI Autopay or e-NACH, so this is not code
--   worth re-earning. Payment and refund rows are accounting records and are
--   not ours to delete. And the admin console's Suspend/Cancel/Activate actions
--   still write statuses, which remain a useful record of who is who; they just
--   no longer decide who may write.
--
--   That last point is the one surprise worth stating plainly: after this
--   migration a SUSPENDED FARM CAN WRITE AGAIN. There is no access tier left to
--   put it in. If cutting a farm off ever becomes necessary, it needs a real
--   mechanism — a farm-level disable — not a billing status pressed into
--   service as one.
--
-- The columns and their order are unchanged, which is what lets this be a
-- CREATE OR REPLACE rather than a drop and rebuild of everything depending on
-- it (v_admin_farm_overview, v_admin_lapsing, v_admin_renewal_due).
-- ============================================================================

CREATE OR REPLACE VIEW v_farm_entitlement AS
SELECT f.id AS farm_id,
    f.name AS farm_name,
    p.code AS plan_code,
    s.status,
    s.billing_period,
    s.trial_ends_on,
    s.current_period_end,
    s.grace_until,
    -- Was a nine-branch CASE over trial dates, grace windows and admin
    -- suspension. There is nothing left to decide.
    'full'::text AS access,
    true AS reminders_active,
    -- No trials exist, so there is no countdown. NULL rather than 0: zero days
    -- left reads as "it just ended", which would be a lie on every screen.
    NULL::integer AS trial_days_left,
    p.max_breeding_does,
    p.max_staff_seats,
    d.breeding_does_used,
    e.staff_seats_used,
    p.max_breeding_does IS NOT NULL AND d.breeding_does_used >= p.max_breeding_does AS at_doe_limit,
    p.max_staff_seats IS NOT NULL AND e.staff_seats_used >= p.max_staff_seats AS at_seat_limit,
        CASE s.billing_period
            WHEN 'monthly'::billing_period_t THEN COALESCE(s.locked_price_monthly_paise, p.price_monthly_paise)
            WHEN 'yearly'::billing_period_t THEN COALESCE(s.locked_price_yearly_paise, p.price_yearly_paise)
            ELSE NULL::integer
        END AS effective_price_paise,
        CASE s.billing_period
            WHEN 'monthly'::billing_period_t THEN cur.price_monthly_paise
            WHEN 'yearly'::billing_period_t THEN cur.price_yearly_paise
            ELSE NULL::integer
        END AS current_list_price_paise,
        CASE s.billing_period
            WHEN 'monthly'::billing_period_t THEN COALESCE(s.locked_price_monthly_paise, p.price_monthly_paise) < cur.price_monthly_paise
            WHEN 'yearly'::billing_period_t THEN COALESCE(s.locked_price_yearly_paise, p.price_yearly_paise) < cur.price_yearly_paise
            ELSE NULL::boolean
        END AS is_grandfathered,
    -- Kept as facts about the subscription row rather than statements about
    -- access. Nothing gates on them any more.
        CASE
            WHEN s.status = 'trialing'::subscription_status_t THEN s.trial_ends_on
            WHEN s.id IS NOT NULL THEN billing_access_until(s.current_period_end, s.grace_until, s.billing_period)
            ELSE NULL::date
        END AS covered_until,
        CASE
            WHEN s.status = 'trialing'::subscription_status_t THEN s.trial_ends_on - CURRENT_DATE
            WHEN s.id IS NOT NULL THEN billing_access_until(s.current_period_end, s.grace_until, s.billing_period) - CURRENT_DATE
            ELSE NULL::integer
        END AS covered_days_left
   FROM farm f
     LEFT JOIN subscription s ON s.farm_id = f.id
     LEFT JOIN plan p ON p.id = s.plan_id
     LEFT JOIN LATERAL ( SELECT v_current_public_plan.price_monthly_paise,
            v_current_public_plan.price_yearly_paise
           FROM v_current_public_plan
         LIMIT 1) cur ON true
     CROSS JOIN LATERAL ( SELECT count(*)::integer AS breeding_does_used
           FROM rabbit r
          WHERE r.farm_id = f.id AND r.sex = 'doe'::sex_t AND (r.role = ANY (ARRAY['breeder'::rabbit_role_t, 'replacement'::rabbit_role_t])) AND (r.status = ANY (ARRAY['active'::rabbit_status_t, 'quarantine'::rabbit_status_t]))) d
     CROSS JOIN LATERAL ( SELECT count(*)::integer AS staff_seats_used
           FROM employee em
          WHERE em.farm_id = f.id AND em.is_active) e;

-- Not optional. A view without this runs as its owner, and 0008 exists because
-- that leaked every farm's data through views while direct table access stayed
-- correctly isolated. CREATE OR REPLACE preserves the setting, but state it so
-- the guarantee is visible here rather than inferred from history.
ALTER VIEW v_farm_entitlement SET (security_invoker = true);
