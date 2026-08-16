# 07 — Roadmap

## Phase 0 — Before writing any code (1–2 weeks)

Cheap work that prevents expensive mistakes.

1. **Answer the open questions** in [08-open-questions.md](08-open-questions.md).
   Herd size and breeding rhythm change the design meaningfully.
2. **Collect 20 real doe cards** from the farm. Model against real handwriting
   and real edge cases — the fostered litter, the doe who kindled on day 34, the
   card with a crossed-out date. Designing from an idealised cycle is how apps
   end up unable to record what actually happened.
3. **Shadow a farm hand for one full day.** Time how long a paper record takes.
   That number is the bar the app must beat, and it is usually about 8 seconds.
4. **Trial an existing app** (Everbreed or similar) for a month. Either it solves
   enough of the problem and you save months of work, or you finish the month
   with a precise list of what is missing. Both are wins.
5. **Freeze the MVP scope in writing.** Everything else goes on a Phase 2 list
   that nobody is allowed to touch until the MVP is in daily use.

---

## Phase 1 — MVP (10–14 weeks)

**Goal:** every doe on the farm is tracked in the app, the paper cards are
retired, and both headline questions are answered on the phone.

| Sprint | Deliverable |
|---|---|
| 1–2 | Data model, Supabase schema, RLS, auth, farm/shed/cage setup |
| 3–4 | Animal registry: create, edit, tags, photos, pedigree links, cage assignment, QR scan |
| 5–6 | Breeding cycle: record mating, palpation, kindling, weaning; state derivation engine |
| 7 | Pregnant dashboard + ready-to-mate queue + buck suggestion with inbreeding checks |
| 8–9 | Task generation, today's-work screen, push notifications |
| 10 | Employees, roles, permissions, attendance |
| 11–12 | Offline sync, conflict handling, field testing in the shed |
| 13–14 | Data migration from paper, staff training, bug fixing |

**Definition of done for the MVP:** a farm hand with no training beyond a
ten-minute walkthrough records a mating, a palpation and a weaning without
asking for help, and the owner can answer "how many are pregnant" in one tap.

---

## Phase 2 — Operations (6–8 weeks)

- Health module: treatments, vaccination schedules, **withdrawal periods that
  block sales**, mortality with causes, quarantine
- Weights and growth curves; weaning and market weight tracking
- Feed inventory, consumption per shed, feed conversion ratio
- Reports and KPIs, led by kits weaned per doe per year
- Web dashboard for the owner
- CSV/Excel export throughout

---

## Phase 3 — Business (6–8 weeks)

- Sales: fryers, breeding stock, manure; customer records; invoices
- Expenses and profit-and-loss, including per-doe profitability
- Payroll from attendance; piece rates; advances
- Pedigree certificate generation for breeding-stock sales
- Multi-farm support

---

## Phase 4 — Optional extensions

Only if the earlier phases are in genuine daily use.

- Buyer-facing catalogue of available stock
- Sell the app to other rabbit farmers (multi-tenancy is already built in)
- Sensors: shed temperature and humidity logging
- Predictive culling suggestions from accumulated performance data

---

## Success metrics for the project itself

Measure the app, not just the rabbits.

| Metric | Target | Why it matters |
|---|---|---|
| Paper cards still in use | 0 by week 4 post-launch | Parallel systems mean the app lost |
| Matings recorded within 24h of happening | > 95% | Late entry means the task engine is working from stale data |
| Does palpated within the day 10–14 window | > 90% | Directly reduces the "presumed pregnant" bucket |
| Presumed (unconfirmed) pregnancies | < 10% of pregnant does | The clearest sign the workflow is being followed |
| Nest boxes placed on day 28 | > 95% | The highest-cost detail on the farm |
| Daily active staff | 100% of caretakers | Adoption |
| Kits weaned per doe per year | Baseline first, then improve | The point of the whole exercise |

Record the **current** values of the last metric before launch. Without a
baseline you will never know whether the app helped, and that is the number that
justifies the entire build.
