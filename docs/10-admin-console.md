# 10 — Signup, Sign-in, and the Super-Admin CRM

Two separate things that are easy to confuse, and dangerous to merge:

- **Farm accounts** — the farmers who sign up and pay. Scoped to one farm, RLS
  enforced, cannot see anything outside it.
- **Platform admins** — you and whoever helps you run the business. No farm, no
  tenant scope, a separate login, and every action logged.

Keeping them in separate tables with separate logins is deliberate. Making a
support account "just an employee with extra permissions" is how a support login
becomes a back door into every customer's data.

---

## Signup — four fields, no verification

Exactly what gets collected:

| Field | Notes |
|---|---|
| **Email** | The login identity. Stored `citext`, so `Ravi@Farm.in` and `ravi@farm.in` are one account |
| **Phone** | Contact, and the fallback channel for password reset |
| **Address** | Also what a GST invoice needs, so it is not a wasted field |
| **Password** | Argon2id or bcrypt. Never anything reversible |
| Farm name | Needed to create the farm itself |

**No verification.** No OTP, no confirmation email, no waiting. Fill the form,
land in the app, 30-day trial running. That is the whole point — every extra step
between "interested" and "using it" costs signups, and at ₹99 you need volume.

The `email_verified_at` column exists and stays NULL. Verification can be
switched on later without a migration if you ever want it.

### The one consequence worth planning for

Unverified email means **you cannot prove an email address belongs to the person
using it**, and that shows up in exactly one place: *password reset*. A farmer who
mistypes his email at signup and later forgets his password has no way back in,
and it becomes a support ticket — which at ₹82 net per farm per month is expensive.

Cheap fix that adds no signup friction: **send the reset code to the phone
number**, which you are collecting anyway. Reset by SMS is not signup
verification; it costs the farmer nothing at signup and gives you a recovery path.
Offer email reset too for whoever typed theirs correctly.

Two smaller things to handle while you are there:

- **Rate-limit signups per IP.** A 30-day free trial with no card and no
  verification is trivially farmed. It costs you compute rather than money, but a
  thousand junk farms makes your admin console useless.
- **Show the email back before submit.** A one-line "we will send receipts to
  ravi@gmial.com — correct?" catches most typos at the only moment it is free to
  fix them.

---

## Sign in and sign out

| Action | Behaviour |
|---|---|
| **Sign in** | Email + password. Issues a session token; the app stores it and stays signed in |
| **Stay signed in** | Default, and long — 30 days or more. Farm staff should never be typing a password in a shed |
| **Sign out** | Revokes that one session. The row is kept, not deleted |
| **Sign out everywhere** | Revokes every session for that user. Offer it after a password change |

`user_session` stores a **hash** of the token, never the token, so a leaked
database does not hand over live sessions. Revoked rows are retained so "who was
signed in, on what, and when" is still answerable after an incident.

> If you use Clerk or Auth0 for auth, they own this table's job and you can drop
> `user_session` entirely. Worth considering even though you want email and
> password rather than OTP: providers support email+password with verification
> turned off, and you avoid owning password hashing, reset flows and breach
> response. At ₹99 a farm you cannot afford a credential incident. The extra
> fields — phone, address — live in your own tables either way.

---

## The super-admin CRM

One console, at an address separate from the farmer-facing app.

### What it shows

`v_admin_farm_overview` — one row per farm:

```
FARM              CITY      OWNER                 PLAN        STATUS    PAYS    DOES  STAFF  LAST SEEN
Sunrise Rabbitry  Margao    ravi@…    +9198…      intro-2026  active    ₹999/y   47     3     2h ago
Green Acres       Belgaum   anil@…    +9199…      intro-2026  grace     ₹99/m    22     1     6d ago
Hilltop Farm      Pune      s@…       +9197…      intro-2026  trialing  —        3      1     19d ago ⚠
```

Filter by status, plan, city, activity. Search by farm name, owner email or
phone — support calls start with a phone number, so make that searchable.

**`days_since_activity` is the most valuable column on the screen.** A farm that
has written nothing in two weeks is churning whether or not it is still paying.
That is your list of people to phone, and phoning them is the highest-return
thing you will do all week.

