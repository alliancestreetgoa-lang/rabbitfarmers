-- ============================================================================
-- Email, and the four of them a farm ever gets
--
-- Nothing in this system has ever sent an email. That is on purpose in places —
-- signup deliberately has no verification (docs/10) and support impersonation
-- is announced in-app because there was no sender — but it leaves one real
-- hole: the farm whose year runs out finds out by opening the app, and the farm
-- that stopped opening the app does not find out at all. That is precisely the
-- customer worth an email.
--
-- docs/09 is blunt about the economics: "at ₹99, a failed monthly mandate costs
-- more in dunning, SMS and support time than the ₹99 it is chasing." So this is
-- deliberately not a dunning *campaign*. It is four messages, each tied to an
-- event that has actually happened, each sent exactly once:
--
--   renewal_due        a week before the money is due
--   renewal_last_call  the day it is due
--   subscription_lapsed the day the farm actually goes read-only
--   payment_received   the receipt, with the invoice number
--
-- The fourth is not chasing anything and belongs anyway: a sequence that nags
-- twice and never says "thank you, you are paid up" reads as a debt collector.
--
-- Two things this shares with everything else here. Nothing is sent twice,
-- because the dedupe key is the event and not the moment. And nothing that has
-- gone wrong is invisible: a bounce suppresses the address rather than being
-- retried into a spam folder for a fortnight, and a queue that stops draining
-- shows up on the billing screen.
--
-- What is NOT here: marketing, digests, and anything a farmer would want to
-- unsubscribe from. Every message below is transactional — it exists because
-- something happened to money that belongs to the person reading it.
-- ============================================================================

CREATE TYPE email_status_t AS ENUM
    ('queued', 'sent', 'failed', 'suppressed', 'expired');

CREATE TYPE email_kind_t AS ENUM
    ('renewal_due', 'renewal_last_call', 'subscription_lapsed', 'payment_received');

-- ----------------------------------------------------------------------------
-- The outbox
--
-- Rows are queued by SQL and rendered by JavaScript at send time. The split is
-- deliberate: deciding WHO gets an email and WHEN is set-based work over every
-- farm, and writing the sentence is not something to do in string concatenation
-- inside a plpgsql function. `context` carries the numbers the template needs
-- so the send does not have to re-derive them — and so an email says what was
-- true when the event happened rather than what is true now.
-- ----------------------------------------------------------------------------
CREATE TABLE email_message (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id       uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    -- Who it was addressed to, snapshotted. An owner who changes their email
    -- next month must not make last month's record say something untrue.
    to_email      citext NOT NULL,
    to_name       text,
    kind          email_kind_t NOT NULL,
    context       jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Deterministic, and the whole reason a scheduler that runs every fifteen
    -- minutes does not send ninety-six copies of the same warning.
    dedupe_key    text UNIQUE NOT NULL,

    status        email_status_t NOT NULL DEFAULT 'queued',
    attempts      int NOT NULL DEFAULT 0,
    -- Backoff. A provider having a bad ten minutes should not burn the five
    -- attempts this row is allowed.
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error    text,

    -- Filled in when it actually goes, so the record shows what was said rather
    -- than what today's template would say.
    subject       text,
    body_text     text,
    provider      text,
    provider_message_id text,

    created_at    timestamptz NOT NULL DEFAULT now(),
    sent_at       timestamptz
);

CREATE INDEX email_message_farm_idx  ON email_message (farm_id, created_at DESC);
CREATE INDEX email_message_queue_idx ON email_message (next_attempt_at)
    WHERE status = 'queued';

ALTER TABLE email_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_message FORCE ROW LEVEL SECURITY;
CREATE POLICY email_message_tenant ON email_message
    USING (farm_id = current_farm_id())
    WITH CHECK (farm_id = current_farm_id());

