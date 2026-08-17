import React, { useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { Banner, Card, Empty, H1, H2, Loading, Muted, Screen } from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';

const rupees = (paise: number | null | undefined) =>
  paise == null ? '—' : `₹${(paise / 100).toLocaleString('en-IN')}`;

const when = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

export default function Billing() {
  const { client, readOnly } = useApp();
  const billing = useQuery('billing', () => client.billing(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sub = billing.data?.subscription;
  const renew = billing.data?.renew;
  const history = billing.data?.history ?? [];
  const ready = billing.data?.gateway_ready ?? false;

  const pay = async (period: 'monthly' | 'yearly') => {
    setBusy(period);
    setError(null);
    try {
      const { pay_url } = await client.startPayment(period);
      /*
       * A URL, opened in the browser. The same line works in an APK and on the
       * web build — which is the whole reason billing uses payment links rather
       * than a checkout SDK, because an SDK would mean a native module on one
       * platform and a script tag on the other.
       */
      if (Platform.OS === 'web') window.location.assign(pay_url);
      else await Linking.openURL(pay_url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>Billing</H1>

        {billing.loading && !billing.data && <Loading />}

        {sub?.access === 'read_only' && (
          <Banner tone="critical"
                  text="Your records are all here and reminders keep coming. Renew to add new ones." />
        )}

        <Card>
          <Text style={s.label}>SUBSCRIPTION</Text>
          <Text style={s.value} testID="billing-status">{sub?.status ?? '—'}</Text>
          {sub?.trial_days_left != null && (
            <Muted>{sub.trial_days_left} days left in your free trial</Muted>
          )}
          {/* Only while it means something. After a refund the period end is
              today or earlier, and "paid up to" next to "cancelled" reads like
              the app has lost track of what happened. */}
          {!!sub?.current_period_end && sub?.access !== 'read_only' && (
            <Muted>Paid up to {when(sub.current_period_end)}</Muted>
          )}
          {renew?.is_grandfathered && (
            <Text style={s.kept} testID="grandfathered">
              You are on the introductory price. It stays yours — a price rise
              does not touch a farm already paying.
            </Text>
          )}
        </Card>

        {!readOnly && (
          <>
            <H2>Renew</H2>
            {!ready ? (
              <Muted>
                Card payments are not switched on yet. Talk to us and we will
                take it directly — nothing about your records changes meanwhile.
              </Muted>
            ) : (
              <>
                <Pressable style={[s.pay, s.payPrimary]} onPress={() => pay('yearly')}
                           disabled={!!busy} testID="pay-yearly">
                  <Text style={s.payTitle}>
                    {busy === 'yearly' ? 'Opening…' : `One year — ${rupees(renew?.yearly_paise)}`}
                  </Text>
                  <Text style={s.paySub}>
                    Two months cheaper than paying monthly
                  </Text>
                </Pressable>
                <Pressable style={s.pay} onPress={() => pay('monthly')}
                           disabled={!!busy} testID="pay-monthly">
                  <Text style={[s.payTitle, { color: colors.accent }]}>
                    {busy === 'monthly' ? 'Opening…' : `One month — ${rupees(renew?.monthly_paise)}`}
                  </Text>
                </Pressable>
                <Muted>
                  Opens Razorpay. Paying early never costs you the days you have
                  left — they are added on.
                </Muted>
              </>
            )}
            {!!error && (
              <Text style={{ color: colors.crit, marginTop: space.md }} testID="billing-error">
                {error}
              </Text>
            )}
          </>
        )}

        <H2>Payments</H2>
        {history.length === 0 && <Empty text="Nothing paid yet." />}
        {history.map((h) => (
          <View key={h.id} style={s.row} testID={`payment-${h.id}`}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle}>
                {rupees(h.amount_paise)} · {h.billing_period === 'yearly' ? 'one year' : 'one month'}
              </Text>
              <Text style={s.rowMeta}>
                {/* A refunded payment was still a payment: it has a date and an
                    invoice number, and hiding them would make the credit note
                    below refer to nothing. */}
                {h.status === 'paid' || h.status === 'refunded'
                  ? `${when(h.paid_at)}${h.invoice_number ? ` · ${h.invoice_number}` : ''}`
                  : h.status === 'failed'
                    ? h.failed_reason ?? 'Did not go through'
                    : `Started ${when(h.created_at)}`}
              </Text>
              {h.status === 'paid' && !!h.period_end && (
                <Text style={s.rowMeta}>Covers to {when(h.period_end)}</Text>
              )}
              {/* Money that came back. A refund the app does not show is a
                  support call: it has left our account and their screen still
                  says they paid. */}
              {!!h.refunded_paise && (
                <Text style={s.refund} testID={`refunded-${h.id}`}>
                  {rupees(h.refunded_paise)} refunded {when(h.refunded_at)}
                  {h.credit_note_number ? ` · ${h.credit_note_number}` : ''}
                </Text>
              )}
            </View>
            <Text style={[
              s.state,
              h.status === 'paid' && { color: colors.accent },
              h.status === 'failed' && { color: colors.crit },
              h.status === 'refunded' && { color: colors.warn },
            ]}>
              {h.status}
            </Text>
          </View>
        ))}

        <View style={{ height: space.lg }} />
        <Muted>
          Prices include GST. Every payment gets a numbered invoice — the number
          is on the line above once it has gone through.
        </Muted>
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({
  label: { ...t.label, color: colors.muted, marginBottom: space.xs },
  value: { ...t.h2, color: colors.ink, textTransform: 'capitalize' },
  kept: { ...t.small, color: colors.accent, marginTop: space.sm, fontWeight: '600' },
  pay: {
    borderWidth: 1, borderColor: colors.accent, borderRadius: radius.md,
    padding: space.lg, marginBottom: space.sm, alignItems: 'center',
  },
  payPrimary: { backgroundColor: colors.accent },
  payTitle: { ...t.title, color: colors.white },
  paySub: { ...t.small, color: colors.white, opacity: 0.85, marginTop: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.rule, borderRadius: radius.md,
    padding: space.lg, marginBottom: space.sm,
  },
  rowTitle: { ...t.title, color: colors.ink },
  rowMeta: { ...t.small, color: colors.muted, marginTop: 2 },
  refund: { ...t.small, color: colors.warn, marginTop: 2, fontWeight: '600' },
  state: { ...t.small, fontWeight: '600', color: colors.muted, textTransform: 'capitalize' },
});
