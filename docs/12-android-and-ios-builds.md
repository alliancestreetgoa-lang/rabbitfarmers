# 12 — Android and iOS builds

The web export is what Netlify serves and what most farmers will use — it
installs to a home screen from the browser and needs no store. This document is
for when you want an actual `.apk` to sideload, or a listing on Play.

**There is no APK in this repository.** Building one needs the Android SDK and a
signing key, and neither belongs in git. Everything else is here: the icons, the
native config, the EAS profiles, and the one behaviour that makes an APK usable
at all.

---

## The thing that makes a native build different

A web build finds the API by asking the page it was served from — Netlify puts
the app and the function on one site, so `/api` on that origin is right by
definition. **An APK has no origin.** It is a file on a phone, and unless the
address was compiled into it, there is nothing to ask.

Two answers, and you want the first:

**Compile it in.** Set `EXPO_PUBLIC_API_URL` at build time and the app never
asks anything:

```bash
EXPO_PUBLIC_API_URL=https://yourfarm.netlify.app/api eas build …
```

**Or let it ask.** A build without that variable shows a *Your Rabbitry address*
field on the sign-in screen, checks that something answers `/health` there
before keeping it, and remembers it. The address is shown afterwards under More
→ Server, because "which server am I even on" is the first question worth
answering when an installed app looks broken.

Do not ship a build that asks. It is there so a build made before you had a URL
is testable rather than inert.

### Two traps, both silent

**The value has to reach the machine that builds.** `eas build` runs on Expo's
servers. Exporting `EXPO_PUBLIC_API_URL` in your own shell does not send it
there — only `eas.json`'s `env` block travels with the project. Set it in
`eas.json` (the GitHub workflow writes it in for you) rather than only on the
command line, or you get an APK that quietly ignores the address you gave it.

**Changing it needs the cache cleared.** The value is substituted into the
JavaScript at transform time and Metro's transform cache is not keyed on it. A
second build with a different address reuses the first one and says nothing —
an app pointed at somebody else's server, with nothing in the log about it. Use
`--clear`:

```bash
npx expo export --clear --platform android
```

EAS builds on a fresh machine each time, so this only bites locally. It bites
hard, though: both of these were found by grepping the compiled bundle for the
address, which is the only way to actually know.

```bash
# what "actually know" looks like
npx expo export --clear --platform android --output-dir /tmp/check
grep -c 'yourfarm.netlify.app' /tmp/check/_expo/static/js/android/*.hbc
```

---

## Build it from GitHub (nothing installed at all)

`.github/workflows/android-apk.yml` runs the EAS build for you. Manual trigger
only — never on a push, because an APK is something you ask for.

Once, in the browser:

1. An Expo account at [expo.dev](https://expo.dev).
2. A project on it. Either `eas init` from `apps/mobile` on any machine, or
   expo.dev → Projects → Create. Copy the project id.
3. Two repository secrets under **Settings → Secrets and variables → Actions**:

   | Secret | Where it comes from |
   |---|---|
   | `EXPO_TOKEN` | expo.dev → account settings → Access tokens |
   | `EAS_PROJECT_ID` | the project id from step 2 |

Then **Actions → Android APK → Run workflow**, and give it your site's address.
The APK comes back as a downloadable workflow artifact, and also sits on
expo.dev with a QR code you can scan straight from the phone.

The workflow bundles for Android before it queues the EAS build. That is the
step that fails for a reason in *this* repository — a bad import, a version
mismatch, an asset that is not where the config says — and catching it locally
costs seconds instead of a twenty-minute queue.

---

## Build it on EAS from your machine (no local Android SDK)

Expo's builders have the SDK, the NDK and a keystore. This is the shortest path
from nothing to an APK on a phone.

```bash
npm i -g eas-cli
eas login                       # a free Expo account
cd apps/mobile
eas init                        # writes a projectId into your Expo account
eas build --platform android --profile preview
```

`preview` is the profile to use. It produces an **`.apk`**, which a phone can
install directly. The `production` profile produces an `.aab` — the format Play
requires and a phone cannot open. Finding that out after a twenty-minute build
is a rite of passage worth skipping, which is why both profiles exist and are
labelled.

When it finishes, EAS prints a URL and a QR code. Open it on the phone, allow
"install unknown apps" for the browser, done.

**Set the API URL first**, either in `eas.json` under the profile's `env`, or on
the command line:

```bash
EXPO_PUBLIC_API_URL=https://yourfarm.netlify.app/api \
  eas build --platform android --profile preview
```

### Signing

EAS generates and keeps a keystore for you on the first build. That keystore
*is* your app's identity on Play: lose it and you cannot update your own app,
only publish a new listing. Pull a copy the day you make your first release:

```bash
eas credentials            # Android → download keystore
```

Store it somewhere that is not a laptop.

---

## Build it locally

Only worth it if you are iterating on native code, and it needs about 8 GB of
downloads the first time.

```bash
# Java 17 and the Android SDK — command-line tools from
# https://developer.android.com/studio#command-tools
export ANDROID_HOME=$HOME/Android/sdk
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"

cd apps/mobile
npm install
npx expo prebuild --platform android     # generates android/
cd android && ./gradlew assembleRelease
# apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

`android/` is **generated, not committed** — it is in `.gitignore`. Expo's model
is that `app.config.js` is the source of truth and the native project is an
output of it; editing files under `android/` by hand means the next prebuild
silently discards your change. If you need a native change, express it as a
config plugin.

An unsigned release APK will not install. For a throwaway build, use
`./gradlew assembleDebug` instead — it is signed with Android's public debug
key, which is fine for testing and unacceptable for anything else.

### It will not build in a sandbox without Google

Worth knowing before you try: `dl.google.com` serves both the SDK and every
Android Gradle artifact (`maven.google.com` is a redirect to it). A build
machine that cannot reach that host cannot build Android at all, no matter what
else is installed — Ubuntu's packaged SDK is build-tools 29 and platform 23,
against React Native 0.76's requirement of 35. Use EAS from such a machine.

---

## iOS

Same project, same command, `--platform ios`. It additionally needs an Apple
Developer account (₹8,000-odd a year) and EAS handles the certificates. There is
no way around the account; Apple does not allow sideloading.

---

## Icons

`assets/` is generated:

```bash
npm --prefix apps/mobile run icons
```

`scripts/make-icons.mjs` draws the mark from ellipses and writes the PNGs
directly — a script rather than four opaque binaries, because an icon is the one
asset nobody can read a diff of. Change the shape there and re-run.

Android's adaptive icon is masked to whatever shape the launcher uses, so the
foreground is drawn smaller than the square icon. That is the `scale` argument.

---

## Before a store listing

Beyond the build itself, and none of it is done:

- **`versionCode`** in `app.config.js` must increase on every upload. Play
  refuses a repeat.
- **A privacy policy URL.** Play requires one for any app that handles accounts.
- **Data safety form.** You collect an email, a phone number and farm records.
- **Push notifications.** The scheduler raises them and the API serves them;
  nothing delivers them to a phone yet. An app store listing that promises
  reminders should probably deliver reminders.