-- The farm may read what was sent to it — "you were emailed on the 3rd" is the
-- answer to a support call — and writes none of it.
GRANT SELECT ON email_message TO rabbitry_app;
GRANT SELECT, INSERT, UPDATE ON email_message TO rabbitry_admin;
REVOKE INSERT, UPDATE, DELETE ON email_message FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Addresses we must stop writing to
--
-- A hard bounce is a dead mailbox and a complaint is somebody pressing "this is
-- spam". Sending to either again is how a sending domain's reputation goes, and
-- when that goes it takes the receipts and the lapse notices with it — the mail
-- that actually matters. So this list is checked before every send and there is
-- no override in the send path.
--
-- Platform-level: an address is dead everywhere, not per farm. Revoked from the
-- farmer-facing role entirely rather than scoped by a policy, like
-- invoice_series and credit_note_series.
-- ----------------------------------------------------------------------------
CREATE TABLE email_suppression (
    address     citext PRIMARY KEY,
    reason      text NOT NULL,
    -- 'bounce', 'complaint', 'manual'. Text rather than an enum because the
    -- provider's own vocabulary lands here and enums are a migration to add to.
    source      text NOT NULL DEFAULT 'bounce',
    detail      text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON email_suppression TO rabbitry_admin;
REVOKE ALL ON email_suppression FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Queueing the four
--
-- Every one of these fires off the same arithmetic the in-app notice does
-- (migration 0029), so the email and the notification cannot disagree about
-- when a farm is lapsing. The dedupe keys carry the date being warned about, so
-- a farm that renews gets a fresh warning next year and never a repeat of this
-- one.
--
-- An address that has bounced is skipped at queue time as well as at send time.
-- Queueing mail that can never go makes a failure list nobody can act on.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_dunning_emails() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    n int := 0;
    step int;
BEGIN
    -- 1. A week before the money is due. Not before that: a farmer told a month
    --    ahead files it and forgets, and we have to tell them again anyway.
    INSERT INTO email_message (farm_id, to_email, to_name, kind, context, dedupe_key)
    SELECT d.farm_id, d.owner_email, d.owner_name, 'renewal_due',
           jsonb_build_object(
               'farm_name', d.farm_name,
               'due_on', d.due_on,
               'days_left', d.days_to_due,
               'amount_paise', d.effective_price_paise,
               'billing_period', d.billing_period,
               'covered_until', d.covered_until,
               'is_trial', d.status = 'trialing'),
           'email:renewal:' || d.farm_id || ':' || d.due_on
    FROM v_admin_lapsing d
    WHERE d.owner_email IS NOT NULL
      AND d.days_to_due BETWEEN 1 AND 7
      AND d.access = 'full'
      AND NOT EXISTS (SELECT 1 FROM email_suppression s WHERE s.address = d.owner_email)
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 2. The day it is due. This is the one that gets opened, so it is the one
    --    that carries what happens next: nothing, for another week or month,
    --    and then read-only.
    INSERT INTO email_message (farm_id, to_email, to_name, kind, context, dedupe_key)
    SELECT d.farm_id, d.owner_email, d.owner_name, 'renewal_last_call',
           jsonb_build_object(
               'farm_name', d.farm_name,
               'due_on', d.due_on,
               'amount_paise', d.effective_price_paise,
               'billing_period', d.billing_period,
               'covered_until', d.covered_until,
               'grace_days', d.covered_days_left,
               'is_trial', d.status = 'trialing'),
           'email:lastcall:' || d.farm_id || ':' || d.due_on
    FROM v_admin_lapsing d
    WHERE d.owner_email IS NOT NULL
      -- On the day, with a couple of days of tolerance for a pass that did not
      -- run. The key is the due date, so late still means once.
      AND d.days_to_due BETWEEN -2 AND 0
      AND d.access = 'full'
      AND NOT EXISTS (SELECT 1 FROM email_suppression s WHERE s.address = d.owner_email)
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 3. It has happened. Same week-wide window as the in-app notice and for the
    --    same reason: the pass can be down, and a lapse nobody was told about is
    --    the support call all of this exists to prevent.
    INSERT INTO email_message (farm_id, to_email, to_name, kind, context, dedupe_key)
    SELECT d.farm_id, d.owner_email, d.owner_name, 'subscription_lapsed',
           jsonb_build_object(
               'farm_name', d.farm_name,
               'covered_until', d.covered_until,
               'amount_paise', d.effective_price_paise,
               'billing_period', d.billing_period,
               'is_trial', d.status = 'trialing'),
           'email:lapsed:' || d.farm_id || ':' || d.covered_until
    FROM v_admin_lapsing d
    WHERE d.owner_email IS NOT NULL
      AND d.access = 'read_only'
      AND d.covered_until >= current_date - 7
      AND NOT EXISTS (SELECT 1 FROM email_suppression s WHERE s.address = d.owner_email)
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    -- 4. The receipt. Keyed on the invoice number, which is unique by
    --    construction, so a farm gets exactly one per payment however many
    --    times this runs — and the GST invoice number is in the farmer's inbox
    --    where their accountant can find it.
    INSERT INTO email_message (farm_id, to_email, to_name, kind, context, dedupe_key)
    SELECT i.farm_id, owner.email, owner.full_name, 'payment_received',
           jsonb_build_object(
               'farm_name', f.name,
               'invoice_number', i.number,
               'total_paise', i.total_paise,
               'subtotal_paise', i.subtotal_paise,
               'tax_paise', i.tax_paise,
               'period_start', i.period_start,
               'period_end', i.period_end,
               'paid_at', i.paid_at),
           'email:receipt:' || i.number
    FROM invoice i
    JOIN farm f ON f.id = i.farm_id
    CROSS JOIN LATERAL (
        SELECT e.email, e.full_name FROM employee e
         WHERE e.farm_id = i.farm_id AND e.role = 'owner' AND e.is_active
         ORDER BY e.created_at LIMIT 1
    ) owner
    WHERE i.status = 'paid'
      AND i.paid_at > now() - interval '3 days'
      AND owner.email IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM email_suppression s WHERE s.address = owner.email)
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;

    RETURN n;
