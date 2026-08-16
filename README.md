# Rabbit Farm Manager — Planning Repository

Planning and design documents for a rabbit farm management application covering
**breeding (mating, gestation, kindling, weaning)** and **staff management**.

The two questions this app exists to answer, instantly, from a phone in the shed:

1. **How many does are pregnant right now?** (and which ones are due this week)
2. **Which does are ready to mate today?** (and with which buck)

Everything else — health, feed, growth, sales, staff — supports those two.

## Status

This repository currently contains **planning documents only**. No application
code has been written yet. The intent is to settle the domain model and the
rules before writing software, because the breeding rules are where a rabbit
app succeeds or fails.

## Documents

| Document | What it covers |
|---|---|
| [docs/01-domain-research.md](docs/01-domain-research.md) | Rabbit reproduction biology and husbandry, with sources. Every number the app hard-codes traces back to here. |
| [docs/02-data-model.md](docs/02-data-model.md) | Entities, relationships, and the doe lifecycle state machine. |
| [docs/03-breeding-engine.md](docs/03-breeding-engine.md) | The rules: pregnancy tracking, the "ready to mate" queue, buck selection, auto-generated tasks. |
| [docs/04-employee-module.md](docs/04-employee-module.md) | Roles, permissions, attendance, task assignment and accountability. |
| [docs/05-features-and-screens.md](docs/05-features-and-screens.md) | Screen-by-screen feature list, MVP scope boundary. |
| [docs/06-tech-stack.md](docs/06-tech-stack.md) | Recommended stack, offline-first strategy, cost estimate. |
| [docs/07-roadmap.md](docs/07-roadmap.md) | Phased build plan and success metrics. |
| [docs/08-open-questions.md](docs/08-open-questions.md) | Decisions needed from the farm owner before building. |
| [db/schema.sql](db/schema.sql) | Reference PostgreSQL schema for the MVP. |
| [db/verify.sql](db/verify.sql) | Fixtures that prove the derived-state logic returns the right answers. |

## Verifying the schema

The schema is not just a sketch — it runs, and the breeding logic is tested
against eleven edge cases (overdue pregnancy, pseudopregnancy, nursing doe,
under-age doe, doe under veterinary hold, and so on):

```bash
createdb rabbitfarm
psql -d rabbitfarm -v ON_ERROR_STOP=1 -f db/schema.sql
psql -d rabbitfarm -v ON_ERROR_STOP=1 -f db/verify.sql
```

Expected output ends with `ALL CHECKS PASSED`. The fixtures roll back, so the
database is left empty. Verified on PostgreSQL 16.

## The one design rule

**Never store a rabbit's status as an editable field. Derive it from events.**

A doe is not "pregnant" because someone ticked a box. She is pregnant because
there is a mating record on 3 March, a positive palpation on 15 March, and no
kindling record yet. If you store a `is_pregnant` boolean, it will drift out of
sync with reality within a month and the app becomes untrustworthy — at which
point staff go back to the paper card and the project is dead.

Record events. Compute state. See [docs/03-breeding-engine.md](docs/03-breeding-engine.md).
