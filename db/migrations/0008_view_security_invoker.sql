-- ============================================================================
-- Make views respect the caller's row-level security
--
-- A Postgres view runs with the privileges of the view's OWNER, not the caller.
-- Because these views are owned by the migration role, RLS on the underlying
-- tables was being evaluated against that owner — so every view was a hole
-- straight through tenant isolation.
--
-- Concretely: SELECT * FROM v_pregnancy_summary returned every farm's pregnant
-- does, to any signed-in farmer. Querying `rabbit` directly was correctly
-- filtered, which is exactly why this hid so well — the isolation tests that
-- hit tables passed while the ones that hit views did not.
--
-- security_invoker = true (PostgreSQL 15+) makes the view evaluate as the
-- caller, so the caller's policies apply. Neon runs 15 or newer.
--
-- The rule this leaves behind: every new view needs this flag. The test
-- "every view runs as its caller" in apps/api/test/isolation.test.js fails the
-- build if one is added without it.
-- ============================================================================

DO $$
DECLARE v record;
BEGIN
    FOR v IN
        SELECT schemaname, viewname FROM pg_views WHERE schemaname = 'public'
    LOOP
        EXECUTE format('ALTER VIEW %I.%I SET (security_invoker = true)',
                       v.schemaname, v.viewname);
    END LOOP;
END $$;

-- ============================================================================
-- "Who did this" references should never block a delete
--
-- recorded_by / checked_by / created_by and friends are audit breadcrumbs. When
-- a farm is deleted its employees cascade away, and these references were then
-- refusing the delete. An employee leaving must not make a record undeletable
-- either — losing the name is acceptable, wedging the row is not.
-- ============================================================================

ALTER TABLE rabbit            DROP CONSTRAINT rabbit_created_by_fkey;
ALTER TABLE rabbit            ADD  CONSTRAINT rabbit_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE mating            DROP CONSTRAINT mating_recorded_by_fkey;
ALTER TABLE mating            ADD  CONSTRAINT mating_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE pregnancy_check   DROP CONSTRAINT pregnancy_check_checked_by_fkey;
ALTER TABLE pregnancy_check   ADD  CONSTRAINT pregnancy_check_checked_by_fkey
    FOREIGN KEY (checked_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE litter            DROP CONSTRAINT litter_recorded_by_fkey;
ALTER TABLE litter            ADD  CONSTRAINT litter_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE receptivity_check DROP CONSTRAINT receptivity_check_checked_by_fkey;
ALTER TABLE receptivity_check ADD  CONSTRAINT receptivity_check_checked_by_fkey
    FOREIGN KEY (checked_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE health_event      DROP CONSTRAINT health_event_recorded_by_fkey;
ALTER TABLE health_event      ADD  CONSTRAINT health_event_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE health_condition  DROP CONSTRAINT health_condition_reported_by_fkey;
ALTER TABLE health_condition  ADD  CONSTRAINT health_condition_reported_by_fkey
    FOREIGN KEY (reported_by) REFERENCES employee(id) ON DELETE SET NULL;
ALTER TABLE health_condition  DROP CONSTRAINT health_condition_resolved_by_fkey;
ALTER TABLE health_condition  ADD  CONSTRAINT health_condition_resolved_by_fkey
    FOREIGN KEY (resolved_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE condition_check   DROP CONSTRAINT condition_check_checked_by_fkey;
ALTER TABLE condition_check   ADD  CONSTRAINT condition_check_checked_by_fkey
    FOREIGN KEY (checked_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE weight_record     DROP CONSTRAINT weight_record_recorded_by_fkey;
ALTER TABLE weight_record     ADD  CONSTRAINT weight_record_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE movement          DROP CONSTRAINT movement_recorded_by_fkey;
ALTER TABLE movement          ADD  CONSTRAINT movement_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE attendance        DROP CONSTRAINT attendance_recorded_by_fkey;
ALTER TABLE attendance        ADD  CONSTRAINT attendance_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE task              DROP CONSTRAINT task_completed_by_fkey;
ALTER TABLE task              ADD  CONSTRAINT task_completed_by_fkey
    FOREIGN KEY (completed_by) REFERENCES employee(id) ON DELETE SET NULL;
