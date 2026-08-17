-- ============================================================================
-- Taking money
--
-- Everything to do with what a farm may do is already settled by migration
-- 0003, and its header states the rule this migration has to obey:
--
--     Access is derived from THIS table, never from a payment-gateway webhook.
--
-- So nothing here grants access. A payment extends `subscription.current_period_end`
-- and sets the status, and the entitlement view does what it always did. A
-- dropped webhook costs a farm a reconciliation, not their records — which
-- matters, because a farm locked out on day 28 of a pregnancy by a webhook that
-- never arrived is a customer lost permanently.
--
-- Payment Links rather than a checkout SDK. A link is a URL: it opens in the
-- browser on a web build and in the browser on a phone, needs no native module,
-- no CSP exception and no SDK version to keep current — and a farmer can be
-- sent one over WhatsApp when they call to say the app will not take their
-- money, which is a support path worth having on day one.
--
-- What is deliberately NOT here: recurring mandates. UPI Autopay and e-NACH
-- need mandate registration, an additional-factor step on the first debit and a
-- pre-debit notification twenty-four hours before every charge. That is a real
-- build with a lot of failure states, and ₹999 once a year is a payment a
-- farmer can make with one tap. `subscription.gateway_subscription_id` and
-- `gateway_mandate_max_paise` have been waiting since 0003 and stay empty.
-- ============================================================================

CREATE TYPE payment_status_t AS ENUM ('created', 'paid', 'failed', 'cancelled', 'refunded');

CREATE TABLE payment (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id          uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    subscription_id  uuid REFERENCES subscription(id) ON DELETE SET NULL,

    gateway          text NOT NULL DEFAULT 'razorpay',
    -- The payment link, and the payment that eventually settled against it.
    gateway_link_id  text UNIQUE,
    gateway_payment_id text,
    short_url        text,

    -- What was actually asked for, snapshotted. The list price can change
    -- tomorrow; what this farm was quoted must not.
    amount_paise     int NOT NULL CHECK (amount_paise > 0),
    currency         text NOT NULL DEFAULT 'INR',
    billing_period   billing_period_t NOT NULL,
    -- What it buys, decided when the link is made rather than when it is paid,
    -- so a farmer who pays three days later still gets what they were shown.
    covers_days      int NOT NULL,

    status           payment_status_t NOT NULL DEFAULT 'created',
    created_at       timestamptz NOT NULL DEFAULT now(),
    paid_at          timestamptz,
    failed_reason    text,
    created_by       uuid REFERENCES employee(id) ON DELETE SET NULL
);

CREATE INDEX payment_farm_idx ON payment (farm_id, created_at DESC);

ALTER TABLE payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_tenant ON payment
    USING (farm_id = current_farm_id())
    WITH CHECK (farm_id = current_farm_id());

GRANT SELECT, INSERT, UPDATE ON payment TO rabbitry_app, rabbitry_admin;
-- Nobody deletes a payment. It is the record of money moving.
REVOKE DELETE ON payment FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Every webhook we were sent, once
--
-- Razorpay retries. It retries on a timeout, on a 500, and on a deploy that
-- happened to restart mid-request — and a retried `payment_link.paid` applied
-- twice is a farm given two years for one payment. The gateway's own event id
-- is the primary key, so the second delivery collides instead of paying out.
--
-- Keeping the payload is not sentiment. When a farmer says they paid and the
-- app disagrees, this is the only place with both sides of the story.
-- ----------------------------------------------------------------------------
CREATE TABLE webhook_event (
    -- x-razorpay-event-id, or a hash of the body when the header is absent.
    id           text PRIMARY KEY,
    gateway      text NOT NULL DEFAULT 'razorpay',
    event        text NOT NULL,
    farm_id      uuid REFERENCES farm(id) ON DELETE SET NULL,
    payload      jsonb NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    result       text
);

CREATE INDEX webhook_event_received_idx ON webhook_event (received_at DESC);

