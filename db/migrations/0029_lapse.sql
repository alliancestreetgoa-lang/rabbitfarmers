-- ============================================================================
-- Subscriptions that actually end
--
-- Since migration 0003 `v_farm_entitlement` has granted full access to any
-- subscription whose STATUS is 'active', and nothing in the system has ever
-- moved a subscription off 'active'. Both halves were written on the assumption
-- that the other one existed. The result: one payment bought the product for
-- ever, and `at_risk` and MRR counted farms that stopped paying in 2026 as
-- paying customers indefinitely.
--
-- Two mechanisms, deliberately, doing two different jobs:
--
--   ACCESS IS DERIVED. What a farm may do comes from `current_period_end` and
--   nothing else — the same rule the whole codebase runs on, that state is
--   computed from facts rather than stored in a field somebody has to remember
--   to update. It follows that a dead scheduler cannot hand out free access,
--   which is the failure direction to want.
--
--   STATUS IS REPORTED. The scheduler moves 'active' → 'past_due' → 'suspended'
--   so the console and MRR say something true. If it stops, the numbers go
--   stale and access stays correct — never the other way round.
--
-- And a grace window, because the alternative is cutting a farmer off at
-- midnight on the day their payment was due. docs/09 asks for thirty days and
-- gives the reason: cut off a nest-box alert on the 5th and a litter dies on
-- day 28, which is real money and a real welfare failure caused by billing
-- logic. Thirty days it is — for the yearly plan.
--
-- Not for the monthly one, and this is the one place this deviates from that
-- document. The thirty days were designed around auto-debit, where not paying
-- means a charge FAILED. There are no mandates yet (0026 defers them), so not
-- paying is a choice — and thirty days of grace on a thirty-day subscription
-- means paying every other month for ever, since a late payment runs from the
-- day it is made. Seven days monthly, thirty yearly: generous where generosity
-- is affordable, and not an invitation where it is not.
--
-- What never changes either way: read-only is the whole penalty. Every record
-- still visible, still exportable, and EVERY REMINDER STILL FIRING. Withholding
-- a nest-box alert over ₹99 kills a litter, and that is not a billing decision
-- anybody gets to make.
--
-- Dates here are server dates (current_date), not farm-local ones. Billing is
-- already server-dated throughout — invoice.issued_on, the financial year, the
-- GST series — while the breeding engine is farm-dated (0020). Mixing the two
-- would put a farm's lapse a day away from its own invoice.
-- ============================================================================

ALTER TYPE notification_kind_t ADD VALUE IF NOT EXISTS 'renewal_due';
ALTER TYPE notification_kind_t ADD VALUE IF NOT EXISTS 'subscription_lapsed';

/*
 * How long after the period ends a farm still has full access.
 *
 * A function rather than a literal in five places, because this is a policy
 * number somebody will want to change and every copy of it would have to be
 * found. It is the only place the number lives.
 *
 * NULL period — a subscription that has never been given one — grants the
 * yearly window, which is the forgiving answer to a question nobody has
 * answered.
 */
CREATE OR REPLACE FUNCTION billing_grace_days(p_period billing_period_t DEFAULT 'yearly')
RETURNS int LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE COALESCE(p_period, 'yearly') WHEN 'monthly' THEN 7 ELSE 30 END;
$$;

/*
 * The last day a farm may still write, whatever its status says.
 *
 * `grace_until` wins when it is set, in both directions. It is an admin saying
 * "access until this date" — one support call granting a fortnight to a farmer
 * whose bank is being difficult, another cutting a defaulter short — and a
 * column named grace_until that could only ever extend would be a trap.
 *
 * NULL when there is nothing to go on. That is not the same as expired, and the
 * distinction is load-bearing: a subscription with no period end has not
 * lapsed, it has never been given one, and locking those farms out would be a
 * migration that silently disabled every account an admin had activated by hand.
 */
CREATE OR REPLACE FUNCTION billing_access_until(
    p_period_end date, p_grace_until date, p_period billing_period_t DEFAULT 'yearly')
RETURNS date LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(p_grace_until, p_period_end + billing_grace_days(p_period));
$$;

