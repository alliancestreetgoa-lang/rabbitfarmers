-- ============================================================================
-- Push delivery
--
-- The scheduler has been raising notifications since migration 0010 and the API
-- has been serving them, and nothing has ever reached a phone. `sent_at` has
-- been NULL on every row ever written. A farmer sees a reminder by opening the
-- app, which is why the app opens on Today rather than a dashboard — but a
-- reminder you have to go looking for is a calendar, not a reminder.
--
-- Three things decide whether this is trustworthy rather than annoying:
--
--   * it must not deliver the same thing twice, ever — one duplicate buzz and
--     people start ignoring the next one
--   * it must not buzz at 02:00 for a rebreed that can wait until six
--   * it must not deliver a backlog. A phone that comes back after a week must
--     not get two hundred alerts about rabbits already dealt with, and a phone
--     registered today must not receive yesterday's news at all.
--
-- All three are properties of the queue, not of the sender, so they live here.
-- ============================================================================

CREATE TYPE push_platform_t AS ENUM ('android', 'ios', 'web');

CREATE TABLE push_device (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id      uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    employee_id  uuid NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    -- ExponentPushToken[…] today. Whatever the provider hands back; this table
    -- deliberately does not care which provider it came from.
    token        text NOT NULL UNIQUE,
    platform     push_platform_t NOT NULL,
    device_name  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),

    -- Delivery health. A token that has been uninstalled keeps accepting sends
    -- and silently discarding them, so the provider's word is the only way to
    -- know, and it usually arrives on the receipt rather than the send.
    failures        int NOT NULL DEFAULT 0,
    disabled_at     timestamptz,
    disabled_reason text
);

CREATE INDEX push_device_farm_idx ON push_device (farm_id) WHERE disabled_at IS NULL;

-- Same-farm guarantee as every other cross-table key since 0007: a device
-- cannot belong to one farm and point at another farm's employee.
ALTER TABLE push_device DROP CONSTRAINT push_device_employee_id_fkey;
ALTER TABLE push_device ADD CONSTRAINT push_device_employee_same_farm
    FOREIGN KEY (farm_id, employee_id) REFERENCES employee (farm_id, id) ON DELETE CASCADE;

