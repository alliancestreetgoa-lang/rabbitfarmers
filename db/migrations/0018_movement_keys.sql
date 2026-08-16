-- ============================================================================
-- A cage move must not make a farm undeletable
--
-- `movement.from_cage_id` and `movement.to_cage_id` referenced cage(id) with no
-- ON DELETE action, which means RESTRICT. Deleting a farm cascades to its
-- cages, and any movement row still pointing at one of them refuses the delete.
--
-- Nothing ever wrote to movement, so nothing ever hit it. Recording cage moves
-- (the rabbit edit endpoint) made it reachable, and it showed up immediately as
-- the test cleanup failing to remove its own farms. In production it would have
-- been the superadmin delete-farm endpoint failing on exactly the farms that had
-- been used most — and an erasure request that cannot be honoured is worse than
-- an inconvenience.
--
-- ON DELETE SET NULL rather than CASCADE, deliberately: that a rabbit was moved
-- on a given day is a fact about the rabbit, and it survives the cage being
-- retired. The timeline already handles a null cage — it says "moved to another
-- cage" — because from_cage_id was always nullable for a rabbit's first
-- placement.
--
-- Same treatment for the employee who recorded it: staff leave, and the record
-- of what they did stays. This mirrors migration 0008, which did it for actor
-- columns everywhere else and did not reach movement because movement had no
-- rows to worry about.
-- ============================================================================

ALTER TABLE movement DROP CONSTRAINT movement_from_cage_id_fkey;
ALTER TABLE movement DROP CONSTRAINT movement_to_cage_id_fkey;
ALTER TABLE movement DROP CONSTRAINT movement_recorded_by_fkey;

ALTER TABLE movement ADD CONSTRAINT movement_from_cage_id_fkey
    FOREIGN KEY (from_cage_id) REFERENCES cage(id) ON DELETE SET NULL;
ALTER TABLE movement ADD CONSTRAINT movement_to_cage_id_fkey
    FOREIGN KEY (to_cage_id) REFERENCES cage(id) ON DELETE SET NULL;
ALTER TABLE movement ADD CONSTRAINT movement_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES employee(id) ON DELETE SET NULL;

-- The same trap, one table over: weight_record and receptivity_check point at
-- employee with no action, and health_event points at both employee and
-- medication_protocol. Recording an Ostovet dose writes health_event.protocol_id,
-- so deleting a farm now has to get past that one too.
ALTER TABLE weight_record DROP CONSTRAINT weight_record_recorded_by_fkey;
ALTER TABLE weight_record ADD CONSTRAINT weight_record_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE receptivity_check DROP CONSTRAINT receptivity_check_checked_by_fkey;
ALTER TABLE receptivity_check ADD CONSTRAINT receptivity_check_checked_by_fkey
    FOREIGN KEY (checked_by) REFERENCES employee(id) ON DELETE SET NULL;

ALTER TABLE health_event DROP CONSTRAINT health_event_protocol_id_fkey;
ALTER TABLE health_event ADD CONSTRAINT health_event_protocol_id_fkey
    FOREIGN KEY (protocol_id) REFERENCES medication_protocol(id) ON DELETE SET NULL;
