-- ============================================================================
-- Verification fixtures for the breeding rules and the derived-state views.
--
-- Run against a database with the migrations applied:
--   cd apps/api && npm run migrate
--   psql -d rabbitry -v ON_ERROR_STOP=1 -f db/verify.sql
--
-- Everything happens inside a transaction that ROLLS BACK at the end, so it is
-- safe to run against a database that already has data — including production,
-- though there is no good reason to.
--
-- Each doe below is a case that breaks naive implementations. The expected
-- result is asserted, so a change to the breeding rules that regresses one of
-- these fails loudly instead of silently miscounting pregnancies or skipping
-- a dose.
-- ============================================================================

BEGIN;

-- Start from a known-empty state.
--
-- Several assertions here are herd-wide by nature — "how many farms are on
-- trial", "which does are ready to mate" — so any pre-existing farm would make
-- them non-deterministic. The whole block rolls back, so nothing is actually
-- removed; this just fixes what the fixtures are measuring against.
DELETE FROM farm;
DELETE FROM plan;

-- Signup collects exactly four things plus the farm name: email, phone,
-- address, password. No verification step — the account is usable immediately.
INSERT INTO farm (id, name, timezone, address_line, city, state, pincode, country)
VALUES ('11111111-1111-1111-1111-111111111111', 'Test Rabbitry', 'Asia/Kolkata',
        'Survey 42, Curtorim', 'Margao', 'Goa', '403709', 'IN');

-- Defaults are this farm's real rhythm: wean (separate the kits) 30 days after
-- kindling, rebreed 3 days after weaning.
INSERT INTO farm_settings (farm_id) VALUES ('11111111-1111-1111-1111-111111111111');

INSERT INTO breed (id, farm_id, name, size_class, doe_first_mating_days)
VALUES ('22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111', 'New Zealand White', 'medium', 150);

INSERT INTO shed (id, farm_id, name)
VALUES ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111', 'Shed A');

-- The owner account created by that signup. email_verified_at stays NULL:
-- verification is deliberately off.
INSERT INTO employee (id, farm_id, full_name, email, phone, role, password_hash)
VALUES ('99999999-9999-9999-9999-999999999999',
        '11111111-1111-1111-1111-111111111111', 'Farm Owner',
        'Owner@TestRabbitry.in', '+919876543210', 'owner', '$argon2id$dummy');

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
  'Ostovet (pre-delivery)',  'expected_kindling', -5, 5, 1, 'daily, last dose the day before expected kindling'),
 ('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
  'Ostovet (post-delivery)', 'kindling',           1, 5, 1, 'daily, starting the day after kindling');

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
 ('a0000000-0000-0000-0000-000000000016', '11111111-1111-1111-1111-111111111111', 'D-M', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400),
 ('a0000000-0000-0000-0000-000000000017', '11111111-1111-1111-1111-111111111111', 'D-N', 'doe', 'breeder', '22222222-2222-2222-2222-222222222222', current_date - 400);

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
--         Her pre-delivery Ostovet course is mid-flight: expected kindling is
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
-- Case M: kindled 2 days ago, post-delivery Ostovet course running.
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
        current_date - 1, 'medication', 'Ostovet',
        'c0000000-0000-0000-0000-000000000002', 1);

-- ---------------------------------------------------------------------------
-- Loose motion: the 2-hourly reminder cycle.
--
--   D-A  reported 5 hours ago, last looked at 3 hours ago  -> reminder DUE
--   D-B  reported 4 hours ago, looked at 30 minutes ago    -> NOT due yet
--   D-N  otherwise ready to breed, but loose                -> out of the queue
--   D-I  had it, marked stopped                             -> gone, breeds again
-- ---------------------------------------------------------------------------
INSERT INTO condition_type
    (id, farm_id, code, name, colour, reminder_interval_hours,
     blocks_breeding, is_contagious, escalate_after_hours)
