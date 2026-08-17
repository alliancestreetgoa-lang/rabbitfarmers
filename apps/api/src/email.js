/**
 * Getting an email out of the door.
 *
 * The same shape as push.js and for the same reasons: everything
 * provider-shaped is behind one function, `EMAIL_BASE` points it somewhere else
 * so this can be tested without an account, and deciding WHO gets mail and WHEN
 * is not in this file — `generate_dunning_emails()` settled that before a row
 * existed. This file's whole job is the network call and what to believe about
 * the answer.
 *
 * Resend is the provider, chosen the way Expo was: it is one HTTP POST with an
 * API key, it does not need a domain-verified SMTP relay to start, and swapping
 * it means editing `send()` rather than anything else. Nothing above this file
 * knows the name.
 *
 * Not configured is a first-class state, not a crash. A farm running this on a
 * laptop with no API key should see queued mail on the console and no errors —
 * the alternative is a scheduler that reports a failure every fifteen minutes
 * for a thing nobody asked it to do.
 */
import { adminPool } from './db.js';
import { renderEmail } from './email-templates.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

const RESEND = 'https://api.resend.com';

const base = () => (process.env.EMAIL_BASE ?? RESEND).replace(/\/$/, '');

/** True when a farmer would actually receive something. Keeps the tests honest. */
export function emailConfigured() {
  return Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);
}

/**
 * Hand one message to the provider.
 *
 * Returns the provider's id for it, which is what a support conversation with
 * the provider is conducted in. Throws with `permanent` set when the provider
 * has told us this address will never work — the caller stops retrying and
 * suppresses rather than burning five attempts on a typo.
 */
async function send({ to, subject, text, html, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${base()}/emails`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      // A farmer replying to a billing email must reach a person. The default
      // no-reply address is how a customer with a question decides the whole
      // thing is a scam and ignores the next one too.
      reply_to: process.env.SUPPORT_EMAIL ?? undefined,
      to: [to],
      subject,
      text,
      html,
    }),
  });

  const body = await res.text();
  let json = null;
  try { json = body ? JSON.parse(body) : null; } catch { /* not JSON */ }

  if (!res.ok) {
    const err = new Error(json?.message ?? json?.error?.message ?? `provider returned ${res.status}`);
    err.status = res.status;
    /*
     * 4xx that is not rate limiting or auth means the message itself is wrong —
     * usually an address the provider will not accept. Retrying that four more
     * times achieves nothing and delays every message behind it.
     */
    err.permanent = res.status >= 400 && res.status < 500
      && ![401, 403, 408, 429].includes(res.status);
    throw err;
  }
  return json?.id ?? null;
}

/**
 * One delivery pass.
 *
 * Reads the queue, renders each message at send time — so a fixed sentence
 * applies to mail queued yesterday — and records what happened to each one
 * separately, so a provider failing halfway leaves exactly the un-sent rows for
 * the next pass.
 *
 * Serial rather than batched, unlike push. The volume is a handful a day
 * against hundreds of notifications, and a provider that rate-limits is far
 * more likely than one that wants a hundred at once.
 */
export async function deliverEmails({ limit = 100, fetchImpl = globalThis.fetch } = {}) {
  const client = await adminPool.connect();
  try {
    // Always, even unconfigured: mail too old to be true must be dropped
    // whether or not anybody is sending it.
    const { rows: stale } = await client.query('SELECT email_expire_stale() AS n');

    if (!emailConfigured()) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM email_message WHERE status = 'queued'`);
      return { ok: true, skipped: 'email not configured', sent: 0, failed: 0,
               queued: rows[0].n, expired: stale[0].n };
    }

    const { rows: queue } = await client.query(
      'SELECT * FROM v_email_queue ORDER BY created_at LIMIT $1', [limit]);

    let sent = 0;
    let failed = 0;

    for (const message of queue) {
      let rendered;
      try {
        rendered = renderEmail(message.kind, message.context ?? {});
      } catch (err) {
        // A template that throws is our bug, not the provider's, and it will
        // throw again on every pass. Permanent, so it stops asking.
        await client.query('SELECT email_record_failure($1,$2,$3)',
          [message.id, `could not render: ${err.message}`, true]);
        failed++;
        continue;
      }

      try {
        const id = await send({
          to: message.to_email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          fetchImpl,
        });
        await client.query('SELECT email_record_sent($1,$2,$3,$4,$5)',
          [message.id, rendered.subject, rendered.text, 'resend', id]);
        sent++;
      } catch (err) {
        await client.query('SELECT email_record_failure($1,$2,$3)',
          [message.id, String(err.message ?? err), Boolean(err.permanent)]);
        /*
         * An address the provider refuses outright is suppressed here rather
         * than waiting for a bounce webhook that may never come — a webhook
         * needs a public URL, and this has to work before there is one.
         */
        if (err.permanent) {
          await client.query('SELECT email_suppress($1,$2,$3,$4)',
            [message.to_email, 'the provider refused the address', 'provider',
             String(err.message ?? err).slice(0, 300)]);
        }
        failed++;
      }
    }

    return { ok: true, sent, failed, queued: queue.length, expired: stale[0].n };
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------- webhooks -- */