ALTER TABLE push_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_device FORCE ROW LEVEL SECURITY;
CREATE POLICY push_device_tenant ON push_device
    USING (farm_id = current_farm_id())
    WITH CHECK (farm_id = current_farm_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON push_device TO rabbitry_app, rabbitry_admin;

-- ----------------------------------------------------------------------------
-- One row per notification per device.
--
-- This table is what makes "never twice" true. Marking the notification itself
-- sent would be wrong the moment somebody has two phones: the first device's
-- delivery would mark the whole row done and the second would never hear.
--
-- It is also the retry story. A send that fails halfway leaves the rows it
-- managed, so the next pass picks up exactly what is missing rather than
-- re-sending everything.
-- ----------------------------------------------------------------------------
CREATE TABLE notification_delivery (
    notification_id uuid NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
    device_id       uuid NOT NULL REFERENCES push_device(id) ON DELETE CASCADE,
    sent_at         timestamptz NOT NULL DEFAULT now(),
    -- The provider's handle for asking, later, whether it actually arrived.
    receipt_id      text,
    status          text NOT NULL DEFAULT 'sent',   -- sent | delivered | failed
    error           text,
    PRIMARY KEY (notification_id, device_id)
);

CREATE INDEX notification_delivery_receipt_idx
    ON notification_delivery (receipt_id) WHERE status = 'sent' AND receipt_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_delivery TO rabbitry_admin;
-- The farmer-facing role has no business here: delivery is platform plumbing
-- driven by the scheduler, which connects as the admin role.
REVOKE ALL ON notification_delivery FROM rabbitry_app;

/*
 * And a policy on top of that revoke.
 *
 * The revoke is the wall; this is the belt. There is no farm_id on the row —
 * it is a join table — but there is a clean path to one through the
 * notification, so scoping it costs a subquery and buys the guarantee that the
 * day somebody grants this table to the app role for a reporting screen, the
 * scoping is already right instead of being remembered.
 *
 * The isolation suite's "every tenant table is covered" test is what asked for
 * this. The alternative was adding the table to that test's exemption list,
 * which is a decision the list explicitly asks to be made on purpose — and a
 * table with a real tenant path does not qualify.
 */
ALTER TABLE notification_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_delivery_tenant ON notification_delivery
    USING (EXISTS (SELECT 1 FROM notification n
                   WHERE n.id = notification_delivery.notification_id
                     AND n.farm_id = current_farm_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM notification n
                   WHERE n.id = notification_delivery.notification_id
                     AND n.farm_id = current_farm_id()));

-- ----------------------------------------------------------------------------
-- What is waiting to go out.
--
-- Not farm-scoped: the dispatcher runs across every farm in one pass, the same
-- way generation does, and connects as the role that bypasses RLS.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_push_queue AS
SELECT
    n.id        AS notification_id,
    n.farm_id,
    n.kind,
    n.title,
    n.body,
    n.urgency,
    n.rabbit_id,
    n.created_at,
    d.id        AS device_id,
    d.token,
    d.platform,
    d.employee_id
FROM notification n
JOIN push_device d
  ON d.farm_id = n.farm_id
 -- NULL means everyone at the farm — used when no caretaker owns the shed, so
 -- the work cannot fall down a gap. See migration 0010.
 AND (n.employee_id IS NULL OR n.employee_id = d.employee_id)
 AND d.disabled_at IS NULL
LEFT JOIN notification_delivery nd
  ON nd.notification_id = n.id AND nd.device_id = d.id
WHERE nd.notification_id IS NULL
  -- Never a backlog. Both halves matter: the first stops a phone that has been
  -- off for a week getting a week of alerts, the second stops a phone
  -- registered this morning getting yesterday's.
  AND n.created_at > now() - interval '12 hours'
  AND n.created_at >= d.created_at
  -- Quiet hours hold everything except an emergency. The farm's own hours, in
  -- the farm's own timezone — and the held rows simply reappear here when the
  -- window lifts, which is the "catch-up at quiet_hours_end" the settings table
  -- has promised since migration 0001.
  AND (n.urgency = 'critical' OR NOT farm_is_quiet(n.farm_id));

ALTER VIEW v_push_queue SET (security_invoker = true);
REVOKE ALL ON v_push_queue FROM rabbitry_app;

-- ----------------------------------------------------------------------------
-- Recording what happened
-- ----------------------------------------------------------------------------

/**
 * Mark one notification delivered to one device.
 *
 * Also stamps notification.sent_at the first time anything gets through, which
 * is what the column has always meant and what the API reports.
 */
CREATE OR REPLACE FUNCTION push_record_sent(
    p_notification uuid, p_device uuid, p_receipt text)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO notification_delivery (notification_id, device_id, receipt_id)
    VALUES (p_notification, p_device, p_receipt)
    ON CONFLICT (notification_id, device_id) DO NOTHING;

    UPDATE notification SET sent_at = COALESCE(sent_at, now())
     WHERE id = p_notification;

    UPDATE push_device
       SET failures = 0, last_seen_at = now()
     WHERE id = p_device;
END $$;

/**
 * A send that did not work.
 *
 * `p_permanent` is the provider saying the app is gone from that phone — an
 * uninstall, or a token replaced. There is no point retrying that, ever, and a
 * dead token left enabled means every future pass wastes a slot on it.
 *
 * Anything else is counted. Five consecutive failures is a token that is not
 * coming back; the row stays so the farm can see the device and why it stopped.
 */
CREATE OR REPLACE FUNCTION push_record_failure(
    p_device uuid, p_error text, p_permanent boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE push_device
       SET failures = CASE WHEN p_permanent THEN failures ELSE failures + 1 END,
           disabled_at = CASE
               WHEN p_permanent THEN now()
               WHEN failures + 1 >= 5 THEN now()
               ELSE disabled_at END,
           disabled_reason = CASE
               WHEN p_permanent THEN p_error
               WHEN failures + 1 >= 5 THEN 'five failures in a row: ' || COALESCE(p_error, 'unknown')
               ELSE disabled_reason END
     WHERE id = p_device;
END $$;

/** A receipt that came back bad. The notification stays; only the device dies. */
CREATE OR REPLACE FUNCTION push_record_receipt(
    p_receipt text, p_status text, p_error text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_device uuid;
BEGIN
    /*
     * Through a CTE, not `UPDATE … RETURNING INTO`.
     *
     * That form raises "query returned more than one row" the moment two
     * delivery rows share a receipt id — and a raise here does not lose one
     * receipt, it aborts the whole pass, so every other phone's receipt goes
     * unchecked too. Provider ids are unique in practice; this is about what
     * happens when that stops being true, which is not the moment to find out
     * that the recovery path takes the rest of the system with it.
     */
    WITH updated AS (
        UPDATE notification_delivery
           SET status = p_status, error = p_error
         WHERE receipt_id = p_receipt
        RETURNING device_id
    )
    SELECT device_id INTO v_device FROM updated LIMIT 1;

    RETURN v_device;
END $$;

-- What the farm can see about its own phones.
CREATE OR REPLACE VIEW v_push_device AS
SELECT d.id, d.farm_id, d.employee_id, e.full_name, d.platform, d.device_name,
       d.created_at, d.last_seen_at, d.failures,
       d.disabled_at, d.disabled_reason,
       (d.disabled_at IS NULL) AS active,
       -- Never the token itself. It is a capability: anybody holding it can
       -- push to that phone, and a support screen is not the place for one.
       right(d.token, 6) AS token_tail
FROM push_device d
JOIN employee e ON e.id = d.employee_id;

ALTER VIEW v_push_device SET (security_invoker = true);
