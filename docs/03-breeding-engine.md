# 03 — The Breeding Engine

This is the part worth building carefully. Everything else in the app is CRUD.

Three outputs:

1. **Pregnant does** — how many, which, due when
2. **Ready-to-mate queue** — who to breed today, with which buck
3. **Today's tasks** — generated from where every doe sits in her cycle

---

## Configuration (per farm, with per-doe overrides)

```yaml
gestation:
  expected_days: 31
  window_start_day: 28        # nest box goes in
  window_end_day: 34          # normal kindling range ends
  overdue_day: 35             # alert: failed pregnancy or missing record

pregnancy_check:
  first_check_day: 12         # palpation window 10-14
  first_check_window: [10, 14]
  recheck_day: 28             # before nest box, catches resorption

# This farm counts the rebreed from WEANING, not from kindling.
rhythm: semi_intensive        # intensive | semi_intensive | extensive
rebreed_anchor: weaning       # kindling | weaning
wean_at_days: 30              # "separate the bunnies"
rebreed_after_weaning_days: 3 # 3-4 days after separating
rebreed_after_kindling_days: 21   # used only when rebreed_anchor = kindling

rest_periods:
  after_failed_service_days: 14
  after_pseudopregnancy_days: 18
  after_abortion_days: 21
  after_weaning_days: 0       # extensive systems may add rest here

age_gates:                    # by breed size, days
  doe_first_mating: { small: 135, medium: 150, large: 180, giant: 250 }
  buck_first_mating: { small: 165, medium: 180, large: 210, giant: 270 }

buck_limits:
  max_services_per_day: 2
  max_services_per_week: 4
  rest_days_after_heavy_use: 2

inbreeding:
  block_shared_parent: true
  warn_shared_grandparent: true

culling_flags:
  failed_services_in_a_row: 3
  low_weaning_litters_in_a_row: 2
  low_weaning_threshold: 5

banding:
  enabled: false
  breeding_weekday: tuesday   # all matings on one weekday for labour planning

# Medication courses. Farm-defined; nothing is hard-coded to a medicine name.
medication_protocols:
  - name: Hosto (pre-delivery)
    anchor: expected_kindling   # service date + 31
    start_offset_days: -5       # begins 5 days before expected kindling
    doses: 5
    interval_days: 1            # daily
  - name: Hosto (post-delivery)
    anchor: kindling            # the actual kindling date
    start_offset_days: 1        # begins the day after she kindles
    doses: 5
    interval_days: 1
```

Every one of these must be editable in the app by the owner. A farmer who cannot
change "wean at 32 days" to "wean at 35 days" will abandon the app.

---

## Rule 1 — Deriving the pregnant list

For each doe, take her **latest mating** and walk this decision tree:

```
latest_mating = most recent mating for this doe

if a litter exists for latest_mating:
    → LACTATING (until weaned) → then RESTING / READY
    stop

latest_check = most recent pregnancy_check for latest_mating
days = days_between(latest_mating.mated_at, today)

if latest_check exists:
    if latest_check.result == 'negative':
        → OPEN   (confidence: confirmed_negative)
    if latest_check.result == 'positive':
        if days >= 35 → OVERDUE  (needs human attention, do NOT count as pregnant)
        if days >= 28 → NEST_BOX (confidence: confirmed)
        else          → PREGNANT (confidence: confirmed)
    if latest_check.result == 'uncertain':
        → treat as no check, but raise "recheck" task

if no check exists:
    if days < 10  → MATED            (too early to know)
    if days <= 14 → MATED + task "palpate now, window closing"
    if days < 28  → PREGNANT (confidence: presumed) + overdue palpation task
    if days < 35  → NEST_BOX (confidence: presumed) + urgent "confirm" task
    if days >= 35 → OVERDUE — flag for review, do not count as pregnant
```

### The headline query the farmer asked for

> **"How many females are pregnant?"**

