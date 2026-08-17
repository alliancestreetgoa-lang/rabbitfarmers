-- ============================================================================
-- The money screen
--
-- Migration 0026 built the machinery that takes money. This one builds the
-- screen that answers the questions the person running the business actually
-- asks, and they are not "what is our MRR" — that one is already answered by
-- v_admin_revenue_summary. They are:
--
--     Did this farmer's payment reach us, and if not, where did it stop?
--     Who is about to lapse, and who lapsed and never came back?
--     What do I owe the GST return this quarter?
--
-- All three are reconciliation questions, and reconciliation only works if the
-- failures are visible. A dashboard that shows revenue and hides the payment
-- that was taken but never applied is worse than no dashboard: it says
-- everything is fine in the one case where somebody has been charged for a
-- product they cannot use. Hence v_admin_billing_exception, which exists to
-- surface exactly those, and which is the first thing on the page.
--
-- Everything here crosses tenants, so every view is revoked from the
-- farmer-facing role rather than merely being scoped by it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Closing a hole from 0026 while we are here.
--
-- billing_apply_payment is SECURITY INVOKER, so RLS and the grants still apply
-- to whoever calls it — but EXECUTE defaults to PUBLIC, which means the
-- farmer-facing role may call the function that moves a subscription's period
-- end. It would fail on next_invoice_number (invoice_series is revoked) and the
-- whole statement would roll back, so this was never exploitable. "Not
-- exploitable because a later statement happens to fail" is not a control.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION billing_apply_payment(text, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION next_invoice_number(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_apply_payment(text, text, int) TO rabbitry_admin;
GRANT EXECUTE ON FUNCTION next_invoice_number(date) TO rabbitry_admin;

-- India's financial year starts in April, and every money total on this screen
-- is grouped by it. indian_financial_year() already names one; this one gives
-- its first day, which is what a `>=` needs.
CREATE OR REPLACE FUNCTION indian_financial_year_start(p_on date)
RETURNS date
LANGUAGE sql IMMUTABLE AS $$
    SELECT (date_trunc('year', p_on::timestamp - interval '3 months')
            + interval '3 months')::date;
$$;

-- ----------------------------------------------------------------------------
-- Recording a payment that did not come through the gateway
--
-- Farmers pay by UPI to a phone number and by bank transfer, and they will call
-- and say so. Until now the only way to credit that was `activate`, which sets
-- a period end and leaves no payment row and no invoice — so the money exists
-- in a bank statement and nowhere in this system, and the GST return is wrong.
--
-- A synthetic link id sends it through billing_apply_payment, the same function
-- Razorpay's webhook calls. That is deliberate: the rules about how a period
-- moves (extend from the later of today and the current end) and how an invoice
-- is numbered are written once, and an offline payment cannot drift from them.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_record_offline_payment(
    p_farm_id uuid,
    p_period billing_period_t,
    p_amount_paise int DEFAULT NULL,      -- NULL means this farm's own price
    p_reference text DEFAULT NULL)        -- UTR, cheque number, "cash"
RETURNS TABLE (payment_id uuid, invoice_number text, period_end date, amount_paise int)
LANGUAGE plpgsql AS $$
DECLARE
    v_amount  int;
    v_days    int := CASE WHEN p_period = 'yearly' THEN 365 ELSE 30 END;
    v_link    text := 'offline:' || gen_random_uuid();
    v_ref     text := NULLIF(btrim(COALESCE(p_reference, '')), '');
    v_pay     uuid;
    v_applied record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM subscription s WHERE s.farm_id = p_farm_id) THEN
        RAISE EXCEPTION 'that farm has no subscription to credit';
    END IF;

    SELECT COALESCE(p_amount_paise,
                    CASE WHEN p_period = 'yearly' THEN r.yearly_paise
                         ELSE r.monthly_paise END)
      INTO v_amount
      FROM v_farm_renewal_price r
     WHERE r.farm_id = p_farm_id;

    IF v_amount IS NULL OR v_amount <= 0 THEN
        RAISE EXCEPTION 'no price to record for that farm — pass an amount';
    END IF;

    INSERT INTO payment (farm_id, gateway, gateway_link_id, amount_paise,
                         billing_period, covers_days, status)
    VALUES (p_farm_id, 'offline', v_link, v_amount, p_period, v_days, 'created')
    RETURNING id INTO v_pay;

    -- The reference is what a bank statement will be searched by, so it becomes
    -- the payment id on the invoice. Without one the synthetic link id stands
    -- in, so the invoice still points back at exactly one payment row.
    SELECT * INTO v_applied
      FROM billing_apply_payment(v_link, COALESCE(v_ref, v_link), NULL);

    RETURN QUERY SELECT v_pay, v_applied.invoice_number, v_applied.period_end, v_amount;
