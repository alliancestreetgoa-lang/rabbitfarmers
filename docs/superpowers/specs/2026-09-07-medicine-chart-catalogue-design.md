# The medicine chart becomes the catalogue, and the farm gets a monthly routine

Source: `Rabbit_Farm_Medicine_Chart.xlsx` (two sheets: *Medicine Chart*, *Monthly
Routine*), compiled from the farm training session at Alliance Street Organic
Farms. Doses are as the trainer gave them. The sheet itself says to confirm
with a vet; the app repeats that on the report screen.

## What changes, in one paragraph

Everything the superadmin had curated before is retired and replaced by the
chart. A sickness may now carry **several medicines in sequence**, each with a
dose, a route, a rhythm, and **who must not get it** (pregnant does, kits under
three months, non-adults). Reporting a sickness on a rabbit starts every step of
its treatment; resolving it cancels what is left. Doses the rules forbid for
that particular rabbit are shown as a hold, never as "give it". Separately, the
farm gets a **monthly preventive routine**: from the 7th to the 16th of every
month the scheduler raises one whole-farm task per routine day, each of which is
pushed to the phone every morning until it is ticked, and the app shows the
month's plan with what has been done.

## Part 1 — the sickness catalogue

### Reportable sicknesses (what a farmer picks from)

| code | Name shown | Colour | Remind every | Contagious | Blocks breeding | Advice shown on report |
|---|---|---|---|---|---|---|
| `loose_motion` | Loose motion / dysentery | #EA580C | 2 h | yes | yes | Stop green fodder immediately. Usually clears in two doses. |
| `cold` | Cold — sneezing or wet, runny nose | #2563EB | 12 h | yes | yes | For a severe cold, nebulize (steam) 2–3 times a day as well. |
| `fungus` | Fungus on skin — ears, nose or paws | #7C3AED | 24 h | yes | yes | Apply with a toothbrush dipped in the lotion, directly on the patch. |
| `fungus_severe` | Severe fungus | #5B21B6 | 24 h | yes | yes | Adults only. Never inject on consecutive days — 48 hours minimum between shots. |
| `fever` | Fever / dullness — not eating, sitting in a corner, hot ears | #DC2626 | 6 h | no | yes | Inject when the ears feel hot. Belamyl MUST follow exactly one hour later. |
| `injury` | Wound — wire cut or fight | #B45309 | 24 h | no | yes | Mix the Xone powder with distilled water before injecting. |
| `retained_kits` | Failed to deliver after 35 days — kits retained | #9F1239 | 12 h | no | yes | Mix the Xone powder with distilled water before injecting. |
| `drooling` | Drooling / water from the mouth — ate something wrong | #0891B2 | 12 h | no | yes | — |
| `infertile` | Not fertile / not coming into heat | #A16207 | — | no | yes | Adult breeders only. Mix into the morning feed daily. |
| `stress` | Shifting stress or new feed — digestion upset | #65A30D | 24 h | no | no | Morning, on an empty stomach. Safe for all rabbits. |
| `sudden_deaths` | Sudden deaths on the farm (3–4 at once) — EMERGENCY | #7F1D1D | 6 h | yes | yes | Mix Lexin into the drinking water for the WHOLE farm immediately. Suspect the food or water. |

Retired (kept in history, gone from the picker on every farm): `off_feed`
(folded into `fever`), `sore_hocks`, `mastitis`, and any farm-local sickness
somebody added by hand (e.g. the production farm's `fungal_infection` with
camascab). Rule: after this migration, **only codes in the active catalogue are
active on any farm**.

`reminder_interval_hours` for existing `loose_motion` stays 2 (the migration
does not blank it); the others are new rows so they take the catalogue value.

### Treatments — several steps per sickness

New table `condition_catalog_treatment`, one row per medicine step:

```
condition_catalog_treatment
  id, catalog_id -> condition_catalog, step int (1..),
  medicine text, route text, dose text,
  doses int (1..60), interval_days int (1..30),
  note text,
  adults_only bool, min_age_days int, not_when_pregnant bool,
  withdrawal_days int
```

