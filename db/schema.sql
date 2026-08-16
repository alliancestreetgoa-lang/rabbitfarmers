-- ============================================================================
-- Rabbit Farm Manager — reference PostgreSQL schema (MVP)
--
-- This is a design artefact to review and argue with, not final migration
-- code. It exists to make the data model in docs/02-data-model.md concrete
-- and to prove the "derive state from events" approach is queryable.
--
-- Target: PostgreSQL 15+ (Supabase). Row-level security policies are sketched
-- at the bottom but not exhaustively specified.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- Enumerations
-- ----------------------------------------------------------------------------
CREATE TYPE sex_t              AS ENUM ('doe', 'buck');
CREATE TYPE rabbit_role_t      AS ENUM ('breeder', 'grower', 'replacement', 'pet');
CREATE TYPE rabbit_status_t    AS ENUM ('active', 'quarantine', 'sold', 'culled', 'dead');
CREATE TYPE origin_t           AS ENUM ('born_here', 'purchased', 'gift');
CREATE TYPE breed_size_t       AS ENUM ('small', 'medium', 'large', 'giant');

CREATE TYPE mating_method_t    AS ENUM ('natural', 'ai');
CREATE TYPE mating_outcome_t   AS ENUM ('pending', 'pregnant', 'negative',
                                        'pseudopregnant', 'aborted', 'kindled',
                                        'terminated');
CREATE TYPE receptivity_t      AS ENUM ('receptive', 'not_receptive', 'unknown');
CREATE TYPE vulva_colour_t     AS ENUM ('pale', 'pink', 'red', 'purple', 'unknown');
CREATE TYPE check_method_t     AS ENUM ('palpation', 'ultrasound', 'observation');
CREATE TYPE check_result_t     AS ENUM ('positive', 'negative', 'uncertain');

CREATE TYPE rhythm_t           AS ENUM ('intensive', 'semi_intensive', 'extensive');

-- What a medication course counts its days from. 'expected_kindling' is the
-- only anchor that points at a date which has not happened yet, and it is the
-- one the pre-delivery course needs.
CREATE TYPE protocol_anchor_t  AS ENUM ('mating', 'expected_kindling', 'kindling', 'weaning');
CREATE TYPE rebreed_anchor_t   AS ENUM ('kindling', 'weaning');

CREATE TYPE employee_role_t    AS ENUM ('owner', 'manager', 'caretaker', 'vet', 'accountant');
CREATE TYPE employment_type_t  AS ENUM ('permanent', 'daily_wage', 'piece_rate', 'contract');
CREATE TYPE attendance_status_t AS ENUM ('present', 'absent', 'leave', 'holiday', 'half_day');

CREATE TYPE task_kind_t        AS ENUM ('palpate', 'recheck', 'nest_box', 'kindling_watch',
                                        'litter_check', 'creep_feed', 'wean', 'breed',
                                        'vaccinate', 'treat', 'medicate', 'weigh',
                                        'cull_review', 'clean', 'other');
CREATE TYPE task_status_t      AS ENUM ('open', 'done', 'skipped', 'cancelled');
CREATE TYPE task_priority_t    AS ENUM ('low', 'medium', 'high', 'critical');