### What it lets you do

| Action | Notes |
|---|---|
| Extend a trial | The most common support action. Give it a one-click 15-day button |
| Change subscription status | Activate, suspend, cancel, reinstate |
| Comp an account | Free for a case-study customer, a friend, a beta tester |
| Change the plan or price | Assigns a different plan row; never edits a price in place |
| Record an offline payment | For the customer who paid you by UPI or bank transfer. Real payment row, real invoice number |
| Replay a webhook | For the delivery that arrived while the database was down. Idempotent |
| Refund | On the payment it reverses. Credit note, days back or not, `billing` only |
| Resend an invoice | GST invoices get lost; this is a weekly request |
| Export a farm's data | For a customer asking, or a cancellation |
| Impersonate ("view as") | Support only. Time-boxed, reason required, logged, visible to the farm |
| Delete a farm | Superadmin only, typed confirmation, soft delete first |

### Roles

| Role | Can |
|---|---|
| `superadmin` | Everything, including deletion and creating other admins |
| `billing` | Subscriptions, invoices, refunds. No animal data |
| `support` | Read farms, extend trials, impersonate read-only. No refunds |
| `readonly` | Look, and nothing else. Good for an analyst or an investor demo |

### Everything is logged

`admin_audit_log` records admin, action, farm, before, after, reason and time.
It is append-only.

This is not bureaucracy. It is the only answer you will have when a customer says
*"my subscription was cancelled and I didn't do it"* — and the only way to trust
a second admin once you hire one. **Require a typed reason** for anything
destructive; it takes four seconds and makes the log actually readable a year
later.

### Impersonation, carefully

Being able to see a farm as its owner sees it turns a twenty-minute support call
into a two-minute one. It is also, in effect, a master key. **Built** — the farm
page has a *View this farm* button for `superadmin` and `support`.

How it works, because the mechanism is the safety:

Support does not get a special kind of access. The console mints an **ordinary
farm session** on the owner's employee row, bound to a row in
`admin_impersonation`, and hands the token over in a **URL fragment** — never a
query string, so it is not sent to a server and never reaches an access log.
Everything hangs off that binding:

- **Read-only, always.** Not a switch. Enforced in `requireAuth` as a blanket
  rule on the HTTP method, not a guard bolted onto the write routes — because
  the write routes are not the whole set. Marking a notification read, changing
  a password and signing every device out carry no write guard, and the last two
  are exactly the ones support must never reach.
- **Time-boxed to an hour**, checked on *every request* against the
  impersonation record rather than at the token's own expiry. Ending it in the
  console shuts the door on the next request.
- **Reason required**, in `admin_audit_log` and in what the farmer is told.
- **Visible to the farm.** A `support_access` notification naming the support
  person and the reason, *and* the session itself in the farmer's signed-in
  devices list as "Rabbitry support · Sam Support". The app carries a strip
  across the bottom of every screen for as long as it is live.
- **Endable from either side.** Support signs out; the admin clicks *End this
  session now*; the farmer changes their password, which revokes every session
  on the farm including this one. `?all=1` from inside a support session is
  deliberately *not* honoured — it would sign the farmer's own phone out.

`test/impersonation.test.js` is a test per clause of that list.

**Scoping is unchanged.** A support session goes through the same RLS as the
farmer's phone, so "read-only" and "this farm only" are enforced in two
different places by two different mechanisms, neither of which is application
code remembering to check.

### The revenue screen

`v_admin_revenue_summary` gives farm counts by status, **MRR** with yearly
subscriptions normalised to a monthly figure, how many farms are on old pricing
(so you know what a price rise would and would not touch), and the count of
paying farms that have gone quiet for two weeks.

Trials are excluded from MRR. A trial is not revenue, and counting it flatters the
number in exactly the way that leads to bad decisions.

### The billing screen

`/admin/billing`, for `superadmin` and `billing` only. Support does not need to
know what the platform earns; what support needs is one farm's payments while
that farmer is on the phone, and those are on the farm's own page where every
admin can see them.

It is ordered by what somebody has to *do*, not by what is nice to look at:

