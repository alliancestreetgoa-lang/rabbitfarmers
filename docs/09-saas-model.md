# 09 — Selling This as a SaaS

The plan changes from "an app for one farm" to "a product other farmers pay for
every month". That changes less of the code than you might expect, and much more
of everything else.

---

## One thing to say plainly first

**Run it on your own farm for a full season before you sell it to anyone.**

Not as a delay tactic — as the fastest route to a sellable product. You get the
one asset no competitor can copy: *"this is my farm, here is what my
kits-weaned-per-doe-per-year was before, here is what it is now."* That sentence
sells more subscriptions than any feature list. It also finds the twenty things
that are wrong with the workflow while the only person inconvenienced is you,
rather than a paying customer whose litter you cost him.

You are also about to discover that **distribution, not software, is the hard
part**. Rabbit farming is a scattered niche. Building the app is 4 months;
finding 200 farmers willing to pay for it is the multi-year problem. Budget your
attention accordingly.

Both concerns are worth a season, not a rethink. The rest of this document
assumes you are going ahead.

---

## What already works

Multi-tenancy was built in from the first commit, which saves the expensive part
of this pivot:

- Every table carries `farm_id`
- Every breeding constant lives in `farm_settings`, not in code
- Breeds, medication protocols and condition types are farm-defined rows
- Names and tags are per farm

So a second farm needs no schema change. What it needs is everything *around*
the product.

## What has to be built

| Area | Why it is new |
|---|---|
| Plans, subscriptions, invoices | You now take money on a schedule |
| Self-serve signup and onboarding | Nobody is there to set the farm up by hand |
| Settings **templates** | Your rhythm is no longer *the* rhythm — it is one starting preset |
| Entitlements and limits | Plans have to mean something |
| Hardened tenant isolation | One leak across farms and the product is finished |
| Backups, uptime, support | Other people's businesses now depend on you |
| Terms, privacy policy, GST invoicing | Legal obligations that did not exist for a personal tool |

---

## Pricing and packaging

### The benchmark

Everbreed, the main incumbent, tiers by **breeding-rabbit count**: roughly
$4.99 / $9.99 / $14.99 / $19.99 per month for 5 / 20 / 50 / unlimited breeding
rabbits, with a 30-day free trial and no card required up front. Kintraks sells a
desktop licence outright for about $20.

Two things follow. Tiering on doe count is the proven shape for this market — it
tracks both the value delivered and the load on your servers. And the ceiling for
a records-only rabbit app is low; nobody is paying $50/month for pedigree
storage.

### Where you are actually different

Everbreed and Kintraks are **breeder record books** — pedigrees, litters,
history — aimed at hobbyists and small breeders. They are weak at exactly what
you built:

- Employees, roles, task assignment and accountability
- Medication protocols that generate the daily round
- Repeating health alerts with escalation
- Local language for staff who do not read English
- Offline operation in a shed with no signal

That is not a records app for a hobbyist. That is an **operations app for a farm
with staff** — a different buyer with a much higher willingness to pay, because
you are saving labour and preventing dead litters rather than storing pedigrees.

**Price against that buyer**, and tier on doe count *and* staff seats.

### Proposed tiers (India, INR, GST inclusive)

| Plan | Breeding does | Staff logins | Monthly | Yearly |
|---|---|---|---|---|
| **Trial** | full access | | 30 days free, no card | |
| **Starter** | up to 25 | 1 | ₹299 | ₹2,990 |
| **Farm** | up to 75 | 3 | ₹699 | ₹6,990 |
| **Commercial** | up to 200 | 8 | ₹1,499 | ₹14,990 |
| **Estate** | unlimited | unlimited | ₹2,999 | ₹29,990 |

Yearly is priced at ten months — two months free. Push it hard, for two reasons
beyond cash flow: UPI Autopay and e-NACH mandates fail more often across twelve
monthly debits than one annual one, and an annual customer gets eleven fewer
opportunities to churn.

**Quote prices GST-inclusive.** SaaS carries 18% GST in India and most of your
customers will be unregistered smallholders who cannot reclaim it. A farmer who
is shown ₹299 and charged ₹353 feels cheated, and you will lose him over ₹54.