-- ----------------------------------------------------------------------------
-- What a farm may do right now
--
-- Same view as 0003, with one clause changed and two columns added. The change:
-- 'active' and 'past_due' no longer mean full access on their own — they mean
-- full access while there is time left on the clock.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_farm_entitlement AS
SELECT
    f.id                       AS farm_id,
    f.name                     AS farm_name,
    p.code                     AS plan_code,
    s.status,
    s.billing_period,
    s.trial_ends_on,
    s.current_period_end,
    s.grace_until,
    CASE
        WHEN s.id IS NULL                          THEN 'read_only'
        -- An admin's decision beats any arithmetic.
        WHEN s.status IN ('suspended', 'cancelled') THEN 'read_only'
        WHEN s.status = 'trialing'
             AND s.trial_ends_on >= current_date   THEN 'full'
        WHEN s.status = 'trialing'                 THEN 'read_only'
        WHEN s.status IN ('active', 'past_due', 'grace') THEN
            CASE
                -- Nothing to go on. Not lapsed — never dated. See above.
                WHEN s.current_period_end IS NULL
                     AND s.grace_until IS NULL     THEN 'full'
                WHEN billing_access_until(s.current_period_end, s.grace_until, s.billing_period)
                     >= current_date               THEN 'full'
                ELSE 'read_only'
            END
        ELSE 'read_only'
    END                        AS access,
    true                       AS reminders_active,   -- always. See the header.
    CASE WHEN s.status = 'trialing'
         THEN GREATEST(0, s.trial_ends_on - current_date) END AS trial_days_left,
    p.max_breeding_does,
    p.max_staff_seats,
    d.breeding_does_used,
    e.staff_seats_used,
    (p.max_breeding_does IS NOT NULL
     AND d.breeding_does_used >= p.max_breeding_does) AS at_doe_limit,
    (p.max_staff_seats IS NOT NULL
     AND e.staff_seats_used >= p.max_staff_seats)     AS at_seat_limit,
    CASE s.billing_period
        WHEN 'monthly' THEN COALESCE(s.locked_price_monthly_paise, p.price_monthly_paise)
        WHEN 'yearly'  THEN COALESCE(s.locked_price_yearly_paise,  p.price_yearly_paise)
    END AS effective_price_paise,
    CASE s.billing_period
        WHEN 'monthly' THEN cur.price_monthly_paise
        WHEN 'yearly'  THEN cur.price_yearly_paise
    END AS current_list_price_paise,
    (CASE s.billing_period
        WHEN 'monthly' THEN COALESCE(s.locked_price_monthly_paise, p.price_monthly_paise)
                              < cur.price_monthly_paise
        WHEN 'yearly'  THEN COALESCE(s.locked_price_yearly_paise, p.price_yearly_paise)
                              < cur.price_yearly_paise
     END) AS is_grandfathered,
    /*
     * New, and appended rather than inserted so every view built on this one
     * keeps working: the last day this farm's money (or its trial) covers, and
     * how many days that is from now. Negative means it has already gone.
     *
     * Deliberately NOT called access_until. It is a fact about the subscription
     * and it keeps its value after an admin suspends the farm — `access` above
     * remains the only authority on what anybody may actually do, and the two
     * disagree exactly when a person has overridden the arithmetic.
     */
    CASE WHEN s.status = 'trialing' THEN s.trial_ends_on
         WHEN s.id IS NOT NULL
              THEN billing_access_until(s.current_period_end, s.grace_until, s.billing_period)
    END AS covered_until,
    CASE WHEN s.status = 'trialing' THEN s.trial_ends_on - current_date
         WHEN s.id IS NOT NULL
              THEN billing_access_until(s.current_period_end, s.grace_until, s.billing_period) - current_date
    END AS covered_days_left
FROM farm f
LEFT JOIN subscription s ON s.farm_id = f.id
LEFT JOIN plan p         ON p.id = s.plan_id
LEFT JOIN LATERAL (
    SELECT price_monthly_paise, price_yearly_paise
    FROM v_current_public_plan LIMIT 1
) cur ON true
CROSS JOIN LATERAL (
    SELECT count(*)::int AS breeding_does_used
    FROM rabbit r
    WHERE r.farm_id = f.id
      AND r.sex = 'doe'
      AND r.role IN ('breeder', 'replacement')
      AND r.status IN ('active', 'quarantine')
) d
CROSS JOIN LATERAL (
    SELECT count(*)::int AS staff_seats_used
    FROM employee em
    WHERE em.farm_id = f.id AND em.is_active
) e;

ALTER VIEW v_farm_entitlement SET (security_invoker = true);

