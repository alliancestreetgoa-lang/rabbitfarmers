/**
 * What the four emails actually say.
 *
 * Rendered in JavaScript rather than built in SQL, and kept in their own file
 * rather than mixed into the sender, because these are the only part of this
 * system a customer reads word for word. Somebody should be able to open one
 * file, read all four, and change a sentence without knowing anything about
 * queues or providers.
 *
 * Rules they all follow:
 *
 *   Plain text first. A farmer opening this on a ₹6,000 Android phone over
 *   patchy data gets the text part instantly; the HTML is a courtesy on top and
 *   carries no image, no tracking pixel and no web font.
 *
 *   Say the number. "Your subscription" is a category; "₹999, on 3 April" is a
 *   fact somebody can act on.
 *
 *   Never threaten the animals. Every message that mentions losing access says,
 *   in the same breath, that the records stay and the reminders keep coming.
 *   That is true (migration 0029) and it is the single most important sentence
 *   in the whole sequence.
 *
 *   No unsubscribe link. Every one of these is transactional — it exists
 *   because something happened to money belonging to the person reading it.
 *   Offering to switch off receipts and lapse warnings would be offering to
 *   make somebody's records disappear without warning.
 */

const rupees = (paise) =>
  paise == null ? '—' : `₹${(paise / 100).toLocaleString('en-IN')}`;

