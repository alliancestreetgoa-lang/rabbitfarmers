-- ============================================================================
-- Verification fixtures for the derived-state views in schema.sql
--
-- Run against a database with schema.sql already applied:
--   psql -d rabbitfarm -v ON_ERROR_STOP=1 -f db/schema.sql
--   psql -d rabbitfarm -v ON_ERROR_STOP=1 -f db/verify.sql
--
-- Each doe below is a case that breaks naive implementations. The expected
-- state is asserted, so a change to the breeding rules that regresses one of
-- these fails loudly instead of silently miscounting pregnancies.
-- ============================================================================

BEGIN;

INSERT INTO farm (id, name, timezone)
VALUES ('11111111-1111-1111-1111-111111111111', 'Test Rabbitry', 'Asia/Kolkata');

INSERT INTO farm_settings (farm_id) VALUES ('11111111-1111-1111-1111-111111111111');

INSERT INTO breed (id, farm_id, name, size_class, doe_first_mating_days)
VALUES ('22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111', 'New Zealand White', 'medium', 150);

INSERT INTO shed (id, farm_id, name)
VALUES ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111', 'Shed A');

-- One buck for everything.
INSERT INTO rabbit (id, farm_id, tag, sex, role, breed_id, date_of_birth)
VALUES ('44444444-4444-4444-4444-444444444444',
        '11111111-1111-1111-1111-111111111111', 'B-01', 'buck', 'breeder',
        '22222222-2222-2222-2222-222222222222', current_date - 400);

-- Does. All breeding-age except D-H (deliberately young).
INSERT INTO rabbit (id, farm_id, tag, sex, role, breed_id, date_of_birth)
VALUES
 ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'D-A', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'D-B', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 'D-C', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-00000000000d', '11111111-1111-1111-1111-111111111111', 'D-D', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-00000000000e', '11111111-1111-1111-1111-111111111111', 'D-E', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-00000000000f', '11111111-1111-1111-1111-111111111111', 'D-F', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', 'D-G', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', 'D-H', 'doe', 'replacement', '22222222-2222-2222-2222-222222222222', current_date - 90),
 ('a0000000-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111111', 'D-I', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-000000000013', '11111111-1111-1111-1111-111111111111', 'D-J', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-000000000014', '11111111-1111-1111-1111-111111111111', 'D-K', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400);

-- ---------------------------------------------------------------------------
-- Case A: mated 12 days ago, palpated positive  -> PREGNANT / confirmed
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444',
        now() - interval '12 days', 'pregnant');
INSERT INTO pregnancy_check (mating_id, checked_on, result)
VALUES ('b0000000-0000-0000-0000-00000000000a', current_date, 'positive');

-- ---------------------------------------------------------------------------
-- Case B: mated 20 days ago, never palpated     -> PREGNANT / presumed
--         This is the bucket where quiet losses hide.
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at)
VALUES ('b0000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444',
        now() - interval '20 days');

-- ---------------------------------------------------------------------------
-- Case C: mated 30 days ago, positive           -> NEST_BOX (day 28+)
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-00000000000c', '44444444-4444-4444-4444-444444444444',
        now() - interval '30 days', 'pregnant');
INSERT INTO pregnancy_check (mating_id, checked_on, result)
VALUES ('b0000000-0000-0000-0000-00000000000c', current_date - 18, 'positive');

-- ---------------------------------------------------------------------------
-- Case D: mated 40 days ago, positive, no litter -> OVERDUE
--         Must NOT be counted as pregnant. This is the case a stored
--         is_pregnant boolean gets wrong forever.
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-00000000000d', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-00000000000d', '44444444-4444-4444-4444-444444444444',
        now() - interval '40 days', 'pregnant');
INSERT INTO pregnancy_check (mating_id, checked_on, result)
VALUES ('b0000000-0000-0000-0000-00000000000d', current_date - 28, 'positive');

-- ---------------------------------------------------------------------------
-- Case E: mated 5 days ago, palpated negative    -> OPEN, and NOT ready
--         (14-day rest after a failed service has not elapsed)
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-00000000000e', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-00000000000e', '44444444-4444-4444-4444-444444444444',
        now() - interval '5 days', 'negative');
INSERT INTO pregnancy_check (mating_id, checked_on, result)
VALUES ('b0000000-0000-0000-0000-00000000000e', current_date, 'negative');

-- ---------------------------------------------------------------------------
-- Case F: kindled 25 days ago, weaned            -> RESTING, and IS ready
--         (25 >= 21-day rebreed interval)
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-00000000000f', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-00000000000f', '44444444-4444-4444-4444-444444444444',
        now() - interval '56 days', 'kindled');
INSERT INTO litter (farm_id, mating_id, doe_id, kindled_on, born_alive, born_dead,
                    weaned_on, weaned_count)
VALUES ('11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-00000000000f',
        'a0000000-0000-0000-0000-00000000000f', current_date - 25, 9, 1,
        current_date - 1, 8);