END $$;

REVOKE ALL ON FUNCTION billing_record_offline_payment(uuid, billing_period_t, int, text)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_record_offline_payment(uuid, billing_period_t, int, text)
    TO rabbitry_admin;

-- ----------------------------------------------------------------------------
-- Every payment, with the farm and the invoice it produced
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
    e.full_name           AS created_by_name
FROM payment p
JOIN farm f            ON f.id = p.farm_id
LEFT JOIN invoice i    ON i.farm_id = p.farm_id
                      AND i.gateway_payment_id = p.gateway_payment_id
LEFT JOIN employee e   ON e.id = p.created_by;

ALTER VIEW v_admin_payment SET (security_invoker = true);
REVOKE ALL ON v_admin_payment FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Webhook health
--
-- The payload is kept whole (0026) because when a farmer says they paid and the
-- app disagrees, this is the only place with both sides. This view pulls the
-- two ids out of it so a stuck delivery can be matched to a payment row without
-- reading JSON by hand at two in the morning.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_webhook AS
SELECT
    w.id,
    w.gateway,
    w.event,
    w.farm_id,
    f.name AS farm_name,
    w.received_at,
    w.processed_at,
    w.result,
    (w.result LIKE 'error:%') AS errored,
    -- Text, not int. A payload we did not write is not a payload we get to
    -- assume the shape of, and a cast that throws would take the whole view out.
    w.payload #>> '{payload,payment_link,entity,id}'     AS link_id,
    w.payload #>> '{payload,payment,entity,id}'          AS payment_id,
    w.payload #>> '{payload,payment_link,entity,amount}' AS amount_text
FROM webhook_event w
LEFT JOIN farm f ON f.id = w.farm_id;

ALTER VIEW v_admin_webhook SET (security_invoker = true);
REVOKE ALL ON v_admin_webhook FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Money that has gone wrong
--
-- The list this whole screen exists for. One row per thing a person has to do
-- something about, worst first, each naming the farm so the next click is
-- obvious.
--
-- Severity 1 is reserved for "we have their money and they cannot use the
-- product". Nothing else on this list costs a customer.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_billing_exception AS

-- Paid, and still locked out. Either the period was never extended or something
-- moved it back afterwards. Either way the farmer is staring at a renew button
-- they have already paid.
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

UNION ALL

-- Paid with no invoice. The subscription moved, so the farmer is fine — the GST
-- return is not, and a missing number in a consecutive series is a question
-- from an auditor.
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

-- A delivery that threw, or one that was accepted and never finished. Five
-- minutes is generous for a handler that does two statements; past that it did
-- not finish, and Razorpay has already stopped retrying if we answered 4xx.
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

