# 06 — Technology Stack

## Recommendation

| Layer | Choice | Why |
|---|---|---|
| **Mobile app** | React Native via **Expo** | One codebase for Android and iOS; Android is what matters on a farm. Expo removes most native build pain and supports over-the-air updates — valuable when staff never update apps manually |
| **Local database** | **SQLite** on device (via `expo-sqlite` or WatermelonDB) | Offline-first is a hard requirement, not a feature |
| **Sync** | **PowerSync** or Supabase Realtime + a custom outbox queue | Bidirectional sync with conflict handling |
| **Backend** | **Supabase** (PostgreSQL + Auth + Storage + Row-Level Security) | Postgres is the right database for this relational, report-heavy domain. RLS enforces the permission model in the database rather than the UI. Cheap to start, no server to run |
| **Auth** | Phone OTP | Farm workers have phone numbers, not reliably email addresses |
| **Business logic** | PostgreSQL views + functions for state derivation; Edge Functions for task generation and notifications | Keeping the breeding rules in the database means every client sees identical answers |
| **Scheduled jobs** | `pg_cron` in Supabase | Nightly task regeneration, overdue detection, daily digest |
| **Notifications** | Expo Push Notifications | Free, works with the Expo stack |
| **Web dashboard** (Phase 2) | Next.js sharing the Supabase client | The owner will want a laptop view for reports; farm hands only need the phone |
| **Reporting exports** | CSV / XLSX generation client-side | Everyone downstream lives in spreadsheets |

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
┌─────────────────────────────────────────────────────┐
│  Expo / React Native app                            │
│  ┌──────────────────────────────────────────────┐   │
│  │  UI  →  local SQLite  →  sync outbox queue   │   │
│  └──────────────────────────────────────────────┘   │
│  Works fully offline. Queue drains when online.     │
└──────────────────────┬──────────────────────────────┘
                       │  HTTPS / WebSocket
┌──────────────────────▼──────────────────────────────┐
│  Supabase                                           │
│                                                     │
│  PostgreSQL                                         │
│    tables:  rabbit, mating, pregnancy_check,        │
│             litter, task, employee, attendance …    │
│    views:   v_doe_reproductive_state,               │
│             v_ready_to_mate, v_pregnant_does        │
│    RLS:     per farm, per role                      │
│                                                     │
│  Edge Functions   nightly task generation,          │
│                   overdue detection, digests        │
│  pg_cron          schedules the above               │
│  Storage          animal photos, documents          │
│  Auth             phone OTP                         │
└─────────────────────────────────────────────────────┘
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

| Item | Monthly |
|---|---|
| Supabase Free tier (fine to launch: 500 MB database, 1 GB storage) | $0 |
| Supabase Pro (when you outgrow it — 8 GB database, daily backups) | ~$25 |
| Expo EAS build & OTA updates | $0–$19 |
| Google Play developer account | $25 one-off |
| Apple developer account (only if iOS is needed) | $99/yr |
| Domain + landing page | ~$15/yr |

A rabbitry of a few hundred animals will run comfortably on the free tier for a
long time. Text records are tiny; **photos** are what will push you to a paid
plan, so compress on device before upload.

---

## Build effort estimate

For one competent full-stack mobile developer:

| Phase | Effort |
|---|---|
| MVP (animals, breeding cycle, ready-to-mate, dashboard, tasks, employees, attendance, offline sync) | **10–14 weeks** |
| Phase 2 (health, feed, weights, reports, web dashboard) | 6–8 weeks |
| Phase 3 (sales, finance, payroll, pedigree certificates) | 6–8 weeks |

The single largest risk to that estimate is **offline sync**. Budget generously
for it, or start with an online-only prototype to validate the workflow and add
sync once the domain model has stopped moving.