ALTER TABLE webhook_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_event FORCE ROW LEVEL SECURITY;
-- Scoped even though the farmer-facing role is revoked below, and NULL farm_id
-- is invisible to everyone: a webhook we could not attribute is not a thing any
-- tenant gets to read.
CREATE POLICY webhook_event_tenant ON webhook_event
    USING (farm_id = current_farm_id())
    WITH CHECK (farm_id = current_farm_id());

GRANT SELECT, INSERT, UPDATE ON webhook_event TO rabbitry_admin;
REVOKE ALL ON webhook_event FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Invoice numbers
--
-- GST requires a consecutive series, unique within a financial year, and India's
-- financial year starts in April. A gap is a question from an auditor, so this
-- allocates from a counter rather than counting existing rows — counting is
-- wrong the moment two payments land in the same second.
-- ----------------------------------------------------------------------------
CREATE TABLE invoice_series (
    financial_year text PRIMARY KEY,       -- '2026-27'
    next_number    int NOT NULL DEFAULT 1
);

-- Admin only. Numbers are allocated by billing_apply_payment, which is called
-- from the webhook and the payment-return page, both of which connect as the
-- admin role. The farmer-facing role never needs one.
GRANT SELECT, INSERT, UPDATE ON invoice_series TO rabbitry_admin;
REVOKE ALL ON invoice_series FROM rabbitry_app;

CREATE OR REPLACE FUNCTION indian_financial_year(p_on date)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN EXTRACT(month FROM p_on) >= 4
        THEN to_char(p_on, 'YYYY') || '-' || to_char(p_on + interval '1 year', 'YY')
        ELSE to_char(p_on - interval '1 year', 'YYYY') || '-' || to_char(p_on, 'YY')
    END;
$$;

CREATE OR REPLACE FUNCTION next_invoice_number(p_on date DEFAULT current_date)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_fy text := indian_financial_year(p_on);
    v_n  int;
BEGIN
    -- One statement, so two concurrent payments cannot both read the same
    -- number. The row lock is held to the end of the transaction.
    INSERT INTO invoice_series (financial_year, next_number)
    VALUES (v_fy, 2)
    ON CONFLICT (financial_year) DO UPDATE
        SET next_number = invoice_series.next_number + 1
    RETURNING next_number - 1 INTO v_n;

    RETURN 'RB/' || v_fy || '/' || lpad(v_n::text, 5, '0');
END $$;

-- ----------------------------------------------------------------------------
-- Applying a payment
--
-- The only function that moves a farm's period, and the only place the rules
-- about *how* a period moves are written down.
--
-- Idempotent on the payment row: called twice — the checkout callback and the
-- webhook both arriving, which is the normal case rather than the exception —
-- the second call finds the payment already paid and changes nothing.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_apply_payment(
    p_link_id text, p_payment_id text, p_amount_paise int DEFAULT NULL)
RETURNS TABLE (applied boolean, farm_id uuid, period_end date, invoice_number text)
LANGUAGE plpgsql AS $$
DECLARE
    v_pay      payment;
    v_sub      subscription;
    v_from     date;
    v_to       date;
    v_number   text;
    v_subtotal int;
    v_tax      int;