### What is *not* gated

Two things stay on every plan including trial, and this is a deliberate choice
rather than an oversight:

- **Data export.** Never hold a farmer's records hostage. It is the fastest way
  to earn a reputation you cannot recover from, in a market small enough that
  everyone talks to everyone.
- **Health and breeding reminders.** See below.

---

## Billing stack

**Razorpay**, not Stripe. Stripe India still does not support e-NACH or UPI
Autopay, which are the rails domestic Indian recurring payments actually run on.
Razorpay covers both under one dashboard, and its UPI Autopay mandate handling
(one-time authentication, then no OTP per charge) is the difference between
collecting and not collecting from a smallholder.

| Concern | Approach |
|---|---|
| Mandate | UPI Autopay first, e-NACH fallback, card for those who prefer it |
| Retries | Razorpay's retry scheduling; then your own dunning emails/SMS |
| Invoices | GST-compliant, sequential numbering, your GSTIN, downloadable |
| Upgrades | Prorated immediately; downgrades take effect next period |
| Refunds | Published policy; a short no-questions window builds more trust than it costs |

Keep the gateway at arm's length: store `gateway`, `gateway_subscription_id` and
`gateway_payment_id`, and derive access from **your own** `subscription` table.
Never let a webhook be the only record that a farm is paid up — webhooks get
missed, and a farm locked out by a dropped webhook at kindling time is a customer
lost permanently.

---

## Subscription lifecycle, and what "unpaid" should mean

This is the part most SaaS products get wrong, and getting it wrong here has
consequences a project-management tool never faces: **rabbits die**.

If a farmer's mandate fails on the 3rd and you cut off his nest-box alert on the
5th, he loses a litter on day 28. That is real money and a real animal welfare
failure, caused by your billing logic. He will tell every rabbit farmer he knows.

```
trialing ──► active ──► past_due ──► grace ──► suspended ──► cancelled
   │            ▲          │           │           │
   └── expires ─┘          └── paid ───┴───────────┘
```

| Status | What the farmer can do |
|---|---|
| `trialing` | Everything. 30 days, no card |
| `active` | Everything |
| `past_due` | **Everything.** Payment retrying; nag in-app, do not degrade |
| `grace` | **Everything, including all reminders.** 30 days. Prominent banner |
| `suspended` | Read-only + export + **reminders keep firing**. No new records |
| `cancelled` | Read-only + export. Data retained 12 months minimum |

**Reminders survive suspension.** They cost you almost nothing to keep running
and they are the difference between a lapsed customer who comes back and a former
customer who tells people you killed his litter. Withhold the *product* — new
records, reports, staff logins — never the animal's welfare.

**Never delete a farm's data on non-payment.** Retain for at least 12 months,
warn before any deletion, and let them export the whole time.

---

## Entitlements and limits

Enforce limits **in the database**, not just the UI, and enforce them at the
point of creation:

- Over the doe limit → cannot add another breeding doe; existing animals keep
  working, nothing is hidden or deleted
- Over the seat limit → cannot add another staff login
- The upgrade prompt appears at the moment of the block, showing the exact plan
  that solves it

Never respond to an over-limit farm by hiding data they already entered. Block
the *next* addition and explain why.

---

## Tenant isolation

Previously a nice-to-have. Now the thing that ends the company if it fails.

- **PostgreSQL row-level security on every table**, keyed on the caller's farm.
  No query anywhere may rely on the application remembering to filter by
  `farm_id`.
- Default-deny. A new table with no policy should return nothing, not everything.
- The `farm_id` on a row is set from the session, never accepted from the client.
- **Automated cross-tenant tests in CI**: farm A's token must return zero rows
  from farm B's data, on every table, on every build. This is a test suite you
  write once and never regret.
- Photos in object storage need the same scoping — a guessable URL is a leak.
- Admin/support access to a customer's farm must be explicit, logged, and
  visible to the customer.

---

## Self-serve onboarding

Nobody will be there to set up the farm. The first ten minutes decide whether
they ever come back.

