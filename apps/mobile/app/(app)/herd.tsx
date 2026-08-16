import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { ConditionMark, Empty, H1, Loading, Screen } from '../../src/ui/components';
import { sexLabel } from '../../src/ui/labels';
import { STATE_LABEL, colors, radius, space, type as t } from '../../src/ui/theme';

const GONE = ['sold', 'culled', 'dead'];

export default function Herd() {
  const { client } = useApp();
  const [q, setQ] = useState('');
  // The herd you are standing in front of, or the ones who have left it.
  // Nothing is ever deleted, so "past" is a filter, not an archive.
  const [past, setPast] = useState(false);
  const { data, loading, reload } = useQuery(
    past ? 'animals:past' : 'animals',
    () => client.animals(past ? { include: 'past' } : {}),
    [past]);

  const animals = (data?.animals ?? []).filter((a) =>
    !q || (a.name ?? '').toLowerCase().includes(q.toLowerCase())
       || a.tag.toLowerCase().includes(q.toLowerCase()));

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
      >
        <H1>Herd</H1>
        <TextInput
          testID="search"
          value={q}
          onChangeText={setQ}
          placeholder="Search by name"
          placeholderTextColor={colors.muted}
          style={s.search}
        />

        <View style={s.tabs}>
          {[false, true].map((v) => (
            <Pressable key={String(v)} testID={v ? 'tab-past' : 'tab-herd'}
                       onPress={() => setPast(v)}
                       accessibilityState={{ selected: past === v }}
                       style={[s.tab, past === v && s.tabOn]}>
              <Text style={[s.tabText, past === v && s.tabTextOn]}>
                {v ? 'Sold, culled, died' : 'In the herd'}
              </Text>
            </Pressable>
          ))}
        </View>

        {loading && !data && <Loading />}
        {!loading && animals.length === 0 && (
          <Empty text={past
            ? 'No rabbits have left the herd yet.'
            : 'No rabbits yet.\nAdd your first one below.'} />
        )}

        {animals.map((a) => (
          <Pressable
            key={a.id}
            testID={`animal-${a.id}`}
            style={s.row}
            onPress={() => router.push(`/(app)/animal?id=${a.id}`)}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{a.name ?? a.tag}</Text>
              <Text style={s.meta}>
                {sexLabel(a.sex)}
                {GONE.includes(a.status)
                  ? ` · ${a.status}${a.status_changed_on ? ` ${a.status_changed_on}` : ''}`
                  : a.reproductive_state
                    ? ` · ${STATE_LABEL[a.reproductive_state] ?? a.reproductive_state}` : ''}
                {a.cage && !GONE.includes(a.status) ? ` · ${a.cage}` : ''}
              </Text>
              {!!a.primary_colour && !!a.primary_condition && (
                <View style={{ marginTop: space.sm }}>
                  <ConditionMark colour={a.primary_colour} label={a.primary_condition} />
                </View>
              )}
            </View>
          </Pressable>
        ))}

        {!past && (
          <>
            <View style={{ height: space.lg }} />
            <Pressable style={s.action} onPress={() => router.push('/record/animal')}
                       testID="add-animal">
              <Text style={s.actionText}>Add a rabbit</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({
  search: {
    minHeight: 48, borderWidth: 1, borderColor: colors.rule, borderRadius: radius.sm,
    paddingHorizontal: space.md, backgroundColor: colors.surface, color: colors.ink,
    marginBottom: space.lg, ...t.body,
  },
  row: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, padding: space.lg, marginBottom: space.sm, minHeight: 64,
  },
  name: { ...t.body, color: colors.ink, fontWeight: '600' },
  meta: { ...t.small, color: colors.muted, marginTop: 2, textTransform: 'capitalize' },
  tabs: { flexDirection: 'row', gap: space.sm, marginBottom: space.lg },
  tab: {
    flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.rule,
    backgroundColor: colors.surface,
  },
  tabOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft, borderWidth: 2 },
  tabText: { ...t.small, color: colors.muted, fontWeight: '600' },
  tabTextOn: { color: colors.accent },
  action: {
    minHeight: 52, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  actionText: { ...t.title, color: colors.accent },
});
