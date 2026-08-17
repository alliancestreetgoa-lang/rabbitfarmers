-- ============================================================================
-- Giving money back
--
-- docs/09 publishes a refund policy and says why: at ₹99 a no-questions refund
-- window costs almost nothing and buys real trust. What it costs instead is
-- three things this migration has to get right, because none of them can be
-- fixed later by hand.
--
-- 1. A GST invoice is never deleted or edited. It is offset by a CREDIT NOTE,
--    which is its own document with its own consecutive series. Both stay on
--    the return: the invoice was issued, the credit note reverses it. Deleting
--    the invoice would leave a gap in a series an auditor reads as evasion.
--
-- 2. A refund usually ends the subscription it paid for, and sometimes must
--    not. Money back because they are leaving takes the days back with it;
--    money back as an apology for a bad week does not — clawing back access
--    would undo the apology. That is `refund_kind_t`, and it is not a detail:
--    it is the difference between a goodwill gesture and a punishment.
--
-- 3. Access is not moved until the money has actually gone. A refund Razorpay
--    has accepted but not yet settled is a promise, and locking a farm out on a
--    promise that then fails is the same failure as a dropped webhook — a
--    farmer standing in a shed unable to write down a kindling because of
--    something happening in a payments system. `billing_settle_refund` is what
--    moves anything, and it runs when `refund.processed` arrives.
-- ============================================================================

CREATE TYPE refund_status_t AS ENUM ('created', 'processed', 'failed', 'cancelled');

-- Why the money is going back, and therefore what happens to their access.
--   cancellation — they are leaving, or it was a mistaken charge. Days go back.
--   goodwill     — an apology or a service credit. They keep every day.
CREATE TYPE refund_kind_t AS ENUM ('cancellation', 'goodwill');

