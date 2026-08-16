import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { Button, Field, H1, Loading, Muted, Screen } from '../../src/ui/components';
import { colors, space, type as t } from '../../src/ui/theme';

/**
 * Separating the kits.
 *
 * The moment the farm is actually measured on — kits weaned per doe per year is
 * the number that decides whether a doe earns her cage — and the anchor the
 * rebreed date counts from. Today has been telling farmers to do this since the
 * scheduler was built, with nowhere to record having done it.
 */
export default function RecordWeaning() {
  const { litter: litterId } = useLocalSearchParams<{ litter: string }>();
  const { client, outbox, refreshOutbox } = useApp();

  const { data } = useQuery(`litter:${litterId}`, () => client.litter(litterId), [litterId]);
  const l = data?.litter;

  const [count, setCount] = useState('');
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [weight, setWeight] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (l && !count) setCount(String(l.weaned_count ?? l.born_alive ?? ''));
  }, [l]);

  if (!l) return <Screen><Loading /></Screen>;

  const doe = l.doe_name ?? l.doe_tag;
  const lost = Number(l.born_alive ?? 0) - Number(count || 0);

  const save = async () => {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 0) { setError('How many did you separate?'); return; }
    if (n > Number(l.born_alive ?? 0)) {
      setError(`She had ${l.born_alive} born alive. Correct the kindling if that is wrong.`);
      return;
    }
    setBusy(true); setError(null);
    try {
      await outbox.enqueue('weaning', {
        weaned_on: on,
        weaned_count: n,
        avg_weaning_weight_g: weight.trim() ? Number(weight) : undefined,
      }, litterId);
      await refreshOutbox();
      router.replace(`/(app)/animal?id=${l.doe_id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>Separate the kits</H1>
        <Muted>
          {doe} kindled on {l.kindled_on} — {l.born_alive} born alive.
          {l.weaned_on ? ` Already recorded as separated on ${l.weaned_on}; saving again replaces it.` : ''}
        </Muted>
        <View style={{ height: space.lg }} />

        <Field label="How many did you separate" testID="weaned-count" value={count}
               onChangeText={setCount} keyboardType="number-pad"
               placeholder={String(l.born_alive ?? 0)} />
        {lost > 0 && (
          <Muted>
            {lost} fewer than were born alive. That is worth knowing — losses
            between the nest box and weaning are where a doe's real record is.
          </Muted>
        )}
        <View style={{ height: space.md }} />

        <Field label="Date separated" testID="weaned-on" value={on} onChangeText={setOn}
               placeholder="2026-08-16" />

        <Field label="Average weight in grams (optional)" testID="weaned-weight"
               value={weight} onChangeText={setWeight} keyboardType="number-pad"
               placeholder="620" />
        <Muted>
          Weigh a few and take the average. It is the earliest honest signal of
          how the litter is doing.
        </Muted>
        <View style={{ height: space.lg }} />

        <View style={s.next}>
          <Text style={s.nextTitle}>What happens next</Text>
          <Text style={s.nextText}>
            {doe} goes back on the ready-to-mate list {l.rebreed_on
              ? `around ${l.rebreed_on}` : 'after the rest your farm sets'}, and
            the kits can be given their own records from her page.
          </Text>
        </View>

        {!!error && <Text style={{ color: colors.crit, marginBottom: space.md }}>{error}</Text>}
        <Button title="Save" onPress={save} loading={busy} testID="save-weaning" />
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  next: {
    borderLeftWidth: 3, borderLeftColor: colors.accent,
    paddingLeft: space.lg, marginBottom: space.lg,
  },
  nextTitle: { ...t.label, color: colors.muted, marginBottom: space.sm },
  nextText: { ...t.body, color: colors.inkSoft },
});
