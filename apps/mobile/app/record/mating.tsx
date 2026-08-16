import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import {
  Banner, Button, Card, H1, Loading, Muted, Pill, Screen, SupportReadOnly,
} from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';
import type { BuckSuggestion } from '../../src/api/types';

export default function RecordMating() {
  const { doe: doeParam } = useLocalSearchParams<{ doe?: string }>();
  const { client, outbox, refreshOutbox, readOnly, session } = useApp();

  const [doeId, setDoeId] = useState<string | undefined>(doeParam);
  const [buckId, setBuckId] = useState<string | undefined>();
  const [bucks, setBucks] = useState<BuckSuggestion[]>([]);
  const [saved, setSaved] = useState<{ sent: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: animals, loading } = useQuery('animals', () => client.animals());
  const does = (animals?.animals ?? []).filter((a) => a.sex === 'doe');
  const doe = does.find((d) => d.id === doeId);

  useEffect(() => {
    if (!doeId) return;
    client.suggestBucks(doeId)
      .then((r) => setBucks(r.bucks))
      .catch(() => setBucks([]));
  }, [doeId, client]);

  const save = async () => {
    if (!doeId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await outbox.enqueue('mating', {
        doe_id: doeId,
        buck_id: buckId,
        mated_at: new Date().toISOString(),
      });
      await refreshOutbox();
      setSaved({ sent: r.sent });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (saved) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ padding: space.lg }}>
          <H1>Saved</H1>
          <Muted>
            {saved.sent
              ? 'Recorded. The palpation and nest box tasks are on their way.'
              : 'Saved on this phone. It will send itself when you have signal.'}
          </Muted>
          <View style={{ height: space.lg }} />
          <Button title="Done" onPress={() => router.replace('/(app)/breeding')} testID="done" />
        </ScrollView>
      </Screen>
    );
  }

  // Support is looking, not touching. The server refuses the write too — this
  // is so the refusal arrives before the typing rather than after it.
  if (readOnly) return <SupportReadOnly by={session?.support?.by} />;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <Banner tone="high" text="Take the doe to the buck's cage — never the other way round." />

        <Text style={s.label}>WHICH DOE</Text>
        {loading && !animals && <Loading />}
        {does.map((d) => (
          <Pressable
            key={d.id}
            testID={`doe-${d.id}`}
            style={[s.pick, doeId === d.id && s.pickOn]}
            onPress={() => { setDoeId(d.id); setBuckId(undefined); }}
          >
            <Text style={[s.pickText, doeId === d.id && s.pickTextOn]}>{d.name ?? d.tag}</Text>
          </Pressable>
        ))}

        {!!doeId && (
          <>
            <Text style={s.label}>WHICH BUCK</Text>
            {bucks.length === 0 && <Muted>No bucks available.</Muted>}
            {bucks.map((b) => {
              const blocked = b.blocked_related || b.over_quota;
              return (
                <Pressable
                  key={b.buck_id}
                  testID={`buck-${b.buck_id}`}
                  disabled={blocked}
                  style={[s.pick, buckId === b.buck_id && s.pickOn, blocked && s.pickOff]}
                  onPress={() => setBuckId(b.buck_id)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[s.pickText, buckId === b.buck_id && s.pickTextOn]}>
                      {b.name ?? b.tag}
                    </Text>
                    <Text style={s.pickMeta}>
                      {b.conception_rate != null
                        ? `${Math.round(b.conception_rate * 100)}% conception`
                        : 'No history yet'}
                      {` · ${b.services_last_7d} services this week`}
                    </Text>
                  </View>
                  {b.blocked_related && <Pill text="too closely related" urgency="critical" />}
                  {!b.blocked_related && b.over_quota && <Pill text="rested" urgency="high" />}
                  {!blocked && b.warn_related && <Pill text="shares a grandparent" urgency="high" />}
                </Pressable>
              );
            })}
          </>
        )}

        {!!error && <Text style={{ color: colors.crit, marginTop: space.md }}>{error}</Text>}

        <View style={{ height: space.lg }} />
        <Button
          title={doe ? `Record mating for ${doe.name ?? doe.tag}` : 'Choose a doe'}
          onPress={save}
          disabled={!doeId}
          loading={busy}
          testID="save-mating"
        />
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  label: { ...t.label, color: colors.muted, marginTop: space.lg, marginBottom: space.sm },
  pick: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    minHeight: 56, paddingHorizontal: space.lg, justifyContent: 'space-between',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, marginBottom: space.sm,
  },
  pickOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft, borderWidth: 2 },
  pickOff: { opacity: 0.55 },
  pickText: { ...t.body, color: colors.ink, fontWeight: '600' },
  pickTextOn: { color: colors.accent },
  pickMeta: { ...t.small, color: colors.muted, marginTop: 2 },
});
