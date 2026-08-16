# 01 — Domain Research: Rabbit Reproduction & Husbandry

Every timing constant the app uses is listed here with its source. When a
developer asks "why day 12?", the answer lives in this file, not in a comment
buried in the code.

**Important:** these are *defaults*, not laws. Breeds, climate and management
style vary. Every number below must be **configurable per farm** in settings.
Hard-coding them is the single most common way farm apps become unusable.

---

## 1. The fundamental fact: rabbits are induced ovulators

Rabbits have **no regular oestrous cycle**. A doe does not come into heat on a
predictable calendar the way a cow does. She ovulates roughly 10–13 hours
*after* mating — the act of mating triggers ovulation.

**Consequences for the app — this changes the whole design:**

- There is no "heat cycle" to predict or count down to. Any app that shows a
  "next heat date" for rabbits is modelling the wrong animal.
- Instead, does move through **waves of receptivity**: receptive for roughly
  5–14 days, then 1–2 days of refusing the buck.
- Therefore "ready to mate" is **not** a date calculation. It is an
  *eligibility* calculation (is she rested, healthy, old enough, not pregnant)
  combined with an *observed receptivity* check made at the cage.
- The app's job is to produce a **candidate queue**, and let the stockman
  confirm receptivity by eye at the cage. It must never claim certainty it
  cannot have.

### Observed receptivity signs (recorded at the cage)

| Sign | Reading |
|---|---|
| Vulva **red / pink / purple**, swollen, moist | Receptive — good conception odds |
| Vulva **pale / white**, small, dry | Not receptive — lower fertility, skip her |
| Restless, rubbing chin on feeder/equipment | Receptive |
| Flattens to floor / lifts tail when touched (lordosis) | Receptive |

Fertility is measurably lower for pale vulvar colour; pink, red and purple
perform similarly. So the app should record a simple 2-value practical field
(**receptive / not receptive**) with the colour as optional detail.

---

## 2. Timing constants

| Event | Value | Notes |
|---|---|---|
| **Gestation** | 28–34 days, **average 31** | Most does kindle day 31–32 |
| **First mating — doe** | ~5 months (small breeds earlier, giant breeds 8–9 months) | Breed-size dependent |
| **First mating — buck** | ~6 months | Slightly later than does |
| **Palpation (pregnancy check)** | **Day 10–14**, best around **day 12** | Kits are grape-sized and detectable |
| **Re-check before nest box** | Day 28–29 | Foetal resorption can occur before day 19 — a day-12 positive is not final |
| **Nest box placed** | **Day 27–29** | Earlier and the doe soils it with urine/faeces |
| **Fur pulling / nest building** | 1–2 days before kindling | Useful confirmation signal |
| **Kindling** | Usually night or early morning, takes 15–30 minutes | Check nest first thing each morning |
| **Pseudopregnancy (false pregnancy)** | **16–18 days** | After a sterile mating or false stimulation. Doe refuses the buck throughout. Matings during this window are usually infertile |
| **Kits' eyes open** | ~day 10 (both eyes by ~14 days) | Welfare checkpoint |
| **Kits start solid feed** | ~day 18–20 | Creep feed checkpoint |
| **Weaning** | 28–35 days (28 under intensive systems, up to 42 extensive) | Driven by the rebreeding rhythm chosen |
| **Fryer / market weight** | 1.5–2 kg at **8–10 weeks** (market window 8–12 weeks) | The revenue event |

### Why the due date must be a *window*, not a day

Gestation is 28–34 days. An app showing "Due: 15 March" and nothing else will
have staff checking nest boxes on the wrong day and losing litters born on
day 29 with no box in place.

**Design decision:** store `mating_date` only. Display:
- **Nest box due:** day 28
- **Expected kindling:** day 31
- **Watch window:** day 28 → day 34
- **Overdue alert:** day 35+ (likely failed pregnancy or missed record)

---

## 3. Mating procedure

- **Always take the doe to the buck's cage.** A doe defends her own territory
  and may attack the buck. This is the single most-broken rule by beginners.
  → The app should show this as a reminder on the "Record mating" screen.
- Watch for the service: a successful service ends with the buck falling off
  or to the side, often with a grunt. Record it.
- **Two services** (returning the doe after a few minutes) is a common practice
  to improve conception. Record the service count.
- Never leave the pair unsupervised for long periods.

