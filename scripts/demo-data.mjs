#!/usr/bin/env node
/**
 * Seed one realistic farm through the public API, then run the scheduler.
 *
 *   node scripts/demo-data.mjs
 *
 * For looking at the app with something in it — a screenshot, a demo, checking
 * that a screen still reads well when it is not empty. Everything goes through
 * the same endpoints the app uses, so this cannot seed a state the app itself
 * could not have produced.
 *
 * The dates are relative to today on purpose. A doe mated 12 days ago is due
 * for palpation whenever you run this, so the daily list is never stale.
 */
const API = process.env.API_URL ?? 'http://localhost:3000';
const STAMP = Date.now().toString(36).slice(-5);
const EMAIL = process.env.DEMO_EMAIL ?? `sunrise.${STAMP}@example.farm`;
const PASSWORD = process.env.DEMO_PASSWORD ?? 'sunrise-demo-2026';

const day = 86_400_000;
const ago = (d) => new Date(Date.now() - d * day).toISOString().slice(0, 10);
const agoTs = (d) => new Date(Date.now() - d * day).toISOString();

let token = null;
async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return json;
}

/* ------------------------------------------------------------------ farm -- */

const session = await call('POST', '/auth/signup', {
  farm_name: 'Sunrise Rabbitry',
  full_name: 'Anil Naik',
  email: EMAIL,
  phone: '+919822012345',
  password: PASSWORD,
  address_line: 'Behind the church, Curtorim',
  city: 'Margao', state: 'Goa', pincode: '403709',
});
token = session.token;
console.log(`farm      Sunrise Rabbitry  (${EMAIL} / ${PASSWORD})`);

const add = async (name, sex, bornDaysAgo, role) =>
  (await call('POST', '/animals', {
    name, sex, role, date_of_birth: ago(bornDaysAgo),
  })).animal;

// Two bucks so the suggestion list has something to rank and a real choice to
// make; six does at deliberately different points in the cycle.
const bhim = await add('Bhim', 'buck', 400);
const arjun = await add('Arjun', 'buck', 300);

const gauri = await add('Gauri', 'doe', 380);
const lakshmi = await add('Lakshmi', 'doe', 420);
const sita = await add('Sita', 'doe', 360);
const radha = await add('Radha', 'doe', 500);
const meera = await add('Meera', 'doe', 460);
const kamala = await add('Kamala', 'doe', 440);
const tulsi = await add('Tulsi', 'doe', 190);   // just old enough to breed
console.log('animals   2 bucks, 7 does');

/* --------------------------------------------------------------- breeding -- */

// Mated 12 days ago: inside the palpation window (day 10–14), so she shows up
// on today's list as a check to do.
const gauriMating = await call('POST', '/matings', {
  doe_id: gauri.id, buck_id: bhim.id, mated_at: agoTs(12), receptivity: 'receptive',
});

// Mated 28 days ago and confirmed: nest box is due now, kindling in a few days.
const lakshmiMating = await call('POST', '/matings', {
  doe_id: lakshmi.id, buck_id: arjun.id, mated_at: agoTs(28), receptivity: 'receptive',
});
await call('POST', '/pregnancy-checks', {
  mating_id: lakshmiMating.mating.id, result: 'positive', checked_on: ago(16),
  notes: 'Felt three, maybe four.',
});

// Mated the day before yesterday — too early to know anything, which is itself
// worth showing: she should NOT appear as ready to mate again.
await call('POST', '/matings', {
  doe_id: sita.id, buck_id: bhim.id, mated_at: agoTs(2), receptivity: 'receptive',
});

// Mated 20 days ago and never palpated. Counted as presumed, not confirmed —
// the case the breeding screen is meant to nag about, because a doe carried as
// pregnant on a guess is how a farm loses six weeks.
await call('POST', '/matings', {
  doe_id: kamala.id, buck_id: arjun.id, mated_at: agoTs(20),
});

// Kindled 27 days ago. Kits separate at 30 days, so that task is three days out
// and the Ostovet after-doses are already behind her.
const radhaMating = await call('POST', '/matings', {
  doe_id: radha.id, buck_id: bhim.id, mated_at: agoTs(58),
});
await call('POST', '/pregnancy-checks', {
  mating_id: radhaMating.mating.id, result: 'positive', checked_on: ago(46),
});
await call('POST', '/litters', {
  doe_id: radha.id, mating_id: radhaMating.mating.id, kindled_on: ago(27),
  born_alive: 8, born_dead: 1, notes: 'Good nest, all covered.',
});

// Weaned 4 days ago: past the 3-day rest, so she is on the rebreed list today.
const meeraMating = await call('POST', '/matings', {
  doe_id: meera.id, buck_id: arjun.id, mated_at: agoTs(97),
});
const meeraLitter = await call('POST', '/litters', {
  doe_id: meera.id, mating_id: meeraMating.mating.id, kindled_on: ago(66),
  born_alive: 7, born_dead: 0,
});
await call('POST', `/litters/${meeraLitter.litter.id}/wean`, {
  weaned_on: ago(4), weaned_count: 7, avg_weaning_weight_g: 620,
});
console.log('breeding  4 open matings, 2 litters, 1 weaned (7 kits)');

