-- ============================================================================
-- 0044  A doe served by two or three bucks is pregnant, not "awaiting check"
--
-- The farm's practice: one doe, two or three bucks in turn. Enough services
-- that a pregnancy is taken as read — nobody palpates on day 12, and a task
-- telling them to is noise. The trade is paternity: with more than one buck
-- in the cycle nobody can say which one sired the litter, which the schema
-- has anticipated since day one (mating.paternity_certain, "false if two
-- bucks in one cycle") without ever having a way to record the second buck.
--
-- This adds the way: the bucks beyond the first, kept on the mating. The
-- rest is done in the API when the mating is recorded — a positive
-- pregnancy_check, method 'observation', written in the same transaction, so
-- v_doe_reproductive_state reads her as confirmed and generate_due_tasks()
-- raises no palpation. Kits from a paternity-uncertain litter get no sire.
-- ============================================================================

ALTER TABLE mating
    ADD COLUMN IF NOT EXISTS other_buck_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN mating.other_buck_ids IS
    'Bucks beyond buck_id that served her in this mating. Non-empty means paternity_certain is false.';

-- The one invariant worth the database's own attention.
ALTER TABLE mating DROP CONSTRAINT IF EXISTS paternity_matches_bucks;
ALTER TABLE mating ADD CONSTRAINT paternity_matches_bucks
    CHECK (cardinality(other_buck_ids) = 0 OR paternity_certain = false);
