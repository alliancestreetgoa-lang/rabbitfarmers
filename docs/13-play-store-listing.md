# 13 — The Play Store listing

What Google asks for, and the answers that are true for this app. Written
2026-09-08 for the first submission (app 0.1.5, `versionCode` 6, package
`in.rabbitfarmers.app`). Update it when the answers change.

## The binary

The Play Store takes an **`.aab`**, not the `.apk` farmers sideload. Build it
with the GitHub Action, production profile:

```bash
gh workflow run android-apk.yml -f profile=production -f api_url=https://rabbitfarmers.com/api
gh run download <run id> -n rabbitry-android-production
```

The keystore that signs it lives on EAS (project `f8193bf6-…`, the account
whose `EXPO_TOKEN` is in the repo secrets). **It is the app's identity on
Play.** Download a copy with `eas credentials` from that account before the
first upload and keep it off the laptop. Every upload needs a higher
`versionCode` in `apps/mobile/app.config.js`.

Play App Signing: accept it when the console offers. Google then holds the
final signing key and the EAS keystore becomes the *upload* key, which can
be reset if lost.

## Listing text

**App name** (30): rabbitfarmers

**Short description** (80): Every doe, every day, accounted for. Free records and reminders for rabbit farms.

**Full description** (4000):

> rabbitfarmers keeps a rabbit farm's records the way the farm actually runs — and tells you what to do today.
>
> • Today: every job for the morning in one list — nest boxes to put in, does to serve, medicine to give, sick rabbits to check — each with its own tick.
> • Herd: every rabbit, its state, cage and history. Females and males in number order.
> • Breeding: record a mating in seconds, and the app works out the nest box day, the kindling watch and when she is due again. Choose your own gap after delivery.
> • Health: report a sick rabbit and the medicine chart tells you what to give, dose by dose, with reminders that stop when it stops. A pregnant doe or a kit too young is held back automatically.
> • The monthly round: de-worming and tonics, rabbit by rabbit, on the farm's own dates.
> • Litters and kits, staff and attendance, all in the same place.
> • Works on the phone in the shed and on a laptop in the office — the same records, live.
>
> Free, no advertising, no subscription. Built at Alliance Street Organic Farms, Goa, for farms like ours.

**Category:** Productivity (or Business). **Tags:** farming, livestock, records.

**Contact:** alliancestreetorganicfarms@gmail.com · +91 73750 96163
**Privacy policy URL:** https://rabbitfarmers.com/privacy
**Website:** https://rabbitfarmers.com

## Graphics

| Asset | Spec | Where |
|---|---|---|
| App icon | 512 × 512 PNG | generated from `apps/mobile/assets/icon.png` |
| Feature graphic | 1024 × 500 PNG/JPEG | generated: brand green, logo, tagline |
| Phone screenshots | 2–8, 16:9 or 9:16, 320–3840 px | take on a real phone: Home, Today, Herd, Report a sick rabbit, Settings |

## Data safety form

Answer as follows. Every line matches `/privacy`.

- **Does the app collect or share user data?** Collects, yes. Shares, no.
- **Encrypted in transit?** Yes. **Can users request deletion?** Yes (see below).
- **Personal info:** Name — collected, required, app functionality. Email address — collected, required, account management. Phone number — collected, required (staff sign in by phone), account management.
- **App activity / other user-generated content:** the farm's records — collected, required, app functionality.
- **Device or other IDs:** push notification token — collected, optional, app functionality.
- **Not collected:** location, contacts, photos, financial info, health info about people, browsing history.
- **Ephemeral:** server logs (address, time) — not stored beyond 30 days.

## Account deletion (Play requires it)

Any app that lets people create an account must offer, **in the app and at a
public URL**, a way to delete the account and its data. As of 2026-09-08 the
app does not have this in-app; deletion is by request through `/privacy`.
Build it before submitting: an owner deleting their account deletes the
farm and every record (cascade on `farm`); a staff member deleting theirs
removes their login and leaves the farm's records. Confirm with the
password. The web URL for the form field: `https://rabbitfarmers.com/delete-account`.

## Content rating questionnaire

Utility / productivity app. No violence, sexual content, language, controlled
substances (veterinary medicine names are not "drugs" in the questionnaire's
sense), gambling, or user-to-user communication. Expect **Everyone**.

## Other declarations

- **Ads:** none. **In-app purchases:** none. **Target audience:** 18 and over.
- **Permissions:** INTERNET only. No location, camera, contacts.
- **Government / news / health app:** no. **COVID-19:** no.
- **Testing:** Google requires a **closed test with 12 testers for 14 days**
  before a personal developer account can publish to production. Use the
  farm's staff phones; the closed-test track takes the same `.aab`.

## Submitting

First release: upload the `.aab` by hand in the console (Production → Create
new release, or the closed-testing track first). Later releases can use
`eas submit --platform android` once a Google service-account JSON is created
in the console and referenced from `eas.json` under `submit.production`.