END $$;

REVOKE ALL ON FUNCTION generate_dunning_emails() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generate_dunning_emails() TO rabbitry_admin;

-- ----------------------------------------------------------------------------
-- What the sender reads, and what it writes back
-- ----------------------------------------------------------------------------

/*
 * Due to go out.
 *
 * Suppression is checked here as well as at queue time, because an address can
 * bounce between the two — and the whole point of a suppression list is that
 * there is no path around it.
 */
CREATE OR REPLACE VIEW v_email_queue AS
SELECT m.id, m.farm_id, m.to_email::text AS to_email, m.to_name,
       m.kind::text AS kind, m.context, m.attempts, m.created_at
FROM email_message m
WHERE m.status = 'queued'
  AND m.next_attempt_at <= now()
  AND NOT EXISTS (SELECT 1 FROM email_suppression s WHERE s.address = m.to_email);

ALTER VIEW v_email_queue SET (security_invoker = true);
REVOKE ALL ON v_email_queue FROM rabbitry_app;

/** It went. */
CREATE OR REPLACE FUNCTION email_record_sent(
    p_id uuid, p_subject text, p_body text, p_provider text, p_message_id text)
RETURNS boolean LANGUAGE sql AS $$
    UPDATE email_message
       SET status = 'sent', sent_at = now(), attempts = attempts + 1,
           subject = p_subject, body_text = p_body,
           provider = p_provider, provider_message_id = p_message_id,
           last_error = NULL
     WHERE id = p_id AND status = 'queued'
    RETURNING true;
$$;

/**
 * It did not.
 *
 * `p_permanent` is the difference between a provider having a bad minute and an
 * address that will never accept mail. A temporary failure earns a longer wait
 * each time — one minute, four, nine, sixteen — and gives up after five, which
 * is about half an hour. Past that the message is stale anyway.
 */