1. **Sign up** — phone number, OTP, farm name. Nothing else.
2. **Pick a starting template** — this is where your rhythm goes:
   - *Gentle (recommended)* — separate kits at 30 days, rebreed 3 days later
   - *Semi-intensive* — rebreed 21 days after kindling
   - *Intensive* — rebreed 14 days after kindling
   - *Custom*
   Every value stays editable afterwards. The template only seeds defaults.
3. **Add your first doe** — one animal, name and sex only.
4. **Record where she is in her cycle** — pregnant / nursing / resting. This is
   the step that makes the app immediately useful instead of an empty database.
5. Everything else — sheds, staff, medication protocols, breeds — comes later,
   prompted in context rather than demanded up front.

**Activation metric:** 10 animals entered and 1 breeding event recorded within 7
days. Farms that clear that bar convert; farms that do not, never will. Measure
it from day one and treat it as the number that matters more than signups.

---

## Support and operations

You are now responsible for other people's businesses.

| Obligation | Minimum viable |
|---|---|
| Backups | Automated daily, **restore tested monthly** — an untested backup is not a backup |
| Uptime | Publish something honest; Supabase Pro plus a status page is enough at first |
| Support channel | WhatsApp. Indian farmers will not open support tickets |
| Response time | Same working day. This is a competitive advantage, not a cost |
| Incident comms | Tell customers before they tell you |
| Onboarding help | Offer to import their paper records for the first 50 customers, by hand if necessary |

That last one is the classic unscalable thing worth doing early: it buys you
loyalty, and it teaches you exactly where the product is confusing.

---

## Legal and compliance (India)

Not advice — a checklist to take to someone qualified:

- Business registration and **GSTIN**; 18% GST on SaaS
- GST-compliant invoicing with sequential numbering
- Terms of Service and Privacy Policy
- **Digital Personal Data Protection Act 2023** — you hold staff personal data
  (names, phone numbers, ID documents, attendance and location), which is exactly
  the category that attracts obligations. Consent, purpose limitation, breach
  notification, deletion on request
- Published refund and cancellation policy
- Data retention and deletion policy, matching what you promise above

---

## The numbers to watch

| Metric | Why |
|---|---|
| Trial → paid conversion | The health of onboarding |
| Activation rate (10 animals + 1 event in 7 days) | Predicts conversion better than anything else |
| Monthly churn | Under 3% is healthy; over 7% means the product is not sticking |
| MRR and annual share | Annual share is your cash flow and your churn defence |
| Support tickets per customer per month | Rising means the product is confusing, not that customers are needy |
| Farms with zero writes in 14 days | Silent churn, still paying. Reach out before they cancel |

---

## Go to market

Honest ranking of what will actually work, most effective first:

1. **Your own farm as the case study.** Real numbers, real photos, real staff.
2. **WhatsApp and Facebook groups** for Indian rabbit and small-livestock
   farmers. This is where the market actually lives.
3. **YouTube.** Farming content has enormous reach in India. A video of your own
   shed running on the app beats any ad.
4. **Feed suppliers and vets** as referral partners — they already have the
   relationships.
5. **Krishi Vigyan Kendras and extension networks** for credibility.
6. Paid ads — last, and probably not worth it at these price points.

---

## Two structural decisions worth taking now

**1. Should this stay rabbit-only?**

The breeding engine is species-agnostic in shape — gestation length, palpation
day, weaning day, rebreed interval. Goats, sheep and pigs are the same machine
with different constants. Moving those constants from `farm_settings` to a
`species` table is cheap now and expensive after a thousand farms are live.

Rabbit farming in India is a small market. Goats are not. This is not a feature
to build now, but it is a schema decision to take now.

**2. Who is the buyer — the hobbyist or the commercial farm?**

You cannot serve both well. The hobbyist wants pedigrees and show records and
will pay ₹299. The commercial farm wants labour accountability and dead-litter
prevention and will pay ₹1,499. Everything you have built so far points at the
second. Pick it deliberately, and let the Starter tier be a doorway rather than
the target.