CREATE TABLE refund (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id           uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    -- Deliberately not ON DELETE CASCADE from payment: a refund without the
    -- payment it reverses is meaningless, and payments are never deleted.
    payment_id        uuid NOT NULL REFERENCES payment(id),
    invoice_id        uuid REFERENCES invoice(id),

    gateway           text NOT NULL DEFAULT 'razorpay',
    gateway_refund_id text UNIQUE,

    amount_paise      int NOT NULL CHECK (amount_paise > 0),
    kind              refund_kind_t NOT NULL DEFAULT 'cancellation',
    -- Required, and not for tidiness: this is the sentence the customer is read
    -- back when they ask why, and the one an auditor reads next to the credit
    -- note. There is no default.
    reason            text NOT NULL CHECK (btrim(reason) <> ''),

    status            refund_status_t NOT NULL DEFAULT 'created',
    -- Filled in at settlement, not at request: all three are facts about money
    -- that has actually moved.
    credit_note_number text UNIQUE,
    subtotal_paise    int,
    tax_paise         int,
    days_removed      int,

    requested_by      uuid REFERENCES platform_admin(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    processed_at      timestamptz,
    failed_reason     text
);

CREATE INDEX refund_farm_idx    ON refund (farm_id, created_at DESC);
CREATE INDEX refund_payment_idx ON refund (payment_id);

ALTER TABLE refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund FORCE ROW LEVEL SECURITY;
CREATE POLICY refund_tenant ON refund
    USING (farm_id = current_farm_id())
    WITH CHECK (farm_id = current_farm_id());

-- The farmer reads their own refunds — a refund that is invisible in the app is
-- a support call — and writes none of them. Refunds are an admin action.
GRANT SELECT ON refund TO rabbitry_app;
GRANT SELECT, INSERT, UPDATE ON refund TO rabbitry_admin;
REVOKE INSERT, UPDATE, DELETE ON refund FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Credit note numbers
--
-- Its own series, separate from invoices, for the same reason invoices have
-- one: consecutive within a financial year, allocated from a counter rather
-- than counted from existing rows, because counting is wrong the moment two
-- refunds settle in the same second.
-- ----------------------------------------------------------------------------
CREATE TABLE credit_note_series (
    financial_year text PRIMARY KEY,
    next_number    int NOT NULL DEFAULT 1
);

-- Admin only, like invoice_series. One row per financial year, shared by every
-- farm: a GST document series has no tenant to scope it to.
GRANT SELECT, INSERT, UPDATE ON credit_note_series TO rabbitry_admin;
REVOKE ALL ON credit_note_series FROM rabbitry_app;

CREATE OR REPLACE FUNCTION next_credit_note_number(p_on date DEFAULT current_date)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_fy text := indian_financial_year(p_on);
    v_n  int;
BEGIN
    INSERT INTO credit_note_series (financial_year, next_number)
    VALUES (v_fy, 2)
    ON CONFLICT (financial_year) DO UPDATE
        SET next_number = credit_note_series.next_number + 1
    RETURNING next_number - 1 INTO v_n;

    RETURN 'CN/' || v_fy || '/' || lpad(v_n::text, 5, '0');
END $$;

REVOKE ALL ON FUNCTION next_credit_note_number(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_credit_note_number(date) TO rabbitry_admin;

-- ----------------------------------------------------------------------------
-- Asking for a refund
--
-- Records the intention and nothing else. No money has moved, no access
-- changes, no credit note is allocated — a number burned on a refund that then
-- failed is a gap in the series.
--
-- The one thing it does enforce is arithmetic: the sum of everything asked for
-- against a payment can never exceed what was taken. Refunds already in flight
-- count towards that, so a double-clicked button cannot refund twice.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_create_refund(
    p_payment_id uuid,
    p_amount_paise int DEFAULT NULL,          -- NULL means everything still refundable
    p_kind refund_kind_t DEFAULT 'cancellation',
    p_reason text DEFAULT NULL,
    p_admin uuid DEFAULT NULL,
    p_gateway text DEFAULT NULL)              -- NULL follows the payment's own
RETURNS refund
LANGUAGE plpgsql AS $$
DECLARE
    v_pay      payment;
    v_invoice  uuid;
    v_already  int;
    v_amount   int;
    v_refund   refund;
BEGIN
    SELECT * INTO v_pay FROM payment WHERE id = p_payment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no such payment';
    END IF;
    IF v_pay.status NOT IN ('paid', 'refunded') THEN
        RAISE EXCEPTION 'that payment is %, so there is nothing to give back', v_pay.status;
    END IF;

    SELECT COALESCE(sum(r.amount_paise), 0) INTO v_already
      FROM refund r
     WHERE r.payment_id = p_payment_id
       AND r.status IN ('created', 'processed');

    v_amount := COALESCE(p_amount_paise, v_pay.amount_paise - v_already);

    IF v_amount <= 0 THEN
        RAISE EXCEPTION 'that payment has already been refunded in full';
    END IF;
    IF v_already + v_amount > v_pay.amount_paise THEN
        RAISE EXCEPTION 'only % paise of that payment is left to refund',
              v_pay.amount_paise - v_already;
    END IF;
    IF btrim(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'a reason is required to refund';
    END IF;

    SELECT i.id INTO v_invoice
      FROM invoice i
     WHERE i.farm_id = v_pay.farm_id
       AND i.gateway_payment_id = v_pay.gateway_payment_id;

    INSERT INTO refund (farm_id, payment_id, invoice_id, gateway, amount_paise,
                        kind, reason, requested_by)
    VALUES (v_pay.farm_id, v_pay.id, v_invoice, COALESCE(p_gateway, v_pay.gateway),
            v_amount, p_kind, btrim(p_reason), p_admin)
    RETURNING * INTO v_refund;

    RETURN v_refund;
END $$;

-- ----------------------------------------------------------------------------
-- The money has actually gone
--
-- Everything that changes for a farm changes here, and only here: the credit
-- note is numbered, the days are taken back if they are being taken back, and
-- the payment is marked refunded once nothing is left of it.
--
-- Idempotent, because it is called from a webhook. A retried `refund.processed`
-- finds the refund already settled and changes nothing — otherwise a farm loses
-- its year twice for one refund.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_settle_refund(
    p_refund_id uuid, p_gateway_refund_id text DEFAULT NULL)
RETURNS TABLE (settled boolean, farm_id uuid, credit_note text,
               days_removed int, period_end date, subscription_status subscription_status_t)
LANGUAGE plpgsql AS $$
DECLARE
    v_ref     refund;
    v_pay     payment;
    v_sub     subscription;
    v_days    int;
    v_end     date;
    v_status  subscription_status_t;
    v_number  text;
    v_subtot  int;
    v_tax     int;
    v_total   int;
BEGIN
    SELECT * INTO v_ref FROM refund r WHERE r.id = p_refund_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::uuid, NULL::text, NULL::int, NULL::date,
                            NULL::subscription_status_t;
        RETURN;
    END IF;

    -- Already settled. The webhook was retried, or the console beat it.
    IF v_ref.status = 'processed' THEN
        SELECT s.current_period_end, s.status INTO v_end, v_status
          FROM subscription s WHERE s.farm_id = v_ref.farm_id;
        RETURN QUERY SELECT false, v_ref.farm_id, v_ref.credit_note_number,
                            v_ref.days_removed, v_end, v_status;
        RETURN;
    END IF;

    SELECT * INTO v_pay FROM payment WHERE id = v_ref.payment_id;
    SELECT * INTO v_sub FROM subscription s WHERE s.farm_id = v_ref.farm_id;

    /*
     * What this refund costs them in days.
     *
     * Goodwill costs nothing — that is the whole point of the kind. A
     * cancellation takes back the share of the days this payment bought, in
     * proportion to the share of the money going back, rounded DOWN so the
     * rounding is always the farmer's.
     */
    v_days := CASE WHEN v_ref.kind = 'goodwill' THEN 0
                   ELSE floor(v_pay.covers_days::numeric * v_ref.amount_paise
                              / v_pay.amount_paise)::int END;

    v_end := v_sub.current_period_end;
    v_status := v_sub.status;

    IF v_days > 0 AND v_end IS NOT NULL THEN
        v_end := v_end - v_days;
        /*
         * Spent. They have their money and we have their days back, so they are
         * not a customer any more — which is a status, not a silence: cancelled
         * is read-only, keeps every record, and keeps every reminder firing.
         * A farm is never locked out of its own animals' welfare alerts.
         */
        IF v_end <= current_date THEN
            v_status := 'cancelled';
        END IF;

        UPDATE subscription s SET
            current_period_end = v_end,
            status             = v_status,
            cancelled_at       = CASE WHEN v_status = 'cancelled'
                                      THEN COALESCE(s.cancelled_at, now()) END,
            cancel_reason      = CASE WHEN v_status = 'cancelled'
                                      THEN 'refunded: ' || v_ref.reason END,
            grace_until        = NULL
         WHERE s.farm_id = v_ref.farm_id;
    END IF;

    -- The credit note, allocated now that money has definitely moved. Same
    -- 18% inclusive split as the invoice it offsets, so the two net to zero.
    v_number := next_credit_note_number(current_date);
    v_subtot := round(v_ref.amount_paise / 1.18);
    v_tax    := v_ref.amount_paise - v_subtot;

    UPDATE refund r SET
        status             = 'processed',
        processed_at       = now(),
        gateway_refund_id  = COALESCE(p_gateway_refund_id, r.gateway_refund_id),
        credit_note_number = v_number,
        subtotal_paise     = v_subtot,
        tax_paise          = v_tax,
        days_removed       = v_days,
        failed_reason      = NULL
     WHERE r.id = v_ref.id;

    -- Nothing left of the payment.
    SELECT COALESCE(sum(r.amount_paise), 0) INTO v_total
      FROM refund r WHERE r.payment_id = v_pay.id AND r.status = 'processed';
    IF v_total >= v_pay.amount_paise THEN
        UPDATE payment SET status = 'refunded' WHERE id = v_pay.id;
    END IF;

    RETURN QUERY SELECT true, v_ref.farm_id, v_number, v_days, v_end, v_status;
END $$;

/** The gateway said no. Nothing has moved, and somebody has to know. */
CREATE OR REPLACE FUNCTION billing_fail_refund(p_refund_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
    v_status refund_status_t;
BEGIN
    SELECT status INTO v_status FROM refund WHERE id = p_refund_id;
    IF NOT FOUND THEN RETURN false; END IF;
    -- A refund that already settled does not un-settle because a late
    -- `refund.failed` arrived out of order.
    IF v_status = 'processed' THEN RETURN false; END IF;

    UPDATE refund SET status = 'failed',
                      failed_reason = COALESCE(NULLIF(btrim(p_reason), ''), 'refund failed')
     WHERE id = p_refund_id;
    RETURN true;
END $$;

REVOKE ALL ON FUNCTION billing_create_refund(uuid, int, refund_kind_t, text, uuid, text)
    FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_settle_refund(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_fail_refund(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_create_refund(uuid, int, refund_kind_t, text, uuid, text)
    TO rabbitry_admin;
GRANT EXECUTE ON FUNCTION billing_settle_refund(uuid, text) TO rabbitry_admin;
GRANT EXECUTE ON FUNCTION billing_fail_refund(uuid, text) TO rabbitry_admin;

-- ----------------------------------------------------------------------------
-- What the farmer sees
--
-- A refund the app does not show is a support call: the money has left our
-- account and their screen still says they paid.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_billing_history AS
SELECT
    p.id, p.farm_id, p.created_at, p.paid_at, p.status,
    p.amount_paise, p.billing_period, p.covers_days, p.short_url,
    p.failed_reason,
    i.number      AS invoice_number,
    i.period_start, i.period_end,
    i.subtotal_paise, i.tax_paise,
    r.refunded_paise,
    r.credit_note_number,
    r.refunded_at
FROM payment p
LEFT JOIN invoice i ON i.gateway_payment_id = p.gateway_payment_id
                   AND i.farm_id = p.farm_id
LEFT JOIN LATERAL (
    SELECT sum(x.amount_paise)::int AS refunded_paise,
           max(x.credit_note_number) AS credit_note_number,
           max(x.processed_at)       AS refunded_at
    FROM refund x
    WHERE x.payment_id = p.id AND x.status = 'processed'
) r ON true;

ALTER VIEW v_billing_history SET (security_invoker = true);

-- ----------------------------------------------------------------------------
-- What the admin sees
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_payment AS
SELECT
    p.id,
    p.farm_id,
    f.name                AS farm_name,
    p.gateway,
    p.gateway_link_id,
    p.gateway_payment_id,
    p.short_url,
    p.amount_paise,
    p.billing_period,
    p.covers_days,
    p.status,
    p.created_at,
    p.paid_at,
    p.failed_reason,
    i.number              AS invoice_number,
    i.period_start,
    i.period_end,
    i.subtotal_paise,
    i.tax_paise,
    e.full_name           AS created_by_name,
    COALESCE(r.refunded_paise, 0)          AS refunded_paise,
    -- What is still refundable, which is the number the form needs and the one
    -- a person would otherwise work out with a calculator and get wrong.
    CASE WHEN p.status IN ('paid', 'refunded')
         THEN p.amount_paise - COALESCE(r.in_flight_paise, 0) ELSE 0 END AS refundable_paise,
    r.credit_note_number
FROM payment p
JOIN farm f            ON f.id = p.farm_id
LEFT JOIN invoice i    ON i.farm_id = p.farm_id
                      AND i.gateway_payment_id = p.gateway_payment_id
LEFT JOIN employee e   ON e.id = p.created_by
LEFT JOIN LATERAL (
    SELECT sum(x.amount_paise) FILTER (WHERE x.status = 'processed')::int AS refunded_paise,
           sum(x.amount_paise) FILTER (WHERE x.status IN ('created', 'processed'))::int
               AS in_flight_paise,
           max(x.credit_note_number)                                     AS credit_note_number
    FROM refund x WHERE x.payment_id = p.id
) r ON true;

ALTER VIEW v_admin_payment SET (security_invoker = true);
REVOKE ALL ON v_admin_payment FROM rabbitry_app;

CREATE OR REPLACE VIEW v_admin_refund AS
SELECT
    r.id,
    r.farm_id,
    f.name                AS farm_name,
    r.payment_id,
    p.amount_paise        AS payment_paise,
    p.gateway_payment_id,
    r.gateway,
    r.gateway_refund_id,
    r.amount_paise,
    r.kind,
    r.reason,
    r.status,
    r.credit_note_number,
    r.subtotal_paise,
    r.tax_paise,
    r.days_removed,
    r.created_at,
    r.processed_at,
    r.failed_reason,
    i.number              AS invoice_number,
    a.full_name           AS requested_by_name
FROM refund r
JOIN farm f              ON f.id = r.farm_id
JOIN payment p           ON p.id = r.payment_id
LEFT JOIN invoice i      ON i.id = r.invoice_id
LEFT JOIN platform_admin a ON a.id = r.requested_by;

ALTER VIEW v_admin_refund SET (security_invoker = true);
REVOKE ALL ON v_admin_refund FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Money that has gone wrong, now that some of it goes backwards
--
-- Two new ways, and one correction that matters more than either: a farm we
-- refunded is SUPPOSED to be read-only. Without the exclusion below, every
-- refund raises a severity-1 "paid, still locked out" alarm, and a list that
-- cries wolf on every ordinary refund is a list nobody reads by March.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_billing_exception AS

SELECT
    'paid_but_locked_out'::text AS kind,
    1                           AS severity,
    p.farm_id,
    f.name                      AS farm_name,
    p.id::text                  AS ref,
    p.paid_at                   AS at,
    p.amount_paise,
    'Paid, and the farm is still read-only. Their subscription ends '
        || COALESCE(ent.current_period_end::text, 'never set') AS detail
FROM payment p
JOIN farm f ON f.id = p.farm_id
JOIN v_farm_entitlement ent ON ent.farm_id = p.farm_id
WHERE p.status = 'paid'
  AND p.paid_at > now() - interval '45 days'
  AND ent.access = 'read_only'
  -- Refunded, in whole or in part: being read-only is the refund working.
  AND NOT EXISTS (SELECT 1 FROM refund r
                   WHERE r.payment_id = p.id AND r.status = 'processed')

UNION ALL

SELECT
    'paid_no_invoice', 2, p.farm_id, f.name, p.id::text, p.paid_at, p.amount_paise,
    'Paid with no invoice number. The GST series has a payment it never billed.'
FROM payment p
JOIN farm f ON f.id = p.farm_id
WHERE p.status = 'paid'
  AND NOT EXISTS (
    SELECT 1 FROM invoice i
     WHERE i.farm_id = p.farm_id
       AND i.gateway_payment_id = p.gateway_payment_id)

UNION ALL

SELECT
    'webhook_failed', 2, w.farm_id, f.name, w.id, w.received_at, NULL::int,
    CASE WHEN w.result LIKE 'error:%'
         THEN 'Webhook ' || w.event || ' failed: ' || w.result
         ELSE 'Webhook ' || w.event || ' was received and never finished processing'
    END
FROM webhook_event w
LEFT JOIN farm f ON f.id = w.farm_id
WHERE w.result LIKE 'error:%'
   OR (w.processed_at IS NULL AND w.received_at < now() - interval '5 minutes')

UNION ALL

SELECT
    'unattributed_payment', 1, NULL::uuid, NULL::text, w.id, w.received_at, NULL::int,
    'A payment link was paid that matches no payment of ours: '
        || COALESCE(w.payload #>> '{payload,payment_link,entity,id}', 'unknown link')
FROM webhook_event w
WHERE w.event = 'payment_link.paid'
  AND w.processed_at IS NOT NULL
  AND w.farm_id IS NULL

UNION ALL

SELECT
    'amount_mismatch', 2, p.farm_id, f.name, p.id::text, p.created_at, p.amount_paise,
    'Refused: ' || COALESCE(p.failed_reason, 'amount did not match')
FROM payment p
JOIN farm f ON f.id = p.farm_id
WHERE p.status = 'failed'
  AND p.failed_reason LIKE 'expected %'

UNION ALL

-- We told a customer their money was coming back and it did not. They are
-- waiting, and nothing will chase it on its own.
SELECT
    'refund_failed', 1, r.farm_id, f.name, r.id::text, r.created_at, r.amount_paise,
    'Refund failed: ' || COALESCE(r.failed_reason, 'no reason given')
FROM refund r
JOIN farm f ON f.id = r.farm_id
WHERE r.status = 'failed'

UNION ALL

-- Accepted by the gateway and never settled. Razorpay's normal speed is five to
-- seven working days; past ten, something is wrong rather than slow.
SELECT
    'refund_stuck', 2, r.farm_id, f.name, r.id::text, r.created_at, r.amount_paise,
    'Refund asked for ' || (current_date - r.created_at::date)
        || ' days ago and still not settled'
FROM refund r
JOIN farm f ON f.id = r.farm_id
WHERE r.status = 'created'
  AND r.created_at < now() - interval '10 days'

UNION ALL

SELECT
    'abandoned_link', 3, p.farm_id, f.name, p.id::text, p.created_at, p.amount_paise,
    'A payment link was made and never paid'
FROM payment p
JOIN farm f ON f.id = p.farm_id
WHERE p.status = 'created'
  AND p.created_at < now() - interval '24 hours';

ALTER VIEW v_admin_billing_exception SET (security_invoker = true);
REVOKE ALL ON v_admin_billing_exception FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- The totals, net of what went back
--
-- "Collected" now means collected minus refunded, counted in the month the
-- money actually moved in each direction. A dashboard that shows gross takings
-- and hides refunds tells the owner the business is doing better than it is,
-- which is the specific way a revenue number becomes a lie.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_billing_summary AS
SELECT
    (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM payment
      WHERE status IN ('paid', 'refunded') AND paid_at >= date_trunc('month', now()))
    - (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM refund
        WHERE status = 'processed' AND processed_at >= date_trunc('month', now()))
        AS collected_month_paise,
    (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM payment
      WHERE status IN ('paid', 'refunded')
        AND paid_at >= indian_financial_year_start(current_date))
    - (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM refund
        WHERE status = 'processed'
          AND processed_at >= indian_financial_year_start(current_date))
        AS collected_fy_paise,
    (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM payment
      WHERE status IN ('paid', 'refunded'))
    - (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM refund WHERE status = 'processed')
        AS collected_total_paise,
    (SELECT count(*)::int FROM payment
      WHERE status IN ('paid', 'refunded') AND paid_at >= date_trunc('month', now()))
        AS payments_month,
    (SELECT COALESCE(sum(tax_paise), 0)::bigint FROM invoice
      WHERE status = 'paid' AND issued_on >= indian_financial_year_start(current_date))
    - (SELECT COALESCE(sum(tax_paise), 0)::bigint FROM refund
        WHERE status = 'processed'
          AND processed_at >= indian_financial_year_start(current_date))
        AS tax_fy_paise,
    (SELECT count(*)::int FROM payment
      WHERE status = 'created' AND created_at >= now() - interval '24 hours')
        AS links_open,
    (SELECT count(*)::int FROM v_admin_billing_exception WHERE severity = 1)
        AS urgent,
    (SELECT count(*)::int FROM v_admin_billing_exception)
        AS exceptions,
    (SELECT count(*)::int FROM v_admin_renewal_due WHERE days_left BETWEEN 0 AND 14)
        AS due_14d,
    (SELECT count(*)::int FROM v_admin_renewal_due WHERE days_left < 0)
        AS overdue,
    (SELECT count(*)::int FROM v_farm_entitlement WHERE access = 'read_only')
        AS locked_out,
    (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM refund
      WHERE status = 'processed'
        AND processed_at >= indian_financial_year_start(current_date))
        AS refunded_fy_paise,
    (SELECT count(*)::int FROM refund WHERE status = 'created')
        AS refunds_in_flight;

ALTER VIEW v_admin_billing_summary SET (security_invoker = true);
REVOKE ALL ON v_admin_billing_summary FROM rabbitry_app;

-- Collections by month, net of refunds settled in that month.
CREATE OR REPLACE VIEW v_admin_revenue_month AS
SELECT
    m.month::date                                   AS month,
    inv.invoices,
    (inv.total_paise - cn.total_paise)::bigint      AS total_paise,
    (inv.tax_paise - cn.tax_paise)::bigint          AS tax_paise,
    cn.total_paise                                  AS refunded_paise
FROM generate_series(date_trunc('month', current_date) - interval '11 months',
                     date_trunc('month', current_date), interval '1 month') m(month)
CROSS JOIN LATERAL (
    SELECT count(*)::int                        AS invoices,
           COALESCE(sum(i.total_paise), 0)::bigint AS total_paise,
           COALESCE(sum(i.tax_paise), 0)::bigint   AS tax_paise
    FROM invoice i
    WHERE i.status = 'paid' AND date_trunc('month', i.issued_on) = m.month
) inv
CROSS JOIN LATERAL (
    SELECT COALESCE(sum(r.amount_paise), 0)::bigint AS total_paise,
           COALESCE(sum(r.tax_paise), 0)::bigint    AS tax_paise
    FROM refund r
    WHERE r.status = 'processed' AND date_trunc('month', r.processed_at) = m.month
) cn;

ALTER VIEW v_admin_revenue_month SET (security_invoker = true);
REVOKE ALL ON v_admin_revenue_month FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- The return
--
-- Both documents, both reported. An invoice is never removed because it was
-- later refunded — the supply happened and was billed; the credit note reverses
-- it. Net is what the business actually kept.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_invoice_fy AS
SELECT
    fy.financial_year,
    inv.invoices,
    inv.taxable_paise,
    inv.tax_paise,
    inv.total_paise,
    inv.first_number,
    inv.last_number,
    cn.credit_notes,
    cn.taxable_paise                                   AS credited_taxable_paise,
    cn.tax_paise                                       AS credited_tax_paise,
    cn.total_paise                                     AS credited_total_paise,
    cn.first_number                                    AS first_credit_note,
    cn.last_number                                     AS last_credit_note,
    (inv.taxable_paise - cn.taxable_paise)::bigint     AS net_taxable_paise,
    (inv.tax_paise - cn.tax_paise)::bigint             AS net_tax_paise,
    (inv.total_paise - cn.total_paise)::bigint         AS net_total_paise
FROM (
    SELECT indian_financial_year(issued_on) AS financial_year FROM invoice WHERE status = 'paid'
    UNION
    SELECT indian_financial_year(processed_at::date) FROM refund WHERE status = 'processed'
) fy
CROSS JOIN LATERAL (
    SELECT count(*)::int                          AS invoices,
           COALESCE(sum(i.subtotal_paise), 0)::bigint AS taxable_paise,
           COALESCE(sum(i.tax_paise), 0)::bigint      AS tax_paise,
           COALESCE(sum(i.total_paise), 0)::bigint    AS total_paise,
           min(i.number)                          AS first_number,
           max(i.number)                          AS last_number
    FROM invoice i
    WHERE i.status = 'paid'
      AND indian_financial_year(i.issued_on) = fy.financial_year
) inv
CROSS JOIN LATERAL (
    SELECT count(*)::int                          AS credit_notes,
           COALESCE(sum(r.subtotal_paise), 0)::bigint AS taxable_paise,
           COALESCE(sum(r.tax_paise), 0)::bigint      AS tax_paise,
           COALESCE(sum(r.amount_paise), 0)::bigint   AS total_paise,
           min(r.credit_note_number)              AS first_number,
           max(r.credit_note_number)              AS last_number
    FROM refund r
    WHERE r.status = 'processed'
      AND indian_financial_year(r.processed_at::date) = fy.financial_year
) cn;

ALTER VIEW v_admin_invoice_fy SET (security_invoker = true);
REVOKE ALL ON v_admin_invoice_fy FROM rabbitry_app;