CREATE OR REPLACE FUNCTION email_record_failure(
    p_id uuid, p_error text, p_permanent boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
    v_attempts int;
BEGIN
    UPDATE email_message
       SET attempts = attempts + 1,
           last_error = left(COALESCE(p_error, 'send failed'), 500),
           next_attempt_at = now() + make_interval(mins => power(attempts + 1, 2)::int),
           status = (CASE WHEN p_permanent OR attempts + 1 >= 5 THEN 'failed'
                          ELSE 'queued' END)::email_status_t
     WHERE id = p_id
    RETURNING attempts INTO v_attempts;
    RETURN v_attempts IS NOT NULL;
END $$;

/**
 * Mail too old to be worth sending.
 *
 * A renewal warning that arrives a week after the renewal is worse than
 * silence: it tells a farmer who has already paid that they are about to be cut
 * off. Anything still queued after three days is dropped, visibly, rather than
 * arriving late.
 */
CREATE OR REPLACE FUNCTION email_expire_stale(p_days int DEFAULT 3) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    UPDATE email_message
       SET status = 'expired',
           last_error = COALESCE(last_error, 'never sent — too old to be true any more')
     WHERE status = 'queued'
       AND created_at < now() - make_interval(days => p_days);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

/**
 * Stop writing to this address, and abandon anything already queued for it.
 *
 * Both halves matter. Suppressing without cancelling the queue leaves messages
 * that the queue view filters out for ever, which reads as a stuck queue.
 */
CREATE OR REPLACE FUNCTION email_suppress(
    p_address text, p_reason text, p_source text DEFAULT 'bounce', p_detail text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    INSERT INTO email_suppression (address, reason, source, detail)
    VALUES (p_address::citext, p_reason, p_source, p_detail)
    ON CONFLICT (address) DO UPDATE
        SET reason = EXCLUDED.reason, source = EXCLUDED.source, detail = EXCLUDED.detail;

    UPDATE email_message
       SET status = 'suppressed',
           last_error = 'address suppressed: ' || p_reason
     WHERE to_email = p_address::citext AND status = 'queued';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

REVOKE ALL ON FUNCTION email_record_sent(uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION email_record_failure(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION email_expire_stale(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION email_suppress(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION email_record_sent(uuid, text, text, text, text) TO rabbitry_admin;
GRANT EXECUTE ON FUNCTION email_record_failure(uuid, text, boolean) TO rabbitry_admin;
GRANT EXECUTE ON FUNCTION email_expire_stale(int) TO rabbitry_admin;
GRANT EXECUTE ON FUNCTION email_suppress(text, text, text, text) TO rabbitry_admin;

-- ----------------------------------------------------------------------------
-- The console
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_email AS
SELECT
    m.id, m.farm_id, f.name AS farm_name,
    m.to_email::text AS to_email, m.to_name,
    m.kind::text AS kind, m.status::text AS status,
    m.subject, m.attempts, m.last_error,
    m.provider, m.provider_message_id,
    m.created_at, m.sent_at, m.next_attempt_at,
    (s.address IS NOT NULL) AS address_suppressed
FROM email_message m
JOIN farm f ON f.id = m.farm_id
LEFT JOIN email_suppression s ON s.address = m.to_email;

ALTER VIEW v_admin_email SET (security_invoker = true);
REVOKE ALL ON v_admin_email FROM rabbitry_app;

CREATE OR REPLACE VIEW v_admin_email_health AS
SELECT
    (SELECT count(*)::int FROM email_message WHERE status = 'queued')   AS queued,
    (SELECT count(*)::int FROM email_message
      WHERE status = 'sent' AND sent_at > now() - interval '7 days')    AS sent_7d,
    (SELECT count(*)::int FROM email_message
      WHERE status = 'failed' AND created_at > now() - interval '7 days') AS failed_7d,
    (SELECT count(*)::int FROM email_message
      WHERE status = 'expired' AND created_at > now() - interval '7 days') AS expired_7d,
    (SELECT count(*)::int FROM email_suppression)                       AS suppressed,
    -- The number that says the queue has stopped draining rather than being
    -- momentarily busy.
    (SELECT count(*)::int FROM email_message
      WHERE status = 'queued' AND created_at < now() - interval '1 hour') AS stuck;

ALTER VIEW v_admin_email_health SET (security_invoker = true);
REVOKE ALL ON v_admin_email_health FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Mail that has gone wrong, on the same list as money that has gone wrong
--
-- Appended to v_admin_billing_exception rather than given its own screen: the
-- person who cares that a receipt bounced is the person already looking at the
-- payment it was a receipt for.
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

SELECT
    'refund_failed', 1, r.farm_id, f.name, r.id::text, r.created_at, r.amount_paise,
    'Refund failed: ' || COALESCE(r.failed_reason, 'no reason given')
FROM refund r
JOIN farm f ON f.id = r.farm_id
WHERE r.status = 'failed'

UNION ALL

SELECT
    'refund_stuck', 2, r.farm_id, f.name, r.id::text, r.created_at, r.amount_paise,
    'Refund asked for ' || (current_date - r.created_at::date)
        || ' days ago and still not settled'
FROM refund r
JOIN farm f ON f.id = r.farm_id
WHERE r.status = 'created'
  AND r.created_at < now() - interval '10 days'

UNION ALL

-- A receipt or a lapse notice that never arrived. The farm does not know what
-- we think they know, which is how a support call starts with both sides sure
-- they are right.
SELECT
    'email_failed', 2, m.farm_id, f.name, m.id::text, m.created_at, NULL::int,
    CASE m.status
        WHEN 'expired' THEN 'A ' || m.kind || ' email was never sent and is now too old to send'
        ELSE 'A ' || m.kind || ' email to ' || m.to_email || ' failed: '
             || COALESCE(m.last_error, 'no reason given')
    END
FROM email_message m
JOIN farm f ON f.id = m.farm_id
WHERE m.status IN ('failed', 'expired')
  AND m.created_at > now() - interval '30 days'

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
