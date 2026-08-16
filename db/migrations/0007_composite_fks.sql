-- ============================================================================
-- Tenant-scoped foreign keys
--
-- Closing a gap that row-level security does not cover on its own.
--
-- Postgres evaluates foreign-key constraints as the referenced table's owner,
-- and those checks deliberately BYPASS row-level security. So a farm could
-- INSERT a mating carrying its own farm_id but pointing doe_id at another
-- farm's rabbit: the row passes the RLS WITH CHECK (its farm_id is correct) and
-- the FK passes too (the rabbit does exist, just not for this tenant).
--
-- The result would be one farm's records referencing another's animals, and a
-- way to probe which ids exist elsewhere. RLS hides rows; it does not stop you
-- pointing at them.
--
-- The fix is structural rather than procedural: make farm_id part of the key.
-- (farm_id, doe_id) -> rabbit(farm_id, id) cannot match across tenants, so the
-- database refuses it without any trigger or application check to forget.
-- ============================================================================

-- Composite targets for the references below.
ALTER TABLE rabbit  ADD CONSTRAINT rabbit_farm_id_key  UNIQUE (farm_id, id);
ALTER TABLE mating  ADD CONSTRAINT mating_farm_id_key  UNIQUE (farm_id, id);
ALTER TABLE litter  ADD CONSTRAINT litter_farm_id_key  UNIQUE (farm_id, id);
ALTER TABLE cage    ADD CONSTRAINT cage_farm_id_key    UNIQUE (farm_id, id);
ALTER TABLE breed   ADD CONSTRAINT breed_farm_id_key   UNIQUE (farm_id, id);
ALTER TABLE employee ADD CONSTRAINT employee_farm_id_key UNIQUE (farm_id, id);
ALTER TABLE condition_type ADD CONSTRAINT condition_type_farm_id_key UNIQUE (farm_id, id);
ALTER TABLE medication_protocol
    ADD CONSTRAINT medication_protocol_farm_id_key UNIQUE (farm_id, id);

-- --- rabbit ------------------------------------------------------------------
ALTER TABLE rabbit DROP CONSTRAINT rabbit_dam_id_fkey;
ALTER TABLE rabbit DROP CONSTRAINT rabbit_sire_id_fkey;
ALTER TABLE rabbit DROP CONSTRAINT rabbit_cage_id_fkey;
ALTER TABLE rabbit DROP CONSTRAINT rabbit_breed_id_fkey;
ALTER TABLE rabbit DROP CONSTRAINT rabbit_litter_fk;

ALTER TABLE rabbit ADD CONSTRAINT rabbit_dam_same_farm
    FOREIGN KEY (farm_id, dam_id)  REFERENCES rabbit (farm_id, id);
ALTER TABLE rabbit ADD CONSTRAINT rabbit_sire_same_farm
    FOREIGN KEY (farm_id, sire_id) REFERENCES rabbit (farm_id, id);
ALTER TABLE rabbit ADD CONSTRAINT rabbit_cage_same_farm
    FOREIGN KEY (farm_id, cage_id) REFERENCES cage (farm_id, id);
ALTER TABLE rabbit ADD CONSTRAINT rabbit_breed_same_farm
    FOREIGN KEY (farm_id, breed_id) REFERENCES breed (farm_id, id);
ALTER TABLE rabbit ADD CONSTRAINT rabbit_litter_same_farm
    FOREIGN KEY (farm_id, litter_id) REFERENCES litter (farm_id, id);

-- --- mating ------------------------------------------------------------------
ALTER TABLE mating DROP CONSTRAINT mating_doe_id_fkey;
ALTER TABLE mating DROP CONSTRAINT mating_buck_id_fkey;
ALTER TABLE mating ADD CONSTRAINT mating_doe_same_farm
    FOREIGN KEY (farm_id, doe_id)  REFERENCES rabbit (farm_id, id);
ALTER TABLE mating ADD CONSTRAINT mating_buck_same_farm
    FOREIGN KEY (farm_id, buck_id) REFERENCES rabbit (farm_id, id);

