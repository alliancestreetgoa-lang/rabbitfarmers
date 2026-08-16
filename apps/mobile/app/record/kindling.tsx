import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { Button, Field, H1, Loading, Muted, Screen } from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';

export default function RecordKindling() {
  const { doe: doeParam } = useLocalSearchParams<{ doe?: string }>();
  const { client, outbox, refreshOutbox } = useApp();
  const [doeId, setDoeId] = useState<string | undefined>(doeParam);
  const [alive, setAlive] = useState('');
  const [dead, setDead] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, loading } = useQuery('animals', () => client.animals());
  const does = (data?.animals ?? []).filter((a) => a.sex === 'doe');

  const save = async () => {
    if (!doeId) { setError('Which doe kindled?'); return; }
    setBusy(true); setError(null);
    try {
      await outbox.enqueue('kindling', {
        doe_id: doeId,
        born_alive: Number(alive || 0),
        born_dead: Number(dead || 0),
        kindled_on: new Date().toISOString().slice(0, 10),
      });
      await refreshOutbox();
      router.replace('/(app)/breeding');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>Record a kindling</H1>
        <Muted>Count them in the nest before you write it down.</Muted>

        <Text style={s.label}>WHICH DOE</Text>
        {loading && !data && <Loading />}
        {does.map((d) => (
          <Pressable key={d.id} testID={`kdoe-${d.id}`} onPress={() => setDoeId(d.id)}
                     style={[s.pick, doeId === d.id && s.pickOn]}>
            <Text style={[s.pickText, doeId === d.id && s.pickTextOn]}>{d.name ?? d.tag}</Text>
          </Pressable>
        ))}

        <View style={{ height: space.lg }} />
        <Field label="Born alive" testID="alive" value={alive} onChangeText={setAlive}
               keyboardType="number-pad" placeholder="8" />
        <Field label="Born dead" testID="dead" value={dead} onChangeText={setDead}
               keyboardType="number-pad" placeholder="0" />

        {!!error && <Text style={{ color: colors.crit, marginBottom: space.md }}>{error}</Text>}
        <Button title="Save kindling" onPress={save} loading={busy} testID="save-kindling" />
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  label: { ...t.label, color: colors.muted, marginTop: space.lg, marginBottom: space.sm },
  pick: {
    minHeight: 56, paddingHorizontal: space.lg, justifyContent: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, marginBottom: space.sm,
  },
  pickOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft, borderWidth: 2 },
  pickText: { ...t.body, color: colors.ink, fontWeight: '600' },
  pickTextOn: { color: colors.accent },
});
