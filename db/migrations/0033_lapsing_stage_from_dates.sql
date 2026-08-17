-- ============================================================================
-- The lapsing call-list still has to mean something
--
-- 0031 made v_farm_entitlement.access the constant 'full'. Two views derived
-- meaning from that column and quietly lost it:
--
--   v_admin_lapsing.stage was CASE ... WHEN access = 'full' THEN ... ELSE
--   'lapsed'. With access constant, 'lapsed' became unreachable and a farm sixty
--   days past its period end reported 'in_grace' — the view stating that a farm
--   is inside a grace window that expired two months ago.
--
-- The fix is not to reintroduce the paywall. `stage` was never really about
-- access; it was about where a farm sits in its payment cycle, and that is still
-- answerable from the dates. access used to be 'full' exactly when
-- covered_days_left >= 0, so swapping the test for that expression preserves the
-- original meaning precisely while surviving 0031.
--
-- The view stays dormant either way: it feeds the admin billing screen, which
-- nothing charges through now. It is corrected rather than dropped because it is
-- a record of who paid and when, and because reverting 0031 must not also
-- require remembering to repair this.
--
-- NOT CHANGED, deliberately: v_admin_billing_exception filters on
-- `access = 'read_only'` to find farms that paid and are still locked out. That
-- fault cannot occur when nothing locks anyone out, so the view correctly
-- returns nothing at all while the product is free, and starts working again by
-- itself if 0031 is ever reverted. A view that reports an impossible condition
-- as absent is right, not broken.
-- ============================================================================

CREATE OR REPLACE VIEW v_admin_lapsing AS
SELECT ent.farm_id,
    ent.farm_name,
    ent.status,
    ent.access,
    ent.billing_period,
    ent.effective_price_paise,
    COALESCE(s.current_period_end, s.trial_ends_on) AS due_on,
    COALESCE(s.current_period_end, s.trial_ends_on) - CURRENT_DATE AS days_to_due,
    ent.covered_until,
    ent.covered_days_left,
    -- Was `ent.access = 'full'`; now the arithmetic that used to decide access.
    -- Same answers as before 0031, for farms whose dates have not changed.
        CASE
            WHEN ent.status = 'trialing'::subscription_status_t
                 AND ent.covered_days_left >= 0                    THEN 'trial_ending'::text
            WHEN ent.status = 'trialing'::subscription_status_t     THEN 'trial_over'::text
            WHEN ent.covered_days_left >= 0
                 AND COALESCE(s.current_period_end, s.trial_ends_on) < CURRENT_DATE
                                                                   THEN 'in_grace'::text
            WHEN ent.covered_days_left >= 0                        THEN 'ending_soon'::text
            ELSE 'lapsed'::text
        END AS stage,
    owner.full_name AS owner_name,
    owner.email::text AS owner_email,
    owner.phone AS owner_phone,
    ov.days_since_activity
   FROM v_farm_entitlement ent
     JOIN subscription s ON s.farm_id = ent.farm_id
     JOIN v_admin_farm_overview ov ON ov.farm_id = ent.farm_id
     LEFT JOIN LATERAL ( SELECT employee.full_name,
            employee.email,
            employee.phone
           FROM employee
          WHERE employee.farm_id = ent.farm_id
            AND employee.role = 'owner'::employee_role_t
            AND employee.is_active
          ORDER BY employee.created_at
         LIMIT 1) owner ON true
  WHERE ent.status <> 'cancelled'::subscription_status_t
    AND COALESCE(s.current_period_end, s.trial_ends_on) IS NOT NULL
    AND (COALESCE(s.current_period_end, s.trial_ends_on) - CURRENT_DATE) <= 14
    AND ent.covered_days_left >= '-60'::integer;

-- 0008's rule: every view runs as its caller, and isolation.test.js fails the
-- build if one does not.
ALTER VIEW v_admin_lapsing SET (security_invoker = true);
