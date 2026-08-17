# Rabbitry API

The backend: farmer-facing API plus the super-admin CRM. Node 22, Hono,
PostgreSQL (Neon in production, any Postgres 15+ locally).

## Setup

```bash
npm install
cp .env.example .env          # then edit the connection strings
npm run migrate               # applies db/migrations, then db/seed.sql
npm start                     # http://localhost:3000
```

Create the first platform admin, then sign in at `/admin/login`:

```bash
ADMIN_PASSWORD='something long and unguessable' \
  node src/create-admin.js you@example.com "Your Name" superadmin
```

## Two database roles, and why

| Env var | Role | Bypasses RLS |
|---|---|---|
| `DATABASE_URL` | `rabbitry_app` | **No** — this is the point |
| `ADMIN_DATABASE_URL` | `rabbitry_admin` | Yes — the CRM reads across every tenant |

Farm requests must only ever use `DATABASE_URL`. Every query runs inside a
transaction with `app.farm_id` set transaction-locally, so a pooled connection
cannot carry one farm's context into the next request, and row-level security —
not application `WHERE` clauses — is what keeps tenants apart.

Setting up the roles on a fresh database:

```sql
CREATE ROLE app_login   LOGIN PASSWORD '...';
CREATE ROLE admin_login LOGIN PASSWORD '...';
GRANT rabbitry_app   TO app_login;    -- created by migration 0006
GRANT rabbitry_admin TO admin_login;
```

## Tests

```bash
npm test
```

184 tests against a real database — no mocks, because the parts most worth
testing here (RLS, view security, the derived breeding state) only exist in
Postgres. They create and clean up their own data, scoped by process id so the
files can run concurrently.

The suite that matters most is `test/isolation.test.js`. It found two real bugs
during the build and both are worth knowing about:

- **Foreign keys bypass RLS.** Postgres checks FK constraints as the referenced
  table's owner, so one farm could create a mating pointing at another farm's
  doe. Fixed structurally in migration `0007` by making `farm_id` part of every
  cross-table key: `(farm_id, doe_id) → rabbit(farm_id, id)` simply cannot match
  across tenants.
- **Views run as their owner, not their caller.** A plain view evaluates the
  underlying RLS against whoever owns the view, so every view was returning
  every farm's rows. Migration `0008` sets `security_invoker = true` on all of
  them, and a test now fails the build if a new view is added without it.

Both were invisible from the application side. That is the argument for testing
isolation against the database rather than trusting the query layer.

## Layout

```
src/
  db.js           two pools; withFarm() sets the tenant context per transaction
  auth.js         scrypt hashing, session tokens, signup validation
  middleware.js   session resolution, entitlement gate, error mapping
  permissions.js  who may do what — one table, enforced server-side
  app.js          route wiring
  routes/
    auth.js       signup, signin, signout, me
    farm.js       animals, breeding cycle, conditions, daily list, settings
    staff.js      the team, sheds, logins, attendance
    admin.js      the super-admin CRM
    scheduler.js  the run trigger and the heartbeat
  admin-ui.js     server-rendered admin pages (no build step)
  scheduler.js    task and notification generation, plus health
  push.js         getting a notification onto a phone
  run-scheduler.js  run one pass from a shell
  migrate.js      migration runner
  create-admin.js first platform admin
```

## Notes worth keeping in mind

**Reminders never stop.** The entitlement gate blocks *writes* when a
subscription lapses. Reads, exports and the daily list keep working on every
status including `suspended`, because a billing failure must never cost a
litter. There is a test asserting this.

**Calendar dates stay strings.** `DATE` columns are parsed as `YYYY-MM-DD`
rather than `Date` objects. A kindling date is a day on the farm, not an
instant, and converting it attaches the server's timezone to it.

**A farm hand signs in with their phone.** The owner has an email; staff are
given a login by their manager and know a phone number, not an email. A phone is
unique only among accounts that have a password (a partial unique index in
migration 0024), so the lookup at sign-in cannot be ambiguous — two farms may
hold the same contact number, only one may make it a login.

**Roles are one table, not scattered checks.** `permissions.js` holds the matrix
from docs/04 and every route names the action it needs. A permission that only
hides a button is not a permission: a farm hand's phone is a shared device, and
`test/staff.test.js` checks each role against an endpoint it must not reach.

**Support impersonation is an ordinary farm session.** `POST
/admin/farms/:id/impersonate` mints a session on the owner's employee row bound
to a row in `admin_impersonation`, so RLS scopes it exactly like the farmer's
phone. Read-only is enforced in `requireAuth` as a blanket rule on the HTTP
method rather than a guard on the write routes — `/auth/password`,
`/auth/signout` and `/notifications/read` carry no write guard, and those are
precisely the ones that must not be reachable. See `test/impersonation.test.js`.

**Push is an improvement on opening the app, never a replacement.** Every part
of registration is allowed to fail — a declined permission, Expo Go, a browser,
a simulator — and all of them end with the app working exactly as before, with
the same reminders on Today. The moment push becomes load-bearing, every farmer
whose phone silently revoked the permission stops being told about a kindling.

Three properties decide whether a farmer keeps notifications turned on, and all
three live in `v_push_queue` rather than in the sender: never the same thing
twice (a row per notification *per device*, so two phones both hear and neither
hears twice), nothing outside quiet hours unless it is critical, and never a
backlog — a phone that has been off for a week does not get a week of alerts,
and a phone registered this morning gets none of yesterday's. Receipts are
checked on a later pass, which is where `DeviceNotRegistered` usually arrives;
skipping that is why push systems quietly accumulate dead tokens.

**The scheduler runs from outside the database.** `src/scheduler.js` generates
tasks and notifications; Netlify's scheduled function calls it every 15 minutes.
Deliberately *not* `pg_cron`, which stops running whenever Neon suspends an idle
compute, with no error anywhere.

Run a pass by hand with `npm run scheduler`. `GET /scheduler/health` returns 503
once nothing has succeeded within `SCHEDULER_STALE_SECONDS` — point an uptime
monitor at it, because that is the alerting.
