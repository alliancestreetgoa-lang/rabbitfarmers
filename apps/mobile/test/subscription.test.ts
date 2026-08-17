/**
 * The sentence a farmer reads about their own subscription.
 *
 * Small enough to look obviously right and wrong in three places that matter:
 * a countdown that never goes away stops being read, "suspended" reads like a
 * punishment for a year that simply ran out, and a farm with no end date must
 * not be told it is ending.
 *
 * No API and no React Native runtime — the module takes a plain object, which
 * is why it is a module rather than four expressions inside a screen.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coverageLine, subscriptionLabel } from '../src/ui/subscription.ts';

const sub = (over: Record<string, unknown> = {}) => ({
  access: 'full', status: 'active',
  covered_until: '2026-09-01', covered_days_left: 15,
  ...over,
});

describe('what the subscription is called', () => {
  test('in the words a person would use', () => {
    assert.equal(subscriptionLabel('trialing'), 'Free trial');
    assert.equal(subscriptionLabel('active'), 'Active');
    assert.equal(subscriptionLabel('past_due'), 'Payment due');
    // Not "Suspended". Nothing was confiscated; a year ran out.
    assert.equal(subscriptionLabel('suspended'), 'Ended');
  });

  test('and anything unexpected is passed through rather than hidden', () => {
    assert.equal(subscriptionLabel('something_new'), 'something_new');
    assert.equal(subscriptionLabel(null), '—');
  });
});

describe('when it runs out', () => {
  test('says nothing while there is more than a fortnight left', () => {
    assert.equal(coverageLine(sub({ covered_days_left: 200 })), null);
    assert.equal(coverageLine(sub({ covered_days_left: 15 })), null);
  });

  test('and counts down inside it', () => {
    assert.match(coverageLine(sub({ covered_days_left: 14 })) ?? '', /^Ends in 14 days, on /);
    assert.equal(coverageLine(sub({ covered_days_left: 1 })), 'Ends tomorrow');
    assert.equal(coverageLine(sub({ covered_days_left: 0 })), 'Ends today');
  });

  test('says so once it has', () => {
    const line = coverageLine(sub({ access: 'read_only', covered_days_left: -3 }));
    assert.match(line ?? '', /^Ended on /);
    assert.match(line ?? '', /2026/);
  });

  test('a trial that ended is a trial that ended, not a subscription', () => {
    const line = coverageLine(sub({
      access: 'read_only', status: 'trialing', covered_days_left: -1 }));
    assert.match(line ?? '', /free trial ended on/);
  });

  test('a farm with no end date is not told it is ending', () => {
    // An account activated by hand has no end. Inventing one would be a lie in
    // the direction of alarm.
    assert.equal(coverageLine(sub({ covered_until: null, covered_days_left: null })), null);
    assert.equal(coverageLine(null), null);
    assert.equal(coverageLine(undefined), null);
  });
});