BEGIN
    SELECT * INTO v_pay FROM payment WHERE gateway_link_id = p_link_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::uuid, NULL::date, NULL::text;
        RETURN;
    END IF;

    -- Already done. The callback beat the webhook, or the webhook was retried.
    IF v_pay.status = 'paid' THEN
        SELECT s.current_period_end INTO v_to FROM subscription s WHERE s.farm_id = v_pay.farm_id;
        RETURN QUERY SELECT false, v_pay.farm_id, v_to, NULL::text;
        RETURN;
    END IF;

    -- Paying the wrong amount is not a payment. Razorpay will not let it happen
    -- through a link, so this is here for the case where somebody constructs
    -- one by hand.
    IF p_amount_paise IS NOT NULL AND p_amount_paise <> v_pay.amount_paise THEN
        UPDATE payment SET status = 'failed',
               failed_reason = format('expected %s paise, received %s',
                                      v_pay.amount_paise, p_amount_paise)
         WHERE id = v_pay.id;
        RETURN QUERY SELECT false, v_pay.farm_id, NULL::date, NULL::text;
        RETURN;
    END IF;

    SELECT * INTO v_sub FROM subscription WHERE subscription.farm_id = v_pay.farm_id;

    /*
     * Extend from whichever is later: today, or where the period already ends.
     *
     * Paying early must not cost the farmer the days they have left — that is
     * the behaviour that makes somebody wait until the last day and then miss
     * it. Paying late starts from today rather than back-dating, so a farm that
     * lapsed for a month does not buy a month that has already gone.
     */
    v_from := GREATEST(current_date, COALESCE(v_sub.current_period_end, current_date));
    v_to   := v_from + v_pay.covers_days;

    UPDATE subscription SET
        status               = 'active',
        current_period_start = v_from,
        current_period_end   = v_to,
        grace_until          = NULL,
        -- Not the trial any more. Leaving this set makes the entitlement view's
        -- trial arithmetic report days remaining on a paid farm.
        trial_ends_on        = NULL,
        gateway              = 'razorpay',
        cancelled_at         = NULL
     WHERE subscription.farm_id = v_pay.farm_id;

    /*
     * The price on the page is what the farmer pays, so GST is inside it rather
     * than added on top. ₹99 means ₹99. The invoice has to show the split
     * anyway, so it is derived here at 18%, which is the rate for SaaS in India.
     */
    v_subtotal := round(v_pay.amount_paise / 1.18);
    v_tax      := v_pay.amount_paise - v_subtotal;
    v_number   := next_invoice_number(current_date);

    INSERT INTO invoice (farm_id, subscription_id, number, period_start, period_end,
                         subtotal_paise, tax_paise, total_paise, status,
                         gateway_payment_id, paid_at)
    VALUES (v_pay.farm_id, v_sub.id, v_number, v_from, v_to,
            v_subtotal, v_tax, v_pay.amount_paise, 'paid', p_payment_id, now());

    UPDATE payment SET status = 'paid', paid_at = now(),
           gateway_payment_id = COALESCE(p_payment_id, gateway_payment_id),
           subscription_id = v_sub.id
     WHERE id = v_pay.id;

    RETURN QUERY SELECT true, v_pay.farm_id, v_to, v_number;
END $$;

/*
 * What a renewal costs this farm, for each period it could choose.
 *
 * v_farm_entitlement already answers this for the period the farm is currently
 * on, which is the right answer for "what do they pay" and the wrong one for a
 * screen offering both. The COALESCE is the same one, and it lives here rather
 * than in the route because grandfathering is a rule about the data, not about
 * a screen: a locked price beats the list price, and a renew button that quotes
 * today's number makes the whole locked-price mechanism pointless.
 */
CREATE OR REPLACE VIEW v_farm_renewal_price AS
SELECT
    s.farm_id,
    COALESCE(s.locked_price_monthly_paise, p.price_monthly_paise) AS monthly_paise,
    COALESCE(s.locked_price_yearly_paise,  p.price_yearly_paise)  AS yearly_paise,
    (s.locked_price_monthly_paise IS DISTINCT FROM p.price_monthly_paise
     OR s.locked_price_yearly_paise IS DISTINCT FROM p.price_yearly_paise) AS is_grandfathered
FROM subscription s
JOIN plan p ON p.id = s.plan_id;

ALTER VIEW v_farm_renewal_price SET (security_invoker = true);

-- What the farmer sees on the billing screen: every payment, and what it bought.
CREATE OR REPLACE VIEW v_billing_history AS
SELECT
    p.id, p.farm_id, p.created_at, p.paid_at, p.status,
    p.amount_paise, p.billing_period, p.covers_days, p.short_url,
    p.failed_reason,
    i.number      AS invoice_number,
    i.period_start, i.period_end,
    i.subtotal_paise, i.tax_paise
FROM payment p
LEFT JOIN invoice i ON i.gateway_payment_id = p.gateway_payment_id
                   AND i.farm_id = p.farm_id;

ALTER VIEW v_billing_history SET (security_invoker = true);