-- --- litter ------------------------------------------------------------------
ALTER TABLE litter DROP CONSTRAINT litter_doe_id_fkey;
ALTER TABLE litter DROP CONSTRAINT litter_mating_id_fkey;
ALTER TABLE litter ADD CONSTRAINT litter_doe_same_farm
    FOREIGN KEY (farm_id, doe_id)    REFERENCES rabbit (farm_id, id);
ALTER TABLE litter ADD CONSTRAINT litter_mating_same_farm
    FOREIGN KEY (farm_id, mating_id) REFERENCES mating (farm_id, id);

-- --- health ------------------------------------------------------------------
ALTER TABLE health_event DROP CONSTRAINT health_event_rabbit_id_fkey;
ALTER TABLE health_event DROP CONSTRAINT health_event_litter_id_fkey;
ALTER TABLE health_event ADD CONSTRAINT health_event_rabbit_same_farm
    FOREIGN KEY (farm_id, rabbit_id) REFERENCES rabbit (farm_id, id) ON DELETE CASCADE;
ALTER TABLE health_event ADD CONSTRAINT health_event_litter_same_farm
    FOREIGN KEY (farm_id, litter_id) REFERENCES litter (farm_id, id) ON DELETE CASCADE;

ALTER TABLE health_condition DROP CONSTRAINT health_condition_rabbit_id_fkey;
ALTER TABLE health_condition DROP CONSTRAINT health_condition_litter_id_fkey;
ALTER TABLE health_condition DROP CONSTRAINT health_condition_condition_type_id_fkey;
ALTER TABLE health_condition ADD CONSTRAINT health_condition_rabbit_same_farm
    FOREIGN KEY (farm_id, rabbit_id) REFERENCES rabbit (farm_id, id) ON DELETE CASCADE;
ALTER TABLE health_condition ADD CONSTRAINT health_condition_litter_same_farm
    FOREIGN KEY (farm_id, litter_id) REFERENCES litter (farm_id, id) ON DELETE CASCADE;
ALTER TABLE health_condition ADD CONSTRAINT health_condition_type_same_farm
    FOREIGN KEY (farm_id, condition_type_id) REFERENCES condition_type (farm_id, id);

-- --- tasks -------------------------------------------------------------------
ALTER TABLE task DROP CONSTRAINT task_rabbit_id_fkey;
ALTER TABLE task DROP CONSTRAINT task_litter_id_fkey;
ALTER TABLE task DROP CONSTRAINT task_mating_id_fkey;
ALTER TABLE task DROP CONSTRAINT task_assigned_to_fkey;
ALTER TABLE task ADD CONSTRAINT task_rabbit_same_farm
    FOREIGN KEY (farm_id, rabbit_id) REFERENCES rabbit (farm_id, id) ON DELETE CASCADE;
ALTER TABLE task ADD CONSTRAINT task_litter_same_farm
    FOREIGN KEY (farm_id, litter_id) REFERENCES litter (farm_id, id) ON DELETE CASCADE;
ALTER TABLE task ADD CONSTRAINT task_mating_same_farm
    FOREIGN KEY (farm_id, mating_id) REFERENCES mating (farm_id, id) ON DELETE CASCADE;
ALTER TABLE task ADD CONSTRAINT task_assignee_same_farm
    FOREIGN KEY (farm_id, assigned_to) REFERENCES employee (farm_id, id);

-- --- attendance --------------------------------------------------------------
ALTER TABLE attendance DROP CONSTRAINT attendance_employee_id_fkey;
ALTER TABLE attendance ADD CONSTRAINT attendance_employee_same_farm
    FOREIGN KEY (farm_id, employee_id) REFERENCES employee (farm_id, id) ON DELETE CASCADE;

-- --- billing -----------------------------------------------------------------
ALTER TABLE invoice DROP CONSTRAINT invoice_subscription_id_fkey;
-- subscription.farm_id already carries a UNIQUE of its own, so this one needs a
-- distinct name.
ALTER TABLE subscription ADD CONSTRAINT subscription_farm_composite_key UNIQUE (farm_id, id);
ALTER TABLE invoice ADD CONSTRAINT invoice_subscription_same_farm
    FOREIGN KEY (farm_id, subscription_id) REFERENCES subscription (farm_id, id);
