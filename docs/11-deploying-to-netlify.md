# 11 — Deploying to Netlify

One Netlify site serves the whole product: the farmer-facing app as static
files, the API and admin console as a serverless function, and the reminder
scheduler as a scheduled function. Neon holds the data. No Razorpay yet — that
is a separate decision.

---

## Verify locally first

```bash
./scripts/verify.sh
```

From nothing, it applies the migrations, runs the 41 breeding-rule assertions,
runs the 214 API tests, then boots the server and hits real endpoints over HTTP —
including running the scheduler and confirming the day-28 nest box task reaches
the daily list. It uses `$DATABASE_URL` if you have one, otherwise starts a
throwaway `postgres:16` container and removes it afterwards.

To poke at it by hand:

```bash
cd apps/api
npm install
cp .env.example .env          # edit the two connection strings
npm run migrate
npm start                     # http://localhost:3000

ADMIN_PASSWORD='something long' npm run create-admin -- you@example.com "Your Name"
```

Then bring up the app on the same origin the deploy will use:

```bash
npm --prefix apps/mobile install
npm --prefix apps/mobile run build:web
node scripts/dev-site.mjs      # http://localhost:8080, admin at /admin/login
```

`dev-site.mjs` mirrors the redirect table in `netlify.toml`. Serving the app on
one port and the API on another hides the single most likely deployment bug:
`/daily` is both a screen and an endpoint, and only a same-origin run proves
which of the two answers it.

For something to look at, seed a farm with a herd, four matings at different
stages, a weaned litter and an open health case:

```bash
node scripts/demo-data.mjs
# add ADMIN_EMAIL / ADMIN_PASSWORD to also seed neighbouring farms on other
# plans, so the admin console has a realistic list
```

---

## How one site serves two things

The app and the API share an origin and their paths overlap. `netlify.toml`
resolves that with an ordered redirect table, first match wins:

| Path | Goes to |
|---|---|
| `/api/*` | the function (prefix stripped — `/api/daily` → `/daily`) |
| `/admin`, `/admin/*` | the function — the server-rendered console |
| `/scheduler/*`, `/health`, `/plans` | the function |
| everything else | `/index.html` with a **200**, so client-side routes and deep links work |

The app finds the API through `EXPO_PUBLIC_API_URL`. It is deliberately **empty**
in the Netlify build: the app then calls `/api` on whatever origin served it, so
one build works on a deploy preview, a branch deploy and production. Set it only
to point a build somewhere else — a native build, for instance, which has no
origin to fall back on.

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
| `SCHEDULER_SECRET` | a long random string; guards `POST /scheduler/run` |
| `SCHEDULER_STALE_SECONDS` | `3600` — how long without a successful run before the heartbeat reports unhealthy |
| `EXPO_PUBLIC_API_URL` | leave **empty** — `netlify.toml` already sets it so, and a value here would pin the app to one host |
| `RAZORPAY_KEY_ID` | from the Razorpay dashboard. Leave unset and the app says card payments are not switched on, rather than showing a button that fails |
| `RAZORPAY_KEY_SECRET` | same place. Never in the repo |
| `RAZORPAY_WEBHOOK_SECRET` | **set when you create the webhook, not before** — it is what proves a delivery is genuine |
| `PUBLIC_URL` | your site's URL. Razorpay redirects the farmer back to `PUBLIC_URL/billing/return` |

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

## The scheduler

`netlify/functions/scheduler.mjs` runs every 15 minutes and is what actually
creates the day-28 nest box task, the separate-the-kits task on day 30, and the
2-hourly loose-motion reminder.

**Not `pg_cron`.** It exists on Neon and will appear to work while you test.
Then the farm goes quiet overnight, Neon suspends the compute, `pg_cron` stops —
there is no wake-on-cron — and the reminders simply do not arrive, with no error
anywhere. An external scheduler both drives the work *and* wakes the database.

Two constraints shaped it:

- **Netlify caps a scheduled function at 30 seconds.** All the generation is
  set-based SQL across every farm in one pass. Looping farms in JavaScript would
  be fine at ten customers and start timing out at five hundred. Watch
  `duration_ms` in `scheduler_run` as you grow.
- **Netlify cron is UTC.** Nothing assumes the server's day: farm-local dates and
  quiet hours are computed from `farm.timezone` in SQL.

It is safe to run twice — every generated row carries a deterministic unique key,
so a repeat pass inserts nothing rather than doubling a farmer's task list. There
is a test for exactly that, and another proving a completed task is not
resurrected.

### After deploying, check the heartbeat

```
GET /scheduler/health
```

Returns **503** when nothing has succeeded within `SCHEDULER_STALE_SECONDS`.
**Point an uptime monitor at it** — a free Better Stack or UptimeRobot check is
enough. That is the alerting, and it is the whole reason the endpoint exists: a
reminder system that fails silently is worse than none, because everyone has
stopped watching for the thing themselves.

You can also trigger a pass by hand, which is useful for a first run or after
downtime:

```bash
curl -X POST https://your-site.netlify.app/scheduler/run \
  -H "x-scheduler-secret: $SCHEDULER_SECRET"

# or from your machine, straight against the database
ADMIN_DATABASE_URL='postgres://…neon.tech/rabbitry' npm --prefix apps/api run scheduler
```

---

## Still missing before this is a real product

Worth being explicit, because the deploy will look finished and will not be:

**Push notifications are on** and need no configuration: the scheduler delivers
through Expo's push service on every pass. Two environment variables exist for
it, both optional — `PUSH_ENABLED=0` turns delivery off entirely, and
`PUSH_ENDPOINT` points the sender somewhere other than Expo, which is how the
test suite drives it against a stub.

Delivery only reaches phones running a **native build**. The web export shows
reminders on Today; web push needs a service worker and VAPID keys that do not
exist yet. See [docs/12](12-android-and-ios-builds.md) for the APK.

**App store builds.** The web export is what Netlify serves. The same Expo
project builds for Android and iOS, but that needs EAS, signing keys and store
accounts, and a native build must have `EXPO_PUBLIC_API_URL` set to the site's
real URL because there is no origin to infer.

**The Razorpay webhook.** In the dashboard, point a webhook at
`https://your-site.netlify.app/webhooks/razorpay` and subscribe it to
`payment_link.paid`, `payment_link.cancelled`, `payment_link.expired` and
`payment.failed`. Put the secret it gives you in `RAZORPAY_WEBHOOK_SECRET`.
Without the webhook a farmer's payment still lands — the redirect back applies
it — but a farmer who closes the browser on the way back is left paid and not
marked paid until somebody reconciles by hand.

**Recurring payments.** Farms pay once and the period is extended. UPI Autopay
and e-NACH mandates are deliberately not built: they need mandate registration,
an additional-factor step on the first debit, and a pre-debit notification
twenty-four hours before every charge. ₹999 once a year is one tap.

**Rate limiting on signup.** A 30-day trial with no card and no verification is
trivially farmed. Netlify has rate limiting available at the edge.

**Backups.** Neon has point-in-time restore — turn it on, and actually test a
restore once. An untested backup is not a backup.
