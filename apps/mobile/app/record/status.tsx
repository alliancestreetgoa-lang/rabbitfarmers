import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { Button, Field, H1, Loading, Muted, Screen } from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';

type Status = 'sold' | 'culled' | 'dead' | 'quarantine' | 'active';

const CHOICES: { value: Status; label: string; blurb: string }[] = [
  { value: 'sold', label: 'Sold', blurb: 'Went to another farm or to market.' },
  { value: 'culled', label: 'Culled', blurb: 'Taken out of the herd deliberately.' },
  { value: 'dead', label: 'Died', blurb: 'Died on the farm.' },
  { value: 'quarantine', label: 'Quarantine', blurb: 'Kept apart for now. She comes back.' },
];

/**
 * How a rabbit leaves the herd — the only way, because there is no delete.
 *
 * Her matings, her litters and her line are the farm's record and outlive her.
 * This screen writes an event; nothing is erased, and her page still opens
 * afterwards.
 */
export default function ChangeStatus() {
  const { rabbit } = useLocalSearchParams<{ rabbit: string }>();
  const { client } = useApp();
  const { data, loading } = useQuery(`history:${rabbit}`, () => client.history(rabbit), [rabbit]);

  const [status, setStatus] = useState<Status | null>(null);
  const [reason, setReason] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading && !data) return <Screen><Loading /></Screen>;
  const a = data?.animal;
  if (!a) {
    return <Screen><View style={{ padding: space.lg }}><Muted>Not found.</Muted></View></Screen>;
  }

  const name = a.name ?? a.tag;

  const save = async () => {
    if (!status) { setError('What happened to her?'); return; }
    if (!reason.trim() && status !== 'quarantine') {
      setError('Say why — it is the part you will want later.');
      return;
    }
    setBusy(true); setError(null);
    try {
      await client.setAnimalStatus(a.id, {
        status,
        reason: reason.trim() || undefined,
        // Rupees on screen, paise on the wire. Money in floats is how a farm
        // ends up with a ₹449.99999 sale.
        sale_price_paise: status === 'sold' && price.trim()
          ? Math.round(Number(price) * 100) : undefined,
      });
      router.replace(`/(app)/animal?id=${a.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>{name}</H1>
        <Muted>
          Nothing is deleted. Her matings, litters and offspring stay on the
          record, and this page stays readable afterwards.
        </Muted>
        <View style={{ height: space.lg }} />

        <Text style={s.label}>WHAT HAPPENED</Text>
        {CHOICES.map((c) => (
          <Pressable key={c.value} testID={`status-${c.value}`}
                     onPress={() => setStatus(status === c.value ? null : c.value)}
                     accessibilityState={{ selected: status === c.value }}
                     style={[s.pick, status === c.value && s.pickOn]}>
            <Text style={[s.pickText, status === c.value && s.pickTextOn]}>{c.label}</Text>
            <Text style={s.pickBlurb}>{c.blurb}</Text>
          </Pressable>
        ))}

        {status === 'sold' && (
          <Field label="Price in rupees (optional)" testID="price" value={price}
                 onChangeText={setPrice} placeholder="450" keyboardType="numeric" />
        )}

        <Text style={s.label}>
          {status === 'quarantine' ? 'WHY (OPTIONAL)' : 'WHY'}
        </Text>
        <TextInput
          testID="reason"
          style={s.notes}
          value={reason}
          onChangeText={setReason}
          placeholder={status === 'sold' ? 'Sold to Prakash at the Margao market'
            : status === 'culled' ? 'Three failed services'
            : status === 'dead' ? 'Found dead in the nest box'
            : 'Off feed, keeping her apart'}
          placeholderTextColor={colors.muted}
          multiline
          numberOfLines={3}
        />
        <Muted>
          Six months from now this is the only thing that explains the gap in
          her record.
        </Muted>
        <View style={{ height: space.lg }} />

        {!!error && <Text style={{ color: colors.crit, marginBottom: space.md }}>{error}</Text>}
        <Button title={status ? `Mark ${name} ${CHOICES.find((c) => c.value === status)!.label.toLowerCase()}` : 'Save'}
                onPress={save} loading={busy} testID="save-status" />
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  label: { ...t.label, color: colors.muted, marginBottom: space.sm, marginTop: space.md },
  pick: {
    minHeight: 64, justifyContent: 'center', padding: space.lg, marginBottom: space.sm,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md,
  },
  pickOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft, borderWidth: 2 },
  pickText: { ...t.title, color: colors.ink },
  pickTextOn: { color: colors.accent },
  pickBlurb: { ...t.small, color: colors.muted, marginTop: 2 },
  notes: {
    minHeight: 88, padding: space.lg, textAlignVertical: 'top',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, color: colors.ink, ...t.body, marginBottom: space.sm,
  },
});
