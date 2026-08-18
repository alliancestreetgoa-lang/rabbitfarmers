import React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { Card, H1, Loading, Muted, Screen } from '../../src/ui/components';
import { colors, space, type as t } from '../../src/ui/theme';

/** Every litter, newest first. Tap through to the doe to record kits or wean. */
export default function Litters() {
  const { client } = useApp();
  const { data, loading, reload } = useQuery('litters', () => client.littersList());

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}>
        <H1>Litters & kits</H1>
        {data?.litters?.length === 0 && (
          <Muted>No litters yet. Record a mating and a kindling follows.</Muted>
        )}
        {(data?.litters ?? []).map((l) => (
          <Pressable key={l.id} onPress={() => router.push(`/(app)/animal?id=${l.doe_id}` as never)}>
            <Card>
              <Text style={s.title}>{l.doe_name ?? l.doe_tag} — kindled {l.kindled_on}</Text>
              <Muted>
                {l.born_alive} born alive{l.born_dead ? ` · ${l.born_dead} dead` : ''} ·{' '}
                {l.weaned_on ? `weaned ${l.weaned_count} on ${l.weaned_on}` : 'not yet weaned'} ·{' '}
                {l.recorded ?? 0} recorded individually
              </Muted>
            </Card>
          </Pressable>
        ))}
        {loading && !data && <Loading />}
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({ title: { ...t.title, color: colors.ink } });