```sql
SELECT
  count(*) FILTER (WHERE confidence = 'confirmed') AS confirmed_pregnant,
  count(*) FILTER (WHERE confidence = 'presumed')  AS presumed_pregnant,
  count(*)                                          AS total_pregnant
FROM v_doe_reproductive_state
WHERE state IN ('PREGNANT', 'NEST_BOX');
```

Never collapse those two columns into one. See [02-data-model.md](02-data-model.md#confirmed-vs-presumed-pregnancy).

---

## Rule 2 — The ready-to-mate queue

> **"Which females are ready for mating?"**

A doe is eligible when **all** of these hold:

| # | Condition | Why |
|---|---|---|
| 1 | `status = 'active'` (not quarantine, sold, culled, dead) | Obvious, but quarantine is easily forgotten |
| 2 | `sex = 'doe'` and `role IN ('breeder','replacement')` | Growers are not breeding stock |
| 3 | Age ≥ first-mating age for her breed size | Breeding too early damages the doe and the litter |
| 4 | Not currently `MATED`, `PREGNANT`, `NEST_BOX` | She is already in a cycle |
| 5 | Not within pseudopregnancy window (18 days from sterile mating) | She will refuse the buck; a wasted trip |
| 6 | Rest interval served, counted from the configured anchor: days since **weaning** ≥ 3 (this farm), or days since kindling ≥ 21 | The rhythm setting |
| 7 | Previous litter weaned | Implied by the weaning anchor — a nursing doe has no weaning date yet, so she cannot qualify |
| 8 | Days since last failed service ≥ `after_failed_service_days` | Give her a receptivity wave to come round |
| 9 | No open health hold (illness, treatment, withdrawal, poor body condition) | Never breed a sick doe |

Eligible does are then **ranked** so the stockman works the list top-down:

```
priority score =
    (days_overdue_for_rebreeding      × 3)   # falling behind rhythm costs the most
  + (observed_receptive_recently      × 25)  # she's ready right now — go
  + (lifetime_weaning_performance     × 2)   # proven does first
  − (failed_services_last_90_days     × 15)  # deprioritise repeat failures
  − (days_since_last_body_condition_check × 0.5)
```

The ranking is a convenience, not a verdict. The screen shows the **reason** for
each doe's position ("18 days since kindling · 2 days overdue · last checked
receptive yesterday") so the stockman can disagree with it. An unexplained
ranked list is a black box, and staff ignore black boxes.

### Reference SQL

```sql
CREATE OR REPLACE VIEW v_ready_to_mate AS
WITH state AS (
  SELECT * FROM v_doe_reproductive_state
)
SELECT
  r.id,
  r.tag,
  r.name,
  s.state,
  s.days_since_last_kindling,
  s.days_since_last_service,
  s.consecutive_failed_services,
  GREATEST(0, s.days_since_last_kindling - f.rebreed_after_kindling_days)
      AS days_overdue,
  rc.receptivity AS last_observed_receptivity,
  rc.checked_on  AS receptivity_checked_on
FROM rabbit r
JOIN state s              ON s.rabbit_id = r.id
JOIN farm_settings f      ON f.farm_id = r.farm_id
JOIN breed b              ON b.id = r.breed_id
LEFT JOIN LATERAL (
    SELECT receptivity, checked_on
    FROM receptivity_check
    WHERE rabbit_id = r.id
    ORDER BY checked_on DESC
    LIMIT 1
) rc ON true
WHERE r.sex = 'doe'
  AND r.status = 'active'
  AND r.role IN ('breeder', 'replacement')
  AND age(current_date, r.date_of_birth)
      >= make_interval(days => b.doe_first_mating_days)
  AND s.state IN ('READY', 'OPEN', 'RESTING', 'LACTATING')
  AND (s.days_since_last_kindling IS NULL
       OR s.days_since_last_kindling >= f.rebreed_after_kindling_days)
  AND (s.days_since_pseudopregnancy IS NULL
       OR s.days_since_pseudopregnancy >= f.after_pseudopregnancy_days)
  AND (s.days_since_failed_service IS NULL
       OR s.days_since_failed_service >= f.after_failed_service_days)
  AND NOT EXISTS (
        SELECT 1 FROM health_event h
        WHERE h.rabbit_id = r.id
          AND h.blocks_breeding
          AND (h.cleared_on IS NULL OR h.cleared_on > current_date)
      );
```

> This is a reference design to validate against real data, not final code. In
> particular `v_doe_reproductive_state` will likely need to be a materialised
> view or a maintained projection table once the herd passes a few hundred
> animals — the recursive event walk gets expensive.

---

## Rule 3 — Buck selection

Given a doe, suggest bucks that are:

1. **`active`, of breeding age, no health hold**
2. **Under service quota** — services in the last 7 days < `max_services_per_week`, and today's services < `max_services_per_day`
3. **Not closely related** —
   - **Block** if buck is the doe's sire, son, or full/half sibling (shares a parent)
   - **Warn** if they share a grandparent
4. Ranked by **conception rate over the last 20 services**, then by lowest recent workload (spreads the load, keeps every buck proven)

```
suggest_bucks(doe):
    candidates = active bucks of breeding age, no health hold
    candidates = filter(candidates, services_last_7d < max_per_week)
    candidates = filter(candidates, services_today < max_per_day)

    for buck in candidates:
        rel = relatedness(doe, buck)
        if rel.shares_parent:      buck.blocked = true, reason = "full/half sibling or parent"
        elif rel.shares_grandparent: buck.warning = "shares a grandparent"

    return sort(candidates, by = [conception_rate desc, services_last_7d asc])
```

The relatedness check only needs two generations to catch the failures that
actually happen in small rabbitries. A full coefficient-of-inbreeding
calculation is a later refinement, not MVP.

---

## Rule 4 — Automatic task generation

Every night (and on every relevant write), the engine regenerates open tasks.
This is what turns the app from a record book into a system that runs the farm.

| Trigger | Task generated | Due | Priority |
|---|---|---|---|
| Mating at day 0 | **Palpate doe {tag}** | day 12 (window 10–14) | High |
| Positive palpation | **Re-check doe {tag} before nest box** | day 28 | Medium |
| Day 27 of confirmed pregnancy | **Place nest box for doe {tag}** | day 28 | **Critical** |
| Day 28–34 | **Check nest for kindling — doe {tag}** | daily | High |
| Day 35, no kindling | **Doe {tag} overdue — inspect and update record** | today | **Critical** |
| Kindling recorded | **Count and check litter {id}** | day+1 | High |
| Litter day 10 | **Kit eye check — litter {id}** | day 10 | Low |
| Litter day 18 | **Start creep feed — litter {id}** | day 18 | Medium |
| Litter at `wean_at_days` (day 30) | **Separate the kits — litter {id}**, record count and weight | that day | High |
| Weaning + `rebreed_after_weaning_days` | **Rebreed doe {tag}** | day 33 from kindling | High |
| Doe enters ready queue | **Breed doe {tag}** | that day | Medium |
| Each scheduled medication dose | **{protocol} — dose N of M for {tag}** | that day | High |
| Vaccination due | **Vaccinate {tags}** | due date | High |
| 3 failed services | **Cull review: doe {tag}** | today | Medium |

Task completion **writes back into the record**. Completing "Palpate doe D-104"
opens the palpation form; the result recorded there is what moves her state.
Tasks must never be a separate to-do list that drifts from the animal records —
that duplication is how these systems rot.

---

---

## Rule 5 — Medication protocols

A protocol is a course of doses defined **once** and applied automatically to
every doe who reaches the anchor event. The farm defines them; no medicine name
is hard-coded anywhere in the app.

```
protocol = (name, anchor, start_offset_days, doses, interval_days)

anchor ∈ { mating, expected_kindling, kindling, weaning }
```

### The two courses this farm runs

| Course | Anchor | Offset | Doses | Falls on |
|---|---|---|---|---|
| **Hosto (pre-delivery)** | expected kindling | −5 | 5 daily | Service days 26, 27, 28, 29, 30 |
| **Hosto (post-delivery)** | actual kindling | +1 | 5 daily | The 5 days after she kindles |

### Why the two courses anchor differently

This is the subtle part, and getting it wrong makes the pre-delivery course
useless.

The **post-delivery** course is easy: kindling already happened, so the date is
known exactly, and the five doses are simply the next five days.

The **pre-delivery** course has to start *before* the event it is counted from.
Kindling is a window (day 28–34), not a date — so the course anchors on
**expected** kindling, service date + 31, which is known from day 0. That places
the last dose on day 30, the day before she is expected to kindle.

Three consequences fall out of that, and all three are handled:

1. **She kindles early.** If she kindles on day 29, the day 29 and 30 doses stop
   being due the moment the kindling is recorded. Doses already given stay in
   her health record, so a course cut short is still visible.
2. **She is not actually pregnant.** Doses are only scheduled for cycles that
   have not been ruled out. A doe palpated negative is never scheduled a
   pre-delivery dose — which is a direct argument for palpating on day 12, since
   an unpalpated doe will otherwise be dosed on a pregnancy that does not exist.
3. **She kindles late.** Doses run out on day 30 and do not extend. The overdue
   alert at day 35 is what catches her.

### Marking a dose done

Recording the dose **is** the completion. A dose disappears from the daily list
because a matching `health_event` row exists for that protocol, doe and dose
number — not because a separate done-flag was flipped. Same principle as
reproductive status: no second copy of the truth to drift out of sync.

A dose given a day early or late still counts, so a caretaker who does the round
at 06:00 on Tuesday instead of 18:00 on Monday does not leave a phantom overdue
dose on the list forever.

> **If Hosto is an antibiotic**, set its `withdrawal_days` and the app will block
> the sale of that animal for meat until the period has elapsed. Worth confirming
> with whoever supplies it — the field exists either way, and leaving it empty is
> a decision, not a default.

---

## Rule 6 — Alerts (push notifications)

Keep these few. An app that notifies constantly gets muted, and then the one
notification that mattered is missed too.

| Alert | When | To whom |
|---|---|---|
| Medication dose due today | each dose day | Assigned caretaker |
| Nest box due today | day 28 | Assigned caretaker + manager |
| Separate the kits today | day 30 after kindling | Assigned caretaker |
| Rebreed doe today | 3 days after separating | Assigned caretaker + manager |
| Kindling window open | day 28–34, morning | Assigned caretaker |
| Overdue pregnancy | day 35 | Manager |
| Palpation window closing | day 14, unchecked | Assigned caretaker |
| Weaning due today | wean day | Assigned caretaker |
| Doe count ready to mate ≥ N | daily 07:00 | Manager |
| Mortality spike | > herd baseline | Owner + manager |
| Withdrawal period violation on a sale attempt | at sale entry | Blocks the sale |

---

## Edge cases the engine must handle

These are the cases that break naïve implementations. Decide each one now.

| Case | Handling |
|---|---|
| **Fostering** — kits moved to another doe | `litter.fostered_in/out` counts; weaning credit follows the *birth* doe for genetics, the *rearing* doe for milk performance. Report both |
| **Doe kindles on day 29** with no box placed | Allow kindling records outside the window; flag as a welfare miss in reports |
| **Backdated entry** — staff records Tuesday's mating on Friday | All event dates are user-editable with an audit trail. Never assume "now" |
| **Two matings in one cycle** (different bucks, 2 days apart) | Allow; mark paternity `uncertain`; exclude from buck conception statistics |
| **Doe dies while pregnant** | Close the mating as `terminated`; remove from pregnant count immediately |
| **Litter fully lost before weaning** | `weaned_count = 0`; doe returns to queue after abortion rest period |
| **Palpation says negative but she kindles anyway** | Kindling record always overrides; log the discrepancy against the checker to track palpation accuracy per person |
| **Rabbit sold or culled with an open cycle** | Close all open cycles on lifecycle change |
| **Clock/timezone change** | Compute all day counts in the farm's timezone, from date parts only |
