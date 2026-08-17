/**
 * The dunning emails.
 *
 * Four messages, each tied to an event that has actually happened, each sent
 * exactly once. docs/09 is blunt about why it is only four: "at ₹99, a failed
 * monthly mandate costs more in dunning, SMS and support time than the ₹99 it is
 * chasing." So most of this file is about restraint — not sending twice, not
 * sending late, not sending at all to an address that has bounced — rather than
 * about the happy path, which is one POST.
 *
 * Three things are being protected.
 *
 * **The customer's inbox.** A scheduler that runs every fifteen minutes and a
 * warning with no dedupe key is ninety-six copies of the same email in a day,
 * and the customer is gone. Every test here runs the generator repeatedly.
 *
 * **The sending domain.** Mail to a dead address is what gets a domain filtered,
 * and once that happens it takes the receipts and the lapse notices with it —
 * the mail that actually matters. Hence a suppression list with no way around it.
 *
 * **The truth.** A renewal warning that arrives a week late tells a farmer who
 * has already paid that they are about to be cut off. Stale mail is dropped
 * visibly rather than sent.
 *
 * The provider is a stub. api.resend.com is unreachable from here, and the cases
 * worth testing — a refused address, a provider having a bad minute, a forged
 * bounce — are not things you arrange against a real one.
 */
import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { api, signupFarm, cleanup, closePools, adminQuery } from './helpers.js';
import { deliverEmails } from '../src/email.js';
import { renderEmail } from '../src/email-templates.js';

const WEBHOOK_SECRET = 'whsec_dGVzdC1lbWFpbC1zZWNyZXQtdmFsdWUtaGVyZQ==';

const RUN = `${process.pid}${Date.now().toString(36)}`;
let counter = 0;

let server;
/** Every message the API asked the provider to send. */
let posted = [];
/** How the stub answers: 'ok' | 'refuse' | 'down' | 'ratelimit'. */
let mode = 'ok';

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      posted.push(payload);

      if (mode === 'refuse') {
        // A 422 is the provider saying the message itself is wrong — almost
        // always an address it will not accept.
        res.writeHead(422, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Invalid `to` field' }));
      }
      if (mode === 'ratelimit') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Too many requests' }));
      }
      if (mode === 'down') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'upstream on fire' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `msg_${RUN}_${++counter}` }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.EMAIL_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.EMAIL_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'rabbitfarmers <billing@rabbitry.test>';
  process.env.SUPPORT_EMAIL = 'support@rabbitry.test';
  process.env.EMAIL_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await adminQuery(`DELETE FROM webhook_event WHERE id LIKE $1`, [`email:%${RUN}%`]);
  await adminQuery(`DELETE FROM email_suppression WHERE address LIKE $1`,
    [`%${process.pid}x%@example.test`]);
  await cleanup();
  await closePools();
});

/* ---------------------------------------------------------------- fixtures -- */

/** A farm whose money is due `dueIn` days from now. */
async function farmDue(dueIn, { period = 'yearly', status = 'active' } = {}) {
  const f = await signupFarm({ farm_name: `Mail Farm ${RUN} ${++counter}` });
  await adminQuery(`
    UPDATE subscription
       SET status = $2::subscription_status_t, trial_ends_on = NULL, grace_until = NULL,
           billing_period = $3::billing_period_t,
           current_period_start = current_date - 300,
           current_period_end = current_date + $4::int
     WHERE farm_id = $1`, [f.farm.id, status, period, dueIn]);
  return f;
}

const generate = () => adminQuery('SELECT generate_dunning_emails() AS n')
  .then((r) => r.rows[0].n);

const mail = (farmId) => adminQuery(
  `SELECT kind, status, to_email::text AS to_email, subject, attempts, last_error, context
     FROM email_message WHERE farm_id = $1 ORDER BY created_at`,
  [farmId]).then((r) => r.rows);

/* ------------------------------------------------------------ the sequence -- */

