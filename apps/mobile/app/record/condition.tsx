import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import {
  Button, H1, Loading, Muted, Screen, SupportReadOnly,
} from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';

const SEVERITY = ['mild', 'moderate', 'severe'] as const;

/**
 * Anyone can report this — no permission, no manager. The whole value is that
 * it gets said the moment it is seen.
 */
export default function ReportCondition() {
  const { rabbit } = useLocalSearchParams<{ rabbit?: string }>();
  const { client, outbox, refreshOutbox, readOnly, session } = useApp();
  const [rabbitId, setRabbitId] = useState<string | undefined>(rabbit);
  const [severity, setSeverity] = useState<typeof SEVERITY[number]>('moderate');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, loading } = useQuery('animals', () => client.animals());
  const animals = data?.animals ?? [];

  const save = async () => {
    if (!rabbitId) { setError('Which rabbit?'); return; }
    setBusy(true); setError(null);
    try {
      await outbox.enqueue('condition', {
        rabbit_id: rabbitId, code: 'loose_motion', severity,
      });
      await refreshOutbox();
      router.replace('/(app)/daily');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  // Support is looking, not touching. The server refuses the write too — this
  // is so the refusal arrives before the typing rather than after it.
  if (readOnly) return <SupportReadOnly by={session?.support?.by} />;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>Loose motion</H1>
        <Muted>
          You will be reminded every two hours until someone marks it stopped.
          The rabbit is held out of breeding meanwhile.
        </Muted>

        <Text style={s.label}>WHICH RABBIT</Text>
        {loading && !data && <Loading />}
        {animals.map((a) => (
          <Pressable key={a.id} testID={`crab-${a.id}`} onPress={() => setRabbitId(a.id)}
                     style={[s.pick, rabbitId === a.id && s.pickOn]}>
            <Text style={[s.pickText, rabbitId === a.id && s.pickTextOn]}>{a.name ?? a.tag}</Text>
          </Pressable>
        ))}

        <Text style={s.label}>HOW BAD</Text>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {SEVERITY.map((v) => (
            <Pressable key={v} testID={`sev-${v}`} onPress={() => setSeverity(v)}
                       style={[s.sev, severity === v && s.pickOn]}>
              <Text style={[s.pickText, severity === v && s.pickTextOn]}>
                {v[0]!.toUpperCase() + v.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>

        {!!error && <Text style={{ color: colors.crit, marginTop: space.md }}>{error}</Text>}
        <View style={{ height: space.lg }} />
        <Button title="Report it" onPress={save} loading={busy} testID="save-condition" />
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
  sev: {
    flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md,
  },
  pickOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft, borderWidth: 2 },
  pickText: { ...t.body, color: colors.ink, fontWeight: '600' },
  pickTextOn: { color: colors.accent },
});
