-- ============================================================================
-- Verification fixtures for the derived-state views in schema.sql
--
-- Run against a database with schema.sql already applied:
--   psql -d rabbitfarm -v ON_ERROR_STOP=1 -f db/schema.sql
--   psql -d rabbitfarm -v ON_ERROR_STOP=1 -f db/verify.sql
--
-- Each doe below is a case that breaks naive implementations. The expected
-- result is asserted, so a change to the breeding rules that regresses one of
-- these fails loudly instead of silently miscounting pregnancies or skipping
-- a dose.
-- ============================================================================

BEGIN;

INSERT INTO farm (id, name, timezone)
VALUES ('11111111-1111-1111-1111-111111111111', 'Test Rabbitry', 'Asia/Kolkata');

-- Defaults are this farm's real rhythm: wean (separate the kits) 30 days after
-- kindling, rebreed 3 days after weaning.
INSERT INTO farm_settings (farm_id) VALUES ('11111111-1111-1111-1111-111111111111');

INSERT INTO breed (id, farm_id, name, size_class, doe_first_mating_days)
VALUES ('22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111', 'New Zealand White', 'medium', 150);

INSERT INTO shed (id, farm_id, name)
VALUES ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111', 'Shed A');

-- --------------------------------------------------------------------------
-- The two medication courses this farm runs.
--
-- Pre-delivery anchors on EXPECTED kindling (service + 31 days), because the
-- real kindling date is unknown when the course must start. In service-day
-- terms the doses land on days 26, 27, 28, 29 and 30.
-- --------------------------------------------------------------------------
INSERT INTO medication_protocol
    (id, farm_id, name, anchor, start_offset_days, doses, interval_days, dose_note)
VALUES
 ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
  'Hosto (pre-delivery)',  'expected_kindling', -5, 5, 1, 'daily, last dose the day before expected kindling'),
 ('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
  'Hosto (post-delivery)', 'kindling',           1, 5, 1, 'daily, starting the day after kindling');

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
 ('a0000000-0000-0000-0000-000000000014', '11111111-1111-1111-1111-111111111111', 'D-K', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-000000000015', '11111111-1111-1111-1111-111111111111', 'D-L', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-000000000016', '11111111-1111-1111-1111-111111111111', 'D-M', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400);

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
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at)
VALUES ('b0000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444',
        now() - interval '20 days');

-- ---------------------------------------------------------------------------
-- Case C: mated 30 days ago, positive           -> NEST_BOX (day 28+)
--         Her pre-delivery Hosto course is mid-flight: expected kindling is
--         tomorrow, so dose 5 of 5 falls today.
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-00000000000c', '44444444-4444-4444-4444-444444444444',
        now() - interval '30 days', 'pregnant');
INSERT INTO pregnancy_check (mating_id, checked_on, result)
VALUES ('b0000000-0000-0000-0000-00000000000c', current_date - 18, 'positive');

-- ---------------------------------------------------------------------------
-- Case D: mated 40 days ago, positive, no litter -> OVERDUE
--         Must NOT be counted as pregnant.
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-00000000000d', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-00000000000d', '44444444-4444-4444-4444-444444444444',
        now() - interval '40 days', 'pregnant');
INSERT INTO pregnancy_check (mating_id, checked_on, result)
VALUES ('b0000000-0000-0000-0000-00000000000d', current_date - 28, 'positive');

-- ---------------------------------------------------------------------------
-- Case E: mated 5 days ago, palpated negative    -> OPEN, NOT ready
--         Also: a failed pregnancy must generate NO medication doses.
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-00000000000e', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-00000000000e', '44444444-4444-4444-4444-444444444444',
        now() - interval '5 days', 'negative');
INSERT INTO pregnancy_check (mating_id, checked_on, result)
VALUES ('b0000000-0000-0000-0000-00000000000e', current_date, 'negative');