-- Somebody paid a link we have no payment row for. Rare, and it means money
-- arrived that this system cannot attribute to a farm.
SELECT
    'unattributed_payment', 1, NULL::uuid, NULL::text, w.id, w.received_at, NULL::int,
    'A payment link was paid that matches no payment of ours: '
        || COALESCE(w.payload #>> '{payload,payment_link,entity,id}', 'unknown link')
FROM webhook_event w
WHERE w.event = 'payment_link.paid'
  AND w.processed_at IS NOT NULL
  AND w.farm_id IS NULL

UNION ALL

-- The amount check in billing_apply_payment refusing a payment. Through a
-- Razorpay link this cannot happen, so if it ever appears somebody built a
-- payment by hand and it is worth a look.
SELECT
    'amount_mismatch', 2, p.farm_id, f.name, p.id::text, p.created_at, p.amount_paise,
    'Refused: ' || COALESCE(p.failed_reason, 'amount did not match')
FROM payment p
JOIN farm f ON f.id = p.farm_id
WHERE p.status = 'failed'
  AND p.failed_reason LIKE 'expected %'

UNION ALL

-- A link made and never paid, after it has expired. Not a fault — it is the
-- normal shape of an abandoned checkout — but a farm with three of these is a
-- farm that is trying to pay and cannot, which is worth a phone call.
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
-- Who to talk to this week
--
-- Trials about to end and subscriptions about to lapse are the same job — a
-- conversation before the money stops — so they are one list with a kind column
-- rather than two tables nobody reads.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_renewal_due AS
SELECT
    s.farm_id,
    f.name                                AS farm_name,
    ent.status,
    ent.access,
    CASE WHEN ent.status = 'trialing' THEN 'trial_ending' ELSE 'renewal_due' END AS kind,
    COALESCE(s.current_period_end, s.trial_ends_on) AS due_on,
    (COALESCE(s.current_period_end, s.trial_ends_on) - current_date)::int AS days_left,
    s.billing_period,
    CASE s.billing_period
        WHEN 'monthly' THEN r.monthly_paise
        ELSE r.yearly_paise
    END                                   AS renewal_paise,
    r.is_grandfathered,
    owner.full_name                       AS owner_name,
    owner.email::text                     AS owner_email,
    owner.phone                           AS owner_phone,
    ov.days_since_activity,
    EXISTS (SELECT 1 FROM payment p
             WHERE p.farm_id = s.farm_id AND p.status = 'created'
               AND p.created_at > now() - interval '24 hours') AS has_open_link
FROM subscription s
JOIN farm f                      ON f.id = s.farm_id
JOIN v_farm_entitlement ent      ON ent.farm_id = s.farm_id
JOIN v_farm_renewal_price r      ON r.farm_id = s.farm_id
JOIN v_admin_farm_overview ov    ON ov.farm_id = s.farm_id
LEFT JOIN LATERAL (
    SELECT full_name, email, phone FROM employee
     WHERE farm_id = s.farm_id AND role = 'owner' AND is_active
     ORDER BY created_at LIMIT 1
) owner ON true
WHERE s.status <> 'cancelled'
  AND COALESCE(s.current_period_end, s.trial_ends_on) IS NOT NULL
  -- Ending within a fortnight, or ended within the last two months. Older than
  -- that is not a renewal conversation any more, it is a churned farm.
  AND COALESCE(s.current_period_end, s.trial_ends_on)
      BETWEEN current_date - 60 AND current_date + 14;

ALTER VIEW v_admin_renewal_due SET (security_invoker = true);
REVOKE ALL ON v_admin_renewal_due FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- What the GST return needs
--
-- Per financial year, because that is the unit an Indian return is filed
-- against, and with the first and last invoice number so the consecutiveness
-- GST requires can be checked at a glance against the count.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_invoice_fy AS
SELECT
    indian_financial_year(i.issued_on) AS financial_year,
    count(*)::int                      AS invoices,
    sum(i.subtotal_paise)::bigint      AS taxable_paise,
    sum(i.tax_paise)::bigint           AS tax_paise,
    sum(i.total_paise)::bigint         AS total_paise,
    min(i.number)                      AS first_number,
    max(i.number)                      AS last_number
FROM invoice i
WHERE i.status = 'paid'
GROUP BY 1;

ALTER VIEW v_admin_invoice_fy SET (security_invoker = true);
REVOKE ALL ON v_admin_invoice_fy FROM rabbitry_app;

-- Twelve months of collections, for the shape of the line rather than the
-- number. Months with no money still appear, because a gap that is drawn is a
-- gap somebody notices.
CREATE OR REPLACE VIEW v_admin_revenue_month AS
SELECT
    m.month::date                                   AS month,
    count(i.id)::int                                AS invoices,
    COALESCE(sum(i.total_paise), 0)::bigint         AS total_paise,
    COALESCE(sum(i.tax_paise), 0)::bigint           AS tax_paise
FROM generate_series(date_trunc('month', current_date) - interval '11 months',
                     date_trunc('month', current_date), interval '1 month') m(month)
LEFT JOIN invoice i ON i.status = 'paid'
                   AND date_trunc('month', i.issued_on) = m.month
GROUP BY 1;

ALTER VIEW v_admin_revenue_month SET (security_invoker = true);
REVOKE ALL ON v_admin_revenue_month FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- The cards at the top
--
-- Collected, not billed: money that has actually arrived. MRR lives in
-- v_admin_revenue_summary and stays there — it is a forward-looking number
-- about subscriptions, and mixing it with cash received is how a dashboard ends
-- up with two different "revenue" figures that disagree.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_billing_summary AS
SELECT
    (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM payment
      WHERE status = 'paid' AND paid_at >= date_trunc('month', now()))
        AS collected_month_paise,
    (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM payment
      WHERE status = 'paid'
        AND paid_at >= indian_financial_year_start(current_date))
        AS collected_fy_paise,
    (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM payment WHERE status = 'paid')
        AS collected_total_paise,
    (SELECT count(*)::int FROM payment
      WHERE status = 'paid' AND paid_at >= date_trunc('month', now()))
        AS payments_month,
    (SELECT COALESCE(sum(tax_paise), 0)::bigint FROM invoice
      WHERE status = 'paid' AND issued_on >= indian_financial_year_start(current_date))
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
        AS locked_out;

ALTER VIEW v_admin_billing_summary SET (security_invoker = true);
REVOKE ALL ON v_admin_billing_summary FROM rabbitry_app;
