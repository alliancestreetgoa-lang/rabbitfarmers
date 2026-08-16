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
-- Case-insensitive email. "Ravi@Farm.in" and "ravi@farm.in" are one login, which
-- is what users expect and what stops duplicate-account support tickets.
CREATE EXTENSION IF NOT EXISTS citext;

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
    -- Collected at signup. Address is also what a GST invoice needs.
    address_line text,
    city         text,
    state        text,
    pincode      text,
    country      text NOT NULL DEFAULT 'IN',
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
    -- Set when auth is delegated to a provider (Clerk/Auth0). The JWT subject
    -- lands here and Neon RLS reads it via auth.user_id().
    auth_user_id     uuid UNIQUE,
    full_name        text NOT NULL,
    -- Login identity. Globally unique, not per farm — two farms cannot share
    -- a login. Collected at signup along with phone and address.
    email            citext UNIQUE,
    -- No verification at signup, by design: a farmer signs up and is straight
    -- into the app. The column exists so verification can be switched on later
    -- without a migration; it stays NULL until then. See docs/10-admin-console.md
    -- for why password reset still needs a channel.
    email_verified_at timestamptz,
    -- ONLY used when running auth yourself instead of a provider. Argon2id or
    -- bcrypt, never anything reversible, never the password itself.
    password_hash    text,
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