-- ----------------------------------------------------------------------------
-- Tenancy and configuration
-- ----------------------------------------------------------------------------
CREATE TABLE farm (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL,
    timezone     text NOT NULL DEFAULT 'UTC',   -- all day-counting uses this
    country      text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- Every constant the breeding engine uses. Nothing here may be hard-coded
-- in application source. See docs/03-breeding-engine.md.
CREATE TABLE farm_settings (
    farm_id                        uuid PRIMARY KEY REFERENCES farm(id) ON DELETE CASCADE,

    gestation_expected_days        int NOT NULL DEFAULT 31,
    gestation_window_start_day     int NOT NULL DEFAULT 28,   -- nest box in
    gestation_window_end_day       int NOT NULL DEFAULT 34,
    gestation_overdue_day          int NOT NULL DEFAULT 35,

    first_check_day                int NOT NULL DEFAULT 12,   -- palpation
    first_check_window_start       int NOT NULL DEFAULT 10,
    first_check_window_end         int NOT NULL DEFAULT 14,
    recheck_day                    int NOT NULL DEFAULT 28,

    rhythm                         rhythm_t NOT NULL DEFAULT 'semi_intensive',
    -- This farm counts the rebreed from WEANING, not from kindling:
    -- kindling +30 -> separate the kits; weaning +3 -> back to the buck.
    -- That works out to a ~33 day kindling-to-service interval.
    rebreed_anchor                 rebreed_anchor_t NOT NULL DEFAULT 'weaning',
    rebreed_after_weaning_days     int NOT NULL DEFAULT 3,
    rebreed_after_kindling_days    int NOT NULL DEFAULT 21,  -- used only if anchor = 'kindling'
    wean_at_days                   int NOT NULL DEFAULT 30,
    require_weaning_before_rebreed boolean NOT NULL DEFAULT false,

    after_failed_service_days      int NOT NULL DEFAULT 14,
    after_pseudopregnancy_days     int NOT NULL DEFAULT 18,
    after_abortion_days            int NOT NULL DEFAULT 21,

    buck_max_services_per_day      int NOT NULL DEFAULT 2,
    buck_max_services_per_week     int NOT NULL DEFAULT 4,

    block_shared_parent            boolean NOT NULL DEFAULT true,
    warn_shared_grandparent        boolean NOT NULL DEFAULT true,

    cull_failed_services_in_a_row  int NOT NULL DEFAULT 3,
    cull_low_weaning_threshold     int NOT NULL DEFAULT 5,

    banding_enabled                boolean NOT NULL DEFAULT false,
    banding_weekday                int,                        -- 0=Sunday .. 6=Saturday
    edit_window_hours              int NOT NULL DEFAULT 24,

    -- Repeating condition reminders are held back overnight and delivered as a
    -- catch-up at quiet_hours_end, unless the condition type opts out. A phone
    -- buzzing at 02:00 gets the whole app muted, which costs more than the
    -- delay does.
    quiet_hours_enabled            boolean NOT NULL DEFAULT true,
    quiet_hours_start              int NOT NULL DEFAULT 22,     -- 0-23, farm local
    quiet_hours_end                int NOT NULL DEFAULT 6,

    CONSTRAINT gestation_window_sane
        CHECK (gestation_window_start_day < gestation_window_end_day
               AND gestation_window_end_day < gestation_overdue_day),
    CONSTRAINT check_window_sane
        CHECK (first_check_window_start <= first_check_day
               AND first_check_day <= first_check_window_end),
    CONSTRAINT banding_weekday_sane
        CHECK (banding_weekday IS NULL OR banding_weekday BETWEEN 0 AND 6)
);

CREATE TABLE breed (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id                uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    name                   text NOT NULL,
    size_class             breed_size_t NOT NULL DEFAULT 'medium',
    -- Age gates in days. Defaults follow docs/01-domain-research.md §2.
    doe_first_mating_days  int NOT NULL DEFAULT 150,
    buck_first_mating_days int NOT NULL DEFAULT 180,
    target_market_weight_g int,
    UNIQUE (farm_id, name)
);

-- ----------------------------------------------------------------------------
-- Housing
-- ----------------------------------------------------------------------------
CREATE TABLE shed (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id  uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    name     text NOT NULL,
    UNIQUE (farm_id, name)
);

CREATE TABLE cage (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id    uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    shed_id    uuid NOT NULL REFERENCES shed(id) ON DELETE CASCADE,
    row_label  text,
    code       text NOT NULL,          -- what is painted on the cage card
    capacity   int NOT NULL DEFAULT 1,
    is_active  boolean NOT NULL DEFAULT true,
    UNIQUE (farm_id, code)
);

-- ----------------------------------------------------------------------------
-- People
-- ----------------------------------------------------------------------------
CREATE TABLE employee (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id          uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    auth_user_id     uuid UNIQUE,               -- links to Supabase auth.users
    full_name        text NOT NULL,
    phone            text NOT NULL,
    photo_url        text,
    role             employee_role_t NOT NULL DEFAULT 'caretaker',
    employment_type  employment_type_t NOT NULL DEFAULT 'permanent',
    joined_on        date,
    left_on          date,
    language         text NOT NULL DEFAULT 'en',
    can_palpate      boolean NOT NULL DEFAULT false,  -- skill-based task routing
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (farm_id, phone)
);

-- Which sheds an employee is responsible for; drives automatic task assignment.
CREATE TABLE employee_section (
    employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    shed_id     uuid NOT NULL REFERENCES shed(id) ON DELETE CASCADE,
    PRIMARY KEY (employee_id, shed_id)
);

CREATE TABLE attendance (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id      uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    employee_id  uuid NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    work_date    date NOT NULL,
    status       attendance_status_t NOT NULL DEFAULT 'present',
    checked_in_at  timestamptz,
    checked_out_at timestamptz,
    check_in_lat   numeric(9,6),
    check_in_lng   numeric(9,6),
    overtime_minutes int NOT NULL DEFAULT 0,
    note         text,
    recorded_by  uuid REFERENCES employee(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employee_id, work_date)
);

-- ----------------------------------------------------------------------------
-- Animals
-- ----------------------------------------------------------------------------
CREATE TABLE rabbit (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- generated client-side
    farm_id        uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    tag            text NOT NULL,                -- ear tattoo / tag; spoken aloud daily
    name           text,
    sex            sex_t NOT NULL,
    role           rabbit_role_t NOT NULL DEFAULT 'grower',
    breed_id       uuid REFERENCES breed(id),
    date_of_birth  date,
    dam_id         uuid REFERENCES rabbit(id),   -- required for inbreeding checks
    sire_id        uuid REFERENCES rabbit(id),
    litter_id      uuid,                         -- FK added after litter is defined
    origin         origin_t NOT NULL DEFAULT 'born_here',
    status         rabbit_status_t NOT NULL DEFAULT 'active',
    status_changed_on date,
    cage_id        uuid REFERENCES cage(id),
    photo_url      text,
    notes          text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid REFERENCES employee(id),
    UNIQUE (farm_id, tag),
    CONSTRAINT not_own_parent CHECK (id <> dam_id AND id <> sire_id)
);

CREATE INDEX rabbit_farm_status_idx ON rabbit (farm_id, status);
CREATE INDEX rabbit_sex_role_idx    ON rabbit (farm_id, sex, role) WHERE status = 'active';
CREATE INDEX rabbit_dam_idx         ON rabbit (dam_id);
CREATE INDEX rabbit_sire_idx        ON rabbit (sire_id);

CREATE TABLE movement (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rabbit_id   uuid NOT NULL REFERENCES rabbit(id) ON DELETE CASCADE,
    from_cage_id uuid REFERENCES cage(id),
    to_cage_id   uuid REFERENCES cage(id),
    moved_at    timestamptz NOT NULL DEFAULT now(),
    reason      text,
    recorded_by uuid REFERENCES employee(id)
);

-- ----------------------------------------------------------------------------
-- Reproduction — the event log
-- ----------------------------------------------------------------------------

-- Cage-side receptivity observation. Cheap to record, materially improves
-- conception rates by avoiding wasted services on non-receptive does.
CREATE TABLE receptivity_check (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rabbit_id    uuid NOT NULL REFERENCES rabbit(id) ON DELETE CASCADE,
    checked_on   date NOT NULL DEFAULT current_date,
    receptivity  receptivity_t NOT NULL DEFAULT 'unknown',
    vulva_colour vulva_colour_t NOT NULL DEFAULT 'unknown',
    checked_by   uuid REFERENCES employee(id),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receptivity_rabbit_idx ON receptivity_check (rabbit_id, checked_on DESC);

-- Day 0 of every reproductive cycle.
CREATE TABLE mating (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id          uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    doe_id           uuid NOT NULL REFERENCES rabbit(id),
    buck_id          uuid REFERENCES rabbit(id),        -- null for AI with unknown sire
    mated_at         timestamptz NOT NULL,
    method           mating_method_t NOT NULL DEFAULT 'natural',
    service_count    int NOT NULL DEFAULT 1,
    service_observed boolean NOT NULL DEFAULT true,
    receptivity      receptivity_t NOT NULL DEFAULT 'unknown',
    paternity_certain boolean NOT NULL DEFAULT true,    -- false if two bucks in one cycle
    -- Cached projection, recomputed by trigger. Never hand-edited.
    outcome          mating_outcome_t NOT NULL DEFAULT 'pending',
    notes            text,
    recorded_by      uuid REFERENCES employee(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT service_count_sane CHECK (service_count BETWEEN 1 AND 5)
);
CREATE INDEX mating_doe_idx     ON mating (doe_id, mated_at DESC);
CREATE INDEX mating_buck_idx    ON mating (buck_id, mated_at DESC);
CREATE INDEX mating_outcome_idx ON mating (farm_id, outcome);

-- Palpation / ultrasound. Multiple per mating is normal (day 12 and day 28).
CREATE TABLE pregnancy_check (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mating_id   uuid NOT NULL REFERENCES mating(id) ON DELETE CASCADE,
    checked_on  date NOT NULL DEFAULT current_date,
    method      check_method_t NOT NULL DEFAULT 'palpation',
    result      check_result_t NOT NULL,
    checked_by  uuid REFERENCES employee(id),   -- palpation skill varies; track it
    notes       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pregnancy_check_mating_idx ON pregnancy_check (mating_id, checked_on DESC);

CREATE TABLE litter (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id               uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    mating_id             uuid UNIQUE REFERENCES mating(id),
    doe_id                uuid NOT NULL REFERENCES rabbit(id),
    nest_box_placed_on    date,
    kindled_on            date NOT NULL,
    born_alive            int NOT NULL DEFAULT 0,
    born_dead             int NOT NULL DEFAULT 0,
    fostered_in           int NOT NULL DEFAULT 0,
    fostered_out          int NOT NULL DEFAULT 0,
    weaned_on             date,
    weaned_count          int,
    avg_weaning_weight_g  int,
    notes                 text,
    recorded_by           uuid REFERENCES employee(id),
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT counts_non_negative CHECK (born_alive >= 0 AND born_dead >= 0),
    CONSTRAINT weaned_after_kindled CHECK (weaned_on IS NULL OR weaned_on >= kindled_on)
);
CREATE INDEX litter_doe_idx ON litter (doe_id, kindled_on DESC);

ALTER TABLE rabbit
    ADD CONSTRAINT rabbit_litter_fk FOREIGN KEY (litter_id) REFERENCES litter(id);

CREATE TABLE weight_record (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rabbit_id   uuid REFERENCES rabbit(id) ON DELETE CASCADE,
    litter_id   uuid REFERENCES litter(id) ON DELETE CASCADE,  -- group weighing
    weighed_on  date NOT NULL DEFAULT current_date,
    weight_g    int NOT NULL,
    animal_count int NOT NULL DEFAULT 1,     -- >1 when weighing a group total
    recorded_by uuid REFERENCES employee(id),
    CONSTRAINT weight_subject CHECK (rabbit_id IS NOT NULL OR litter_id IS NOT NULL)
);

-- ----------------------------------------------------------------------------
-- Medication protocols
--
-- A protocol is a repeating course of doses defined once and then applied
-- automatically to every doe who reaches the anchor event. The farm defines
-- these; nothing here is hard-coded to a particular medicine.
--
-- The two courses this farm runs today:
--   "Ostovet" pre-delivery   anchor expected_kindling, offset -5, 5 daily doses
--   "Ostovet" post-delivery  anchor kindling,          offset +1, 5 daily doses
--
-- Ostovet (Virbac) is a calcium / phosphorus / vitamin D3 / B12 liquid feed
-- supplement, not a drug, so it carries no meat withdrawal period. It is dosed
-- either side of kindling because a doe's calcium demand spikes at parturition
-- and at the onset of lactation.
-- ----------------------------------------------------------------------------
CREATE TABLE medication_protocol (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id           uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    name              text NOT NULL,
    anchor            protocol_anchor_t NOT NULL,
    start_offset_days int NOT NULL,          -- negative counts backwards from the anchor
    doses             int NOT NULL DEFAULT 1,
    interval_days     int NOT NULL DEFAULT 1,
    dose_note         text,                  -- "1 ml in drinking water", etc.
    applies_to        text NOT NULL DEFAULT 'doe',   -- doe | litter
    -- Left NULL for feed supplements such as Ostovet. Set it for antibiotics:
    -- meat from a treated animal must not be sold until the period has elapsed,
    -- and the sale screen enforces that.
    withdrawal_days   int,
    notify            boolean NOT NULL DEFAULT true,
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (farm_id, name, anchor),
    CONSTRAINT doses_positive    CHECK (doses BETWEEN 1 AND 60),
    CONSTRAINT interval_positive CHECK (interval_days BETWEEN 1 AND 30)
);

-- ----------------------------------------------------------------------------
-- Health (Phase 2, defined now because it gates the breeding queue)
-- ----------------------------------------------------------------------------
CREATE TABLE health_event (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id           uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    rabbit_id         uuid REFERENCES rabbit(id) ON DELETE CASCADE,
    litter_id         uuid REFERENCES litter(id) ON DELETE CASCADE,
    occurred_on       date NOT NULL DEFAULT current_date,
    category          text NOT NULL,          -- illness | injury | vaccination | medication
    diagnosis         text,
    medicine          text,
    dose              text,
    -- Set when this dose was given against a scheduled protocol. This is what
    -- takes the dose off the daily list; see v_medication_due.
    protocol_id       uuid REFERENCES medication_protocol(id),
    dose_number       int,
    -- Meat rabbits must not be sold during withdrawal. The sale screen checks this.
    withdrawal_until  date,
    blocks_breeding   boolean NOT NULL DEFAULT false,
    cleared_on        date,
    recorded_by       uuid REFERENCES employee(id),
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_rabbit_idx ON health_event (rabbit_id, occurred_on DESC);

-- ----------------------------------------------------------------------------
-- Ongoing health conditions
--
-- A health_event is a point in time ("vaccinated on the 3rd"). A condition is a
-- state that persists until someone says it has stopped, and nags while it is
-- open. Loose motion is the first one; the mechanism is general.
--
-- Nothing about the nagging is stored. The next reminder is computed from the
-- last observation, so resolving the condition silences it with no scheduled
-- job to cancel and no orphaned reminder rows left behind.
-- ----------------------------------------------------------------------------
CREATE TABLE condition_type (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id                 uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    code                    text NOT NULL,      -- loose_motion, sore_hocks, ...
    name                    text NOT NULL,      -- shown to staff, in their language
    -- The mark drawn on the animal everywhere it appears: list, cage map,
    -- profile header, daily list.
    colour                  text NOT NULL DEFAULT '#EA580C',
    reminder_interval_hours numeric(4,1),       -- NULL = no repeating reminder
    blocks_breeding         boolean NOT NULL DEFAULT true,
    -- Contagious conditions drive the cluster check in v_condition_clusters.
    is_contagious           boolean NOT NULL DEFAULT false,
    escalate_after_hours    int,                -- unresolved this long -> tell the manager
    respect_quiet_hours     boolean NOT NULL DEFAULT true,
    is_active               boolean NOT NULL DEFAULT true,
    UNIQUE (farm_id, code)
);

CREATE TABLE health_condition (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id           uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    condition_type_id uuid NOT NULL REFERENCES condition_type(id),
    -- One or the other: a single animal, or a whole litter of kits.
    rabbit_id         uuid REFERENCES rabbit(id) ON DELETE CASCADE,
    litter_id         uuid REFERENCES litter(id) ON DELETE CASCADE,
    started_at        timestamptz NOT NULL DEFAULT now(),
    -- Every "still going" observation pushes this forward, which restarts the
    -- reminder clock. Someone who just checked is not nagged again immediately.
    last_checked_at   timestamptz NOT NULL DEFAULT now(),
    resolved_at       timestamptz,
    severity          text,                     -- mild | moderate | severe
    notes             text,
    reported_by       uuid REFERENCES employee(id),
    resolved_by       uuid REFERENCES employee(id),
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT condition_subject
        CHECK (rabbit_id IS NOT NULL OR litter_id IS NOT NULL),
    CONSTRAINT resolved_after_start
        CHECK (resolved_at IS NULL OR resolved_at >= started_at)
);
-- Partial index: the open-condition query runs on every screen load.
CREATE INDEX condition_open_idx
    ON health_condition (farm_id, last_checked_at)
    WHERE resolved_at IS NULL;
CREATE INDEX condition_rabbit_idx ON health_condition (rabbit_id)
    WHERE resolved_at IS NULL;

-- Each look at the animal while the condition is open. This is what makes the
-- record useful afterwards: "loose for 3 days, mild throughout" is a different
-- story from "mild, then severe overnight", and only the check history tells
-- them apart.
CREATE TABLE condition_check (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    condition_id uuid NOT NULL REFERENCES health_condition(id) ON DELETE CASCADE,
    checked_at   timestamptz NOT NULL DEFAULT now(),
    status       text NOT NULL,        -- ongoing | improving | worse | stopped
    note         text,
    checked_by   uuid REFERENCES employee(id)
);
CREATE INDEX condition_check_idx ON condition_check (condition_id, checked_at DESC);

-- ----------------------------------------------------------------------------
-- Tasks
-- ----------------------------------------------------------------------------
CREATE TABLE task (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id       uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    kind          task_kind_t NOT NULL,
    title         text NOT NULL,
    due_on        date NOT NULL,
    priority      task_priority_t NOT NULL DEFAULT 'medium',
    status        task_status_t NOT NULL DEFAULT 'open',
    rabbit_id     uuid REFERENCES rabbit(id) ON DELETE CASCADE,
    litter_id     uuid REFERENCES litter(id) ON DELETE CASCADE,
    mating_id     uuid REFERENCES mating(id) ON DELETE CASCADE,
    assigned_to   uuid REFERENCES employee(id),
    -- Set for engine-generated tasks so regeneration is idempotent and does
    -- not duplicate a task the caretaker has already completed.
    generated_key text UNIQUE,
    completed_at  timestamptz,
    completed_by  uuid REFERENCES employee(id),
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_open_idx ON task (farm_id, due_on) WHERE status = 'open';
CREATE INDEX task_assignee_idx ON task (assigned_to, due_on) WHERE status = 'open';

-- ----------------------------------------------------------------------------
-- Audit trail
-- ----------------------------------------------------------------------------
CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    farm_id     uuid NOT NULL,
    table_name  text NOT NULL,
    record_id   uuid NOT NULL,
    action      text NOT NULL,          -- insert | update | delete
    changed_by  uuid,
    changed_at  timestamptz NOT NULL DEFAULT now(),
    old_values  jsonb,
    new_values  jsonb
);
CREATE INDEX audit_record_idx ON audit_log (table_name, record_id, changed_at DESC);

-- ============================================================================
-- Derived state
--
-- Reproductive status is never stored. It is computed here from the event log.
-- See docs/03-breeding-engine.md for the decision tree these views implement.
--
-- NOTE: current_date is used for readability. In production, replace with
-- (now() AT TIME ZONE farm.timezone)::date so day counts follow farm-local
-- days rather than the server's.
-- ============================================================================

CREATE OR REPLACE VIEW v_doe_reproductive_state AS
WITH last_mating AS (
    SELECT DISTINCT ON (m.doe_id)
           m.doe_id, m.id AS mating_id, m.buck_id, m.mated_at, m.outcome
    FROM mating m
    ORDER BY m.doe_id, m.mated_at DESC
),
last_check AS (
    SELECT DISTINCT ON (pc.mating_id)
           pc.mating_id, pc.result, pc.checked_on
    FROM pregnancy_check pc
    ORDER BY pc.mating_id, pc.checked_on DESC, pc.created_at DESC
),
last_litter AS (
    SELECT DISTINCT ON (l.doe_id)
           l.doe_id, l.id AS litter_id, l.mating_id, l.kindled_on, l.weaned_on
    FROM litter l
    ORDER BY l.doe_id, l.kindled_on DESC
),
last_pseudo AS (
    SELECT doe_id, max((mated_at)::date) AS on_date
    FROM mating WHERE outcome = 'pseudopregnant' GROUP BY doe_id
),
last_failed AS (
    SELECT doe_id, max((mated_at)::date) AS on_date
    FROM mating WHERE outcome IN ('negative', 'aborted') GROUP BY doe_id
),
base AS (
    SELECT
        r.id          AS rabbit_id,
        r.farm_id,
        r.tag,
        lm.mating_id,
        lm.buck_id,
        (lm.mated_at)::date                              AS last_service_on,
        (current_date - (lm.mated_at)::date)             AS gestation_day,
        lc.result                                        AS last_check_result,
        lc.checked_on                                    AS last_check_on,
        ll.litter_id,
        ll.mating_id                                     AS litter_mating_id,
        ll.kindled_on,
        ll.weaned_on,
        (current_date - ll.kindled_on)                   AS days_since_last_kindling,
        (current_date - ll.weaned_on)                    AS days_since_weaning,
        (current_date - lp.on_date)                      AS days_since_pseudopregnancy,
        (current_date - lf.on_date)                      AS days_since_failed_service,
        (r.date_of_birth IS NOT NULL
         AND current_date - r.date_of_birth
             >= COALESCE(b.doe_first_mating_days, 150))  AS old_enough,
        fs.gestation_window_start_day,
        fs.gestation_overdue_day,
        fs.first_check_window_end
    FROM rabbit r
    JOIN farm_settings fs      ON fs.farm_id = r.farm_id
    LEFT JOIN breed b          ON b.id = r.breed_id
    LEFT JOIN last_mating lm   ON lm.doe_id = r.id
    LEFT JOIN last_check lc    ON lc.mating_id = lm.mating_id
    LEFT JOIN last_litter ll   ON ll.doe_id = r.id
    LEFT JOIN last_pseudo lp   ON lp.doe_id = r.id
    LEFT JOIN last_failed lf   ON lf.doe_id = r.id
    WHERE r.sex = 'doe'
      AND r.status IN ('active', 'quarantine')
),
resolved AS (
    SELECT base.*,
        CASE
            WHEN NOT old_enough                                THEN 'GROWING'
            WHEN mating_id IS NULL                             THEN 'READY'
            -- The latest mating already produced a litter
            WHEN litter_mating_id = mating_id
                 AND weaned_on IS NULL                         THEN 'LACTATING'
            WHEN litter_mating_id = mating_id                  THEN 'RESTING'
            WHEN last_check_result = 'negative'                THEN 'OPEN'
            WHEN outcome_is_pseudo                             THEN 'PSEUDOPREGNANT'
            WHEN gestation_day >= gestation_overdue_day        THEN 'OVERDUE'
            WHEN gestation_day >= gestation_window_start_day   THEN 'NEST_BOX'
            WHEN last_check_result = 'positive'                THEN 'PREGNANT'
            WHEN gestation_day <= first_check_window_end       THEN 'MATED'
            ELSE 'PREGNANT'
        END AS state
    FROM base
    -- pseudopregnancy flag pulled forward for readability
    CROSS JOIN LATERAL (
        SELECT (days_since_pseudopregnancy IS NOT NULL
                AND days_since_pseudopregnancy < 18) AS outcome_is_pseudo
    ) p
)
SELECT
    resolved.*,
    CASE
        WHEN state IN ('PREGNANT', 'NEST_BOX') AND last_check_result = 'positive'
            THEN 'confirmed'
        WHEN state IN ('PREGNANT', 'NEST_BOX')
            THEN 'presumed'
    END AS confidence,
    CASE WHEN state IN ('PREGNANT', 'NEST_BOX', 'MATED')
         THEN last_service_on + 31 END AS expected_kindling_on,
    CASE WHEN state IN ('PREGNANT', 'NEST_BOX', 'MATED')
         THEN last_service_on + 28 END AS window_start_on,
    CASE WHEN state IN ('PREGNANT', 'NEST_BOX', 'MATED')
         THEN last_service_on + 34 END AS window_end_on
FROM resolved;


-- "How many females are pregnant?" — the farmer's first question.
CREATE OR REPLACE VIEW v_pregnant_does AS
SELECT *
FROM v_doe_reproductive_state
WHERE state IN ('PREGNANT', 'NEST_BOX');

-- Dashboard counts. Confirmed and presumed are deliberately never merged.
CREATE OR REPLACE VIEW v_pregnancy_summary AS
SELECT
    farm_id,
    count(*)                                                  AS total_pregnant,
    count(*) FILTER (WHERE confidence = 'confirmed')          AS confirmed_pregnant,
    count(*) FILTER (WHERE confidence = 'presumed')           AS presumed_pregnant,
    count(*) FILTER (WHERE window_start_on <= current_date + 7) AS due_within_7_days
FROM v_pregnant_does
GROUP BY farm_id;


-- "Which females are ready for mating?" — the farmer's second question.
CREATE OR REPLACE VIEW v_ready_to_mate AS
SELECT
    s.rabbit_id,
    s.farm_id,
    s.tag,
    s.state,
    s.days_since_last_kindling,
    s.days_since_weaning,
    CASE fs.rebreed_anchor
        WHEN 'weaning'  THEN GREATEST(0, COALESCE(s.days_since_weaning, 0)
                                         - fs.rebreed_after_weaning_days)
        WHEN 'kindling' THEN GREATEST(0, COALESCE(s.days_since_last_kindling, 0)
                                         - fs.rebreed_after_kindling_days)
    END AS days_overdue,
    rc.receptivity  AS last_observed_receptivity,
    rc.checked_on   AS receptivity_checked_on
FROM v_doe_reproductive_state s
JOIN rabbit r        ON r.id = s.rabbit_id
JOIN farm_settings fs ON fs.farm_id = s.farm_id
LEFT JOIN LATERAL (
    SELECT receptivity, checked_on
    FROM receptivity_check
    WHERE rabbit_id = s.rabbit_id
    ORDER BY checked_on DESC
    LIMIT 1
) rc ON true
WHERE r.status = 'active'                       -- excludes quarantine
  AND r.role IN ('breeder', 'replacement')
  AND s.state IN ('READY', 'OPEN', 'RESTING', 'LACTATING')
  -- Rest interval, counted from whichever anchor the farm uses. With the
  -- 'weaning' anchor a nursing doe is excluded automatically, because she has
  -- no weaning date yet.
  AND (
        s.kindled_on IS NULL                       -- maiden doe: no rest to serve
     OR (fs.rebreed_anchor = 'kindling'
         AND s.days_since_last_kindling >= fs.rebreed_after_kindling_days)
     OR (fs.rebreed_anchor = 'weaning'
         AND s.days_since_weaning IS NOT NULL
         AND s.days_since_weaning >= fs.rebreed_after_weaning_days)
      )
  AND (NOT fs.require_weaning_before_rebreed OR s.state <> 'LACTATING')
  AND (s.days_since_pseudopregnancy IS NULL
       OR s.days_since_pseudopregnancy >= fs.after_pseudopregnancy_days)
  AND (s.days_since_failed_service IS NULL
       OR s.days_since_failed_service >= fs.after_failed_service_days)
  AND NOT EXISTS (
        SELECT 1 FROM health_event h
        WHERE h.rabbit_id = s.rabbit_id
          AND h.blocks_breeding
          AND (h.cleared_on IS NULL OR h.cleared_on > current_date)
      )
  -- An open condition such as loose motion keeps her out of the queue until
  -- someone marks it stopped.
  AND NOT EXISTS (
        SELECT 1
        FROM health_condition hc
        JOIN condition_type ct ON ct.id = hc.condition_type_id
        WHERE hc.rabbit_id = s.rabbit_id
          AND hc.resolved_at IS NULL
          AND ct.blocks_breeding
      );


-- Buck workload, for the service-quota rule in buck selection.
CREATE OR REPLACE VIEW v_buck_availability AS
SELECT
    r.id AS buck_id,
    r.farm_id,
    r.tag,
    count(m.id) FILTER (WHERE (m.mated_at)::date = current_date)      AS services_today,
    count(m.id) FILTER (WHERE (m.mated_at)::date > current_date - 7)  AS services_last_7d,
    count(m.id) FILTER (WHERE m.outcome IN ('pregnant', 'kindled'))   AS successes,
    count(m.id) FILTER (WHERE m.outcome IN ('pregnant', 'kindled', 'negative')) AS scored_services
FROM rabbit r
LEFT JOIN mating m ON m.buck_id = r.id
WHERE r.sex = 'buck' AND r.status = 'active'
GROUP BY r.id, r.farm_id, r.tag;


-- Every dose every protocol calls for, expanded to individual dated doses.
--
-- The pre-delivery course anchors on EXPECTED kindling (service + 31), because
-- the real kindling date is not known when the course has to start. Those rows
-- disappear the moment a litter is recorded, which is exactly the cancellation
-- behaviour wanted: if she kindles on day 29, the day 29 and 30 doses stop
-- being due. Doses already given stay recorded in health_event, so a course cut
-- short is still visible in her history.
CREATE OR REPLACE VIEW v_medication_schedule AS
WITH anchors AS (
    SELECT m.farm_id, m.doe_id AS rabbit_id, NULL::uuid AS litter_id, m.id AS mating_id,
           'expected_kindling'::protocol_anchor_t AS anchor,
           (m.mated_at)::date + fs.gestation_expected_days AS anchor_date
    FROM mating m
    JOIN farm_settings fs ON fs.farm_id = m.farm_id
    LEFT JOIN litter l    ON l.mating_id = m.id
    WHERE l.id IS NULL
      AND m.outcome NOT IN ('negative', 'pseudopregnant', 'aborted', 'terminated')
  UNION ALL
    SELECT m.farm_id, m.doe_id, NULL::uuid, m.id,
           'mating'::protocol_anchor_t, (m.mated_at)::date
    FROM mating m
  UNION ALL
    SELECT l.farm_id, l.doe_id, l.id, l.mating_id,
           'kindling'::protocol_anchor_t, l.kindled_on
    FROM litter l
  UNION ALL
    SELECT l.farm_id, l.doe_id, l.id, l.mating_id,
           'weaning'::protocol_anchor_t, l.weaned_on
    FROM litter l
    WHERE l.weaned_on IS NOT NULL
)
SELECT
    p.id            AS protocol_id,
    p.name          AS protocol_name,
    a.farm_id,
    a.rabbit_id,
    a.litter_id,
    a.mating_id,
    a.anchor,
    a.anchor_date,
    (n + 1)         AS dose_number,
    p.doses         AS total_doses,
    a.anchor_date + p.start_offset_days + (n * p.interval_days) AS due_on,
    p.dose_note,
    p.withdrawal_days,
    p.notify
FROM medication_protocol p
JOIN anchors a
      ON a.anchor = p.anchor
     AND a.farm_id = p.farm_id
CROSS JOIN generate_series(0, p.doses - 1) AS n
WHERE p.is_active;


-- Doses still outstanding: scheduled, but with no matching dose recorded.
-- Recording the dose in health_event is what drops it off the list — this is
-- the "mark done and it disappears" behaviour, with no separate done-flag to
-- fall out of sync.
CREATE OR REPLACE VIEW v_medication_due AS
SELECT s.*,
       (s.due_on - current_date) AS days_until_due
FROM v_medication_schedule s
WHERE NOT EXISTS (
    SELECT 1 FROM health_event h
    WHERE h.protocol_id = s.protocol_id
      AND h.rabbit_id   = s.rabbit_id
      AND h.dose_number = s.dose_number
      AND h.occurred_on >= s.due_on - 2      -- tolerate a dose given a day early or late
      AND h.occurred_on <= s.due_on + 2
);


-- Every open health condition, with its colour mark and its next nag.
--
-- next_reminder_at counts from the LAST OBSERVATION, not from onset, so
-- recording "still loose" at 10:00 moves the next reminder to 12:00 rather than
-- leaving a backlog of missed 2-hourly slots to fire all at once.
--
-- Quiet-hours suppression is applied by the notification sender, not here:
-- this view answers "is a reminder due", the sender answers "may we buzz a
-- phone right now". Keeping them separate means the in-app list stays truthful
-- overnight even while pushes are held.
CREATE OR REPLACE VIEW v_open_conditions AS
SELECT
    hc.id                       AS condition_id,
    hc.farm_id,
    hc.rabbit_id,
    hc.litter_id,
    r.tag,
    r.name                      AS rabbit_name,
    ct.code                     AS condition_code,
    ct.name                     AS condition_name,
    ct.colour,
    ct.blocks_breeding,
    ct.is_contagious,
    ct.respect_quiet_hours,
    hc.severity,
    hc.started_at,
    hc.last_checked_at,
    round(EXTRACT(epoch FROM now() - hc.started_at) / 3600.0, 1)  AS hours_open,
    CASE WHEN ct.reminder_interval_hours IS NOT NULL
         THEN hc.last_checked_at
              + make_interval(mins => (ct.reminder_interval_hours * 60)::int)
    END                         AS next_reminder_at,
    CASE WHEN ct.reminder_interval_hours IS NOT NULL
          AND now() >= hc.last_checked_at
              + make_interval(mins => (ct.reminder_interval_hours * 60)::int)
         THEN true ELSE false
    END                         AS reminder_due,
    CASE WHEN ct.escalate_after_hours IS NOT NULL
          AND now() >= hc.started_at
              + make_interval(hours => ct.escalate_after_hours)
         THEN true ELSE false
    END                         AS needs_escalation
FROM health_condition hc
JOIN condition_type ct ON ct.id = hc.condition_type_id
LEFT JOIN rabbit r     ON r.id = hc.rabbit_id
WHERE hc.resolved_at IS NULL;


-- The colour marks to draw against each animal, wherever it is listed.
-- Most severe (longest open) first, so one dot can stand in when space is tight.
CREATE OR REPLACE VIEW v_rabbit_flags AS
SELECT
    rabbit_id,
    farm_id,
    count(*)                                        AS flag_count,
    (array_agg(colour         ORDER BY started_at))[1] AS primary_colour,
    (array_agg(condition_name ORDER BY started_at))[1] AS primary_condition,
    array_agg(condition_name  ORDER BY started_at)     AS conditions,
    bool_or(reminder_due)                           AS any_reminder_due
FROM v_open_conditions
WHERE rabbit_id IS NOT NULL
GROUP BY rabbit_id, farm_id;


-- Contagious conditions appearing together in one shed. Loose motion spreads
-- through shared feed, water and faeces, so two open cases in the same shed is
-- an outbreak signal worth raising before it becomes ten.
CREATE OR REPLACE VIEW v_condition_clusters AS
SELECT
    c.farm_id,
    s.id            AS shed_id,
    s.name          AS shed_name,
    c.condition_code,
    c.condition_name,
    count(*)        AS open_cases,
    min(c.started_at) AS first_case_at
FROM v_open_conditions c
JOIN rabbit r ON r.id = c.rabbit_id
JOIN cage cg  ON cg.id = r.cage_id
JOIN shed s   ON s.id = cg.shed_id
WHERE c.is_contagious
GROUP BY c.farm_id, s.id, s.name, c.condition_code, c.condition_name
HAVING count(*) >= 2;


-- The single feed behind the daily tab: everything a person must do now,
-- medication, husbandry and open health conditions together, most urgent first.
CREATE OR REPLACE VIEW v_daily_list AS
SELECT
    'medication'                          AS source,
    md.protocol_id::text                  AS ref_id,
    md.rabbit_id,
    r.tag,
    md.farm_id,
    md.due_on,
    md.due_on::timestamptz                AS due_at,
    md.protocol_name || ' — dose ' || md.dose_number || ' of ' || md.total_doses
                                          AS title,
    CASE WHEN md.due_on < current_date THEN 'critical' ELSE 'high' END AS urgency,
    NULL::text                            AS colour
FROM v_medication_due md
JOIN rabbit r ON r.id = md.rabbit_id
WHERE md.notify
  AND md.due_on <= current_date

UNION ALL

SELECT
    'task',
    t.id::text,
    t.rabbit_id,
    r.tag,
    t.farm_id,
    t.due_on,
    t.due_on::timestamptz,
    t.title,
    CASE WHEN t.due_on < current_date THEN 'critical' ELSE t.priority::text END,
    NULL::text
FROM task t
LEFT JOIN rabbit r ON r.id = t.rabbit_id
WHERE t.status = 'open'
  AND t.due_on <= current_date

UNION ALL

-- Open conditions sit on the list continuously, not only at the reminder
-- moment. The 2-hourly reminder is the push notification; the row itself stays
-- visible the whole time so the condition cannot be forgotten between buzzes.
SELECT
    'condition',
    oc.condition_id::text,
    oc.rabbit_id,
    oc.tag,
    oc.farm_id,
    oc.started_at::date,
    oc.next_reminder_at,
    oc.condition_name || ' — check ' || COALESCE(oc.rabbit_name, oc.tag, 'litter')
        || ' (' || oc.hours_open || 'h)',
    CASE WHEN oc.needs_escalation OR oc.reminder_due THEN 'critical' ELSE 'high' END,
    oc.colour
FROM v_open_conditions oc;


-- The headline KPI: kits weaned per doe per year.
CREATE OR REPLACE VIEW v_doe_performance AS
SELECT
    r.id AS rabbit_id,
    r.farm_id,
    r.tag,
    count(l.id)                                   AS litters,
    sum(l.born_alive)                             AS total_born_alive,
    sum(COALESCE(l.weaned_count, 0))              AS total_weaned,
    CASE WHEN sum(l.born_alive) > 0
         THEN round((sum(l.born_alive) - sum(COALESCE(l.weaned_count, 0)))::numeric
                    / sum(l.born_alive), 3)
    END                                           AS pre_weaning_mortality,
    min(l.kindled_on)                             AS first_kindling,
    max(l.kindled_on)                             AS last_kindling,
    CASE WHEN count(l.id) > 1
         THEN round((max(l.kindled_on) - min(l.kindled_on))::numeric
                    / (count(l.id) - 1), 1)
    END                                           AS avg_kindling_interval_days
FROM rabbit r
LEFT JOIN litter l ON l.doe_id = r.id
WHERE r.sex = 'doe'
GROUP BY r.id, r.farm_id, r.tag;

-- ============================================================================
-- Row-level security (sketch — expand per role before production)
-- ============================================================================
-- ALTER TABLE rabbit ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY rabbit_same_farm ON rabbit
--     USING (farm_id IN (
--         SELECT farm_id FROM employee
--         WHERE auth_user_id = auth.uid() AND is_active
--     ));
--
-- Financial tables additionally restrict to roles ('owner', 'accountant').
-- Caretakers get UPDATE on their own recent records only, enforced with a
-- created_by = self AND created_at > now() - interval '24 hours' predicate
-- (see the edit-window rule in docs/04-employee-module.md).
