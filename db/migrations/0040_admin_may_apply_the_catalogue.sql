-- ============================================================================
-- The admin console could not run the function it exists to run
--
-- Migration 0037 ends with
--
--     REVOKE ALL ON FUNCTION apply_condition_catalog(uuid) FROM PUBLIC;
--
-- and then never grants it back to anybody. The function is SECURITY DEFINER
-- and owned by the database owner, so the owner kept EXECUTE and no one else
-- had it. The API connects as admin_login (a member of rabbitry_admin), and
-- the admin console calls this function straight from Node:
--
--     SELECT apply_condition_catalog(id) FROM farm
--
-- so "Add & apply to every farm" failed with a permission error, surfaced to
-- the browser as the generic "Something went wrong on our side".
--
-- The failure is worse than a refusal, because the two writes are not in one
-- transaction. The INSERT into condition_catalog commits, and only the apply
-- step dies — leaving the sickness in the master catalogue but pressed onto no
-- farm, which reads on screen as "nothing happened" while the next attempt
-- takes the ON CONFLICT branch. Any catalogue row added before this migration
-- needs re-applying once; the console does that on its next successful save,
-- and the backfill at the bottom of this file does it now.
--
-- Not caught by the tests because they connect as the database superuser,
-- which bypasses privilege checks entirely. seed_new_farm and
-- seed_medication_protocols are deliberately NOT granted: nothing calls them
-- from Node, only PERFORM from inside other SECURITY DEFINER functions, where
-- they run as the definer and need no grant of their own.
-- ============================================================================

GRANT EXECUTE ON FUNCTION apply_condition_catalog(uuid) TO rabbitry_admin;

-- Press the catalogue onto every farm once, to repair anything added while the
-- grant was missing. Idempotent: the function is all ON CONFLICT DO UPDATE.
SELECT apply_condition_catalog(id) FROM farm;
