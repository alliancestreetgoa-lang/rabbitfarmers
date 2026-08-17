# 04 — Employee Module

> **Status: built**, apart from the parts marked deferred below. Staff sign in
> with a phone number, the permission matrix is enforced in the API (not the
> UI), sheds route work automatically, and attendance exports to CSV.
> `apps/api/src/permissions.js` is the matrix; `test/staff.test.js` checks every
> role against an endpoint it must not reach.
>
> **Deferred, on purpose:** payroll and wage computation, shift rosters,
> GPS/QR attendance verification, per-employee UI language, and the
> accountability metrics at the bottom of this page. Each is called out where it
> appears.

The employee side is not a separate HR app bolted on. Its value comes from being
**wired into the breeding calendar**: the breeding engine generates the work, the
employee module assigns it, and completion writes back into the animal records.

```
Breeding engine ──generates──► Tasks ──assigned to──► Employees
       ▲                                                  │
       └──────────── results written back ────────────────┘
```

---

## Roles and permissions

| Role | Can do | Cannot do |
|---|---|---|
| **Owner** | Everything, including finances, payroll, settings, deleting records | — |
| **Farm manager** | All animal and task operations, assign work, approve leave, view reports | Payroll rates, delete history, billing |
| **Caretaker / farm hand** | Complete assigned tasks, record matings, palpations, kindlings, weanings, feeding, mortality, weights | See financials, other staff's pay, edit past records beyond a grace window |
| **Veterinarian** | Read all animal records, write health events, prescriptions, withdrawal periods | Breeding decisions, finances, staff |
| **Accountant** | Read/write sales, expenses, payroll; read herd summary | Individual animal records, health data |

Implementation note: enforce this **server-side**, never only in the UI. A farm
hand's phone is a shared device in practice.

*Built.* One table in `apps/api/src/permissions.js` rather than role checks
scattered through the routes — a matrix you can read in one screen is a matrix
somebody will notice is wrong. Every route names the action it needs, and the
refusal names who to ask rather than which check failed. Tenant isolation stays
where it was, in row-level security; roles sit above it, because every employee
of a farm is inside the same tenant.

### The edit-window rule

*Built* — `canEditRecord` in `permissions.js`, applied to editing a rabbit and
editing a kindling.

Farm hands can edit their own entries for **24 hours**, then the record locks and
needs a manager to change it. Without this, mistakes are never corrected (too
scary to ask) or history is quietly rewritten (worse). With it, honest fixes are
easy and audit integrity holds.

---

## Employee record

| Field | Notes |
|---|---|
| Name, photo | Photo matters — shared devices, low literacy contexts |
| Phone | Also the login identity. Farm workers reliably have a phone number, not an email. **Password, not OTP** — there is no SMS provider, so a manager sets a temporary password and reads it out once. A phone is unique among accounts that can sign in, so somebody works at one farm |
| Role, assigned sheds/rows | Scopes their task list to their section |
| Employment type | Permanent / daily wage / piece rate / contract |
| Join date, wage rate, pay cycle | Feeds payroll |
| ID document, emergency contact | Compliance and safety |
| Languages | Drives UI language default |
| Active / inactive | Never delete an employee — history references them |

---

## Attendance

- **Check in / check out** from the phone, one tap.
- *Built:* one-tap check in and check out from the top of Today, a manager
  marking anybody, a monthly summary and a CSV export.
- **Verification options** — *deferred*, none built. Worth choosing only once a
  farm is actually using the plain version:
  - GPS geofence around the farm (simplest, works offline with queued sync)
  - QR code posted in each shed (cheap, no GPS drain, harder to fake from home)
  - Manager marks attendance (fallback for staff without smartphones)
- **Leave and absence** with type (paid / unpaid / sick / holiday) and approval.
- **Overtime** captured as hours beyond the standard shift.
- **Monthly attendance summary** exports to payroll.

Offline is mandatory here: sheds have poor signal, and attendance that fails to
record because of a dead network is the fastest way to lose staff trust in the
whole app.

---

## Task assignment and accountability

### Assignment strategies

1. **By section** (default) — each caretaker owns specific sheds/rows and
   automatically receives every task for animals housed there. *Built:*
   `assign_tasks_by_section()`, run by the scheduler after each generation pass.
   A shed with **two** caretakers leaves its work unassigned on purpose — the
   farm has not decided who owns it, and picking one produces work that looks
   assigned and is nobody's.
2. **By skill** — *deferred.* The `can_palpate` flag is recorded and editable;
   nothing routes on it yet. Palpation and health treatments should route only
   to staff flagged as trained. Palpation accuracy varies enormously between people; an untrained
   palpation is worse than none, because it produces a confident wrong answer.
3. **Manual** — *deferred.* A manager cannot yet hand one task to one person.

### The daily work screen (a farm hand's entire app)

```
┌────────────────────────────────────────┐
│  Ravi · Shed B          Tue 16 Aug     │
│  ▸ Checked in 06:12                    │
├────────────────────────────────────────┤
│  DUE TODAY                       6      │
│                                         │
│  🔴 Nest box → D-104        day 28     │
│  🔴 Nest box → D-117        day 28     │
│  🟠 Palpate  → D-089        day 12     │
│  🟠 Check nest → D-076   day 30 of 34  │
│  🟡 Wean litter L-45      32 days      │
│  🟡 Breed → D-032    ready, 3d overdue │
│                                         │
│  OVERDUE                         1      │
│  🔴 Palpate → D-051     day 16 ⚠       │
└────────────────────────────────────────┘
```

Design constraints for this screen, learned from how these apps fail:

- **One screen, no navigation.** If a farm hand has to hunt for today's work, they
  will use the paper card instead.
- **Big tap targets.** This is used with cold, wet or gloved hands.
- **Every task completes in ≤ 3 taps**, with the outcome captured inline.
- **Works fully offline**, syncing when the phone reaches wifi.
- **Local language**, selectable per employee.

### Accountability metrics (per employee) — deferred

The data to compute all of these is already recorded; nothing reports on it yet.


Use these to coach, not to punish — and say so openly to staff, or they will
start falsifying entries and the data becomes worthless.

| Metric | What it reveals |
|---|---|
| Tasks completed on time % | Reliability |
| Nest boxes placed on day 28 (not 30) | Attention to the highest-cost detail |
| Palpation accuracy (checks vs. eventual kindlings) | Training need |
| Pre-weaning mortality in their section | Husbandry quality — compare against herd average, not zero |
| Conception rate of matings they performed | Technique (though buck and doe matter more) |
| Days since last data entry | Adoption — an empty section means the app is being bypassed |

---

## Payroll (Phase 3, not MVP) — deferred, as planned

Deliberately deferred. Payroll is a large, regulation-heavy build, and every
country's rules differ. Building it early would delay the breeding features that
are the actual reason for this app.

MVP does the useful 20%: attendance records that **export to CSV/Excel** so
whoever runs payroll today keeps running it, with better inputs.

Later phases can add: wage computation from attendance, piece-rate (per litter
weaned, per cage cleaned), advances and deductions, payslip generation.

---

## Shift and roster planning — deferred

For farms large enough to need it:

- Weekly roster per shed, with cover for leave.
- **Critical-task coverage warning:** if nobody is rostered on a day when nest
  boxes are due, warn the manager in advance. A missed nest box can cost an
  entire litter — that is real money, and it is the kind of thing a roster
  screen should shout about.
- Banded breeding (see [01-domain-research.md](01-domain-research.md#5-rebreeding-rhythms--the-biggest-management-decision))
  makes rostering dramatically easier, because the workload lands on predictable
  weekdays instead of scattering across the month.
