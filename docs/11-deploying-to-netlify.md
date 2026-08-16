# 11 — Deploying to Netlify

Netlify hosts the API and the admin console as a serverless function; Neon holds
the data. No mobile app and no Razorpay yet — those are separate decisions.

---

## Verify locally first

```bash
./scripts/verify.sh
```

From nothing, it applies the migrations, runs the 41 breeding-rule assertions,
runs the 45 API tests, then boots the server and hits real endpoints over HTTP.
It uses `$DATABASE_URL` if you have one, otherwise starts a throwaway
`postgres:16` container and removes it afterwards.

To poke at it by hand:

```bash
cd apps/api
npm install
cp .env.example .env          # edit the two connection strings
npm run migrate
npm start                     # http://localhost:3000

ADMIN_PASSWORD='something long' npm run create-admin -- you@example.com "Your Name"
# then sign in at http://localhost:3000/admin/login
```

---

## What Netlify changes

Two things, and both are already handled — worth knowing why.

**Serverless has no memory between requests.** Admin sessions originally lived
in a `Map` inside the process. That works perfectly on one long-lived server and
fails on Netlify, where consecutive requests can land on different instances:
the admin signs in, then gets logged out at random. Sessions now live in
`admin_session` (migration `0009`). There is a test that runs a *second* app
instance against a token issued by the first, which is the only way this failure
mode shows up before production.

**Connections are per-instance.** Use Neon's **pooled** connection string — the
host with `-pooler` in it. Without it, a burst of function invocations opens a
burst of direct Postgres connections and you hit the ceiling.

---

## Setup

### 1. Neon

Create the project, then two roles — the whole tenant isolation story depends on
the API connecting as one that cannot bypass RLS:

```sql
CREATE ROLE app_login   LOGIN PASSWORD '…';
CREATE ROLE admin_login LOGIN PASSWORD '…';
```

Apply the migrations from your machine (they create `rabbitry_app` and
`rabbitry_admin`), then grant:

```bash
ADMIN_DATABASE_URL='postgres://…-pooler…neon.tech/rabbitry?sslmode=require' \
  npm --prefix apps/api run migrate
```

```sql
GRANT rabbitry_app   TO app_login;
GRANT rabbitry_admin TO admin_login;
```

### 2. Netlify environment variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | pooled Neon string as **`app_login`** |
| `ADMIN_DATABASE_URL` | pooled Neon string as **`admin_login`** |
| `NODE_ENV` | `production` — this is what makes session cookies `Secure` |
| `TRIAL_DAYS` | `30` |

Getting `DATABASE_URL` wrong is the one mistake that matters: point it at
`admin_login` and every farm can read every other farm, because that role
bypasses row-level security by design. The isolation tests will not catch a
misconfigured environment variable — only you can.

### 3. Deploy

```bash
netlify deploy --build          # preview
netlify deploy --build --prod   # live
```

### 4. Check the deploy

```bash
npm --prefix apps/api run smoke -- https://your-site.netlify.app
```

Health, pricing, admin console rendering, and that both auth guards reject
anonymous callers. Add `--write` to also create a throwaway farm — it proves the
database is writable and the trial starts, but it leaves a real farm behind, so
only against a preview deploy.

### 5. Create your admin

`create-admin.js` talks to the database, not the site, so run it locally with
`ADMIN_DATABASE_URL` pointed at Neon:

```bash
ADMIN_DATABASE_URL='postgres://…neon.tech/rabbitry' \
ADMIN_PASSWORD='something long and unguessable' \
  npm --prefix apps/api run create-admin -- you@example.com "Your Name" superadmin
```

---

## Migrations are not run by the build

Deliberately. Netlify can run builds concurrently — a deploy preview alongside
production — and two runners applying the same migration at once is a bad
afternoon. Run them yourself against Neon before promoting a deploy.

The runner is idempotent, and it **refuses to continue if an already-applied
migration has been edited**, since that is how two environments silently
diverge. Once applied, a migration is immutable; change things by adding a new
one.

Neon's branching pairs well with this: branch the database, run the migration
against the branch, point a deploy preview at it, and only then apply to
production.

---

## Still missing before this is a real product

Worth being explicit, because the deploy will look finished and will not be:

**The scheduler.** Nothing generates the day-28 nest box task or fires the
2-hourly loose-motion reminder. Netlify Scheduled Functions are the natural home
— *not* `pg_cron`, which on Neon stops running whenever the compute suspends,
with no error anywhere. Add a heartbeat that alerts you when a run is missed; a
reminder system that fails silently is worse than none, because everyone has
stopped watching for the thing themselves.

**Push notifications.** The daily list is correct; nothing pushes it to a phone.

**Rate limiting on signup.** A 30-day trial with no card and no verification is
trivially farmed. Netlify has rate limiting available at the edge.

**Backups.** Neon has point-in-time restore — turn it on, and actually test a
restore once. An untested backup is not a backup.
