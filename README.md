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

**Stack:** Expo (React Native, exported to web) + Hono on Netlify Functions +
Neon serverless PostgreSQL, email-and-password sign-in, Razorpay for
subscriptions later. See [docs/06-tech-stack.md](docs/06-tech-stack.md) —
including the scheduling trap that would silently stop every reminder.

**Pricing:** 30-day full-access trial, then ₹99/month or ₹999/year — introductory,
with grandfathering enforced in the schema.

## Status

**The app, the backend and the admin CRM are built and tested.** Not deployed.

| Part | State |
|---|---|
| Database migrations, RLS, tenant isolation | Built, 9 isolation tests |
| Signup / sign in / sign out | Built, 10 tests |
| Breeding cycle, daily list, ready-to-mate, weaning, conditions | Built, 29 tests |
| Kits as individuals, with both parents linked | Built, 9 tests |
| Editing a rabbit — sexing a kit, renaming, cage moves | Built, 5 tests |
| Ostovet medicine rounds, 5 doses either side of kindling | Built, 6 tests |
| Rabbit history, corrections, animals leaving the herd | Built, 12 tests |
| Subscriptions, trial, grace, entitlements | Built, 4 tests |
| Super-admin CRM with audit trail | Built, 25 tests |
| Support impersonation — read-only, an hour, visible to the farm | Built, 13 tests |
| Staff: logins by phone, five roles enforced server-side, sections, attendance | Built, 26 tests |
| Push delivery — quiet hours, no duplicates, dead tokens retired | Built, 19 tests against a stub provider |
| Scheduler (task generation, 2-hourly reminders, heartbeat) | Built, 25 tests |
| Expo app — Today, Breeding, Herd, Team, Billing, recording, offline outbox | Built, 33 tests — 22 against the real API |
| Android / iOS binaries | Icons, native config and EAS profiles ready. **No APK built** — needs the Android SDK and a signing key |
| Netlify deployment | Configured and deployment-ready, **not deployed** |
| Razorpay billing — payment links, signed webhooks, GST invoices | Built, 25 tests against a stub gateway, plus a 27-check browser pass. Recurring mandates deferred |
| Admin billing — reconciliation, renewals, GST totals, offline payments | Built, 32 tests |

### Verify it yourself

```bash
./scripts/verify.sh
```

From nothing: applies the migrations, runs the 41 breeding-rule assertions, runs
the 246 API tests, then boots the server and hits real endpoints over HTTP —
including running the scheduler and confirming the day-28 nest box task reaches
the daily list. Uses `$DATABASE_URL` if you have one, otherwise starts a
throwaway `postgres:16` container and removes it afterwards.

### Run the whole thing locally

```bash
./scripts/localhost.sh
```

Database, migrations, an admin account, a farm with rabbits in it, the app
built, everything served on one port. Run it again and it keeps what is already
there. `--fresh` throws the database away, `--rebuild` rebuilds the app,
`--no-demo` leaves the farm empty.

Needs PostgreSQL 15+ running, or Docker, or a `DATABASE_URL` you set yourself.

<details><summary>Or the same thing by hand</summary>

```bash
cd apps/api && npm start                       # the API on :3000
ADMIN_PASSWORD='something long' npm run create-admin -- you@example.com "You"

npm --prefix apps/mobile run build:web         # build the app
node scripts/dev-site.mjs                      # both on http://localhost:8080
node scripts/demo-data.mjs                     # a farm with something in it
```

</details>

`:8080` serves the app and the API on one origin, exactly as Netlify will — the
farmer's app at `/`, the admin console at `/admin/login`. That matters: `/daily`
is both a screen and an endpoint, so a two-port setup cannot tell you which one
a deploy would answer with.

Deploying is [docs/11-deploying-to-netlify.md](docs/11-deploying-to-netlify.md).

### The next thing to build

**Store builds.** The web export is what gets deployed, and it installs to a
home screen from the browser. There is no APK in the repo: the icons, the native
config and the EAS build profiles are here, but producing a binary needs the
Android SDK and a signing key, and neither belongs in git. One command on a
machine that has them, or none at all: **Actions → Android APK → Run workflow**
builds it on Expo's servers and hands back a downloadable APK, once two secrets
are set. See [docs/12-android-and-ios-builds.md](docs/12-android-and-ios-builds.md).

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
| [docs/12-android-and-ios-builds.md](docs/12-android-and-ios-builds.md) | Getting an installable APK, signing, and why a native build has to be told where its server is. |
| [apps/api](apps/api) | The backend and admin CRM, with its own README. |
| [apps/mobile](apps/mobile) | The Expo app — Today, Breeding, Herd, recording, and the offline outbox. |
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

## Nothing about a rabbit is ever deleted

A doe's matings, her litters, her illnesses and her line are the farm's record
and outlive her. So:

- **There is no endpoint that deletes an animal.** She is marked sold, culled or
  died, with a reason, and that becomes another line in her history.
- **Postgres enforces it too.** `mating.doe_id`, `litter.doe_id` and
  `rabbit.dam_id` are deliberately not `ON DELETE CASCADE`, so a rabbit who has
  ever bred cannot be removed even from a psql prompt. There is a test that
  tries.
- **Corrections keep both values.** Editing a kindling record writes the old and
  new values into `audit_log`, and the doe's timeline gains a line saying what
  changed and who changed it. "Eight — no, nine" is a fact about the record, not
  an overwrite.
- **Status is a log, not a column.** Quarantined in March, back in service in
  April, sold in November — three facts, all kept.
- **Kits become individuals, with both parents on the record.** A litter is a
  count in the nest box and an animal each once they are separated. That link is
  what lets the buck suggestion refuse a doe her own father four years later.

`GET /animals/:id/history` returns the whole timeline, and it keeps working
after she has gone. That is the point: her record is most useful exactly when
she is no longer in front of you.

## The one design rule

**Never store a rabbit's status as an editable field. Derive it from events.**

A doe is not "pregnant" because someone ticked a box. She is pregnant because
there is a mating record on 3 March, a positive palpation on 15 March, and no
kindling record yet. If you store a `is_pregnant` boolean, it will drift out of
sync with reality within a month and the app becomes untrustworthy — at which
point staff go back to the paper card and the project is dead.

Record events. Compute state. See [docs/03-breeding-engine.md](docs/03-breeding-engine.md).
