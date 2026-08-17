import { adminPool } from './db.js';

/**
 * Getting a notification onto a phone.
 *
 * The scheduler has been raising notifications since migration 0010 and nothing
 * has ever delivered one. This is the missing half.
 *
 * Expo's push service is the provider, because the app is an Expo app and the
 * alternative is holding an FCM service account and an APNs key per platform
 * for a farm-management app with no other reason to have them. Everything
 * provider-shaped is behind `send()` and `receipts()` so swapping it is one
 * file, and `PUSH_ENDPOINT` points them somewhere else — which is how this gets
 * tested against something local instead of against Expo's servers.
 *
 * What is NOT here, on purpose: deciding who to tell and when. That is already
 * settled by the time a row exists — `generate_notifications()` picks the
 * caretaker, and `v_push_queue` handles quiet hours, duplicates and backlog.
 * This file's whole job is the network call and what to believe about the
 * answer.
 */

const EXPO_SEND = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS = 'https://exp.host/--/api/v2/push/getReceipts';

/** Expo takes 100 messages per request and rejects more. */
const BATCH = 100;

const endpoint = (fallback, suffix) => {
  const base = process.env.PUSH_ENDPOINT;
  return base ? `${base.replace(/\/$/, '')}${suffix}` : fallback;
};

/** True when a farmer would actually get something. Keeps the tests honest. */
export function pushConfigured() {
  return process.env.PUSH_ENABLED !== '0';
}

/**
 * Errors that mean "stop sending to this token", from Expo's documented set.
 *
 * DeviceNotRegistered is the common one and it is permanent: the app was
 * uninstalled, or the token was reissued. Retrying it forever is how a farm
 * with thirty ex-devices spends every pass talking to phones that are gone.
 */
const PERMANENT = new Set(['DeviceNotRegistered', 'InvalidCredentials']);

/**
 * One delivery pass across every farm.
 *
 * Reads the queue, sends in batches, and writes down what happened to each
 * device separately — so a partial failure leaves exactly the un-sent rows for
 * the next pass rather than re-sending the lot.
 */
export async function deliverPending({ limit = 500, fetchImpl = globalThis.fetch } = {}) {
  if (!pushConfigured()) return { ok: true, skipped: 'push disabled', sent: 0 };

  const client = await adminPool.connect();
  try {
    const { rows: queue } = await client.query(
      `SELECT * FROM v_push_queue ORDER BY created_at LIMIT $1`, [limit]);
    if (!queue.length) return { ok: true, sent: 0, failed: 0, batches: 0 };

    let sent = 0;
    let failed = 0;
    let batches = 0;

    for (let i = 0; i < queue.length; i += BATCH) {
      const slice = queue.slice(i, i + BATCH);
      batches++;

      const messages = slice.map((q) => ({
        to: q.token,
        title: q.title,
        body: q.body ?? undefined,
        // What the app needs to open the right screen without another round
        // trip. A farmer tapping "Nest box — Lakshmi" should land on Lakshmi.
        data: {
          notification_id: q.notification_id,
          kind: q.kind,
          rabbit_id: q.rabbit_id,
          farm_id: q.farm_id,
        },
        // A sick rabbit at 2am is worth a sound. Everything else is not — and
        // the queue has already refused to hand us anything non-critical
        // during quiet hours.
        priority: q.urgency === 'critical' ? 'high' : 'normal',
        sound: q.urgency === 'critical' ? 'default' : null,
        channelId: q.urgency === 'critical' ? 'urgent' : 'default',
      }));

      let results;
      try {
        results = await postJson(fetchImpl, endpoint(EXPO_SEND, '/send'), messages);
      } catch (err) {
        /*
         * The provider was unreachable. Not the devices' fault, so nothing is
         * counted against them — a token disabled because Expo had an outage
         * would be a phone that silently stops getting alerts for good.
         */
        failed += slice.length;
        continue;
      }

      const tickets = Array.isArray(results?.data) ? results.data : [];
      for (let j = 0; j < slice.length; j++) {
        const q = slice[j];
        const ticket = tickets[j];

        if (ticket?.status === 'ok') {
          await client.query('SELECT push_record_sent($1,$2,$3)',
            [q.notification_id, q.device_id, ticket.id ?? null]);
          sent++;
        } else {
          const code = ticket?.details?.error ?? null;
          await client.query('SELECT push_record_failure($1,$2,$3)',
            [q.device_id, ticket?.message ?? 'no ticket returned', PERMANENT.has(code)]);
          failed++;
        }
      }
    }

    return { ok: true, sent, failed, batches, queued: queue.length };
  } finally {
    client.release();
  }
}

/**
 * Ask what actually happened to what we sent.
 *
 * Expo accepts a message and then tells you the truth later: the send returns a
 * ticket, and the receipt — available for about a day — is where
 * DeviceNotRegistered usually turns up. Skipping this is why push systems
 * accumulate dead tokens and slowly stop working with nothing in any log.
 *
 * Left at least fifteen minutes, which is Expo's own guidance and conveniently
 * one scheduler tick.
 */
export async function checkReceipts({ olderThanMinutes = 15, limit = 1000,
                                      fetchImpl = globalThis.fetch } = {}) {
  if (!pushConfigured()) return { ok: true, skipped: 'push disabled', checked: 0 };

  const client = await adminPool.connect();
  try {
    const { rows } = await client.query(`
      SELECT receipt_id FROM notification_delivery
       WHERE status = 'sent' AND receipt_id IS NOT NULL
         AND sent_at < now() - make_interval(mins => $1)
       LIMIT $2`, [olderThanMinutes, limit]);
    if (!rows.length) return { ok: true, checked: 0, dead: 0 };

    let checked = 0;
    let dead = 0;

    for (let i = 0; i < rows.length; i += BATCH * 10) {
      const ids = rows.slice(i, i + BATCH * 10).map((r) => r.receipt_id);
      let body;
      try {
        body = await postJson(fetchImpl, endpoint(EXPO_RECEIPTS, '/receipts'), { ids });
      } catch {
        continue;   // provider down; the rows stay 'sent' and we try next pass
      }

      for (const [receiptId, receipt] of Object.entries(body?.data ?? {})) {
        checked++;
        if (receipt?.status === 'ok') {
          await client.query(`SELECT push_record_receipt($1, 'delivered')`, [receiptId]);
          continue;
        }
        const code = receipt?.details?.error ?? null;
        const { rows: who } = await client.query(
          `SELECT push_record_receipt($1, 'failed', $2) AS device_id`,
          [receiptId, receipt?.message ?? code ?? 'delivery failed']);
        const deviceId = who[0]?.device_id;
        if (deviceId) {
          await client.query('SELECT push_record_failure($1,$2,$3)',
            [deviceId, receipt?.message ?? code ?? 'delivery failed', PERMANENT.has(code)]);
          if (PERMANENT.has(code)) dead++;
        }
      }
    }

    return { ok: true, checked, dead };
  } finally {
    client.release();
  }
}

async function postJson(fetchImpl, url, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      // Expo compresses responses for large batches; being explicit avoids a
      // surprise when a farm grows past a hundred devices.
      'accept-encoding': 'gzip, deflate',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`push provider returned ${res.status}`);
  return res.json();
}
