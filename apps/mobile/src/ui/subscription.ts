/**
 * How a subscription is described to the person paying for it.
 *
 * The server's status values are the business's words, not the farmer's:
 * `past_due` and `suspended` are precise and slightly accusatory, and
 * "suspended" in particular reads like an account has been disciplined when all
 * that happened is a year ran out. Shown here in the words a person would use.
 *
 * Both screens that mention a subscription import from here, so the More tab and
 * the Billing tab cannot end up describing the same farm differently.
 */

export const SUBSCRIPTION_LABEL: Record<string, string> = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Payment due',
  grace: 'Payment due',
  suspended: 'Ended',
  cancelled: 'Cancelled',
};

export const subscriptionLabel = (status?: string | null) =>
  (status ? SUBSCRIPTION_LABEL[status] ?? status : '—');

interface Coverage {
  access?: string | null;
  covered_until?: string | null;
  covered_days_left?: number | null;
  status?: string | null;
}

const day = (d: string) =>
  new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * One line saying when this runs out, or that it has.
 *
 * Null while there is more than a fortnight left: a farm two hundred days from
 * renewal does not need to be reminded of it every time it opens the app, and a
 * countdown that is always on the screen stops being read by the time it
 * matters. Null too when there is no date at all — an account activated by hand
 * has no end, and inventing one would be a lie in the direction of alarm.
 */
export function coverageLine(sub?: Coverage | null): string | null {
  if (!sub?.covered_until || sub.covered_days_left == null) return null;
  const left = sub.covered_days_left;

  if (sub.access === 'read_only') {
    return sub.status === 'trialing'
      ? `Your free trial ended on ${day(sub.covered_until)}`
      : `Ended on ${day(sub.covered_until)}`;
  }
  if (left <= 0) return 'Ends today';
  if (left === 1) return 'Ends tomorrow';
  if (left <= 14) return `Ends in ${left} days, on ${day(sub.covered_until)}`;
  return null;
}