-- ----------------------------------------------------------------------------
-- Moving the status along
--
-- Reporting only — access is already decided by the view above, so this
-- function can be late, can be skipped, and can be run twice, and no farm's
-- access changes by a day either way.
--
-- 'suspended' rather than 'cancelled' for non-payment: cancelled means the
-- customer ended it, and a churn number that cannot tell "they left" from "they
-- stopped paying" is a churn number that cannot be acted on. Both are read-only
-- and both keep every record.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_advance_subscriptions()
RETURNS TABLE (past_due int, suspended int)
LANGUAGE plpgsql AS $$
DECLARE
    v_past int := 0;
    v_susp int := 0;
BEGIN
    -- The money was due and did not arrive. Still full access: they are inside
    -- the grace window, and most of them are about to pay.
    UPDATE subscription s
       SET status = 'past_due'
     WHERE s.status = 'active'
       AND s.current_period_end IS NOT NULL
       AND s.current_period_end < current_date;
    GET DIAGNOSTICS v_past = ROW_COUNT;

    -- Grace is spent. This is the row that stops them counting towards MRR.
    UPDATE subscription s
       SET status = 'suspended'
     WHERE s.status IN ('past_due', 'grace')
       AND s.current_period_end IS NOT NULL
       AND billing_access_until(s.current_period_end, s.grace_until, s.billing_period) < current_date;
    GET DIAGNOSTICS v_susp = ROW_COUNT;

    RETURN QUERY SELECT v_past, v_susp;
END $$;

REVOKE ALL ON FUNCTION billing_advance_subscriptions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_advance_subscriptions() TO rabbitry_admin;

-- ----------------------------------------------------------------------------
-- Telling them first
--
-- A farm that finds out it is read-only by trying to record a kindling is a
-- farm that phones support angry, and rightly. These go into the same list the
-- nest-box reminders arrive in, which is the one place a farmer already looks.
--
-- Never 'critical'. Push delivery holds anything below critical until quiet
-- hours are over (migration 0025), and a bill is not worth a 3am buzz.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_billing_notifications() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    n int := 0;
    step int;
BEGIN
    -- 1. A week out, and again on the day. Two rows, not a stream: the dedupe
    --    key carries the date being warned about, so a period that moves
    --    because they paid produces a new warning next time and never a repeat
    --    of this one.
    INSERT INTO notification (farm_id, kind, title, body, urgency, dedupe_key)
    SELECT ent.farm_id, 'renewal_due',
           CASE WHEN ent.covered_days_left > 0
                THEN 'Your subscription ends in ' || ent.covered_days_left || ' days'
                ELSE 'Your subscription ends today' END,
           'Renewing costs ₹' || (ent.effective_price_paise / 100)::text
             || ' for another ' || CASE ent.billing_period WHEN 'yearly' THEN 'year' ELSE 'month' END
             || '. Everything keeps working until then, and your records stay '
             || 'either way — renew from More · Billing.',
           CASE WHEN ent.covered_days_left <= 0 THEN 'high' ELSE 'medium' END::task_priority_t,
           'renewal:' || ent.farm_id || ':' || ent.covered_until || ':'
             || CASE WHEN ent.covered_days_left <= 0 THEN 'now' ELSE 'soon' END
    FROM v_farm_entitlement ent
    WHERE ent.access = 'full'
      AND ent.covered_until IS NOT NULL
      AND ent.covered_days_left BETWEEN 0 AND 7
      AND ent.status <> 'cancelled'
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 2. It has happened. Said once, on the day it happens, and said plainly:
    --    the two things a farmer actually wants to know are whether their
    --    records are gone (no) and whether the alerts stop (no).
    INSERT INTO notification (farm_id, kind, title, body, urgency, dedupe_key)
    SELECT ent.farm_id, 'subscription_lapsed',
           CASE WHEN ent.status = 'trialing'
                THEN 'Your free trial has ended'
                ELSE 'Your subscription has ended' END,
           'You can still see and export every record, and every reminder keeps '
             || 'coming — nothing about your animals changes. Renew to add new '
             || 'records again.',
           'high'::task_priority_t,
           'lapsed:' || ent.farm_id || ':' || ent.covered_until
    FROM v_farm_entitlement ent
    WHERE ent.access = 'read_only'
      AND ent.covered_until IS NOT NULL
      /*
       * Within the last week, not for ever afterwards.
       *
       * Two things are being balanced. A farm that lapsed in March must not be
       * told about it again the first time this function ever runs — that would
       * be a backlog of notices to every historically lapsed farm, and the one
       * customer who lapsed yesterday would be lost in it. But the scheduler
       * can be down for a day, and a lapse nobody was told about is exactly the
       * support call this exists to prevent, so the window is wide enough to
       * survive an outage rather than exactly one day wide.
       *
       * The dedupe key carries the date, so a wider window still means one
       * notice per lapse, never a stream.
       */
      AND ent.covered_until >= current_date - 7
      AND ent.status <> 'cancelled'
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    RETURN n;
END $$;