---

## 4. Rebreeding rhythms — the biggest management decision

The interval between kindling and the next mating determines everything: litters
per year, doe lifespan, feed cost, and labour load. The farm picks **one rhythm**
as a default and the app derives its whole task calendar from it.

| Rhythm | Rebreed after kindling | Litters/doe/year | Wean at | Doe productive life |
|---|---|---|---|---|
| **Intensive** | ~11–14 days | 8–9 | 28 days | 1 – 1.5 years |
| **Semi-intensive** | 14–21 days | 6–7 | 28–35 days | ~2 years |
| **Extensive** | 35–42 days | 4–5 | 35–42 days | ~3 years |

A commonly recommended commercial compromise is a **35-day breed-back**, which
balances doe condition against output.

**This farm's rhythm:** kits separated at **30 days** after delivery, doe
rebred **3–4 days** after separating. That is a ~33-day kindling-to-service
interval and a ~64-day cycle, putting it between semi-intensive and extensive at
roughly **5–6 litters per doe per year** — a rhythm that treats the doe gently
and should give her a long productive life.

Note this counts the rest from **weaning**, not from kindling. Most published
schedules count from kindling, so the app makes the anchor a setting rather than
assuming one. It matters: with a weaning anchor, a doe whose weaning is recorded
late is *also* rebred late, so late data entry costs real production days. That
is worth knowing, and it is a good argument for entering the separation on the
day it happens.

**Design decision:** rebreed interval and its anchor are farm-level settings with
a per-doe override. A doe in poor condition gets a longer rest; the app must
allow that without a fight, and must record *why* (body condition) so the data
explains the decision later.

**Design decision:** schedule on **7-day multiples** where possible. Commercial
rabbitries breed on fixed weekdays because it makes labour planning and record
keeping vastly simpler — all of Tuesday's does kindle around the same Tuesday.
This "banding" is worth building in as an option from day one.

---

## 5. Buck management

- **Ratio:** 1 buck per **8–10 does**. A beginner setup is 1 buck to 3–4 does.
- **Service load:** commonly limited to **2–3 services per week**. Mature bucks
  can handle a single mating daily over long periods, but after several services
  in a day or two they need several days' rest.
- Buck fertility should be tracked: conception rate per buck is a real,
  actionable number. A buck whose does keep coming back empty is the problem,
  not the does.

**Design decision:** the app tracks services per buck per rolling 7 days and
greys out over-worked bucks in the mating screen. It also computes each buck's
conception rate over the last N services.

---

## 6. Inbreeding

Small rabbitries drift into inbreeding fast because everyone keeps the best
doe's daughters and there is only one buck. The results are small litters, weak
kits and high pre-weaning mortality — and the farmer usually blames feed.

**Design decision:** store `dam_id` and `sire_id` on every rabbit and block or
warn on any pairing that shares a parent or grandparent. This is cheap to build
and is the highest-value feature most rabbit apps skip.

---

## 7. Records that matter — the traditional doe card

The paper doe card, which the app must fully replace, holds:

> ear number/tattoo · breed · date of birth · dam · sire · breed date · buck
> used · palpation date and result · nest box date · due date · kindled date ·
> born alive · born dead · number weaned · average weaning weight · planned
> rebreed date

If the app does not capture all of these in fewer taps than a pen takes, staff
will keep using the pen. This is the usability bar.

---

## 8. The single headline KPI

> **Kits weaned per doe per year.**

Litters per year, kits born alive, pre-weaning mortality, weaning weight and
kindling interval are all *inputs* to it. A doe can fail on one input and still
earn her cage. This number, per doe and per herd, is what the reports screen
should lead with — not a wall of charts.

Secondary KPIs worth tracking:

- **Conception rate** = confirmed pregnancies ÷ services (per doe, per buck, per month)
- **Pre-weaning mortality** = (born alive − weaned) ÷ born alive
- **Kindling interval** = average days between successive litters per doe
- **Feed conversion ratio** = kg feed ÷ kg live weight produced
- **Doe replacement rate** = culls + deaths ÷ average doe herd size

---

## 9. Culling and replacement

Unproductive does are the quiet profit killer — they eat like productive does.
FAO's model weekly work plan for a rational rabbitry puts *"culling sick and
unproductive females"* on fixed days of the week, alongside filling in doe cards
and weaning litters.

