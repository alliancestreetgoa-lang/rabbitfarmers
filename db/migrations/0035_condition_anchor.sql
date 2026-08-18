-- ============================================================================
-- 0035  A fifth thing a medicine course can hang from: a reported sickness
--
-- Every protocol so far anchors on a breeding event. The farm's actual first
-- question — "she has loose motion, what do I give her and for how long" —
-- needs a course that starts the day the condition is reported and stops
-- nagging the moment it is marked stopped.
--
-- Only the enum value lives here: Postgres refuses to use a new enum value in
-- the transaction that created it, and each migration runs in its own
-- transaction. 0036 does the wiring.
-- ============================================================================

ALTER TYPE protocol_anchor_t ADD VALUE IF NOT EXISTS 'condition';
