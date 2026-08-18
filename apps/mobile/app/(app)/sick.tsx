import React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { Card, H1, Loading, Muted, Screen } from '../../src/ui/components';
import { STATE_LABEL, colors, space, type as t } from '../../src/ui/theme';

/** Every rabbit; tap one for its full health record. */
export default function Sick() {
  const { client } = useApp();
  const animals = useQuery('animals', () => client.animals({}));
  const conditions = useQuery('conditions', () => client.conditions());
  const doses = useQuery('doses', () => client.medicationDue());
  const loading = animals.loading || conditions.loading;
  const reload = () => { animals.reload(); conditions.reload(); doses.reload(); };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}>
        <H1>Sick rabbit</H1>
        <Muted>Every rabbit's health record. Tap one to see everything.</Muted>
        <View style={{ height: space.md }} />
        {(animals.data?.animals ?? []).map((a) => {
          const sick = (conditions.data?.open ?? []).filter((c) => c.rabbit_id === a.id);
          const pending = (doses.data?.due ?? []).filter((d) => d.rabbit_id === a.id);
          return (
            <Pressable key={a.id} testID={`sick-${a.id}`}
              onPress={() => router.push(`/(app)/rabbit-health?id=${a.id}` as never)}>
              <Card>
                <Text style={s.title}>{a.name ?? a.tag}</Text>
                <Muted>
                  {STATE_LABEL[a.reproductive_state ?? ''] ?? (a.sex === 'buck' ? 'Buck' : '—')}
                  {' · '}
                  {sick.length
                    ? sick.map((c) => c.condition_name).join(', ')
                    : 'healthy'}
                  {pending.length ? ` · ${pending.length} dose${pending.length === 1 ? '' : 's'} due` : ''}
                </Muted>
              </Card>
            </Pressable>
          );
        })}
        {animals.data?.animals?.length === 0 && <Muted>No rabbits yet.</Muted>}
        {loading && !animals.data && <Loading />}
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({ title: { ...t.title, color: colors.ink } });