Typical culling triggers the app should flag automatically:

- Failed to conceive after **3 consecutive services**
- Two litters in a row with fewer than N weaned
- Persistent pre-weaning mortality above herd average
- Age past productive life for the chosen rhythm
- Repeated mastitis, sore hocks, or refusal to nurse

**Design decision:** the app *suggests* culls with the evidence attached. It
never auto-culls. The decision stays with the farmer.

---

## 10. Health notes that affect the data model

- **Vaccination** (RHDV/RHDV2, myxomatosis where regionally relevant) needs
  scheduled reminders with due dates and batch numbers.
- **Medicine withdrawal periods** are critical for meat rabbits — an animal
  treated with antibiotics must not be sold for meat until the withdrawal
  period has elapsed. The app must **block or hard-warn on sale** during
  withdrawal. This is a food-safety and legal issue, not a nice-to-have.
- Mortality needs a cause field with a controlled vocabulary, otherwise the
  data is useless for spotting an outbreak.
- Quarantine status for new arrivals must exclude an animal from the breeding
  queue automatically.

---

## Sources

- [Rabbit Breeding Cycle Explained: Timelines and Best Practices — Everbreed](https://everbreed.com/blog/rabbit-breeding-cycle-explained-timelines-stages-and-best-practices/)
- [How Long Are Rabbits Pregnant? Breeder Timeline — Everbreed](https://everbreed.com/blog/how-long-are-rabbits-pregnant/)
- [Rabbit Reproductive Physiology: What Every Breeder Should Understand — Everbreed](https://everbreed.com/blog/rabbit-reproductive-physiology-what-every-breeder-should-understand/)
- [How Often Should You Breed Your Rabbits — Everbreed](https://everbreed.com/blog/how-often-should-you-breed-your-rabbits/)
- [When Do Newborn Rabbits Open Their Eyes — Everbreed](https://everbreed.com/blog/when-do-newborn-rabbits-open-their-eyes/)
- [Breeding and Reproduction of Rabbits — Merck Veterinary Manual](https://www.merckvetmanual.com/all-other-pets/rabbits/breeding-and-reproduction-of-rabbits)
- [Management of Rabbits — MSD Veterinary Manual](https://www.msdvetmanual.com/exotic-and-laboratory-animals/rabbits/management-of-rabbits)
- [Rabbit Reproduction Basics — LafeberVet](https://lafeber.com/vet/rabbit-reproduction-basics/)
- [Rabbit Tracks: Breeding Techniques and Management — Michigan State University Extension](https://www.canr.msu.edu/resources/rabbit_tracks_breeding_techniques_and_management)
- [Rabbit Breeding and Management: A Guide for Producers — Utah State University Extension](https://extension.usu.edu/small-acreage-livestock/research/rabbit-breeding-and-management-a-guide-for-producers)
- [Commercial Rabbit Production — Mississippi State University Extension (PDF)](https://www.poultry.msstate.edu/pdf/extension/rabbit_production.pdf)
- [Rabbit Production — Penn State Extension](https://extension.psu.edu/rabbit-production)
- [The Rabbit — Husbandry, Health and Production, Ch. 9 — FAO](https://www.fao.org/4/x5082e/X5082E09.htm)
- [Rabbit Housing — FAO Farm Structures Ch.10](https://www.fao.org/4/s1250e/s1250e17.htm)
- [Pseudopregnancy — Rabbit — WikiVet](https://en.wikivet.net/Pseudopregnancy_-_Rabbit)
- [Reproductive Diseases in Farmed Rabbit Does — NCBI/PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7602256/)
- [Rabbit Reproduction — Sathe & Shipley, Society for Theriogenology (PDF)](https://cdn.ymaws.com/www.therio.org/resource/collection/2CF03851-0A7C-4489-8F1A-8C507FEB205D/2013_v4_004.pdf)
- [Culling Rabbits: Selection Metrics and Rabbitry Records — RabbitBreeder](https://rabbitbreeder.app/blog/rabbitry-records-culling)
- [Rabbit Farming Part 5: Breeding and Herd Management — ProAgri](https://www.proagrimedia.com/livestock/rabbit-farming-part-5-breeding-and-herd-management/)
- [Breeding Meat Rabbits: From Pairing to Fryers — Homestead Rabbits](https://homesteadrabbits.com/breeding-meat-rabbits/)
