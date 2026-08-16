# 05 — Features and Screens

## Scope discipline

The failure mode for farm apps is building everything and shipping nothing
usable. The MVP boundary below is deliberately tight: it covers the two questions
the farm actually asked for, plus the minimum around them to make the data real.

| Phase | Included |
|---|---|
| **MVP** | Animals, cages, matings, pregnancy checks, kindling, weaning, ready-to-mate queue, pregnant dashboard, tasks, employees, attendance |
| **Phase 2** | Health & vaccination, weights & growth, feed & inventory, reports/KPIs |
| **Phase 3** | Sales & finance, payroll, pedigree certificates, multi-farm, buyer portal |

---

## Screen inventory

### 1. Dashboard (home)

The one screen the owner opens every morning.

```
┌──────────────────────────────────────────────┐
│  Sunrise Rabbitry            Tue 16 Aug      │
├──────────────────────────────────────────────┤
│   PREGNANT           READY TO MATE           │
│      24                    11                │
│   19 confirmed        4 overdue              │
│    5 presumed ⚠                              │
├──────────────────────────────────────────────┤
│   NURSING    GROWERS    BUCKS    TOTAL       │
│      18        243        6       312        │
├──────────────────────────────────────────────┤
│  DUE THIS WEEK                               │
│  Nest boxes        7   Wed–Fri               │
│  Kindlings         5   window open           │
│  Weanings          3   Thu                   │
│  Palpations        9   Tue–Sat               │
├──────────────────────────────────────────────┤
│  NEEDS ATTENTION                             │
│  ⚠ D-051 overdue day 37 — no kindling        │
│  ⚠ 5 does presumed pregnant, never palpated  │
│  ⚠ D-018 failed 3 services — cull review     │
├──────────────────────────────────────────────┤
│  THIS MONTH                                  │
│  Kits weaned/doe/yr   42.1  ▲                │
│  Conception rate      74%   ▼                │
│  Pre-wean mortality   11%   ▲                │
└──────────────────────────────────────────────┘
```

Every number is tappable and drills through to the underlying list. A dashboard
figure you cannot drill into is decoration.

### 2. Pregnant does

List view, grouped by due window, sorted by expected kindling date.

Per row: tag, days pregnant, expected kindling date, due window, confidence badge
(confirmed/presumed), buck, cage, next task.
Filters: confirmed / presumed / due this week / overdue.
Bulk action: mark nest boxes placed for a whole group.

### 3. Ready to mate ← *the screen the farm asked for*

Ranked list with the **reason** shown per doe:

```
D-032  Californian · Cage B-14
       Ready · 24 days since kindling (3 overdue)
       Last litter: 8 weaned · Lifetime 7.8/litter
       Suggested bucks:  B-03 ✓ 78%   B-07 ✓ 71%
                         B-01 ⛔ shares sire
       [ Record mating ]
```

Tapping a suggested buck opens the mating form pre-filled. The record-mating
screen carries the reminder: **take the doe to the buck's cage, never the
reverse.**

### 4. Animal profile

Header: tag, photo, breed, sex, age, cage, current state badge.
Tabs:
- **Timeline** — every event in one chronological feed: matings, checks,
  kindlings, weanings, weights, treatments, moves
- **Breeding history** — table of cycles with outcomes and a running conception rate
- **Pedigree** — 3-generation tree from `dam_id`/`sire_id`
- **Health** — treatments, vaccinations, active withdrawal periods
- **Performance** — litters, kits weaned, mortality vs. herd average

### 5. Record mating

Doe (pre-filled) → buck (suggested, with inbreeding badges) → date/time
(defaults now, editable for backdating) → services observed (1/2) → receptivity
observed (receptive / not / unknown) → notes → save.

On save, the engine immediately schedules the palpation task for day 12 and the
nest box task for day 28, and shows the computed due window as confirmation.

### 6. Record kindling

Litter size born alive / born dead → nest condition → doe condition → notes →
photo (optional). Auto-creates the litter, closes the mating, and schedules
day-10, day-18 and weaning tasks.

### 7. Record weaning

Number weaned → total or average weight → destination (grower cages / retained as
replacement / sold) → save. Weaning is the KPI moment; make this form fast and
unavoidable.

### 8. Tasks / today

See [04-employee-module.md](04-employee-module.md#the-daily-work-screen-a-farm-hands-entire-app).

### 9. Cages / shed map

Visual grid of sheds → rows → cages. Each cage shows occupant tag and state
colour. Empty cages highlighted (idle capacity is lost income). Tap to move an
animal, which writes a `movement` record.

### 10. Employees

List, profiles, roles, attendance calendar, task completion stats.

### 11. Reports (Phase 2)

Lead with **kits weaned per doe per year**. Then conception rate by buck, by doe
and by staff member; pre-weaning mortality by shed; kindling interval
distribution; doe league table with cull suggestions; feed conversion.

Every report exports to CSV/Excel. Farmers and their accountants live in
spreadsheets; an app that traps data is worse than the paper it replaced.

### 12. Settings

Farm profile and timezone · breeding rhythm and all constants from
[03-breeding-engine.md](03-breeding-engine.md#configuration-per-farm-with-per-doe-overrides)
· breeds and their age gates · sheds and cages · roles · languages · notification
preferences · data export and backup.

---

## Cross-cutting requirements

| Requirement | Why it is not optional |
|---|---|
| **Offline-first** | Sheds have no signal. Every write must queue locally and sync later |
| **≤ 3 taps per record** | Beat the paper card or lose to it |
| **Multi-language** | Farm hands may not read English. Language is per-employee |
| **Large touch targets, high contrast** | Used outdoors, in sunlight, with dirty hands |
| **QR / barcode on cage cards** | Scan to open the animal — far faster and less error-prone than typing a tag |
| **Full audit trail** | Who recorded what, when, and what changed |
| **Export everything** | Data portability builds trust and prevents lock-in resentment |
| **Photo capture** | Nest condition, injuries, buyer listings |

## Explicitly out of scope for v1

Named so they do not creep in:

- IoT sensors, automatic weighing, RFID gates
- AI weight estimation from photos
- Marketplace / buyer-facing storefront
- Genetic coefficient-of-inbreeding calculation beyond 2 generations
- Full payroll with statutory deductions
- Feed formulation / ration balancing
