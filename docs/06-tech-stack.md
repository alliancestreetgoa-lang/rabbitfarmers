# 06 — Technology Stack

## Recommendation

| Layer | Choice | Why |
|---|---|---|
| **Database** | **Neon** (serverless PostgreSQL) | Chosen. Postgres is right for this relational, report-heavy domain; Neon adds branching and scale-to-zero |
| **Mobile app** | React Native via **Expo** | One codebase for Android and iOS; Android is what matters on a farm. Expo removes most native build pain and supports over-the-air updates — valuable when staff never update apps manually |
| **Local database** | **SQLite** on device (`expo-sqlite` or WatermelonDB) | Offline-first is a hard requirement, not a feature |
| **Sync** | **PowerSync** or a custom outbox queue over your API | Bidirectional sync with conflict handling |
| **API layer** | Next.js route handlers or Hono on **Vercel / Cloudflare Workers** | Neon is a database, not a backend — this is the part Supabase would have given you |
| **Auth** | **Email + password**, no verification — via Clerk/Auth0, or self-hosted with `user_session`. Issues JWTs that Neon RLS validates | Signup friction costs signups; see [10-admin-console.md](10-admin-console.md) |
| **Row-level security** | **Neon RLS** via `pg_session_jwt`, `auth.user_id()` | Tenant isolation enforced in the database, not the application |
| **File storage** | **Cloudflare R2** (or S3) | Neon has no object store; photos need one, with per-farm scoping |
| **Business logic** | PostgreSQL views and functions for state derivation | Every client gets identical answers to "who is pregnant" |
| **Scheduled jobs** | **External scheduler** — see the warning below | This is the one that will bite you |
| **Notifications** | Expo Push Notifications | Free, works with the Expo stack |
| **Billing** | **Razorpay** subscriptions (UPI Autopay + e-NACH) | Stripe India still does not support the rails Indian recurring payments run on |
| **Web dashboard** (Phase 2) | Next.js sharing the same API | The owner wants a laptop view for reports; farm hands only need the phone |
| **Reporting exports** | CSV / XLSX generated client-side | Everyone downstream lives in spreadsheets |

### What Neon gives you, and what it does not

Neon is Postgres-as-a-service, not a backend platform. Worth being clear about
the trade, because it is a good choice but a different shape of work:

**What you gain**
- **Branching** — a throwaway database per pull request, and a staging branch
  that is a copy of production. For a product where a bad migration could
  corrupt breeding records across every customer, this is a genuine safety net.
- **Scale-to-zero** — near-zero cost while you have three customers.
- **Connection pooling** built in, which matters from serverless functions.
- **Neon RLS** — JWTs from Clerk or Auth0 validated in the database, so tenant
  isolation is enforced in Postgres rather than trusted to application code.

**What you now assemble yourself** (Supabase would have bundled these)
- Auth → Clerk, Auth0, or Neon Auth
- Object storage for photos → Cloudflare R2 or S3
- Serverless functions → Vercel or Cloudflare Workers
- Scheduled jobs → external, see below

None of that is hard. It is a handful of extra vendors and a day or two of
wiring, in exchange for better database ergonomics.

---

## ⚠ The scheduling trap — read this before writing any code

**Neon's scale-to-zero suspends the compute when idle, and `pg_cron` only runs
while the compute is awake. There is no wake-on-cron.**

`pg_cron` is available on Neon, so it will look like it works. It will work all
day while you are testing. Then your farm goes quiet overnight, the compute
suspends, and:

- the 02:00 nightly task regeneration never runs
- the day-28 nest box alert is never generated
- the 2-hourly loose motion reminder stops firing

Nobody gets an error. The reminders simply do not arrive, and the first you hear
about it is a customer who lost a litter. **For an app whose entire value is
time-based reminders, this is the single biggest architectural risk in the
project.**

Two ways out:

| Option | Trade-off |
|---|---|
| **External scheduler** (recommended) — Vercel Cron, Cloudflare Workers Cron, GitHub Actions or Inngest hitting an endpoint that runs the SQL | Costs nothing, keeps scale-to-zero, and the wake-up call itself brings the compute back. Also gives you retries and failure alerts, which `pg_cron` does not |
| **Disable scale-to-zero** on the branch that hosts the schedule | Simple, but you pay for compute 24/7 and lose Neon's main cost advantage |

Take the external scheduler. Then add the check that actually saves you: a
**heartbeat** — if the scheduler has not run in the last 30 minutes, alert
*yourself*. A reminder system that fails silently is worse than no reminder
system, because people have stopped watching for the thing themselves.

---

## Tenant strategy: one database, not one per farm

Neon's branching makes database-per-tenant tempting. Do not — emphatically not at
₹99/month. A farm paying ₹99 cannot carry its own compute, and migrations across
hundreds of branches become a job in themselves.

**One database, `farm_id` on every table, RLS enforcing it.** Revisit only if you
land an enterprise customer who contractually demands physical isolation.

## Why not the alternatives

- **Flutter** — a perfectly good choice; pick it instead if the developer you hire
  knows Dart. The architecture in these documents is framework-agnostic. Do not
  let a stack debate delay the domain modelling, which is the hard part.
- **Firebase / Firestore** — excellent offline support, but this domain is deeply
  relational (pedigrees, cycles, cross-entity reports). Modelling pedigree
  queries and herd KPIs on a document store means fighting the database on every
  report. Choose Postgres.
- **Pure web app / PWA** — cheaper to build, but offline reliability, camera,
  barcode scanning and push notifications are all weaker, and those are exactly
  the shed-side requirements. A PWA is a reasonable *prototype* to validate the
  workflow before committing to native.
- **Off-the-shelf software** (Everbreed, Kintraks, FarmKeep and similar) — genuinely
  worth trialling before building anything. They cover pedigree, breeding history
  and basic finances well. Where they generally fall short for a commercial
  operation like this one is **employee management, task assignment and
  accountability**, which is precisely the half you specifically asked for. Trial
  one for a month regardless: a month of using someone else's app will sharpen
  your own requirements more than any amount of planning.

---

## Architecture sketch

```
┌──────────────────────────────────────────────────────┐
│  Expo / React Native app                             │
│    UI  →  local SQLite  →  sync outbox queue         │
│    Works fully offline. Queue drains when online.    │
└───────────────┬──────────────────────────────────────┘
                │ HTTPS, JWT from the auth provider
┌───────────────▼──────────────────────────────────────┐
│  API — Vercel / Cloudflare Workers                   │
│    sync endpoints · entitlement checks               │
│    Razorpay webhooks · push dispatch                 │
└───────────────┬──────────────────────────────────────┘
                │ pooled connection, JWT forwarded
┌───────────────▼──────────────────────────────────────┐
│  Neon — serverless PostgreSQL                        │
│    tables:  farm, rabbit, mating, litter, task,      │
│             employee, health_condition,              │
│             subscription, invoice, user_session,     │
│             platform_admin, admin_audit_log …        │
│    views:   v_doe_reproductive_state, v_daily_list,  │
│             v_ready_to_mate, v_farm_entitlement,     │
│             v_admin_farm_overview                    │
│    RLS:     pg_session_jwt → auth.user_id()          │
│    branches: one per pull request + staging          │
└──────────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────┐
   │  External scheduler (Vercel Cron / Workers Cron) │
   │    NOT pg_cron — Neon suspends and it stops.     │
   │    · nightly task regeneration                   │
   │    · 2-hourly condition reminders                │
   │    · overdue detection, daily digest             │
   │    · heartbeat: alert if a run is missed         │
   └───────────────┬──────────────────────────────────┘
                   │ wakes Neon, runs the SQL
                   └──────────────► Neon

   Auth — email + password, issues the JWT
   Admin CRM — separate domain, RLS-bypassing role, every action audited
   Cloudflare R2 — animal photos, per-farm scoped
   Razorpay — UPI Autopay / e-NACH subscriptions
```