1. **Needs attention** — `v_admin_billing_exception`. Every way money can go
   wrong, worst first. Severity 1 is reserved for the two that cost a customer:
   a farm that **paid and is still locked out**, and a **payment we cannot
   attribute to any farm**. Then a paid payment with no invoice (the farmer is
   fine; the GST series has a gap), a webhook that failed or never finished, a
   refused amount, and — as noise rather than emergency — a payment link that
   was made and never paid.
2. **Renewals and trials, next fortnight** — `v_admin_renewal_due`. Trials
   ending and subscriptions lapsing are the same job: a conversation before the
   money stops. One list, with the owner's phone number on it. It carries two
   dates because they are up to a month apart: `days_left` counts to the day the
   **money** is due, which is the call worth making, and `covered_days_left`
   counts to the day the farm actually stops being able to record. The `stage`
   column names where they are — `ending_soon`, `in_grace`, `lapsed`,
   `trial_ending`, `trial_over`.
3. **Payments** — every payment, filterable by farm, invoice number or gateway
   id, which are the three things a person doing a reconciliation is holding.
4. **Collected by month**, and **the GST return** — per financial year, with the
   first and last invoice number so the consecutive series GST requires can be
   checked against the count at a glance.

### Refunds

The button is on the payment it reverses, on the farm's page, for `billing` and
`superadmin` — never `support`. Four things are decided for you, and each one is
a decision somebody would otherwise have to remember:

- **The invoice is never touched.** A refund issues a **credit note** with its
  own consecutive series (`CN/2026-27/00001`), and both documents go on the
  return. An invoice deleted because it was later refunded leaves a gap in a
  series an auditor reads as evasion.
- **Why decides what it costs them.** A *cancellation* takes back the share of
  the days that payment bought, in proportion to the money going back, rounded
  down in the farmer's favour; if that spends the period, the subscription is
  cancelled — read-only, every record kept, every reminder still firing. A
  *goodwill* refund takes back nothing. Clawing back access for an apology would
  undo the apology.
- **Nothing moves until the money has.** Razorpay's normal speed is five to
  seven working days. Until `refund.processed` arrives the farm is still a
  paying customer, because locking somebody out on a promise that might yet fail
  is a farmer in a shed unable to record a kindling. A refund that fails is
  raised at severity 1; one still unsettled after ten days is raised too, with a
  **Settled** button for when Razorpay's own dashboard shows it went and no
  webhook ever arrived.
- **Never more than was taken.** Part refunds are allowed and stack; refunds
  already in flight count towards the limit, so a double-clicked button cannot
  pay a customer twice. Money taken by hand goes back by hand and settles when
  the person recording it says it has.

Two more actions live here, both audited with a required reason:

- **Replay a stored webhook.** Razorpay retries for a while and then stops.
  After that a delivery that arrived while the database was down is a payment
  sitting in a row that nothing will ever apply on its own. Replay runs the
  stored payload through the same code the live endpoint does; it is safe to
  press twice, because `billing_apply_payment` refuses a payment it has already
  applied.
- **Record a payment taken outside Razorpay** (on the farm page). Farmers pay by
  UPI to a phone number and by bank transfer, and then they call. `activate`
  moves the period and leaves no payment row and no invoice — the money is in a
  bank statement and nowhere in this system, and the return is short by ₹999.
  This goes through the same function the webhook calls, so an offline payment
  extends a period and takes an invoice number by exactly the same rules, and it
  charges the farm's **locked** price rather than today's list price.

---

## Security notes for the admin surface

The console reaches across every tenant, so it is the highest-value target in the
system.

- **Separate domain or path**, not a hidden route in the farmer app.
- **The admin connection uses a role that bypasses RLS.** That is the point of it —
  which is precisely why farm-facing code must never use that role. Two different
  database roles, two different connection strings, not a flag.
- **Two-factor for admins.** You skipped verification for farmers deliberately;
  do not skip it for the account that can read every farm.
- **Alert on unusual admin activity** — bulk exports, many impersonations in an
  hour, out-of-hours access. Alert yourself; you are the only one watching.
- **Admin sessions expire fast** — hours, not the 30 days farm staff get.