| Sickness | step | Medicine | Route | Dose | Doses × interval | Not for | Note |
|---|---|---|---|---|---|---|---|
| loose_motion | 1 | O2 M | oral | 1 ml | 2 × 1 day | — | Give one dose. If it persists the next day, give the second; it usually clears in two. |
| cold | 1 | Meriquin | oral | 1 ml | 2 × 1 day | — | Give once. If not cured after 24 hours, repeat. |
| fungus | 1 | Gamma Scab Lotion | topical | as needed | 3 × 1 day | — | Once a day for 2–3 days, on the affected area. |
| fungus_severe | 1 | Hitech (injection) | subcutaneous, behind the neck | 0.3 ml | 2 × 2 days | adults only; never pregnant; not under 90 days | Single dose. Repeat after 48 hours only if not cured. |
| fever | 1 | Gentamicin + Dexamethasone | injection | 0.3 ml (0.15 + 0.15) | 1 | — | Inject when the ears feel hot. |
| fever | 2 | Belamyl (B-complex) | injection | 0.3 ml | 1 | — | EXACTLY one hour after Gentamicin + Dexamethasone. |
| injury | 1 | Xone / X1 / C1 | injection (reconstituted) | 0.3 ml | 1 | — | Reconstitute with distilled water first. |
| retained_kits | 1 | Xone / X1 / C1 | injection (reconstituted) | 0.3 ml | 1 | — | Reconstitute with distilled water first. |
| drooling | 1 | Taxim | injection | 0.3 ml | 1 | — | — |
| infertile | 1 | Agrimin Forte | powder in morning feed | 1 g | 30 × 1 day | adults only | Continue daily until she comes into heat / he covers. |
| stress | 1 | Gutwell | powder into the mouth | a pinch | 3 × 1 day | — | Morning, empty stomach. |
| sudden_deaths | 1 | Lexin / Mix Powder | in drinking water, whole farm | 20 g per 100 L | 1 | — | Immediately. |

"Repeat only if not cured" is already how the engine works: resolving the
sickness cancels the remaining doses, so marking a cold *stopped* after one
Meriquin removes the second.

### Breeding courses (unchanged mechanism, updated to the chart)

`seed_medication_protocols` and the rows on every existing farm become:

- **Calcium Ostovet + Vimeral (pre-delivery)** — anchor `expected_kindling`,
  offset −5, 5 doses daily. Dose "1 ml (0.5 ml of each), mixed together, oral or in feed".
- **Calcium Ostovet + Vimeral (post-delivery)** — anchor `kindling`, offset +1,
  5 doses daily. Same dose.

### Per-farm shape (`medication_protocol`)

`apply_condition_catalog` presses every treatment step onto every farm as one
`medication_protocol` row named `medicine (sickness name)` — the existing
convention, which also keeps `(farm_id, name, anchor)` unique across two
sicknesses that share Xone. New columns on `medication_protocol`, copied from
the step: `step`, `route`, `dose`, `adults_only`, `min_age_days`,
`not_when_pregnant`. Steps that vanish from the catalogue are deactivated.

### Rules at dose time

`v_medication_schedule` gains `hold_reason text`:

- `'pregnant'` when `not_when_pregnant` and the rabbit's reproductive state is
  MATED / PREGNANT / NEST_BOX / OVERDUE (a mating counts as pregnant, per 0039);
- `'under 3 months'` when `min_age_days` is set and `farm_today − date_of_birth
  < min_age_days` (unknown birth date = grown, per 0038);
- `'not an adult'` when `adults_only` and role is `grower`, or age < 90 days.

`v_medication_due`, `GET /medication`, `v_daily_list` and `GET /daily` carry
`hold_reason` through. The apps render a held dose as **"Do not give — she is
pregnant. Ask the vet."** in place of the *Given* button. `POST /medication`
refuses to record a held dose with 409 and the reason; a vet who overrules can
still record it as a manual health event.

### Reporting

`GET /condition-types` returns `treatment` as an ordered **list** of steps
(`{ step, medicine, route, dose, doses, interval_days, note, adults_only,
min_age_days, not_when_pregnant }`) plus the sickness's `advice`.
`POST /conditions` echoes the same list, with `hold_reason` per step for *this*
rabbit, so the report screen can say at once "Hitech is not for her — she is
pregnant". Report screens (mobile + web) show the steps in order, the advice,
and the vet disclaimer.

### Admin console

