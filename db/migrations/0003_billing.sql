-- ============================================================================
-- SaaS: plans, subscriptions, entitlements
--
-- Access is derived from THIS table, never from a payment-gateway webhook.
-- Webhooks get missed, and a farm locked out by a dropped webhook on day 28 of
-- a pregnancy is a customer lost permanently. The gateway IDs are stored for
-- reconciliation; they are not the source of truth.
-- ============================================================================
CREATE TYPE subscription_status_t AS ENUM
    ('trialing', 'active', 'past_due', 'grace', 'suspended', 'cancelled');
CREATE TYPE billing_period_t AS ENUM ('monthly', 'yearly');
CREATE TYPE invoice_status_t AS ENUM ('draft', 'due', 'paid', 'failed', 'refunded');

-- One plan, sold two ways: ₹99/month or ₹999/year, after a 30-day full-access
-- trial. The limit columns stay NULL (unlimited) — they are kept so a tier can
-- be introduced later without a migration, not because anything is capped today.
--
-- ₹99 is INTRODUCTORY. Two rules follow, and both matter:
--
--   1. Plan rows are immutable price points. Raising the price means INSERTing a
--      new row and setting available_until on the old one — never UPDATEing a
--      price in place, because existing subscriptions point at these rows.
--   2. The price is also snapshotted onto the subscription at signup. That is
--      the belt-and-braces: even if someone does edit a plan row by hand, no
--      existing customer is silently repriced.
CREATE TABLE plan (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code               text UNIQUE NOT NULL,
    name               text NOT NULL,
    -- NULL means unlimited. Both are NULL on the current single plan.
    max_breeding_does  int,
    max_staff_seats    int,
    -- Stored in paise to avoid float money. GST-inclusive: most customers are
    -- unregistered smallholders who cannot reclaim it, and a farmer shown ₹299
    -- then charged ₹353 feels cheated.
    price_monthly_paise int NOT NULL,
    price_yearly_paise  int NOT NULL,
    features           jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Shown on the pricing page as "Introductory pricing".
    is_introductory    boolean NOT NULL DEFAULT false,
    -- The window in which NEW signups may take this price. Closing it does not
    -- affect anyone already on it.
    available_from     date NOT NULL DEFAULT current_date,
    available_until    date,
    is_public          boolean NOT NULL DEFAULT true,
    sort_order         int NOT NULL DEFAULT 0
);

CREATE TABLE subscription (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id                 uuid UNIQUE NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    plan_id                 uuid NOT NULL REFERENCES plan(id),
    status                  subscription_status_t NOT NULL DEFAULT 'trialing',
    billing_period          billing_period_t NOT NULL DEFAULT 'monthly',
    trial_ends_on           date,
    current_period_start    date,
    current_period_end      date,
    grace_until             date,
    -- Price snapshotted at signup. This is what the farm actually pays for as
    -- long as the subscription lives, regardless of what the plan row later
    -- says. Grandfathering an introductory price is not a promise you keep by
    -- remembering — it is one you keep by storing the number.
    locked_price_monthly_paise int,
    locked_price_yearly_paise  int,
    price_locked_at            timestamptz,
    gateway                 text,                 -- razorpay
    -- Set the UPI Autopay mandate MAXIMUM well above the amount charged (a few
    -- thousand rupees is still under the ₹15,000 no-OTP threshold). The mandate
    -- max cannot be raised without the customer re-authorising, so headroom
    -- costs nothing now and avoids re-onboarding every customer later.
    gateway_mandate_max_paise int,
    gateway_subscription_id text,
    cancelled_at            timestamptz,
    cancel_reason           text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_status_idx ON subscription (status, current_period_end);

CREATE TABLE invoice (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id            uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    subscription_id    uuid REFERENCES subscription(id),
    number             text UNIQUE NOT NULL,      -- sequential, GST requires it
    issued_on          date NOT NULL DEFAULT current_date,
    period_start       date,
    period_end         date,
    subtotal_paise     int NOT NULL,
    tax_paise          int NOT NULL DEFAULT 0,    -- 18% GST on SaaS in India
    total_paise        int NOT NULL,
    status             invoice_status_t NOT NULL DEFAULT 'due',
    gateway_payment_id text,
    paid_at            timestamptz
);
CREATE INDEX invoice_farm_idx ON invoice (farm_id, issued_on DESC);

-- What a NEW signup would pay today. Exactly one row while a single plan is on
-- sale; the pricing page reads from here rather than hard-coding ₹99 anywhere.
CREATE OR REPLACE VIEW v_current_public_plan AS
SELECT *
FROM plan
WHERE is_public
  AND available_from <= current_date
  AND (available_until IS NULL OR available_until >= current_date)
ORDER BY sort_order;


-- What a farm may do right now, what it actually pays, and how close it is to
-- any plan limits.
--
-- Note what NEVER degrades: reminders. A farm past due, in grace or suspended
-- still gets its nest-box and loose-motion alerts. They cost almost nothing to
-- keep running, and withholding them means dead litters caused by billing
-- logic. Withhold the product — new records, reports, extra staff logins —
-- never the animal's welfare.
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
        WHEN s.id IS NULL                       THEN 'read_only'
        WHEN s.status = 'trialing'
             AND s.trial_ends_on >= current_date THEN 'full'
        WHEN s.status = 'trialing'              THEN 'read_only'
        WHEN s.status IN ('active', 'past_due') THEN 'full'
        WHEN s.status = 'grace'
             AND (s.grace_until IS NULL OR s.grace_until >= current_date)
                                                THEN 'full'
        ELSE 'read_only'
    END                        AS access,
    true                       AS reminders_active,   -- always. See above.
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
    -- What this farm actually pays: the snapshot taken at signup, falling back
    -- to the plan row only when no snapshot exists.
    CASE s.billing_period
        WHEN 'monthly' THEN COALESCE(s.locked_price_monthly_paise, p.price_monthly_paise)
        WHEN 'yearly'  THEN COALESCE(s.locked_price_yearly_paise,  p.price_yearly_paise)
    END AS effective_price_paise,
    -- What the same subscription would cost a new customer signing up today.
    CASE s.billing_period
        WHEN 'monthly' THEN cur.price_monthly_paise
        WHEN 'yearly'  THEN cur.price_yearly_paise
    END AS current_list_price_paise,
    -- True once the list price has risen above what this farm locked in.
    (CASE s.billing_period
        WHEN 'monthly' THEN COALESCE(s.locked_price_monthly_paise, p.price_monthly_paise)
                              < cur.price_monthly_paise
        WHEN 'yearly'  THEN COALESCE(s.locked_price_yearly_paise, p.price_yearly_paise)
                              < cur.price_yearly_paise
     END) AS is_grandfathered
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