describe('when a farm gets an email', () => {
  test('a week before the money is due, and only then', async () => {
    const soon = await farmDue(5);
    const later = await farmDue(20);
    await generate();

    const mine = await mail(soon.farm.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kind, 'renewal_due');
    assert.equal(mine[0].to_email, soon.email);
    assert.equal(mine[0].context.days_left, 5);
    assert.equal(mine[0].context.amount_paise, 99900);

    assert.deepEqual(await mail(later.farm.id), [],
      'a farm three weeks out does not need telling yet');
  });

  test('on the day it is due', async () => {
    const f = await farmDue(0);
    await generate();
    const mine = await mail(f.farm.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kind, 'renewal_last_call');
    // The one that gets opened, so it carries how long they have left.
    assert.equal(mine[0].context.grace_days, 30);
  });

  test('nothing stops, so there is no "it has stopped" mail to send', async () => {
    /*
     * Asserted a `subscription_lapsed` email until migration 0031.
     *
     * That branch of generate_dunning_emails() selects farms whose entitlement
     * has gone to 'read_only'. Access is now the constant 'full', so the branch
     * matches nobody and the mail cannot be produced — which is the correct
     * outcome, not a gap: telling a farmer on a free product that their
     * subscription has ended would be a lie, and unlike an in-app notice this
     * one leaves the building.
     *
     * Called directly here, as the whole file does. The scheduler no longer calls
     * this function at all — see the last suite in lapse.test.js.
     */
    const f = await farmDue(-31);
    await generate();
    assert.deepEqual(await mail(f.farm.id), [],
      'a free product must never email a farmer that their subscription ended');
  });

  test('and a receipt when they pay', async () => {
    const f = await farmDue(300);
    const link = `plink_mail_${RUN}_${++counter}`;
    await adminQuery(`
      INSERT INTO payment (farm_id, gateway_link_id, amount_paise, billing_period,
                           covers_days, status)
      VALUES ($1, $2, 99900, 'yearly', 365, 'created')`, [f.farm.id, link]);
    const applied = await adminQuery('SELECT * FROM billing_apply_payment($1,$2,$3)',
      [link, `pay_mail_${RUN}_${counter}`, null]).then((r) => r.rows[0]);

    await generate();
    const mine = await mail(f.farm.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kind, 'payment_received');
    assert.equal(mine[0].context.invoice_number, applied.invoice_number);
    // The GST number in the farmer's inbox, where their accountant can find it.
    assert.equal(mine[0].context.tax_paise + mine[0].context.subtotal_paise, 99900);
  });

  test('never twice, however often the scheduler runs', async () => {
    const f = await farmDue(3);
    for (let i = 0; i < 5; i += 1) await generate();
    assert.equal((await mail(f.farm.id)).length, 1,
      'ninety-six copies of the same warning in a day is how you lose a customer');
  });

  test('a farm that has left is not chased', async () => {
    const f = await farmDue(-31, { status: 'cancelled' });
    await generate();
    assert.deepEqual(await mail(f.farm.id), []);
  });

  test('a farm that lapsed months ago is left alone', async () => {
    const f = await farmDue(-200);
    await generate();
    assert.deepEqual(await mail(f.farm.id), []);
  });
});

/* ------------------------------------------------------------- the sending -- */

