import { Link } from 'react-router-dom';

/**
 * The privacy policy, in plain words. Play requires a public URL for one, and
 * a farmer deserves one anyway: this is what the app keeps, why, and how to
 * get it deleted. Keep it true — every line here is a promise.
 */
export function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-10 text-farm-ink">
      <Link to="/" className="text-sm font-semibold text-farm-accent">← rabbitfarmers</Link>
      <h1 className="mt-6 font-serif text-3xl">Privacy policy</h1>
      <p className="mt-1 text-sm text-farm-muted">Last updated 8 September 2026</p>

      <section className="mt-8 space-y-3 text-sm leading-6">
        <p>
          rabbitfarmers is a free record-keeping tool for rabbit farms, made by Alliance Street
          Organic Farms, Goa, India. This page says what the app stores, what it does with it,
          and how to have it deleted.
        </p>

        <h2 className="pt-4 text-lg font-semibold">What we store</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Your account:</strong> your name, and the email address or phone number you sign in with. Your password is stored only as a one-way hash.</li>
          <li><strong>Your farm's records:</strong> the rabbits, matings, litters, health conditions, medicines given, tasks, attendance and staff details you enter. They belong to your farm.</li>
          <li><strong>Your phone's push token</strong>, if you allow notifications, so reminders can reach the phone.</li>
          <li><strong>Sign-in sessions</strong> and basic server logs (time, address, what was requested), kept for security and to fix faults.</li>
        </ul>

        <h2 className="pt-4 text-lg font-semibold">What we do with it</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Run the app for you: show your records, raise reminders, send notifications to your phone.</li>
          <li>Nothing else. We do not sell it, share it with advertisers, or use it to build profiles. The app shows no advertising.</li>
          <li>Records are visible only to people you add to your farm, and to the farm's own owner and managers according to the role you give them.</li>
          <li>A super administrator at Alliance Street Organic Farms can see farm records to support you and to keep the shared medicine chart accurate. Every such access is logged.</li>
        </ul>

        <h2 className="pt-4 text-lg font-semibold">Where it is kept</h2>
        <p>
          On servers run for us by Netlify and Neon (database), in encrypted form in transit and at rest.
          Push notifications go through Expo's notification service.
        </p>

        <h2 className="pt-4 text-lg font-semibold">Deleting your data</h2>
        <p>
          You can delete your account, or your whole farm with every record in it, at any time.
          Ask by email or phone using the contact below and it is done within 7 days; nothing is kept
          except server logs, which expire on their own within 30 days. Records you delete inside the
          app (a rabbit, a mating, a person) are removed from the working records the same way.
        </p>

        <h2 className="pt-4 text-lg font-semibold">Children</h2>
        <p>The app is for people running a farm and is not directed at children under 13.</p>

        <h2 className="pt-4 text-lg font-semibold">Contact</h2>
        <p>
          Alliance Street Organic Farms, Goa, India.<br />
          Phone: +91 73750 96163<br />
          Email: alliancestreetorganicfarms@gmail.com
        </p>

        <p className="pt-4 text-farm-muted">
          If this policy changes, the date at the top changes with it, and anything that changes what
          we keep or why will be announced inside the app first.
        </p>
      </section>
    </main>
  );
}
