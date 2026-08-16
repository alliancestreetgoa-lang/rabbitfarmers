import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { Card, H1, Muted, Pill, Screen } from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';

export default function More() {
  const { client, session, signOut, pending, readOnly } = useApp();
  const { data } = useQuery('me', () => client.me());
  const sub = data?.subscription;
  const failed = pending.filter((p) => p.failed);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>More</H1>

        <Card>
          <Text style={s.label}>FARM</Text>
          <Text style={s.value} testID="farm-name">{data?.farm?.name ?? session?.farm?.name ?? '—'}</Text>
          <Muted>{data?.user?.name} · {data?.user?.role}</Muted>
        </Card>

        <Card>
          <Text style={s.label}>SUBSCRIPTION</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Text style={s.value} testID="sub-status">{sub?.status ?? '—'}</Text>
            {sub?.access === 'read_only' && <Pill text="read only" urgency="critical" />}
          </View>
          {sub?.trial_days_left != null && (
            <Muted>{sub.trial_days_left} days left in your free trial</Muted>
          )}
          {sub?.effective_price_paise != null && (
            <Muted>
              ₹{sub.effective_price_paise / 100} per {sub.billing_period === 'yearly' ? 'year' : 'month'}
              {sub.is_grandfathered ? ' · introductory price kept' : ''}
            </Muted>
          )}
          {sub?.access === 'read_only' && (
            <Text style={s.warn}>
              You can still see and export everything. Renew to add new records.
              Reminders keep working either way.
            </Text>
          )}
        </Card>

        {failed.length > 0 && (
          <Card>
            <Text style={s.label}>NEEDS ATTENTION</Text>
            {failed.map((f) => (
              <Text key={f.id} style={s.warn}>{f.kind}: {f.lastError}</Text>
            ))}
          </Card>
        )}

        {!readOnly && (
          <Pressable style={s.action} onPress={() => router.push('/record/condition')}
                     testID="report-problem">
            <Text style={s.actionText}>Report a sick rabbit</Text>
          </Pressable>
        )}

        <View style={{ height: space.lg }} />
        <Pressable style={[s.action, { borderColor: colors.crit }]}
                   onPress={async () => { await signOut(); router.replace('/(auth)/sign-in'); }}
                   testID="signout">
          <Text style={[s.actionText, { color: colors.crit }]}>
            {/* Same button, honest label. Support signing out ends the support
                view; it does not sign the farmer's own devices out. */}
            {readOnly ? 'End support view' : 'Sign out'}
          </Text>
        </Pressable>
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({
  label: { ...t.label, color: colors.muted, marginBottom: space.xs },
  value: { ...t.h2, color: colors.ink, textTransform: 'capitalize' },
  warn: { ...t.small, color: colors.warn, marginTop: space.sm, fontWeight: '600' },
  action: {
    minHeight: 52, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.accent,
    alignItems: 'center', justifyContent: 'center', marginBottom: space.sm,
  },
  actionText: { ...t.title, color: colors.accent },
});