VALUES
 ('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
  'loose_motion', 'Loose motion', '#EA580C', 2, true, true, 24);

INSERT INTO health_condition
    (id, farm_id, condition_type_id, rabbit_id, started_at, last_checked_at, severity)
VALUES
 ('e0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
  'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a',
  now() - interval '5 hours', now() - interval '3 hours', 'moderate'),
 ('e0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
  'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000b',
  now() - interval '4 hours', now() - interval '30 minutes', 'mild'),
 -- Would otherwise be top of the breeding queue; the open condition holds her out.
 ('e0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
  'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000017',
  now() - interval '30 hours', now() - interval '1 hour', 'severe'),
 -- Resolved: must vanish from every open-condition view.
 ('e0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
  'd0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000012',
  now() - interval '3 days', now() - interval '2 days', 'mild');
UPDATE health_condition
   SET resolved_at = now() - interval '2 days'
 WHERE id = 'e0000000-0000-0000-0000-000000000003';

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
        ['D-M', 'LACTATING'],      ['D-N', 'READY']
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

    -- F (weaned 5 days ago) and I (had loose motion, now stopped) qualify.
    -- L is blocked by the 3-day post-weaning gap, E by the failed-service rest,
    -- G and M by still nursing, H by age, J by pseudopregnancy, K by the
    -- veterinary hold, N by open loose motion.
    IF got IS DISTINCT FROM ARRAY['D-F', 'D-I'] THEN
        RAISE EXCEPTION 'READY FAIL: expected {D-F,D-I}, got %', got;
    END IF;
    RAISE NOTICE 'ok  ready to mate: %  (D-N held out by loose motion, D-I released once stopped)', got;
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

-- --- Ostovet: pre-delivery course ---------------------------------------------
DO $$
DECLARE
    n int; last_due date;
BEGIN
    SELECT count(*), max(due_on) INTO n, last_due
    FROM v_medication_schedule
    WHERE rabbit_id = 'a0000000-0000-0000-0000-00000000000c'
      AND protocol_name = 'Ostovet (pre-delivery)';

    -- 5 doses, the last on the day before expected kindling (service + 30).
    IF n <> 5 OR last_due IS DISTINCT FROM current_date THEN
        RAISE EXCEPTION 'PRE-COURSE FAIL: expected 5 doses ending %, got % ending %',
            current_date, n, last_due;
    END IF;
    RAISE NOTICE 'ok  D-C pre-delivery Ostovet: % doses, last dose % (day before kindling)',
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
      AND protocol_name = 'Ostovet (pre-delivery)';

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
      AND protocol_name = 'Ostovet (pre-delivery)';

    IF n <> 0 THEN
        RAISE EXCEPTION 'CANCEL FAIL: kindled doe still has % pre-delivery doses', n;
    END IF;
    RAISE NOTICE 'ok  D-M pre-delivery course closed on kindling';
END $$;

-- --- Ostovet: post-delivery course --------------------------------------------
DO $$
DECLARE
    doses int[]; due_now int[];
BEGIN
    SELECT array_agg(dose_number ORDER BY dose_number) INTO doses
    FROM v_medication_schedule
    WHERE rabbit_id = 'a0000000-0000-0000-0000-000000000016'
      AND protocol_name = 'Ostovet (post-delivery)';

    IF doses IS DISTINCT FROM ARRAY[1,2,3,4,5] THEN
        RAISE EXCEPTION 'POST-COURSE FAIL: expected 5 doses, got %', doses;
    END IF;

    -- Dose 1 was given and recorded, so it must be gone from the due list.
    SELECT array_agg(dose_number ORDER BY dose_number) INTO due_now
    FROM v_medication_due
    WHERE rabbit_id = 'a0000000-0000-0000-0000-000000000016'
      AND protocol_name = 'Ostovet (post-delivery)'
      AND due_on <= current_date;

    IF due_now IS DISTINCT FROM ARRAY[2] THEN
        RAISE EXCEPTION 'DUE FAIL: expected only dose 2 outstanding, got %', due_now;
    END IF;
    RAISE NOTICE 'ok  D-M post-delivery Ostovet: 5 doses scheduled, dose 1 marked done, dose 2 due today';
