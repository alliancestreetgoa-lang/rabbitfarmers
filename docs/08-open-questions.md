# 08 — Open Questions

Answers needed from the farm owner. Each one changes the design; assumptions
currently in use are marked so the plan stays buildable either way.

## Herd and operation

1. **How many breeding does and bucks are on the farm today?** How many do you
   expect in two years?
   *Assumed: 50–150 does. Under ~30, a spreadsheet may genuinely serve you better,
   and it is worth saying so.*

2. **Meat, breeding stock, pets, or fur?** This determines whether the app leads
   with market weights and fryer counts or with pedigrees and show records.
   *Assumed: meat production, with some breeding-stock sales.*

3. **Which breeds?** This sets the first-mating age gates and target weights.

4. ~~**Which breeding rhythm?**~~ **Answered:** separate the kits at 30 days
   after delivery, rebreed 3–4 days after separating. That is a ~33-day
   kindling-to-service interval, roughly 5–6 litters per doe per year. Built as
   the default; `rebreed_after_weaning_days` is set to 3 and adjustable to 4.

5. **Do you want banded breeding** (all matings on one weekday) for easier labour
   planning?
   *Assumed: no, but the option is built in.*

6. **How are cages identified today** — shed/row/number, or something else?

7. **How are rabbits identified** — ear tattoo, ear tag, or nothing yet? If
   nothing, adopting a tagging scheme is prerequisite work before any app helps.

## Medication — Hosto

These do not block anything structural; the protocol mechanism is built and the
courses are seeded. But the details need confirming before the app is dosing
real animals off them.

21. **What exactly is Hosto — spelling, and is it an antibiotic, a supplement or
    a calcium/energy tonic?** I have set it up as a farm-defined medicine, so the
    app works either way. But if it is an antibiotic, its **withdrawal period**
    must go in the settings, and the app will then block meat sales from a
    treated animal until that period has elapsed. Ask your supplier or vet for
    the withdrawal figure.

22. **Dose and route** — how much, and given how (in drinking water, in feed, by
    injection)? This becomes the reminder text a farm hand reads at the cage.

23. **Does the post-delivery course start on the day she kindles, or the day
    after?** *Assumed: the day after, so doses land on days 1–5.* Changing it to
    days 0–4 is a one-field edit.

24. **Does the doe get it, the kits, or both?** *Assumed: the doe.*

25. **If she kindles early — say day 29 — should the remaining pre-delivery doses
    be given anyway, or dropped?** *Assumed: dropped, since the course is
    "before delivery" and delivery has happened.*

26. **Are there other regular medicines** — dewormer, vaccine, coccidiostat,
    vitamin — that should be set up as protocols now? Each is the same form,
    no code change.

## Staff

8. **How many employees, in what roles?** Do they have smartphones? Personal or
   shared?
   *Assumed: 2–6 staff, personal Android phones.*

9. **What language should the app be in?** Do all staff read English comfortably?

10. **Is attendance tracked today?** GPS, QR or manager-marked?

11. **Is payroll in scope at all**, or is that handled elsewhere?
    *Assumed: out of scope for v1; attendance exports instead.*

## Current practice

12. **What records are kept today** — paper doe cards, a notebook, a spreadsheet,
    nothing? Can 20 real examples be shared?

13. **Is palpation performed?** By whom, and on which day? If nobody palpates,
    the "presumed pregnant" bucket will dominate and the workflow needs rethinking
    around observation-based confirmation instead.

14. **What goes wrong most often today?** Missed nest boxes, does forgotten in
    the queue, kit mortality, staff not following instructions? The most painful
    one should get the most design attention.

15. **What is the current kits-weaned-per-doe-per-year figure?** If unknown,
    that alone justifies the app — but capture a rough baseline now.

## Constraints

16. **Budget and timeline?** This determines build-versus-buy, and whether a
    prototype comes first.

17. **Who will build it** — you, a hired developer, an agency? The stack
    recommendation should follow their skills.

18. **Is internet available in the sheds**, or only at the house/office? This sets
    how hard offline support has to work.

19. **Any regulatory requirements** — food safety, traceability, veterinary
    record retention — that the app must satisfy?

20. **Do you intend to sell this app to other rabbit farmers later?** If yes,
    multi-tenancy and per-farm configuration matter from day one — they are
    already in the plan, but it changes the priority of the settings screen.
