# 05 — Features and Screens

## Scope discipline

The failure mode for farm apps is building everything and shipping nothing
usable. The MVP boundary below is deliberately tight: it covers the two questions
the farm actually asked for, plus the minimum around them to make the data real.

| Phase | Included |
|---|---|
| **MVP** | **Daily tab**, animals (manually named), cages, matings, pregnancy checks, kindling, separating kits, **medication protocols**, **health conditions with repeating reminders**, ready-to-mate queue, pregnant dashboard, tasks, employees, attendance |
| **Phase 2** | Vaccination schedules, weights & growth, feed & inventory, reports/KPIs |
| **Phase 3** | Sales & finance, payroll, pedigree certificates, multi-farm, buyer portal |

---

## Screen inventory

### 0. Daily — the tab that opens on login

**This is the landing screen, not the dashboard.** Open the app and this is what
you see: everything due today, in one list, with nothing else to navigate to.

```
┌──────────────────────────────────────────────┐
│  ●  Daily      Herd   Breeding   More        │
├──────────────────────────────────────────────┤
│  TUESDAY 16 AUGUST              9 to do      │
├──────────────────────────────────────────────┤
│  NEEDS A LOOK NOW                     2      │
│  ●  Loose motion → Ganga        31h  ⚠       │
│  ●  Loose motion → Rani          6h          │
├──────────────────────────────────────────────┤
│  OVERDUE                              1      │
│  ○  Ostovet 3 of 5 → Lakshmi   yesterday     │
├──────────────────────────────────────────────┤
│  TODAY                                6      │
│  ○  Ostovet 5 of 5 → Rani                    │
│     last dose before delivery                │
│  ○  Ostovet 2 of 5 → Chandni                 │
│  ○  Nest box → Rani            day 28        │
│  ○  Separate kits → Meera      30 days       │
│  ○  Rebreed → Sita             buck: Raja    │
│  ○  Palpate → Kaveri           day 12        │
├──────────────────────────────────────────────┤
│  ✓  Ostovet 2 of 5 → Lakshmi     06:14       │
│  ✓  Nest box → Gauri             06:20       │
└──────────────────────────────────────────────┘
```

Behaviour, exactly as specified:

| Rule | Implementation |
|---|---|
| Opens automatically on login | Daily is the default tab, always first |
| Shows what is due today | Medication doses, husbandry tasks and open health conditions in one merged list |
| Open health conditions pin to the top | They stay listed continuously, not only at the 2-hourly reminder |
| Overdue items surface above today's | Sorted by due date ascending, oldest first |
| **Tap to mark done → it leaves the list** | Completion writes the underlying record; the item drops out of the query on the next render |
| Completed items stay visible until midnight | Greyed at the bottom with a timestamp, so a caretaker can see what they already did and undo a mistake |
| Badge count on the tab icon | Open items only; goes to zero when the day's work is finished |

The "done" list at the bottom matters more than it looks. Without it, a farm hand
who marks something done by accident has no way to see or undo it, and an owner
cannot tell "nothing due" apart from "nobody opened the app today".

Nothing on this screen is a separate to-do list. Marking an Ostovet dose done writes
a health record against that doe; marking a palpation done opens the result form.
The list is a *view* of outstanding work, which is why an item cannot be ticked
off without the underlying record actually existing.

### 1. Dashboard (home)

The owner's morning overview, one tab across from Daily.

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

### 4. Animal registry — added and named by hand

Every rabbit is entered manually by you, with a name you choose. No
auto-generated codes: if the doe is called *Lakshmi*, the app says Lakshmi
everywhere — daily list, notifications, reports.

Add a rabbit: **name → male or female → breed → date of birth → cage →
mother and father (if bred here) → photo.** Only name and sex are required, so a
doe can be entered in about ten seconds and filled in later.

Two notes on this:

- **The sex picker says male and female, with "doe" and "buck" underneath.**
  The breeding screens use the rabbitry terms throughout and should — they are
  precise. But this is the screen where someone entering stock on their first
  morning has to be certain, and a buck filed as a doe joins the ready-to-mate
  queue and never kindles. The plain words lead; the pairing is taught here and
  repeated on the animal's own page.

- **An optional short tag alongside the name.** Names get duplicated on a farm
  (two does called Rani) and reused after an animal dies. A short unique tag —
  even just `D-01` — stops the app confusing them, while still displaying the
  name everywhere. Enforced unique; the name is not.
- **Parents matter more than they look.** Filling in mother and father is what
  lets the app block inbred pairings later. For your founding stock, leave them
  blank; for anything born on the farm, the app fills them in itself from the
  litter.

### 5. Animal profile

Header: name, tag, photo, breed, sex, age, cage, current state badge.
Tabs:
- **Timeline** — every event in one chronological feed: matings, checks,
  kindlings, weanings, weights, treatments, moves
- **Breeding history** — table of cycles with outcomes and a running conception rate
- **Pedigree** — 3-generation tree from `dam_id`/`sire_id`
- **Health** — treatments, vaccinations, active withdrawal periods
- **Performance** — litters, kits weaned, mortality vs. herd average

