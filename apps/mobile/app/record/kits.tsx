import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import {
  Button, Field, H1, Loading, Muted, Screen, SupportReadOnly,
} from '../../src/ui/components';
import { sexLabel } from '../../src/ui/labels';
import { colors, radius, space, type as t } from '../../src/ui/theme';

type Sex = 'unknown' | 'doe' | 'buck';

/**
 * Give a litter's kits their own records.
 *
 * Until this point they are a number. That is right in the nest box and wrong
 * the moment one is kept back for breeding: her mother would be a count in a
 * row, so the inbreeding check has nothing to look at and her pedigree starts
 * on whatever day somebody types her name in.
 */
export default function AddKits() {
  const { litter: litterId } = useLocalSearchParams<{ litter: string }>();
  const { client, readOnly, session } = useApp();

  const { data, loading, reload } = useQuery(
    `kits:${litterId}`, () => client.kits(litterId), [litterId]);
  const { data: rec } = useQuery(
    `litter:${litterId}`, () => client.litter(litterId), [litterId]);

  const [count, setCount] = useState('');
  const [prefix, setPrefix] = useState('');
  const [sex, setSex] = useState<Sex>('unknown');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const left = data?.litter.not_yet_recorded ?? 0;
  const doeName = rec?.litter.doe_name ?? rec?.litter.doe_tag ?? '';

  useEffect(() => {
    if (left > 0 && !count) setCount(String(left));
    if (doeName && !prefix) setPrefix(doeName);
  }, [left, doeName]);

  if (loading && !data) return <Screen><Loading /></Screen>;

  const save = async () => {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) { setError('How many?'); return; }
    setBusy(true); setError(null);
    try {
      await client.addKits(litterId, { count: n, prefix: prefix.trim() || undefined, sex });
      await reload();
      // Back to the mother, where they now appear under Offspring.
      if (rec?.litter.doe_id) router.replace(`/(app)/animal?id=${rec.litter.doe_id}`);
      else router.back();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  // Support is looking, not touching. The server refuses the write too — this
  // is so the refusal arrives before the typing rather than after it.
  if (readOnly) return <SupportReadOnly by={session?.support?.by} />;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>Add the kits</H1>
        <Muted>
          Each one gets its own record, with {doeName || 'its mother'} as mother
          and the buck she was served by as father. That is what lets the app
          refuse a brother–sister mating years from now.
        </Muted>
        <View style={{ height: space.lg }} />

        {data && (
          <View style={s.summary}>
            <Text style={s.summaryText}>
              This litter: {data.litter.expected} kit(s)
              {data.litter.recorded > 0
                ? `, ${data.litter.recorded} already recorded` : ''}
            </Text>
            {left === 0 && (
              <Text style={s.summaryMeta}>
                All of them have their own records already.
              </Text>
            )}
          </View>
        )}

        {left > 0 && (
          <>
            <Field label="How many" testID="count" value={count} onChangeText={setCount}
                   keyboardType="number-pad" placeholder={String(left)} />
            <Field label="Name them" testID="prefix" value={prefix} onChangeText={setPrefix}
                   placeholder={doeName || 'Lakshmi'} />
            <Muted>
              They will be {prefix || doeName || 'Lakshmi'}-1, {prefix || doeName || 'Lakshmi'}-2
              and so on. Rename any of them later.
            </Muted>
            <View style={{ height: space.lg }} />

            <Text style={s.label}>SEX</Text>
            <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.sm }}>
              {(['unknown', 'doe', 'buck'] as const).map((v) => (
                <Pressable key={v} testID={`kitsex-${v}`} onPress={() => setSex(v)}
                           accessibilityState={{ selected: sex === v }}
                           style={[s.pick, sex === v && s.pickOn]}>
                  <Text style={[s.pickText, sex === v && s.pickTextOn]}>
                    {sexLabel(v)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Muted>
              Leave it as not sexed unless you have checked. A buck filed as a
              doe waits two months in the mating queue for a litter that never
              comes.
            </Muted>
            <View style={{ height: space.lg }} />

            {!!error && <Text style={{ color: colors.crit, marginBottom: space.md }}>{error}</Text>}
            <Button title={`Add ${count || left} kit(s)`} onPress={save} loading={busy}
                    testID="save-kits" />
          </>
        )}

        {!!data?.kits.length && (
          <>
            <Text style={s.label}>ALREADY RECORDED</Text>
            {data.kits.map((k) => (
              <Pressable key={k.id} style={s.row} testID={`kit-${k.id}`}
                         onPress={() => router.push(`/(app)/animal?id=${k.id}`)}>
                <Text style={s.rowTitle}>{k.name ?? k.tag}</Text>
                <Text style={s.rowMeta}>
                  {sexLabel(k.sex)}{k.cage ? ` · ${k.cage}` : ''}
                </Text>
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  label: { ...t.label, color: colors.muted, marginTop: space.md, marginBottom: space.sm },
  summary: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, padding: space.lg, marginBottom: space.lg,
  },
  summaryText: { ...t.body, color: colors.ink, fontWeight: '600' },
  summaryMeta: { ...t.small, color: colors.muted, marginTop: 4 },
  pick: {
    flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md,
  },
  pickOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft, borderWidth: 2 },
  pickText: { ...t.body, color: colors.ink, fontWeight: '600' },
  pickTextOn: { color: colors.accent },
  row: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, padding: space.lg, marginBottom: space.sm, minHeight: 56,
    justifyContent: 'center',
  },
  rowTitle: { ...t.body, color: colors.ink, fontWeight: '600' },
  rowMeta: { ...t.small, color: colors.muted, marginTop: 2 },
});