-- ---------------------------------------------------------------------------
-- Case F: kindled 35 days ago, kits separated 5 days ago -> RESTING, IS ready
--         (5 days since weaning >= the 3-day rebreed interval)
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-00000000000f', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-00000000000f', '44444444-4444-4444-4444-444444444444',
        now() - interval '66 days', 'kindled');
INSERT INTO litter (farm_id, mating_id, doe_id, kindled_on, born_alive, born_dead,
                    weaned_on, weaned_count)
VALUES ('11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-00000000000f',
        'a0000000-0000-0000-0000-00000000000f', current_date - 35, 9, 1,
        current_date - 5, 8);

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
-- Case I: never mated, breeding age              -> READY
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Case J: pseudopregnant 5 days ago              -> PSEUDOPREGNANT, NOT ready
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

-- ---------------------------------------------------------------------------
-- Case L: kits separated TODAY                   -> RESTING, NOT ready
--         The 3-day gap between separating the kits and rebreeding must be
--         served. This is the case that a "weaned means ready" shortcut breaks.
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-000000000015', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-000000000015', '44444444-4444-4444-4444-444444444444',
        now() - interval '61 days', 'kindled');
INSERT INTO litter (farm_id, mating_id, doe_id, kindled_on, born_alive,
                    weaned_on, weaned_count)
VALUES ('11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-000000000015',
        'a0000000-0000-0000-0000-000000000015', current_date - 30, 8,
        current_date, 8);

-- ---------------------------------------------------------------------------
-- Case M: kindled 2 days ago, post-delivery Hosto course running.
--         Dose 1 (yesterday) has been given and recorded. Dose 2 falls today.
--         Dose 1 must have dropped off the list; dose 2 must be on it.
-- ---------------------------------------------------------------------------
INSERT INTO mating (id, farm_id, doe_id, buck_id, mated_at, outcome)
VALUES ('b0000000-0000-0000-0000-000000000016', '11111111-1111-1111-1111-111111111111',
        'a0000000-0000-0000-0000-000000000016', '44444444-4444-4444-4444-444444444444',
        now() - interval '33 days', 'kindled');
INSERT INTO litter (farm_id, mating_id, doe_id, kindled_on, born_alive)
VALUES ('11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-000000000016',
        'a0000000-0000-0000-0000-000000000016', current_date - 2, 10);
INSERT INTO health_event (farm_id, rabbit_id, occurred_on, category, medicine,
                          protocol_id, dose_number)
VALUES ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000016',
        current_date - 1, 'medication', 'Hosto',
        'c0000000-0000-0000-0000-000000000002', 1);

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
        ['D-K', 'READY'],          ['D-L', 'RESTING'],
        ['D-M', 'LACTATING']
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

    -- A and C confirmed; B presumed. D is overdue and deliberately excluded.
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

    -- F (weaned 5 days ago) and I (never mated) qualify.
    -- L is blocked by the 3-day post-weaning gap, E by the failed-service rest,
    -- G and M by still nursing, H by age, J by pseudopregnancy, K by the
    -- veterinary hold.
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

-- --- Hosto: pre-delivery course ---------------------------------------------
DO $$
DECLARE
    n int; last_due date;
BEGIN
    SELECT count(*), max(due_on) INTO n, last_due
    FROM v_medication_schedule
    WHERE rabbit_id = 'a0000000-0000-0000-0000-00000000000c'
      AND protocol_name = 'Hosto (pre-delivery)';

    -- 5 doses, the last on the day before expected kindling (service + 30).
    IF n <> 5 OR last_due IS DISTINCT FROM current_date THEN
        RAISE EXCEPTION 'PRE-COURSE FAIL: expected 5 doses ending %, got % ending %',
            current_date, n, last_due;
    END IF;
    RAISE NOTICE 'ok  D-C pre-delivery Hosto: % doses, last dose % (day before kindling)',
        n, last_due;
END $$;

DO $$
DECLARE
    n int;
