import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { Card, H1, Muted, Pill, Screen } from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';
import { coverageLine, subscriptionLabel } from '../../src/ui/subscription';

const ROLE_LABEL: Record<string, string> = {
  owner: 'owner', manager: 'manager', caretaker: 'farm hand',
  vet: 'vet', accountant: 'accountant',
};

export default function More() {
  const { client, session, signOut, pending, readOnly, serverUrl, canSetServer } = useApp();
  const { data } = useQuery('me', () => client.me());
  const sub = data?.subscription;
  const failed = pending.filter((p) => p.failed);
  const role = data?.user?.role ?? session?.user?.role ?? '';
  const canSeeTeam = ['owner', 'manager', 'accountant'].includes(role);
  // Same list the server enforces for billing:read. A farm hand never sees
  // what the farm pays.
  const canSeeBilling = ['owner', 'manager', 'accountant'].includes(role);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>More</H1>

        <Card>
          <Text style={s.label}>FARM</Text>
          <Text style={s.value} testID="farm-name">{data?.farm?.name ?? session?.farm?.name ?? '—'}</Text>
          <Muted>{data?.user?.name} · {ROLE_LABEL[data?.user?.role ?? ''] ?? data?.user?.role}</Muted>
        </Card>

        <Card>
          <Text style={s.label}>SUBSCRIPTION</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Text style={s.value} testID="sub-status">{subscriptionLabel(sub?.status)}</Text>
            {sub?.access === 'read_only' && <Pill text="read only" urgency="critical" />}
          </View>
          {/* The same sentence the Billing tab shows, from the same function.
              Two screens describing one farm differently is how a farmer ends
              up ringing to ask which of them is right. */}
          {!!coverageLine(sub) && (
            <Text style={sub?.access === 'read_only' ? s.warn : s.soon} testID="coverage">
              {coverageLine(sub)}
            </Text>
          )}
          {sub?.trial_days_left != null && sub.trial_days_left > 0 && (
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

        {/* On an installed app, where the address came from a person typing it,
            "which server am I even on" is the first question worth answering
            when something looks wrong. Signing out returns to the field. */}
        {canSetServer && (
          <Card>
            <Text style={s.label}>SERVER</Text>
            <Text style={s.value} testID="server-url">{serverUrl}</Text>
            <Muted>Sign out to point this phone somewhere else.</Muted>
          </Card>
        )}

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

        {/* Only for the roles the server would actually let through. Offering a
            button that answers 403 teaches people to distrust the app. */}
        {canSeeTeam && (
          <Pressable style={s.action} onPress={() => router.push('/(app)/team')}
                     testID="open-team">
            <Text style={s.actionText}>Team and attendance</Text>
          </Pressable>
        )}

        {canSeeBilling && (
          <Pressable style={s.action} onPress={() => router.push('/(app)/billing')}
                     testID="open-billing">
            <Text style={s.actionText}>
              {sub?.access === 'read_only' ? 'Renew your subscription' : 'Billing and invoices'}
            </Text>
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
  soon: { ...t.small, color: colors.warn, marginTop: space.xs, fontWeight: '600' },
  action: {
    minHeight: 52, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.accent,
    alignItems: 'center', justifyContent: 'center', marginBottom: space.sm,
  },
  actionText: { ...t.title, color: colors.accent },
});