-- ---------------------------------------------------------------------------
-- Case G: kindled 10 days ago, still nursing     -> LACTATING, NOT ready
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-000000000010', '44444444-4444-4444-4444-444444444444',
        now() - interval '41 days', 'kindled');
INSERT INTO litter (farm_id, mating_id, doe_id, kindled_on, born_alive, born_dead)
VALUES ('11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-000000000010',
        'a0000000-0000-0000-0000-000000000010', current_date - 10, 7, 0);

-- ---------------------------------------------------------------------------
-- Case H: 90 days old                            -> GROWING, NOT ready
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Case I: never mated, breeding age              -> READY
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Case J: pseudopregnant 5 days ago              -> PSEUDOPREGNANT, NOT ready
--         She will refuse the buck for 16-18 days; a trip to the buck cage
--         would be wasted labour.
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-000000000013', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-000000000013', '44444444-4444-4444-4444-444444444444',
        now() - interval '5 days', 'pseudopregnant');

-- ---------------------------------------------------------------------------
-- Case K: never mated but under veterinary hold  -> READY state, NOT in queue
-- ---------------------------------------------------------------------------
INSERT INTO health_event (farm_id, rabbit_id, category, diagnosis, blocks_breeding)
VALUES ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000014',
        'illness', 'mastitis', true);

-- ============================================================================
-- Assertions
-- ============================================================================

DO $$
DECLARE
    expected  text[][] := ARRAY[
        ['D-A', 'PREGNANT'],       ['D-B', 'PREGNANT'],
        ['D-C', 'NEST_BOX'],       ['D-D', 'OVERDUE'],
        ['D-E', 'OPEN'],           ['D-F', 'RESTING'],
        ['D-G', 'LACTATING'],      ['D-H', 'GROWING'],
        ['D-I', 'READY'],          ['D-J', 'PSEUDOPREGNANT'],
        ['D-K', 'READY']
    ];
    i int;
    actual text;
BEGIN
    FOR i IN 1 .. array_length(expected, 1) LOOP
        SELECT state INTO actual
        FROM v_doe_reproductive_state WHERE tag = expected[i][1];

        IF actual IS DISTINCT FROM expected[i][2] THEN
            RAISE EXCEPTION 'STATE FAIL %: expected %, got %',
                expected[i][1], expected[i][2], COALESCE(actual, 'NULL');
        END IF;
        RAISE NOTICE 'ok  state  % = %', expected[i][1], actual;
    END LOOP;
END $$;

DO $$
DECLARE
    conf int; pres int; total int;
BEGIN
    SELECT confirmed_pregnant, presumed_pregnant, total_pregnant
      INTO conf, pres, total
    FROM v_pregnancy_summary;

    -- A (confirmed) + C (confirmed) = 2 ; B (presumed) = 1
    -- D is overdue and deliberately excluded from the pregnant count.
    IF (conf, pres, total) IS DISTINCT FROM (2, 1, 3) THEN
        RAISE EXCEPTION 'SUMMARY FAIL: expected (2,1,3), got (%,%,%)', conf, pres, total;
    END IF;
    RAISE NOTICE 'ok  pregnancy summary: % confirmed, % presumed, % total', conf, pres, total;
END $$;

DO $$
DECLARE
    got text[];
BEGIN
    SELECT array_agg(tag ORDER BY tag) INTO got FROM v_ready_to_mate;

    -- F (rested 25d), I (never mated) qualify.
    -- E blocked by failed-service rest, G by nursing + rhythm, H by age,
    -- J by pseudopregnancy, K by the veterinary hold.
    IF got IS DISTINCT FROM ARRAY['D-F', 'D-I'] THEN
        RAISE EXCEPTION 'READY FAIL: expected {D-F,D-I}, got %', got;
    END IF;
    RAISE NOTICE 'ok  ready to mate: %', got;
END $$;

DO $$
DECLARE
    d date;
BEGIN
    SELECT expected_kindling_on INTO d
    FROM v_doe_reproductive_state WHERE tag = 'D-A';

    IF d IS DISTINCT FROM current_date - 12 + 31 THEN
        RAISE EXCEPTION 'DUE DATE FAIL: expected %, got %', current_date + 19, d;
    END IF;
    RAISE NOTICE 'ok  D-A expected kindling %  (day 31 from service)', d;
END $$;

DO $$
DECLARE
    m numeric;
BEGIN
    SELECT pre_weaning_mortality INTO m FROM v_doe_performance WHERE tag = 'D-F';
    -- 9 born alive, 8 weaned -> 0.111
    IF round(m, 3) IS DISTINCT FROM 0.111 THEN
        RAISE EXCEPTION 'KPI FAIL: expected 0.111 pre-weaning mortality, got %', m;
    END IF;
    RAISE NOTICE 'ok  D-F pre-weaning mortality %', m;
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL CHECKS PASSED'; END $$;

ROLLBACK;
