import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Talking to Razorpay, and — more importantly — deciding whether something
 * claiming to be from Razorpay actually is.
 *
 * The webhook endpoint is the one route in this application that an anonymous
 * caller on the internet can reach and that moves money's worth of state. If
 * the signature check is wrong, anybody who guesses the URL can give themselves
 * a year of a paid subscription by POSTing a JSON body. So that function is the
 * most carefully written thing in this file and the most heavily tested thing
 * in the suite.
 *
 * `RAZORPAY_BASE` points the API calls somewhere else, which is how this is
 * tested without an account. Nothing about the signature checks changes.
 */

const BASE = () => (process.env.RAZORPAY_BASE ?? 'https://api.razorpay.com').replace(/\/$/, '');

export function razorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

/**
 * Constant-time compare of two hex digests.
 *
 * `a === b` on a signature leaks, through timing, how much of a guess was
 * right — which is enough to reconstruct a valid one given patience. Both
 * lengths are checked first because timingSafeEqual throws on a mismatch, and a
 * throw is itself a timing signal.
 */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * Is this webhook really from Razorpay?
 *
 * HMAC-SHA256 of the EXACT bytes of the request body, keyed with the webhook
 * secret. The exact bytes matter: re-serialising the parsed JSON changes key
 * order and whitespace, the digest no longer matches, and every real webhook
 * gets rejected while the endpoint still looks like it is working.
 */
export function verifyWebhook(rawBody, signature, secret = process.env.RAZORPAY_WEBHOOK_SECRET) {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return safeEqualHex(expected, signature);
}

/**
 * Is this payment-link callback really from Razorpay?
 *
 * A different scheme from the webhook, and this is Razorpay's own: for payment
 * links the signed string is the link id, its reference, its status and the
 * payment id, joined with pipes, keyed with the API secret.
 *
 * The callback is a convenience — it is what the farmer's browser is redirected
 * to, so it arrives first and lets the screen say "paid" immediately. It is not
 * the source of truth. The webhook is, because a browser that closed on the way
 * back never sends this at all.
 */
export function verifyPaymentLink(
  { linkId, referenceId, status, paymentId }, signature,
  secret = process.env.RAZORPAY_KEY_SECRET,
) {
  if (!secret || !signature) return false;
  const payload = `${linkId}|${referenceId ?? ''}|${status}|${paymentId}`;
  const expected = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return safeEqualHex(expected, signature);
}

function authHeader() {
  const pair = `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

/**
 * Create a payment link.
 *
 * A link rather than a checkout SDK: it is a URL, so it works from the web
 * build, from an APK, and from a WhatsApp message when a farmer rings up to say
 * the app will not take their money.
 *
 * `reference_id` is our own payment row, which is what lets a webhook be tied
 * back to a farm without trusting anything in the notes.
 */
export async function createPaymentLink({
  amountPaise, description, referenceId, customer, callbackUrl, expireBy,
  fetchImpl = globalThis.fetch,
}) {
  const body = {
    amount: amountPaise,
    currency: 'INR',
    description,
    reference_id: referenceId,
    customer: {
      name: customer?.name ?? undefined,
      email: customer?.email ?? undefined,
      contact: customer?.phone ?? undefined,
    },
    // Razorpay will email/SMS the link itself. We do not want it to: the farmer
    // is standing in the app, and an unexpected SMS about a payment they have
    // not made yet is a support call.
    notify: { sms: false, email: false },
    reminder_enable: false,
    callback_url: callbackUrl,
    callback_method: 'get',
    ...(expireBy ? { expire_by: expireBy } : {}),
  };

  const res = await fetchImpl(`${BASE()}/v1/payment_links`, {
    method: 'POST',
    headers: {
      authorization: authHeader(),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

  if (!res.ok) {
    const err = new Error(json?.error?.description ?? `Razorpay returned ${res.status}`);
    err.status = res.status;
    err.gateway = json?.error ?? null;
    throw err;
  }
  return json;
}

/**
 * Send money back.
 *
 * Razorpay refunds against the PAYMENT, not the link, which is why the payment
 * id is stored on our row at all. Two things about the call matter:
 *
 * `notes.refund_id` carries our own refund row's id into the gateway and back
 * out again on every webhook about it. The refund id Razorpay returns is stored
 * too, but a webhook that arrives before this call's response has been written
 * — which is a real ordering on a slow connection — can still be matched.
 *
 * Normal speed, not instant. Instant refunds cost extra and land in minutes;
 * normal takes five to seven working days and is what the published policy
 * promises. A farmer who is leaving is not waiting on the difference.
 */
export async function createRefund({
  paymentId, amountPaise, refundId, notes, fetchImpl = globalThis.fetch,
}) {
  const res = await fetchImpl(`${BASE()}/v1/payments/${paymentId}/refund`, {
    method: 'POST',
    headers: {
      authorization: authHeader(),
      'content-type': 'application/json',
      accept: 'application/json',
      // Razorpay's own idempotency header. A retry after a timeout returns the
      // first refund rather than making a second one, which is the difference
      // between a customer being paid once and twice.
      ...(refundId ? { 'x-razorpay-idempotency-key': refundId } : {}),
    },
    body: JSON.stringify({
      amount: amountPaise,
      speed: 'normal',
      notes: { ...(notes ?? {}), ...(refundId ? { refund_id: refundId } : {}) },
    }),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

  if (!res.ok) {
    const err = new Error(json?.error?.description ?? `Razorpay returned ${res.status}`);
    err.status = res.status;
    err.gateway = json?.error ?? null;
    throw err;
  }
  return json;
}

/** Read a link back, for reconciling a payment nobody told us about. */
export async function fetchPaymentLink(linkId, { fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(`${BASE()}/v1/payment_links/${linkId}`, {
    headers: { authorization: authHeader(), accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Razorpay returned ${res.status}`);
  return res.json();
}