---

## Offline conflict strategy

Two staff recording the same event on two phones, both offline, is a real and
frequent scenario. Decide the policy up front:

| Data type | Policy |
|---|---|
| **Events** (mating, kindling, weighing, treatment) | **Append-only.** Never overwrite. Two records of the same kindling become a *duplicate warning* for a manager to merge, not a silent overwrite |
| **Attributes** (name, cage, notes) | Last-write-wins on a per-field basis, with the loser retained in the audit log |
| **Derived state** | Never synced. Always recomputed server-side from events |
| **Task completion** | First completion wins; later ones become no-ops |
| **IDs** | Generate **UUIDs on the client** so offline records never collide on sync |

Append-only events plus client-generated UUIDs eliminate most sync pain before it
starts. This is worth getting right in week one; retro-fitting it is a rewrite.

---

## Indicative cost

Running a SaaS, not one farm — so these are fixed costs you carry from day one,
before anyone pays you.

| Item | Monthly |
|---|---|
| Neon Free (0.5 GB, fine for building and the first customers) | $0 |
| Neon Launch (when you outgrow it — autoscaling, PITR, branches) | ~$19 |
| Vercel or Cloudflare Workers (API + cron) | $0–$20 |
| Auth provider, e.g. Clerk (free to ~10k monthly active users) | $0–$25 |
| Cloudflare R2 (photos; no egress fees, which matters) | ~$1–5 |
| Expo EAS build & OTA updates | $0–$19 |
| SMS for password reset (~₹0.15–0.25 per message, MSG91 or similar) | usage |
| Razorpay | ~2% per transaction, no monthly fee (₹2 on ₹99, ₹20 on ₹999) |
| Google Play developer account | $25 one-off |
| Domain + landing page | ~$15/yr |

**Roughly ₹2,000–7,500/month ($25–90) to run before revenue.** At ₹99/month you
keep about ₹82 net of GST and gateway fees, so infrastructure breaks even at
around **30–90 paying farms**. Text records are tiny; **photos** are what grows
storage, so compress on device before upload.

Two costs that surprise people, and both bite hard at a ₹99 price point:

- **Unverified signup is free to abuse.** A 30-day trial with no card and no
  verification is trivially farmed. It costs compute rather than money, but a
  thousand junk farms makes the admin console useless — rate-limit signups per IP.
- **Support time** is your largest cost by far and appears on no invoice. At ₹82
  net per farm per month, roughly five minutes of WhatsApp is the entire margin.
  This is the real argument for spending the extra week on onboarding.

---

## Build effort estimate

For one competent full-stack mobile developer:

| Phase | Effort |
|---|---|
| MVP for one farm (animals, breeding cycle, ready-to-mate, daily tab, medication protocols, health conditions, tasks, employees, attendance, offline sync) | **10–14 weeks** |
| **SaaS layer** (signup, onboarding templates, one plan + Razorpay, trial/grace handling, RLS hardening, cross-tenant tests) | **+3–5 weeks** |
| **Super-admin CRM** (farm list, subscription controls, audit log, impersonation, revenue screen) | **+2 weeks** |
| Phase 2 (vaccination, feed, weights, reports, web dashboard) | 6–8 weeks |
| Phase 3 (sales, finance, payroll, pedigree certificates) | 6–8 weeks |

Two risks dominate that estimate. **Offline sync** is the larger one — budget
generously, or ship an online-only prototype first and add sync once the domain
model has stopped moving. **Tenant isolation** is the more dangerous one: it is
not slow to build, but a mistake in it is fatal to the business rather than
merely annoying, so it needs the automated cross-tenant test suite from the
first week rather than the last.