REVOKE ALL ON FUNCTION generate_billing_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generate_billing_notifications() TO rabbitry_admin;

-- ----------------------------------------------------------------------------
-- The console, now that lapsing is a thing that happens
-- ----------------------------------------------------------------------------

-- A farm on its way out, and how far along. This is the list to phone.
--
-- Two different dates matter and the list carries both. `due_on` is when the
-- money was or is due; `covered_until` is when access actually stops, which is
-- up to a month later. The list is selected on the FIRST of those, because the
-- conversation worth having happens before the payment is late — a farm with
-- thirty days of grace left has already been ignoring you for a fortnight.
CREATE OR REPLACE VIEW v_admin_lapsing AS
SELECT
    ent.farm_id,
    ent.farm_name,
    ent.status,
    ent.access,
    ent.billing_period,
    ent.effective_price_paise,
    COALESCE(s.current_period_end, s.trial_ends_on) AS due_on,
    (COALESCE(s.current_period_end, s.trial_ends_on) - current_date)::int AS days_to_due,
    ent.covered_until,
    ent.covered_days_left,
    CASE
        WHEN ent.status = 'trialing' AND ent.access = 'full'      THEN 'trial_ending'
        WHEN ent.status = 'trialing'                              THEN 'trial_over'
        WHEN ent.access = 'full'
             AND COALESCE(s.current_period_end, s.trial_ends_on) < current_date
                                                                  THEN 'in_grace'
        WHEN ent.access = 'full'                                  THEN 'ending_soon'
        ELSE 'lapsed'
    END AS stage,
    owner.full_name  AS owner_name,
    owner.email::text AS owner_email,
    owner.phone      AS owner_phone,
    ov.days_since_activity
FROM v_farm_entitlement ent
JOIN subscription s          ON s.farm_id = ent.farm_id
JOIN v_admin_farm_overview ov ON ov.farm_id = ent.farm_id
LEFT JOIN LATERAL (
    SELECT full_name, email, phone FROM employee
     WHERE farm_id = ent.farm_id AND role = 'owner' AND is_active
     ORDER BY created_at LIMIT 1
) owner ON true
WHERE ent.status <> 'cancelled'
  AND COALESCE(s.current_period_end, s.trial_ends_on) IS NOT NULL
  AND COALESCE(s.current_period_end, s.trial_ends_on) - current_date <= 14
  -- Two months after the door shut it is not a renewal conversation any more.
  AND ent.covered_days_left >= -60;

ALTER VIEW v_admin_lapsing SET (security_invoker = true);
REVOKE ALL ON v_admin_lapsing FROM rabbitry_app;

-- The renewal list on the billing screen, rebuilt on the same arithmetic so the
-- two screens cannot disagree about who is about to lapse.
CREATE OR REPLACE VIEW v_admin_renewal_due AS
SELECT
    /*
     * Column order is load-bearing, not taste: 0027 created this view and
     * CREATE OR REPLACE may only append. Everything new is at the bottom.
     */
    l.farm_id,
    l.farm_name,
    l.status,
    l.access,
    CASE WHEN l.status = 'trialing' THEN 'trial_ending' ELSE 'renewal_due' END AS kind,
    l.due_on,
    -- Days until the MONEY is due, which is the call worth making. How long
    -- they can still work is covered_days_left, below.
    l.days_to_due                                   AS days_left,
    l.billing_period,
    CASE l.billing_period
        WHEN 'monthly' THEN r.monthly_paise
        ELSE r.yearly_paise
    END                                             AS renewal_paise,
    r.is_grandfathered,
    l.owner_name,
    l.owner_email,
    l.owner_phone,
    l.days_since_activity,
    EXISTS (SELECT 1 FROM payment p
             WHERE p.farm_id = l.farm_id AND p.status = 'created'
               AND p.created_at > now() - interval '24 hours') AS has_open_link,
    l.stage,
    l.covered_until,
    l.covered_days_left
FROM v_admin_lapsing l
JOIN v_farm_renewal_price r ON r.farm_id = l.farm_id;

ALTER VIEW v_admin_renewal_due SET (security_invoker = true);
REVOKE ALL ON v_admin_renewal_due FROM rabbitry_app;