END $$;

-- --- The daily list ----------------------------------------------------------
DO $$
DECLARE
    t text;
BEGIN
    SELECT title INTO t
    FROM v_daily_list
    WHERE tag = 'D-M' AND source = 'medication';

    IF t IS DISTINCT FROM 'Ostovet (post-delivery) — dose 2 of 5' THEN
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

-- --- Loose motion: reminders, colour marks, resolution -----------------------
DO $$
DECLARE
    open_tags text[]; due_tags text[];
BEGIN
    SELECT array_agg(tag ORDER BY tag) INTO open_tags
    FROM v_open_conditions WHERE condition_code = 'loose_motion';

    -- D-I was marked stopped, so she must not appear at all.
    IF open_tags IS DISTINCT FROM ARRAY['D-A', 'D-B', 'D-N'] THEN
        RAISE EXCEPTION 'OPEN CONDITION FAIL: expected {D-A,D-B,D-N}, got %', open_tags;
    END IF;

    -- Reminder is due only where the last look was more than 2 hours ago.
    SELECT array_agg(tag ORDER BY tag) INTO due_tags
    FROM v_open_conditions
    WHERE condition_code = 'loose_motion' AND reminder_due;

    IF due_tags IS DISTINCT FROM ARRAY['D-A'] THEN
        RAISE EXCEPTION 'REMINDER FAIL: expected only D-A due, got %', due_tags;
    END IF;
    RAISE NOTICE 'ok  loose motion open on %, reminder due for % (2h since last check)',
        open_tags, due_tags;
END $$;

DO $$
DECLARE
    nxt timestamptz; last_seen timestamptz;
BEGIN
    SELECT next_reminder_at, last_checked_at INTO nxt, last_seen
    FROM v_open_conditions WHERE tag = 'D-B';

    -- Counted from the last observation, not from onset: checked 30 min ago,
    -- so the next nag is 90 minutes out, not overdue from a 4-hour-old start.
    IF nxt IS DISTINCT FROM last_seen + interval '2 hours' THEN
        RAISE EXCEPTION 'INTERVAL FAIL: expected % got %', last_seen + interval '2 hours', nxt;
    END IF;
    IF nxt <= now() THEN
        RAISE EXCEPTION 'INTERVAL FAIL: D-B should not be due yet, next was %', nxt;
    END IF;
    RAISE NOTICE 'ok  D-B next reminder % — clock restarted by the last check, no backlog', nxt;
END $$;

DO $$
DECLARE
    col text; esc boolean;
BEGIN
    SELECT primary_colour INTO col FROM v_rabbit_flags
    WHERE rabbit_id = 'a0000000-0000-0000-0000-00000000000a';
    IF col IS DISTINCT FROM '#EA580C' THEN
        RAISE EXCEPTION 'FLAG FAIL: expected colour mark on D-A, got %', COALESCE(col,'none');
    END IF;

    -- D-I resolved, so she carries no mark.
    IF EXISTS (SELECT 1 FROM v_rabbit_flags
               WHERE rabbit_id = 'a0000000-0000-0000-0000-000000000012') THEN
        RAISE EXCEPTION 'FLAG FAIL: resolved condition still marking D-I';
    END IF;

    -- D-N open 30 hours against a 24-hour escalation threshold.
    SELECT needs_escalation INTO esc FROM v_open_conditions WHERE tag = 'D-N';
    IF NOT esc THEN
        RAISE EXCEPTION 'ESCALATION FAIL: D-N open 30h should have escalated';
    END IF;
    RAISE NOTICE 'ok  colour mark % on D-A, none on resolved D-I, D-N escalated after 24h', col;