/**
 * Is this bounce notification really from the provider?
 *
 * Resend signs webhooks the Svix way: the signed string is `id.timestamp.body`,
 * HMAC-SHA256 with the base64 secret after its `whsec_` prefix, and the header
 * carries one or more space-separated `v1,<base64>` signatures — more than one
 * while a secret is being rotated, so any match counts.
 *
 * Worth the care for the same reason the Razorpay one is: this endpoint is
 * reachable by anyone on the internet and it can stop a farm receiving mail.
 * Forging a bounce for a competitor's address is a cheap and quiet attack.
 */
export function verifyEmailWebhook(rawBody, headers, secret = process.env.EMAIL_WEBHOOK_SECRET) {
  if (!secret) return false;
  const id = headers['svix-id'] ?? headers['webhook-id'];
  const timestamp = headers['svix-timestamp'] ?? headers['webhook-timestamp'];
  const signature = headers['svix-signature'] ?? headers['webhook-signature'];
  if (!id || !timestamp || !signature) return false;

  // Five minutes either way. Without this, a signature captured once is valid
  // for ever and can be replayed to re-suppress an address the moment support
  // clears it.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`, 'utf8')
    .digest('base64');

  return String(signature).split(' ').some((part) => {
    const value = part.startsWith('v1,') ? part.slice(3) : part;
    const a = Buffer.from(value, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // Length first: timingSafeEqual throws on a mismatch, and a throw is itself
    // a timing signal.
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * What a bounce notification means for us.
 *
 * Only two events matter. A hard bounce is a mailbox that does not exist; a
 * complaint is somebody pressing "this is spam", which is a clearer instruction
 * to stop than any unsubscribe link. Soft bounces — a full mailbox, a server
 * having a bad afternoon — are deliberately ignored: suppressing on those would
 * cut off a real customer for somebody else's outage.
 */
export async function applyEmailEvent(body) {
  const type = String(body?.type ?? '');
  const data = body?.data ?? {};
  const to = Array.isArray(data.to) ? data.to[0] : data.to;
  if (!to) return { result: 'no address' };

  if (type === 'email.bounced') {
    const kind = String(data.bounce?.type ?? data.bounce_type ?? '').toLowerCase();
    if (kind && kind !== 'hard' && kind !== 'permanent') {
      return { result: 'soft bounce, ignored' };
    }
    const { rows } = await adminPool.query('SELECT email_suppress($1,$2,$3,$4) AS cancelled',
      [to, 'the address does not exist', 'bounce',
       data.bounce?.message ?? data.bounce?.subType ?? null]);
    return { result: 'suppressed', cancelled: rows[0].cancelled };
  }

  if (type === 'email.complained') {
    const { rows } = await adminPool.query('SELECT email_suppress($1,$2,$3,$4) AS cancelled',
      [to, 'they marked it as spam', 'complaint', null]);
    return { result: 'suppressed', cancelled: rows[0].cancelled };
  }

  return { result: 'ignored' };
}
