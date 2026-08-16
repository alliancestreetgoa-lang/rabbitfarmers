import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { Card, ConditionMark, H1, Loading, Muted, Pill, Screen } from '../../src/ui/components';
import { STATE_LABEL, colors, radius, relativeDay, space, type as t } from '../../src/ui/theme';

export default function AnimalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useApp();
  const { data, loading } = useQuery(`animals`, () => client.animals(), [id]);
  const a = (data?.animals ?? []).find((x) => x.id === id);

  if (loading && !data) return <Screen><Loading /></Screen>;
  if (!a) return <Screen><View style={{ padding: space.lg }}><Muted>Not found.</Muted></View></Screen>;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>{a.name ?? a.tag}</H1>
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
          <Pill text={a.sex === 'doe' ? 'Doe' : 'Buck'} urgency="low" />
          {!!a.reproductive_state && (
            <Pill
              text={STATE_LABEL[a.reproductive_state] ?? a.reproductive_state}
              urgency={a.reproductive_state === 'OVERDUE' ? 'critical'
                : a.reproductive_state === 'NEST_BOX' ? 'high' : 'low'}
            />
          )}
        </View>

        {!!a.primary_colour && !!a.primary_condition && (
          <View style={{ marginTop: space.lg }}>
            <Card style={{ borderColor: a.primary_colour }}>
              <ConditionMark colour={a.primary_colour} label={a.primary_condition} />
              <Muted>Held out of breeding until this is marked stopped.</Muted>
            </Card>
          </View>
        )}

        <View style={{ height: space.lg }} />
        <Card>
          <Row k="Tag" v={a.tag} />
          <Row k="Breed" v={a.breed ?? '—'} />
          <Row k="Born" v={a.date_of_birth ?? '—'} />
          <Row k="Cage" v={a.cage ?? '—'} />
          {!!a.expected_kindling_on && (
            <Row k="Due" v={`${a.expected_kindling_on} (${relativeDay(a.expected_kindling_on)})`} />
          )}
          {a.confidence && <Row k="Pregnancy" v={a.confidence} />}
        </Card>

        {a.sex === 'doe' && (
          <>
            <Pressable style={s.action} testID="a-mate"
                       onPress={() => router.push(`/record/mating?doe=${a.id}`)}>
              <Text style={s.actionText}>Record a mating</Text>
            </Pressable>
            <Pressable style={s.action} testID="a-kindle"
                       onPress={() => router.push(`/record/kindling?doe=${a.id}`)}>
              <Text style={s.actionText}>Record a kindling</Text>
            </Pressable>
          </>
        )}
        <Pressable style={s.action} testID="a-sick"
                   onPress={() => router.push(`/record/condition?rabbit=${a.id}`)}>
          <Text style={s.actionText}>Report a problem</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.kv}>
      <Text style={s.k}>{k}</Text>
      <Text style={s.v}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm },
  k: { ...t.small, color: colors.muted },
  v: { ...t.body, color: colors.ink, fontWeight: '600', textTransform: 'capitalize' },
  action: {
    minHeight: 52, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.accent,
    alignItems: 'center', justifyContent: 'center', marginBottom: space.sm,
  },
  actionText: { ...t.title, color: colors.accent },
});