END $$;

DO $$
DECLARE
    n int;
BEGIN
    SELECT count(*) INTO n FROM v_daily_list WHERE source = 'condition';
    IF n <> 3 THEN
        RAISE EXCEPTION 'DAILY LIST FAIL: expected 3 open conditions, got %', n;
    END IF;
    RAISE NOTICE 'ok  daily list carries all 3 open conditions continuously, not just at reminder time';
END $$;

-- --- SaaS entitlements -------------------------------------------------------
-- One plan, two billing periods: ₹99/month or ₹999/year, after a 30-day
-- full-access trial. No caps on does or staff.
INSERT INTO plan (id, code, name, max_breeding_does, max_staff_seats,
                  price_monthly_paise, price_yearly_paise, is_introductory, sort_order)
VALUES ('f0000000-0000-0000-0000-000000000001', 'intro-2026', 'Rabbitry',
        NULL, NULL, 9900, 99900, true, 1);

-- Signed up 18 days ago, so 12 days of trial left. The price is snapshotted
-- onto the subscription at signup, which is what makes grandfathering real.
INSERT INTO subscription (farm_id, plan_id, status, billing_period, trial_ends_on,
                          locked_price_monthly_paise, locked_price_yearly_paise,
                          price_locked_at, gateway_mandate_max_paise)
VALUES ('11111111-1111-1111-1111-111111111111',
        'f0000000-0000-0000-0000-000000000001', 'trialing', 'yearly',
        current_date + 12, 9900, 99900, now(), 500000);

DO $$
DECLARE
    acc text; days int; used int; at_doe boolean; at_seat boolean;
BEGIN
    SELECT access, trial_days_left, breeding_does_used, at_doe_limit, at_seat_limit
      INTO acc, days, used, at_doe, at_seat
    FROM v_farm_entitlement;

    IF acc <> 'full' OR days <> 12 THEN
        RAISE EXCEPTION 'TRIAL FAIL: expected full access with 12 days left, got % / %', acc, days;
    END IF;
    -- Unlimited plan: no cap can ever be hit, whatever the herd size.
    IF at_doe OR at_seat THEN
        RAISE EXCEPTION 'LIMIT FAIL: unlimited plan reported a limit at % does', used;
    END IF;
    RAISE NOTICE 'ok  trial: full access, % days left, % does, no caps', days, used;
END $$;

DO $$
DECLARE
    m int; y int; ratio numeric; intro boolean;
BEGIN
    SELECT price_monthly_paise, price_yearly_paise, is_introductory
      INTO m, y, intro
    FROM v_current_public_plan;
    ratio := round(y::numeric / m, 1);

    IF (m, y) IS DISTINCT FROM (9900, 99900) THEN
        RAISE EXCEPTION 'PRICE FAIL: expected ₹99 / ₹999, got % / % paise', m, y;
    END IF;
    IF NOT intro THEN
        RAISE EXCEPTION 'PRICE FAIL: launch plan must be flagged introductory';
    END IF;
    RAISE NOTICE 'ok  pricing: ₹% monthly, ₹% yearly (% months), flagged introductory',
        m/100, y/100, ratio;
END $$;

-- The test this whole mechanism exists for: raising the price must not touch a
-- single existing customer.
DO $$
DECLARE
    paying int; list int; grand boolean; new_list int;
