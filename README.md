# Rabbit Farm Manager

A rabbit farm management application covering
**breeding (mating, gestation, kindling, weaning)**, **medication rounds**,
**health alerts** and **staff management** — built to be sold to farmers as a
monthly or yearly subscription.

The two questions this app exists to answer, instantly, from a phone in the shed:

1. **How many does are pregnant right now?** (and which ones are due this week)
2. **Which does are ready to mate today?** (and with which buck)

Everything else — medication rounds, health alerts, feed, growth, sales, staff —
supports those two.

**Stack:** Expo (React Native) + Neon serverless PostgreSQL, email-and-password
sign-in, Razorpay for subscriptions. See [docs/06-tech-stack.md](docs/06-tech-stack.md)
— including the scheduling trap that would silently stop every reminder.

**Pricing:** 30-day full-access trial, then ₹99/month or ₹999/year — introductory,
with grandfathering enforced in the schema.

## Status

**Backend and admin CRM are built and tested.** The mobile app is not started.

| Part | State |
|---|---|
| Database migrations, RLS, tenant isolation | Built, 9 isolation tests |
| Signup / sign in / sign out | Built, 10 tests |
| Breeding cycle, daily list, ready-to-mate, conditions | Built, 8 tests |
| Subscriptions, trial, grace, entitlements | Built, 4 tests |
| Super-admin CRM with audit trail | Built, 14 tests |
| Scheduler (task generation, 2-hourly reminders) | **Not built** — see the note below |
| Netlify deployment | Configured, not deployed |
| Expo mobile app | Not started — deliberately deferred |
| Razorpay billing | Not started — deliberately deferred |

### Verify it yourself

```bash
./scripts/verify.sh
```

From nothing: applies the migrations, runs the 41 breeding-rule assertions, runs
the 45 API tests, then boots the server and hits real endpoints over HTTP. Uses
`$DATABASE_URL` if you have one, otherwise starts a throwaway `postgres:16`
container and removes it afterwards.

Then poke at it by hand:

```bash
cd apps/api && npm start                    # http://localhost:3000
ADMIN_PASSWORD='something long' npm run create-admin -- you@example.com "You"
                                            # then http://localhost:3000/admin/login
```

Deploying is [docs/11-deploying-to-netlify.md](docs/11-deploying-to-netlify.md).

### The next thing to build

The **scheduler**. Nothing yet generates the day-28 nest box task or fires the
2-hourly loose-motion reminder. It must run from an external scheduler rather
than `pg_cron` — Neon suspends idle computes and cron jobs then stop firing with
no error anywhere. See [docs/06-tech-stack.md](docs/06-tech-stack.md).

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
| [docs/09-saas-model.md](docs/09-saas-model.md) | Pricing, plans, billing, tenant isolation, onboarding, go-to-market. |
| [docs/10-admin-console.md](docs/10-admin-console.md) | Signup and sign-in, and the super-admin CRM for running every farm and subscription. |
| [docs/11-deploying-to-netlify.md](docs/11-deploying-to-netlify.md) | Netlify + Neon setup, environment variables, and what to check after a deploy. |
| [apps/api](apps/api) | The backend and admin CRM, with its own README. |
| [db/migrations](db/migrations) | Ordered, immutable migrations — the source of truth for the schema. |
| [db/verify.sql](db/verify.sql) | Fixtures that prove the derived-state logic returns the right answers. |

## Verifying the schema

The schema is not just a sketch — it runs, and the logic is tested against the
cases that break naive implementations: overdue pregnancy, pseudopregnancy,
nursing doe, under-age doe, doe under veterinary hold, a medication course
cancelled by an early kindling, a loose-motion reminder cycle, a suspended
subscription that must still fire its reminders, and a price rise that must not
touch a single existing customer.

```bash
createdb rabbitry
cd apps/api && npm run migrate
psql -d rabbitry -v ON_ERROR_STOP=1 -f ../../db/verify.sql
```

Expected output ends with `ALL CHECKS PASSED` after 41 assertions. The fixtures
roll back, so the database is left as it was. Verified on PostgreSQL 16; Neon
runs Postgres, so it applies unchanged.

## The one design rule

**Never store a rabbit's status as an editable field. Derive it from events.**

A doe is not "pregnant" because someone ticked a box. She is pregnant because
there is a mating record on 3 March, a positive palpation on 15 March, and no
kindling record yet. If you store a `is_pregnant` boolean, it will drift out of
sync with reality within a month and the app becomes untrustworthy — at which
point staff go back to the paper card and the project is dead.

Record events. Compute state. See [docs/03-breeding-engine.md](docs/03-breeding-engine.md).