describe('sending it', () => {
  test('one POST, with both a text and an HTML part', async () => {
    mode = 'ok';
    posted = [];
    const f = await farmDue(4);
    await generate();

    const result = await deliverEmails();
    assert.ok(result.sent >= 1, JSON.stringify(result));

    const sent = posted.find((p) => p.to[0] === f.email);
    assert.ok(sent, 'the message went to the owner');
    assert.equal(sent.from, 'rabbitfarmers <billing@rabbitry.test>');
    // A farmer replying to a billing email must reach a person, not a void.
    assert.equal(sent.reply_to, 'support@rabbitry.test');
    assert.match(sent.subject, /ends on/);
    assert.ok(sent.text.includes('₹999'), 'says the number');
    assert.ok(sent.html.includes('<html'), 'and carries an HTML part');
    // No tracking pixel, no remote image, no web font.
    assert.ok(!/<img|https?:\/\/fonts|url\(/i.test(sent.html), sent.html.slice(0, 200));

    const [row] = await mail(f.farm.id);
    assert.equal(row.status, 'sent');
    assert.ok(row.subject, 'what was said is kept, not just that it went');
  });

  test('a provider having a bad minute is retried, not given up on', async () => {
    mode = 'down';
    const f = await farmDue(4);
    await generate();
    await deliverEmails();

    let [row] = await mail(f.farm.id);
    assert.equal(row.status, 'queued', 'still queued — the provider, not the address');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /500|fire/);

    // Backed off, so the next pass does not burn another attempt immediately.
    const { rows } = await adminQuery(
      `SELECT next_attempt_at > now() AS waiting FROM email_message WHERE farm_id = $1`,
      [f.farm.id]);
    assert.equal(rows[0].waiting, true);

    // When it comes back, it goes.
    mode = 'ok';
    await adminQuery(
      `UPDATE email_message SET next_attempt_at = now() WHERE farm_id = $1`, [f.farm.id]);
    await deliverEmails();
    [row] = await mail(f.farm.id);
    assert.equal(row.status, 'sent');
  });

  test('and gives up after five', async () => {
    mode = 'down';
    const f = await farmDue(4);
    await generate();
    for (let i = 0; i < 5; i += 1) {
      await adminQuery(
        `UPDATE email_message SET next_attempt_at = now() WHERE farm_id = $1`, [f.farm.id]);
      await deliverEmails();
    }
    const [row] = await mail(f.farm.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 5);
  });

  test('an address the provider refuses is suppressed, not retried', async () => {
    mode = 'refuse';
    const f = await farmDue(4);
    await generate();
    await deliverEmails();

    const [row] = await mail(f.farm.id);
    assert.equal(row.status, 'failed', 'no point trying a bad address four more times');
    assert.equal(row.attempts, 1);

    const { rows } = await adminQuery(
      'SELECT reason, source FROM email_suppression WHERE address = $1', [f.email]);
    assert.equal(rows.length, 1, 'and it goes on the list without waiting for a bounce');
    assert.equal(rows[0].source, 'provider');
  });

  test('rate limiting is not the address’s fault', async () => {
    mode = 'ratelimit';
    const f = await farmDue(4);
    await generate();
    await deliverEmails();

    const [row] = await mail(f.farm.id);
    assert.equal(row.status, 'queued', '429 means slow down, not stop');
    const { rowCount } = await adminQuery(
      'SELECT 1 FROM email_suppression WHERE address = $1', [f.email]);
    assert.equal(rowCount, 0, 'a busy provider must not cost a customer their mail');
  });

  test('mail too old to be true is dropped rather than sent late', async () => {
    /*
     * A renewal warning that arrives a week after the renewal tells a farmer who
     * has already paid that they are about to be cut off. Worse than silence.
     */
    mode = 'ok';
    posted = [];
    const f = await farmDue(4);
    await generate();
    await adminQuery(
      `UPDATE email_message SET created_at = now() - interval '5 days' WHERE farm_id = $1`,
      [f.farm.id]);

    const result = await deliverEmails();
    assert.ok(result.expired >= 1);
    const [row] = await mail(f.farm.id);
    assert.equal(row.status, 'expired');
    assert.ok(!posted.some((p) => p.to[0] === f.email), 'and it never left');
  });

  test('with no provider configured it queues quietly and sends nothing', async () => {
    // A farm running this on a laptop with no API key should see queued mail
    // and no errors, not a failure every fifteen minutes.
    const f = await farmDue(4);
    await generate();
    const key = process.env.EMAIL_API_KEY;
    delete process.env.EMAIL_API_KEY;
    try {
      const result = await deliverEmails();
      assert.equal(result.ok, true);
      assert.equal(result.sent, 0);
      assert.match(result.skipped, /not configured/);
      const [row] = await mail(f.farm.id);
      assert.equal(row.status, 'queued');
    } finally {
      process.env.EMAIL_API_KEY = key;
    }
  });
});

/* --------------------------------------------------------------- bounces -- */

/** A provider webhook, signed the way Svix signs one. */
async function bounceWebhook(body, { secret = WEBHOOK_SECRET, id, timestamp } = {}) {
  const raw = JSON.stringify(body);
  const svixId = id ?? `msg_${RUN}_${++counter}`;
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
    .update(`${svixId}.${ts}.${raw}`, 'utf8')
    .digest('base64');

  return api('POST', '/webhooks/email', {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': String(ts),
      'svix-signature': `v1,${signature}`,
    },
    rawBody: raw,
  });
}