BEGIN
    -- Close the introductory offer and publish a new price point as a NEW row.
    UPDATE plan SET available_until = current_date - 1, is_public = false
     WHERE code = 'intro-2026';
    INSERT INTO plan (code, name, max_breeding_does, max_staff_seats,
                      price_monthly_paise, price_yearly_paise, sort_order)
    VALUES ('standard-2027', 'Rabbitry', NULL, NULL, 24900, 249000, 1);

    SELECT effective_price_paise, current_list_price_paise, is_grandfathered
      INTO paying, list, grand
    FROM v_farm_entitlement;

    -- Existing farm is on the yearly cycle and must still pay ₹999.
    IF paying <> 99900 THEN
        RAISE EXCEPTION 'GRANDFATHER FAIL: existing farm repriced to ₹%', paying/100;
    END IF;
    IF list <> 249000 OR NOT grand THEN
        RAISE EXCEPTION 'GRANDFATHER FAIL: expected list ₹2490 and grandfathered, got ₹% / %',
            list/100, grand;
    END IF;

    -- A new signup today gets the new price, and only one plan is on sale.
    SELECT price_yearly_paise INTO new_list FROM v_current_public_plan;
    IF new_list <> 249000 THEN
        RAISE EXCEPTION 'GRANDFATHER FAIL: new signup should see ₹2490, got ₹%', new_list/100;
    END IF;
    IF (SELECT count(*) FROM v_current_public_plan) <> 1 THEN
        RAISE EXCEPTION 'GRANDFATHER FAIL: exactly one plan should be on sale';
    END IF;

    RAISE NOTICE 'ok  price raised to ₹%/yr for new signups; existing farm still pays ₹% (grandfathered)',
        new_list/100, paying/100;

    -- Restore for the remaining assertions.
    DELETE FROM plan WHERE code = 'standard-2027';
    UPDATE plan SET available_until = NULL, is_public = true WHERE code = 'intro-2026';
END $$;

DO $$
DECLARE
    acc text; rem boolean;
BEGIN
    -- Payment failed and the grace period has expired.
    UPDATE subscription
       SET status = 'suspended', grace_until = current_date - 1
     WHERE farm_id = '11111111-1111-1111-1111-111111111111';

    SELECT access, reminders_active INTO acc, rem FROM v_farm_entitlement;

    IF acc <> 'read_only' THEN
        RAISE EXCEPTION 'SUSPEND FAIL: expected read_only, got %', acc;
    END IF;
    -- The point of the whole design: billing failure must never silence a
    -- nest-box or loose-motion alert. Rabbits do not know about invoices.
    IF NOT rem THEN
        RAISE EXCEPTION 'SUSPEND FAIL: reminders must survive suspension';
    END IF;
    RAISE NOTICE 'ok  suspended: access %, reminders still active', acc;
END $$;

DO $$
DECLARE
    acc text;
BEGIN
    -- Grace period still running: full access, banner in the app, no degradation.
    UPDATE subscription
       SET status = 'grace', grace_until = current_date + 20
     WHERE farm_id = '11111111-1111-1111-1111-111111111111';

    SELECT access INTO acc FROM v_farm_entitlement;
    IF acc <> 'full' THEN
        RAISE EXCEPTION 'GRACE FAIL: expected full access during grace, got %', acc;
    END IF;
    RAISE NOTICE 'ok  grace period: full access retained';
END $$;

DO $$
DECLARE
    acc text;
BEGIN
    -- Trial ran out without anyone paying: read-only, but nothing deleted and
    -- every animal still visible.
    UPDATE subscription
       SET status = 'trialing', trial_ends_on = current_date - 1, grace_until = NULL
     WHERE farm_id = '11111111-1111-1111-1111-111111111111';

    SELECT access INTO acc FROM v_farm_entitlement;
    IF acc <> 'read_only' THEN
        RAISE EXCEPTION 'TRIAL EXPIRY FAIL: expected read_only, got %', acc;
    END IF;
    IF (SELECT count(*) FROM v_doe_reproductive_state) = 0 THEN
        RAISE EXCEPTION 'TRIAL EXPIRY FAIL: expired farm must not have animals hidden';
    END IF;
    RAISE NOTICE 'ok  trial expired: read_only, all animals still visible and exportable';
END $$;

-- --- Signup, sign in, sign out ----------------------------------------------
DO $$
DECLARE
    e text; ph text; addr text; verified timestamptz;
