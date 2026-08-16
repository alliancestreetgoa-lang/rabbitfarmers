import React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { Card, Empty, H1, H2, Loading, Muted, Pill, Screen, Stat } from '../../src/ui/components';
import { colors, radius, relativeDay, space, type as t } from '../../src/ui/theme';

/**
 * The two questions the whole app exists to answer, on one screen.
 */
export default function Breeding() {
  const { client } = useApp();
  const preg = useQuery('pregnant', () => client.pregnant());
  const ready = useQuery('ready', () => client.readyToMate());

  const s1 = preg.data?.summary;
  const loading = preg.loading || ready.loading;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        refreshControl={
          <RefreshControl refreshing={loading}
            onRefresh={() => { preg.reload(); ready.reload(); }} />}
      >
        <H1>Breeding</H1>

        {loading && !preg.data && <Loading />}

        <Card>
          <Text style={s.cardLabel}>PREGNANT</Text>
          <View style={s.statRow}>
            <Stat n={s1?.total_pregnant ?? 0} label="total" />
            <Stat n={s1?.confirmed_pregnant ?? 0} label="confirmed" />
            <Stat n={s1?.presumed_pregnant ?? 0} label="presumed"
                  tone={(s1?.presumed_pregnant ?? 0) > 0 ? 'high' : undefined} />
          </View>
          {(s1?.presumed_pregnant ?? 0) > 0 && (
            <Text style={s.note} testID="presumed-note">
              {s1!.presumed_pregnant} never palpated. That is where losses hide — palpate to
              find out.
            </Text>
          )}
        </Card>

        <H2>Due soon</H2>
        {(preg.data?.does ?? []).length === 0 && !loading && (
          <Empty text="Nobody is pregnant yet." />
        )}
        {(preg.data?.does ?? []).map((d) => (
          <Pressable
            key={d.rabbit_id}
            testID={`pregnant-${d.rabbit_id}`}
            style={s.row}
            onPress={() => router.push(`/(app)/animal?id=${d.rabbit_id}`)}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle}>{d.name ?? d.tag}</Text>
              <Text style={s.rowMeta}>
                Day {d.gestation_day} · due {relativeDay(d.expected_kindling_on)}
                {' '}({d.window_start_on.slice(5)} to {d.window_end_on.slice(5)})
              </Text>
            </View>
            <Pill
              text={d.confidence === 'confirmed' ? 'confirmed' : 'presumed'}
              urgency={d.confidence === 'confirmed' ? 'low' : 'high'}
            />
          </Pressable>
        ))}

        <H2>Ready to mate</H2>
        {(ready.data?.ready ?? []).length === 0 && !loading && (
          <Empty text="Nobody is ready today." />
        )}
        {(ready.data?.ready ?? []).map((d) => (
          <Pressable
            key={d.rabbit_id}
            testID={`ready-${d.rabbit_id}`}
            style={s.row}
            onPress={() => router.push(`/record/mating?doe=${d.rabbit_id}`)}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle}>{d.name ?? d.tag}</Text>
              {/* The reason she is on the list. An unexplained ranked list is a
                  black box, and staff ignore black boxes. */}
              <Text style={s.rowMeta} testID={`ready-reason-${d.rabbit_id}`}>
                {d.days_since_weaning != null
                  ? `${d.days_since_weaning} days since separating`
                  : d.days_since_last_kindling != null
                    ? `${d.days_since_last_kindling} days since kindling`
                    : 'Never bred'}
                {d.days_overdue ? ` · ${d.days_overdue} overdue` : ''}
                {d.total_weaned ? ` · ${d.total_weaned} weaned lifetime` : ''}
              </Text>
            </View>
            {!!d.days_overdue && d.days_overdue > 0 && <Pill text="overdue" urgency="high" />}
          </Pressable>
        ))}

        <View style={{ height: space.xl }} />
        <Pressable style={s.action} onPress={() => router.push('/record/mating')}
                   testID="record-mating">
          <Text style={s.actionText}>Record a mating</Text>
        </Pressable>
        <Pressable style={s.action} onPress={() => router.push('/record/kindling')}
                   testID="record-kindling">
          <Text style={s.actionText}>Record a kindling</Text>
        </Pressable>
        <View style={{ height: space.md }} />
        <Muted>Always take the doe to the buck, never the buck to the doe.</Muted>
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({
  cardLabel: { ...t.label, color: colors.muted, marginBottom: space.md },
  statRow: { flexDirection: 'row', gap: space.xl, flexWrap: 'wrap' },
  note: { ...t.small, color: colors.warn, marginTop: space.md, fontWeight: '600' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.rule, borderRadius: radius.md,
    padding: space.lg, marginBottom: space.sm, minHeight: 64,
  },
  rowTitle: { ...t.body, color: colors.ink, fontWeight: '600' },
  rowMeta: { ...t.small, color: colors.muted, marginTop: 2 },
  action: {
    minHeight: 52, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.accent,
    alignItems: 'center', justifyContent: 'center', marginBottom: space.sm,
  },
  actionText: { ...t.title, color: colors.accent },
});