`/admin/sicknesses` shows every catalogue row with its steps. The form edits:
name, colour, remind-every, contagious, blocks breeding, advice, and a
repeatable **medicine step** block (medicine, route, dose, doses, interval
days, note, adults only, not when pregnant, min age days). Saving replaces the
sickness's steps wholesale and presses the catalogue onto every farm, as today.

## Part 2 — the monthly routine

From the *Monthly Routine* sheet, re-dated on 2026-09-08 to the rotation as the
farm actually runs it (migration 0045; 0043 had laid it over days 1–7). Whole
farm, the 7th to the 16th of every month:

| Day | Task | Who is left out |
|---|---|---|
| 7, 8, 9 | Hitech (oral) 1 ml — morning, empty stomach. De-worming + fungus. | pregnant does, kits under 3 months |
| 13, 14, 15 | Liv 52 1 ml oral — liver tonic after the Hitech course. | kits under 3 months (in feed is fine) |
| 13, 14, 15 | Gutwell — a pinch into the mouth, morning, empty stomach. | — |
| 16 | Tetracycline — 1 g per litre of drinking water. Critical in the rainy season. | — |

Standing, printed on every routine task and on the routine screen, never raised
as a daily task: *Agrimin Forte 1 g per adult breeder in the morning feed, daily*;
*Calcium Ostovet + Vimeral may be mixed into the daily feed for the whole herd.*

### Mechanism

- `task_kind_t` gains `routine` (own migration, enum rule).
- `generate_routine_tasks()`: for every farm, insert this month's routine tasks
  whose `due_on ≥ farm_today`, `generated_key = 'routine:' || farm_id || ':' ||
  yyyy-mm || ':' || step`. A farm that joins on the 10th gets the 13th onward; a
  farm that joins on the 20th waits for next month. (Until 0045 this was
  confined to days 1–7.)
  Priority `high`; `rabbit_id` NULL (the daily list already renders rabbit-less
  tasks).
- `generate_notifications()` task arm: `routine` tasks notify regardless of
  priority (today only `critical` tasks push), once per farm-day per task,
  outside quiet hours. Kind stays `task_due`.
- The task's `title` is the medicine line; its `notes` is the who-is-left-out
  line plus the standing advice.
- Each farm's routine tasks are exempt from `assign_tasks_by_section` (no
  section to assign by; they stay with the owner/manager).
- `GET /routine` returns this month's plan with each step's task status, so the
  Health screen can show "This month's routine — 3 of 7 done".

## Migrations

```
0043_task_kind_routine.sql        ALTER TYPE task_kind_t ADD VALUE 'routine'
0044_medicine_chart.sql           condition_catalog_treatment; new columns on
                                  medication_protocol + condition_catalog(advice);
                                  apply_condition_catalog rewritten for steps;
                                  seed_new_farm loses its hard-coded five;
                                  seed_medication_protocols -> Ostovet + Vimeral;
                                  v_medication_schedule/_due/_daily_list with hold_reason;
                                  generate_due_tasks job 11; generate_notifications
                                  routine arm;
                                  DELETE old catalogue rows, INSERT the chart;
                                  rename existing Ostovet rows; apply to every farm;
                                  deactivate condition_type/protocols not in catalogue;
                                  self-check DO block.
```

The DELETE-and-reinsert on `condition_catalog` is the "remove whatever we had
before". `condition_type` rows on farms are never deleted (history, RLS, FK
from open cases) — they are deactivated.

## Testing

- `treatment.test.js`: multi-step treatment round-trips through admin →
  farm; report starts all steps; resolve cancels the rest; held doses carry a
  reason and `POST /medication` refuses them; a pregnant doe reported with
  `fungus_severe` is told so on the report response; every chart code is
  present and every retired code is gone from `/condition-types`.
- `scheduler.test.js`: routine tasks appear on day 1 with 7 steps, day 5 with
  3, day 20 with none; idempotent across passes; push queued outside quiet
  hours; `GET /routine` counts done steps.
- `db/verify.sql`: hold_reason for a pregnant doe and a kit; Ostovet + Vimeral
  rows.
- Existing suites stay green on a clean DB (349 → more).

## Out of scope

- The APK rebuild on EAS (needs the EAS credentials; web build ships).
- Litter-wide dosing (0036 left it out; still out).
- Per-rabbit exclusion inside routine tasks — the task text names who to skip;
  the app does not enumerate them.