### 6. Record mating

Doe (pre-filled) → buck (suggested, with inbreeding badges) → date/time
(defaults now, editable for backdating) → services observed (1/2) → receptivity
observed (receptive / not / unknown) → notes → save.

On save, the engine immediately schedules the palpation task for day 12 and the
nest box task for day 28, and shows the computed due window as confirmation.

### 7. Record kindling

Litter size born alive / born dead → nest condition → doe condition → notes →
photo (optional). Auto-creates the litter, closes the mating, and schedules
day-10 and day-18 checks, the day-30 separation, and the five post-delivery
Ostovet doses. It also closes any remaining pre-delivery doses.

### 8. Record separating the kits

Number separated → total or average weight → where they went (grower cages /
kept as replacement / sold) → save.

This is the KPI moment — kits weaned per doe per year is counted here — so the
form has to be fast and hard to skip. On save it schedules the rebreed task for
three days later.

### 9. Health conditions and the loose-motion flag

**Reporting it** — from any animal, one tap: *Report a problem → Loose motion →
mild / moderate / severe → save.* Any staff member can do this; it needs no
permission and no manager.

**While it is open**, the rabbit carries an orange mark everywhere it appears:

```
┌────────────────────────────────────────┐
│  Herd · Shed B                          │
├────────────────────────────────────────┤
│   Lakshmi     D-104   Pregnant, day 22  │
│ ● Rani        D-117   Loose motion 6h   │
│   Meera       D-089   Nursing, 12 kits  │
│ ● Ganga       D-051   Loose motion 31h ⚠│
└────────────────────────────────────────┘
```

The dot is always paired with the words "Loose motion" — never colour alone.
Colour-blindness is common, and a phone screen in Goa sunlight washes colour out
entirely.

**The reminder** arrives every 2 hours and offers two answers:

| Answer | Effect |
|---|---|
| **Still loose** | Logs the observation, restarts the 2-hour clock |
| **Stopped** | Resolves it — mark gone, reminders stop, breeding queue released |

**On the cage map**, an affected cage is filled orange. That is the view that
shows you a spreading problem: three orange cages in one row is a feed or water
problem, not three unlucky rabbits.

**Escalation and outbreak.** Open past 24 hours and the manager is told. Two or
more open cases in one shed raises an outbreak warning — loose motion spreads via
shared feed, water and soiled bedding, so the second case is the one worth acting
on, not the fifth.

**Afterwards**, the condition stays in the animal's history with its full check
trail. "Loose 3 days, mild throughout" and "mild, then severe overnight" are
different animals and different decisions, and only the check history tells them
apart. A doe with repeat episodes surfaces in the cull review.

### 10. Medication protocols (settings)

Define a course once and it applies to every doe automatically from then on:

**Name → what it counts from → how many days before or after → how many doses →
how often.**

Your two Ostovet courses are the first entries. Adding a dewormer or a vaccine
later is the same form, no code change.

The "counts from" choice is the only part that needs thought:

| Counts from | Use when | Example |
|---|---|---|
| Expected delivery | The course must start *before* she kindles | Ostovet, 5 days before |
| Actual delivery | The course starts after she kindles | Ostovet, 5 days after |
| Mating | Tied to service, not birth | — |
| Separating the kits | Tied to weaning | — |

### 11. Tasks and rosters

Manager's view of the same work the Daily tab shows a caretaker — who is assigned
what, what is unassigned, and what is running late. See
[04-employee-module.md](04-employee-module.md#the-daily-work-screen-a-farm-hands-entire-app).

### 12. Cages / shed map

Visual grid of sheds → rows → cages. Each cage shows occupant tag and state
colour. Empty cages highlighted (idle capacity is lost income). Tap to move an
animal, which writes a `movement` record.

### 13. Employees

List, profiles, roles, attendance calendar, task completion stats.

### 14. Reports (Phase 2)

Lead with **kits weaned per doe per year**. Then conception rate by buck, by doe
and by staff member; pre-weaning mortality by shed; kindling interval
distribution; doe league table with cull suggestions; feed conversion.

Every report exports to CSV/Excel. Farmers and their accountants live in
spreadsheets; an app that traps data is worse than the paper it replaced.

### 15. Settings

Farm profile and timezone · breeding rhythm and all constants from
[03-breeding-engine.md](03-breeding-engine.md#configuration-per-farm-with-per-doe-overrides)
· **medication protocols** · breeds and their age gates · sheds and cages · roles
· languages · notification preferences · data export and backup.

The settings that matter most on this farm, and their current values:

| Setting | Value |
|---|---|
| Loose motion reminder | every 2 hours until marked stopped |
| Quiet hours | 22:00 – 06:00, catch-up at 06:00 |
| Separate the kits | 30 days after delivery |
| Rebreed | 3 days after separating |
| Nest box in | day 28 |
| Palpate | day 12 |
| Ostovet, before delivery | 5 daily doses, ending the day before expected delivery |
| Ostovet, after delivery | 5 daily doses, starting the day after delivery |

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