describe('an address that stops working', () => {
  test('a hard bounce suppresses it and cancels what is queued', async () => {
    mode = 'ok';
    const f = await farmDue(4);
    await generate();

    const res = await bounceWebhook({
      type: 'email.bounced',
      data: { to: [f.email], bounce: { type: 'hard', message: 'mailbox does not exist' } },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.result, 'suppressed');
    assert.equal(res.body.cancelled, 1, 'queued mail to a dead address is abandoned');

    const [row] = await mail(f.farm.id);
    assert.equal(row.status, 'suppressed');

    // And nothing new is queued for them either.
    await adminQuery(
      `UPDATE subscription SET current_period_end = current_date + 3 WHERE farm_id = $1`,
      [f.farm.id]);
    await generate();
    assert.equal((await mail(f.farm.id)).length, 1, 'no second message to a dead address');
  });

  test('the send path checks the list again, whatever put an address on it', async () => {
    /*
     * email_suppress() cancels what is already queued, and the generator will
     * not queue anything new — but the claim the whole list rests on is that
     * there is NO path around it. An address added by a person at a psql
     * prompt, or one suppressed a moment after a message was queued, has to be
     * caught by the send path itself.
     */
    mode = 'ok';
    posted = [];
    const f = await farmDue(4);
    await generate();
    await adminQuery(
      `INSERT INTO email_suppression (address, reason, source)
       VALUES ($1, 'added by hand', 'manual')`, [f.email]);

    await deliverEmails();

    assert.ok(!posted.some((p) => p.to[0] === f.email),
      'a suppressed address must not be written to, however it got on the list');
    const [row] = await mail(f.farm.id);
    assert.equal(row.status, 'queued', 'and the message is held, not marked sent');
  });

  test('a complaint is the clearest unsubscribe there is', async () => {
    const f = await farmDue(4);
    const res = await bounceWebhook({
      type: 'email.complained', data: { to: [f.email] },
    });
    assert.equal(res.body.result, 'suppressed');
    const { rows } = await adminQuery(
      'SELECT reason FROM email_suppression WHERE address = $1', [f.email]);
    assert.match(rows[0].reason, /spam/);
  });

  test('a soft bounce is somebody else’s outage, not a dead address', async () => {
    const f = await farmDue(4);
    const res = await bounceWebhook({
      type: 'email.bounced',
      data: { to: [f.email], bounce: { type: 'soft', message: 'mailbox full' } },
    });
    assert.match(res.body.result, /ignored/);
    const { rowCount } = await adminQuery(
      'SELECT 1 FROM email_suppression WHERE address = $1', [f.email]);
    assert.equal(rowCount, 0, 'a full mailbox today is a working one tomorrow');
  });

  test('an unsigned bounce changes nothing', async () => {
    /*
     * The attack this stops: forge a bounce for a competitor's address and that
     * farm stops receiving its receipts and its lapse warnings, with nothing on
     * any screen to say why.
     */
    const f = await farmDue(4);
    const res = await api('POST', '/webhooks/email', {
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify({ type: 'email.bounced', data: { to: [f.email] } }),
    });
    assert.equal(res.status, 400);

    const wrong = await bounceWebhook(
      { type: 'email.bounced', data: { to: [f.email] } },
      { secret: 'whsec_c29tZWJvZHkgZWxzZXMgc2VjcmV0IHZhbHVl' });
    assert.equal(wrong.status, 400);

    const { rowCount } = await adminQuery(
      'SELECT 1 FROM email_suppression WHERE address = $1', [f.email]);
    assert.equal(rowCount, 0);
  });

  test('a signature captured yesterday cannot be replayed today', async () => {
    const f = await farmDue(4);
    const old = Math.floor(Date.now() / 1000) - 3600;
    const res = await bounceWebhook(
      { type: 'email.bounced', data: { to: [f.email] } }, { timestamp: old });
    assert.equal(res.status, 400);
  });

  test('the same bounce twice is handled once', async () => {
    const f = await farmDue(4);
    const id = `msg_dupe_${RUN}`;
    const body = { type: 'email.bounced',
                   data: { to: [f.email], bounce: { type: 'hard' } } };
    const first = await bounceWebhook(body, { id });
    const second = await bounceWebhook(body, { id });
    assert.equal(first.body.result, 'suppressed');
    assert.equal(second.body.duplicate, true);
  });
});

/* ------------------------------------------------------------- the words -- */

describe('what the emails say', () => {
  const context = {
    farm_name: 'Sunrise Rabbitry', due_on: '2026-09-01', days_left: 5,
    amount_paise: 99900, billing_period: 'yearly', covered_until: '2026-10-01',
    grace_days: 30,
  };

  test('every one of them says the records stay and the reminders keep coming', () => {
    /*
     * The single most important sentence in the sequence, and the one that is
     * easiest to lose in an edit. A farmer who thinks not paying deletes their
     * herd will not renew — they will assume it is already gone.
     */
    for (const kind of ['renewal_last_call', 'subscription_lapsed']) {
      const { text } = renderEmail(kind, context);
      assert.match(text, /nothing is deleted|Nothing has been deleted/i, kind);
      assert.match(text, /reminders (keep|are still)/i, kind);
    }
  });

  test('and none of them offers to switch off a receipt', () => {
    // Transactional, all four. An unsubscribe link here is an offer to make
    // somebody's records disappear without warning.
    for (const kind of ['renewal_due', 'renewal_last_call', 'subscription_lapsed',
                        'payment_received']) {
      const { text, html } = renderEmail(kind, { ...context, invoice_number: 'RB/2026-27/00001',
        total_paise: 99900, subtotal_paise: 84661, tax_paise: 15239 });
      assert.ok(!/unsubscribe/i.test(text + html), kind);
      // But every one says why it arrived and how to reach a person.
      assert.match(text, /You are getting this because/, kind);
      assert.match(text, /support@/, kind);
    }
  });

  test('the amount and the date are in words a person can act on', () => {
    const { subject, text } = renderEmail('renewal_due', context);
    assert.match(subject, /Sunrise Rabbitry/);
    assert.match(subject, /1 September 2026/, 'long dates: 09/01 is ambiguous by country');
    assert.match(text, /₹999/);
    assert.match(text, /5 days/);
  });

  test('a trial is called a trial', () => {
    const { subject } = renderEmail('renewal_due', { ...context, is_trial: true });
    assert.match(subject, /free trial/);
  });

  test('an unknown kind throws rather than sending something blank', () => {
    assert.throws(() => renderEmail('nonsense', {}), /no template/);
  });

  test('every style is on the element it applies to, not on <body>', () => {
    /*
     * Gmail strips <head>, <style> and the <body> tag itself. Anything set
     * there is gone by the time a farmer reads it, which is exactly how a
     * carefully typeset email arrives in Times New Roman — and how this one
     * did, until a browser was pointed at it.
     */
    const { html } = renderEmail('renewal_due', context);
    const inner = html.slice(html.indexOf('<div'));
    assert.match(inner, /<p style="font-family:/,
      'paragraphs must carry their own font');
    assert.ok(!/<link|<style/.test(html), 'no stylesheet survives an email client');
  });

  test('the footer is separate lines, not one run-on paragraph', () => {
    const { html } = renderEmail('renewal_due', context);
    assert.match(html, /<hr /, 'a rule before it');
    assert.match(html, /<p[^>]*>Reply to this email/);
    assert.match(html, /<p[^>]*>You are getting this because/);
  });
});

/* ------------------------------------------------------------- isolation -- */

describe('one farm’s mail', () => {
  test('is not another farm’s', async () => {
    const a = await farmDue(4);
    const b = await farmDue(4);
    await generate();

    const res = await api('GET', '/auth/me', { token: a.token });
    assert.equal(res.status, 200);

    // The farmer-facing role may read its own messages and write none.
    const { rows } = await adminQuery(`
      SELECT has_table_privilege('rabbitry_app', 'email_message', 'SELECT') AS can_read,
             has_table_privilege('rabbitry_app', 'email_message', 'INSERT') AS can_write,
             has_table_privilege('rabbitry_app', 'email_suppression', 'SELECT') AS sees_list`);
    assert.equal(rows[0].can_read, true);
    assert.equal(rows[0].can_write, false);
    assert.equal(rows[0].sees_list, false,
      'the suppression list is platform-wide and none of a tenant’s business');

    const mineA = await mail(a.farm.id);
    const mineB = await mail(b.farm.id);
    assert.equal(mineA.length, 1);
    assert.equal(mineB.length, 1);
    assert.notEqual(mineA[0].to_email, mineB[0].to_email);
  });

  test('and the queue is not readable by a farm at all', async () => {
    const { rows } = await adminQuery(
      `SELECT has_table_privilege('rabbitry_app', 'v_email_queue', 'SELECT') AS can`);
    assert.equal(rows[0].can, false);
  });
});