BEGIN
    SELECT em.email, em.phone, f.address_line || ', ' || f.city || ' ' || f.pincode,
           em.email_verified_at
      INTO e, ph, addr, verified
    FROM employee em JOIN farm f ON f.id = em.farm_id
    WHERE em.role = 'owner';

    IF e IS NULL OR ph IS NULL OR addr IS NULL THEN
        RAISE EXCEPTION 'SIGNUP FAIL: email/phone/address must all be captured';
    END IF;
    IF verified IS NOT NULL THEN
        RAISE EXCEPTION 'SIGNUP FAIL: no verification step should have run';
    END IF;
    RAISE NOTICE 'ok  signup: %, %, % — unverified, usable immediately', e, ph, addr;
END $$;

DO $$
DECLARE
    n int;
BEGIN
    -- Email is case-insensitive: the same login however it is typed.
    SELECT count(*) INTO n FROM employee WHERE email = 'owner@testrabbitry.in';
    IF n <> 1 THEN
        RAISE EXCEPTION 'LOGIN FAIL: case-insensitive email lookup returned %', n;
    END IF;

    BEGIN
        INSERT INTO employee (farm_id, full_name, email, phone)
        VALUES ('11111111-1111-1111-1111-111111111111', 'Impostor',
                'OWNER@testrabbitry.IN', '+910000000000');
        RAISE EXCEPTION 'LOGIN FAIL: duplicate email in another case was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;  -- expected
    END;
    RAISE NOTICE 'ok  login identity: email is case-insensitive and unique';
END $$;

DO $$
DECLARE
    live int;
BEGIN
    -- Sign in on two devices.
    INSERT INTO user_session (employee_id, token_hash, expires_at, device)
    VALUES ('99999999-9999-9999-9999-999999999999', 'hash-phone', now() + interval '30 days', 'Redmi Note 12'),
           ('99999999-9999-9999-9999-999999999999', 'hash-web',   now() + interval '30 days', 'Chrome, laptop');

    SELECT count(*) INTO live FROM v_active_session
     WHERE employee_id = '99999999-9999-9999-9999-999999999999';
    IF live <> 2 THEN
        RAISE EXCEPTION 'SESSION FAIL: expected 2 live sessions, got %', live;
    END IF;

    -- Sign out on the phone only.
    UPDATE user_session SET revoked_at = now(), revoked_reason = 'sign out'
     WHERE token_hash = 'hash-phone';

    SELECT count(*) INTO live FROM v_active_session
     WHERE employee_id = '99999999-9999-9999-9999-999999999999';
    IF live <> 1 THEN
        RAISE EXCEPTION 'SESSION FAIL: sign-out left % live sessions', live;
    END IF;
    -- The revoked row is kept, so "who was signed in when" stays answerable.
    IF (SELECT count(*) FROM user_session
        WHERE employee_id = '99999999-9999-9999-9999-999999999999') <> 2 THEN
        RAISE EXCEPTION 'SESSION FAIL: sign-out must revoke, not delete';
    END IF;
    RAISE NOTICE 'ok  sign in on 2 devices, sign out revokes one and keeps the record';
END $$;

-- --- Super-admin CRM ---------------------------------------------------------
DO $$
DECLARE
    r record;