BEGIN
    -- A doe confirmed NOT pregnant must never be scheduled a pre-delivery dose.
    SELECT count(*) INTO n
    FROM v_medication_schedule
    WHERE rabbit_id = 'a0000000-0000-0000-0000-00000000000e'
      AND protocol_name = 'Hosto (pre-delivery)';

    IF n <> 0 THEN
        RAISE EXCEPTION 'PRE-COURSE FAIL: failed pregnancy scheduled % doses', n;
    END IF;
    RAISE NOTICE 'ok  D-E (palpated negative) scheduled no pre-delivery doses';
END $$;

DO $$
DECLARE
    n int;
BEGIN
    -- Once she kindles, any remaining pre-delivery doses stop being due.
    SELECT count(*) INTO n
    FROM v_medication_schedule
    WHERE rabbit_id = 'a0000000-0000-0000-0000-000000000016'
      AND protocol_name = 'Hosto (pre-delivery)';

    IF n <> 0 THEN
        RAISE EXCEPTION 'CANCEL FAIL: kindled doe still has % pre-delivery doses', n;
    END IF;
    RAISE NOTICE 'ok  D-M pre-delivery course closed on kindling';
END $$;

-- --- Hosto: post-delivery course --------------------------------------------
DO $$
DECLARE
    doses int[]; due_now int[];
BEGIN
    SELECT array_agg(dose_number ORDER BY dose_number) INTO doses
    FROM v_medication_schedule
    WHERE rabbit_id = 'a0000000-0000-0000-0000-000000000016'
      AND protocol_name = 'Hosto (post-delivery)';

    IF doses IS DISTINCT FROM ARRAY[1,2,3,4,5] THEN
        RAISE EXCEPTION 'POST-COURSE FAIL: expected 5 doses, got %', doses;
    END IF;

    -- Dose 1 was given and recorded, so it must be gone from the due list.
    SELECT array_agg(dose_number ORDER BY dose_number) INTO due_now
    FROM v_medication_due
    WHERE rabbit_id = 'a0000000-0000-0000-0000-000000000016'
      AND protocol_name = 'Hosto (post-delivery)'
      AND due_on <= current_date;

    IF due_now IS DISTINCT FROM ARRAY[2] THEN
        RAISE EXCEPTION 'DUE FAIL: expected only dose 2 outstanding, got %', due_now;
    END IF;
    RAISE NOTICE 'ok  D-M post-delivery Hosto: 5 doses scheduled, dose 1 marked done, dose 2 due today';
END $$;

-- --- The daily list ----------------------------------------------------------
DO $$
DECLARE
    t text;
BEGIN
    SELECT title INTO t
    FROM v_daily_list
    WHERE tag = 'D-M' AND source = 'medication';

    IF t IS DISTINCT FROM 'Hosto (post-delivery) — dose 2 of 5' THEN
        RAISE EXCEPTION 'DAILY LIST FAIL: got %', COALESCE(t, 'NULL');
    END IF;
    RAISE NOTICE 'ok  daily list shows "%" for D-M', t;
END $$;

-- --- Separate-the-kits and rebreed dates ------------------------------------
DO $$
DECLARE
    separate_on date; rebreed_on date; kindled date;
BEGIN
    SELECT l.kindled_on,
           l.kindled_on + fs.wean_at_days,
           l.kindled_on + fs.wean_at_days + fs.rebreed_after_weaning_days
      INTO kindled, separate_on, rebreed_on
    FROM litter l
    JOIN farm_settings fs ON fs.farm_id = l.farm_id
    WHERE l.doe_id = 'a0000000-0000-0000-0000-000000000016';

    IF separate_on <> kindled + 30 OR rebreed_on <> kindled + 33 THEN
        RAISE EXCEPTION 'SCHEDULE FAIL: separate %, rebreed % (kindled %)',
            separate_on, rebreed_on, kindled;
    END IF;
    RAISE NOTICE 'ok  D-M kindled %, separate kits %, rebreed %',
        kindled, separate_on, rebreed_on;
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
