-- ============================================================================
-- 0046  A dose can be anchored to the month
--
-- The monthly routine becomes per-rabbit doses (0047). Their anchor is the
-- first of the current month, for every rabbit in the herd. Its own file: an
-- enum value added in a transaction cannot be used by a later statement of
-- the same transaction, and each migration runs in one.
-- ============================================================================

ALTER TYPE protocol_anchor_t ADD VALUE IF NOT EXISTS 'month';