BEGIN
    INSERT INTO platform_admin (id, email, full_name, role)
    VALUES ('aaaa0000-0000-0000-0000-00000000000a', 'me@rabbitryapp.in',
            'Super Admin', 'superadmin');

    SELECT * INTO r FROM v_admin_farm_overview
     WHERE farm_id = '11111111-1111-1111-1111-111111111111';

    IF r.owner_email IS NULL OR r.owner_phone IS NULL OR r.city IS NULL THEN
        RAISE EXCEPTION 'ADMIN FAIL: console must show owner contact and address';
    END IF;
    IF r.breeding_does <> 14 OR r.staff_count < 1 THEN
        RAISE EXCEPTION 'ADMIN FAIL: expected 14 does and staff, got % / %',
            r.breeding_does, r.staff_count;
    END IF;
    IF r.last_activity_at IS NULL THEN
        RAISE EXCEPTION 'ADMIN FAIL: last activity must be computed';
    END IF;
    RAISE NOTICE 'ok  admin console: % (%) — % · % does · % staff · plan % · pays ₹%',
        r.farm_name, r.city, r.owner_email, r.breeding_does, r.staff_count,
        r.plan_code, r.effective_price_paise/100;
END $$;

DO $$
DECLARE
    before_status text; after_status text; logged int;
BEGIN
    -- A support action: extend the trial by 15 days, with the before/after and
    -- a reason written to the audit log.
    SELECT status::text INTO before_status FROM subscription
     WHERE farm_id = '11111111-1111-1111-1111-111111111111';

    UPDATE subscription
       SET status = 'trialing', trial_ends_on = current_date + 15
     WHERE farm_id = '11111111-1111-1111-1111-111111111111';

    INSERT INTO admin_audit_log (admin_id, action, target_farm_id, target_table,
                                 before_value, after_value, reason)
    VALUES ('aaaa0000-0000-0000-0000-00000000000a', 'extend_trial',
            '11111111-1111-1111-1111-111111111111', 'subscription',
            jsonb_build_object('status', before_status),
            jsonb_build_object('status', 'trialing', 'trial_ends_on', current_date + 15),
            'Customer asked for more time to migrate paper records');

    SELECT count(*) INTO logged FROM admin_audit_log
     WHERE target_farm_id = '11111111-1111-1111-1111-111111111111';
    IF logged <> 1 THEN
        RAISE EXCEPTION 'AUDIT FAIL: expected 1 logged admin action, got %', logged;
    END IF;

    SELECT access INTO after_status FROM v_farm_entitlement;
    IF after_status <> 'full' THEN
        RAISE EXCEPTION 'AUDIT FAIL: extended trial should restore full access, got %', after_status;
    END IF;
    RAISE NOTICE 'ok  admin extended trial, access back to %, action logged with reason', after_status;
END $$;

DO $$
DECLARE
    s record;
BEGIN
    SELECT * INTO s FROM v_admin_revenue_summary;
    IF s.trialing <> 1 THEN
        RAISE EXCEPTION 'REVENUE FAIL: expected 1 trialing farm, got %', s.trialing;
    END IF;
    -- Trials are not revenue, so MRR must still be zero.
    IF s.mrr_paise <> 0 THEN
        RAISE EXCEPTION 'REVENUE FAIL: a trial must not count toward MRR, got %', s.mrr_paise;
    END IF;
    RAISE NOTICE 'ok  revenue summary: % trialing, % active, MRR ₹% (trials excluded)',
        s.trialing, s.active, s.mrr_paise/100;
END $$;

DO $$
DECLARE
    mrr bigint;
BEGIN
    -- Convert to a paying yearly customer at the grandfathered ₹999.
    UPDATE subscription
       SET status = 'active', trial_ends_on = NULL,
           current_period_start = current_date, current_period_end = current_date + 365
     WHERE farm_id = '11111111-1111-1111-1111-111111111111';

    SELECT mrr_paise INTO mrr FROM v_admin_revenue_summary;
    -- ₹999/year normalised to a month = 8325 paise.
    IF mrr <> round(99900 / 12.0) THEN
        RAISE EXCEPTION 'REVENUE FAIL: yearly ₹999 should normalise to % paise/month, got %',
            round(99900/12.0), mrr;
    END IF;
    RAISE NOTICE 'ok  yearly ₹999 normalises to ₹%/month of MRR', round(mrr/100.0, 2);
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL CHECKS PASSED'; END $$;

ROLLBACK;