/* ---------------------------------------------------------------- health -- */

// Loose motion on the youngest doe. Two-hourly reminders, and it keeps her out
// of the breeding queue until it stops — the one that kills.
//
// Seen five hours ago rather than now, so the reminder is genuinely overdue and
// the scheduler below has something real to raise. Recording it as "now" would
// leave every health screen technically correct and completely empty.
await call('POST', '/conditions', {
  rabbit_id: tulsi.id, code: 'loose_motion', severity: 'moderate',
  observed_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
  notes: 'Wet under the tail at first feed.',
});
console.log('health    1 open case of loose motion, seen 5 hours ago');

/* ------------------------------------------------------------- scheduler -- */

/*
 * The same default scripts/localhost.sh exports. They have to agree: a
 * mismatch is refused with a 401 and this script then prints "undefined
 * task(s)" and hands over a farm whose Today tab is empty for no visible
 * reason — which is exactly the screen the demo exists to show.
 */
const secret = process.env.SCHEDULER_SECRET ?? 'local-dev-secret';
const run = await fetch(`${API}/scheduler/run`, {
  method: 'POST', headers: { 'x-scheduler-secret': secret },
}).then((r) => r.json());

if (run.error) {
  console.log(`scheduler REFUSED: ${run.error}`);
  console.log('  the farm is seeded, but nothing has generated its tasks yet.');
  console.log('  set SCHEDULER_SECRET to whatever the API is running with and re-run.');
} else {
  console.log(`scheduler ${run.tasksCreated} task(s), ${run.notificationsCreated} notification(s)`);
}

// Zero notifications overnight is correct, not broken, and worth saying out
// loud — otherwise the next person to run this spends an hour looking for a bug
// in the reminder that the farm's own quiet hours are suppressing.
const { settings } = await call('GET', '/settings');
if (run.notificationsCreated === 0 && settings.quiet_hours_enabled) {
  const me = await call('GET', '/auth/me');
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', hour12: false, timeZone: me.farm.timezone,
  }).format(new Date()));
  const quiet = settings.quiet_hours_start > settings.quiet_hours_end
    ? hour >= settings.quiet_hours_start || hour < settings.quiet_hours_end
    : hour >= settings.quiet_hours_start && hour < settings.quiet_hours_end;
  if (quiet) {
    console.log(`          (quiet hours ${settings.quiet_hours_start}:00–`
      + `${settings.quiet_hours_end}:00 on the farm — reminders are held, not lost, `
      + `and the item still shows on Today)`);
  }
}

const daily = await call('GET', '/daily');
const pregnant = await call('GET', '/pregnant');
const ready = await call('GET', '/ready-to-mate');
console.log(`today     ${daily.open} open item(s)`);
console.log(`pregnant  ${pregnant.summary?.confirmed_pregnant ?? 0} confirmed, `
  + `${pregnant.summary?.presumed_pregnant ?? 0} presumed`);
console.log(`ready     ${ready.ready.length} doe(s)`);

/* ----------------------------------------------------------- other farms -- */

/**
 * The admin console is a list. A list of one proves nothing about sorting,
 * filtering or the revenue summary, so give it neighbours on different plans —
 * but only when admin credentials are to hand, since moving a subscription is
 * something only a platform admin can do.
 */
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const adminLogin = await fetch(`${API}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD,
    }),
  });
  if (!adminLogin.ok) {
    console.log('admin     could not sign in — skipping the neighbouring farms');
  } else {
    const { token: adminToken } = await adminLogin.json();
    const adminAuth = {
      authorization: `Bearer ${adminToken}`, 'content-type': 'application/json',
    };

    const neighbours = [
      { farm: 'Konkan Warren', owner: 'Sujata Kamat', city: 'Ponda',
        email: `konkan.${STAMP}@example.farm`, herd: 14,
        action: 'activate', body: { reason: 'Paid the first year up front' } },
      { farm: 'Green Acre Rabbits', owner: 'Firoz Shaikh', city: 'Belagavi',
        email: `greenacre.${STAMP}@example.farm`, herd: 6,
        action: 'extend_trial', body: { reason: 'Asked for two more weeks to finish setup', days: 14 } },
    ];

    for (const n of neighbours) {
      const s = await call('POST', '/auth/signup', {
        farm_name: n.farm, full_name: n.owner, email: n.email, phone: '+919822000000',
        password: PASSWORD, city: n.city, state: n.city === 'Belagavi' ? 'Karnataka' : 'Goa',
      });
      const saved = token;
      token = s.token;
      for (let i = 0; i < n.herd; i++) {
        await add(`Doe ${i + 1}`, i % 4 === 0 ? 'buck' : 'doe', 300 + i * 7);
      }
      token = saved;

      const res = await fetch(`${API}/admin/farms/${s.farm.id}/${n.action}`, {
        method: 'POST', headers: adminAuth, body: JSON.stringify(n.body),
      });
      console.log(`neighbour ${n.farm} — ${n.herd} animals, ${n.action}`
        + (res.ok ? '' : ` (failed: ${res.status})`));
    }
  }
}

console.log(`\nsign in at the app with  ${EMAIL}  /  ${PASSWORD}`);