/** '3 April 2026'. Long form on purpose: a bare 03/04 is ambiguous by country. */
const day = (d) => {
  if (!d) return '';
  const date = new Date(`${String(d).slice(0, 10)}T00:00:00Z`);
  return date.toLocaleDateString('en-IN',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

const period = (p) => (p === 'monthly' ? 'month' : 'year');

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const appUrl = () => (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
const support = () => process.env.SUPPORT_EMAIL ?? 'support@rabbitry.app';

/**
 * The one line every message ends with.
 *
 * Not a legal formality: an email about money with no way to reply to a person
 * is how a farmer decides it is a scam and ignores the next one too.
 */
function footer(context) {
  const url = appUrl();
  return [
    '',
    '—',
    `You are getting this because you run ${context.farm_name ?? 'a farm'} on Rabbitry.`,
    `Reply to this email and a person will read it, or write to ${support()}.`,
    url ? `Your farm: ${url}` : '',
  ].filter(Boolean).join('\n');
}

/* -------------------------------------------------------------- the four -- */

const TEMPLATES = {
  /** A week out. Short — nothing has gone wrong yet. */
  renewal_due(c) {
    const what = c.is_trial ? 'free trial' : 'subscription';
    return {
      subject: `${c.farm_name}: your ${what} ends on ${day(c.due_on)}`,
      lines: [
        `Your ${what} for ${c.farm_name} ends on ${day(c.due_on)} — `
          + `${c.days_left} ${c.days_left === 1 ? 'day' : 'days'} from now.`,
        '',
        `Renewing is ${rupees(c.amount_paise)} for another ${period(c.billing_period)}. `
          + 'Open the app, go to More · Billing, and tap Renew.',
        '',
        'Nothing changes until then, and paying early never costs you the days '
          + 'you have left — they are added on.',
      ],
    };
  },

  /**
   * The day it is due. The one that gets opened, so it carries what happens
   * next — including the fact that nothing happens immediately.
   */
  renewal_last_call(c) {
    const what = c.is_trial ? 'free trial' : 'subscription';
    const grace = Number(c.grace_days);
    return {
      subject: `${c.farm_name}: your ${what} ends today`,
      lines: [
        `Your ${what} for ${c.farm_name} ends today.`,
        '',
        Number.isFinite(grace) && grace > 0
          ? `You can keep recording until ${day(c.covered_until)} — ${grace} more `
            + `${grace === 1 ? 'day' : 'days'} — while you sort it out.`
          : 'You can keep recording for a few more days while you sort it out.',
        '',
        `Renewing is ${rupees(c.amount_paise)} for another ${period(c.billing_period)}, `
          + 'from More · Billing in the app.',
        '',
        'And if you do not: nothing is deleted. Every rabbit, every mating, every '
          + 'litter stays exactly where it is and you can still read and export '
          + 'all of it. Your reminders keep coming too — nest boxes, medicine '
          + 'rounds, sick animals. We do not switch those off over a bill.',
      ],
    };
  },

  /** It has happened. Two facts first, then the ask. */
  subscription_lapsed(c) {
    const what = c.is_trial ? 'free trial' : 'subscription';
    return {
      subject: `${c.farm_name}: your ${what} has ended`,
      lines: [
        `Your ${what} for ${c.farm_name} ended on ${day(c.covered_until)}.`,
        '',
        'Two things that have NOT happened:',
        '',
        '  · Nothing has been deleted. Every animal, mating, litter and treatment '
          + 'is still there, and you can still open the app and read or export all of it.',
        '  · Your reminders are still running. Nest box days, medicine rounds and '
          + 'sick-animal alerts keep arriving exactly as before. We do not '
          + 'withhold those over a bill.',
        '',
        'What has changed is that you cannot add new records until you renew.',
        '',
        `Renewing is ${rupees(c.amount_paise)} for a ${period(c.billing_period)}, `
          + 'from More · Billing in the app. It takes about a minute and '
          + 'everything starts working again immediately.',
      ],
    };
  },

  /**
   * The receipt. Carries the GST invoice number, because the farmer's
   * accountant is going to ask for it and searching an inbox is easier than
   * finding a screen.
   */
  payment_received(c) {
    return {
      subject: `${c.farm_name}: payment received — ${c.invoice_number}`,
      lines: [
        `Thank you — we have your payment of ${rupees(c.total_paise)} for ${c.farm_name}.`,
        '',
        `Invoice ${c.invoice_number}`,
        `Covers ${day(c.period_start)} to ${day(c.period_end)}`,
        `Taxable value ${rupees(c.subtotal_paise)}`,
        `GST at 18% ${rupees(c.tax_paise)}`,
        `Total paid ${rupees(c.total_paise)}`,
        '',
        'Prices include GST, so the total above is what left your account. '
          + 'The same invoice is in the app under More · Billing.',
      ],
    };
  },
};

/**
 * Render one message.
 *
 * Returns text and HTML built from the same lines, so the two versions cannot
 * drift apart — which is the usual way an email ends up saying one thing in a
 * preview pane and another in a plain-text client.
 */
export function renderEmail(kind, context = {}) {
  const template = TEMPLATES[kind];
  if (!template) throw new Error(`no template for email kind "${kind}"`);

  const { subject, lines } = template(context);
  // One array of lines, used for both parts, so the plain-text version and the
  // HTML one cannot drift apart — which is the usual way an email ends up
  // saying one thing in a preview pane and another in a plain-text client.
  const all = [...lines, ...footer(context).split('\n')];
  const text = all.join('\n');

  /*
   * Every style is inline and on the element it applies to, including the font.
   * Gmail strips <head>, <style> and the <body> tag itself, so anything set
   * there is gone by the time a farmer reads it — which is exactly how a
   * carefully typeset email arrives in Times New Roman. The container and each
   * paragraph carry their own.
   */
  const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',"
    + 'Roboto,Helvetica,Arial,sans-serif';

  const paragraphs = all.map((line) => {
    if (line.trim() === '') return '<div style="height:10px;line-height:10px">&nbsp;</div>';
    if (line.trim() === '—') return '<hr style="border:0;border-top:1px solid #D3DBD2;margin:18px 0">';
    const bullet = line.startsWith('  ·');
    return `<p style="${FONT};font-size:16px;line-height:1.6;color:#1B211D;margin:0 0 8px${
      bullet ? ';padding-left:16px' : ''}">${esc(line.replace(/^\s+/, ''))}</p>`;
  }).join('\n');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#F6F8F4">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #D3DBD2;
  border-radius:4px;padding:28px;${FONT}">
<h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:21px;
  line-height:1.3;color:#1B211D;margin:0 0 18px">${esc(subject)}</h1>
${paragraphs}
</div></body></html>`;

  return { subject, text, html };
}

export const emailKinds = () => Object.keys(TEMPLATES);
