import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { Button, Field, H1, Loading, Muted, Screen } from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';

/**
 * She delivered — how many, and anything worth saying about it.
 *
 * Doubles as the edit screen. Pass `?litter=<id>` and it loads the record and
 * saves a correction instead of a new kindling. One screen rather than two,
 * because the fields are identical and the second copy is the one that drifts.
 */
export default function RecordKindling() {
  const { doe: doeParam, litter: litterId } =
    useLocalSearchParams<{ doe?: string; litter?: string }>();
  const editing = !!litterId;

  const { client, outbox, refreshOutbox } = useApp();
  const [doeId, setDoeId] = useState<string | undefined>(doeParam);
  const [alive, setAlive] = useState('');
  const [dead, setDead] = useState('');
  const [notes, setNotes] = useState('');
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, loading } = useQuery('animals', () => client.animals());
  const does = (data?.animals ?? []).filter((a) => a.sex === 'doe');

  const { data: existing } = useQuery(
    `litter:${litterId}`,
    () => (litterId ? client.litter(litterId) : Promise.resolve(null)),
    [litterId]);

  // Fill the form from the record being corrected, once it arrives.
  useEffect(() => {
    const l = existing?.litter;
    if (!l) return;
    setDoeId(l.doe_id);
    setAlive(String(l.born_alive ?? ''));
    setDead(String(l.born_dead ?? ''));
    setNotes(l.notes ?? '');
    setOn(l.kindled_on);
  }, [existing]);

  const save = async () => {
    if (!doeId) { setError('Which doe kindled?'); return; }
    if (!alive.trim() && !dead.trim()) { setError('How many kits?'); return; }
    setBusy(true); setError(null);
    try {
      if (editing) {
        // Corrections go straight out rather than through the outbox: the
        // farmer is looking at the old numbers and needs to know the new ones
        // landed. A queued correction that silently fails is worse than an
        // error they can see.
        await client.editLitter(litterId!, {
          born_alive: Number(alive || 0),
          born_dead: Number(dead || 0),
          notes: notes.trim(),
          kindled_on: on,
        });
        router.replace(`/(app)/animal?id=${doeId}`);
      } else {
        await outbox.enqueue('kindling', {
          doe_id: doeId,
          born_alive: Number(alive || 0),
          born_dead: Number(dead || 0),
          notes: notes.trim() || undefined,
          kindled_on: on,
        });
        await refreshOutbox();
        router.replace('/(app)/breeding');
      }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const total = (Number(alive || 0) + Number(dead || 0)) || 0;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>{editing ? 'Correct the kindling' : 'She delivered'}</H1>
        <Muted>
          {editing
            ? 'What it said before is kept on her record. Nothing is overwritten.'
            : 'Count them in the nest before you write it down.'}
        </Muted>

        {!editing && (
          <>
            <Text style={s.label}>WHICH DOE</Text>
            {loading && !data && <Loading />}
            {does.map((d) => (
              <Pressable key={d.id} testID={`kdoe-${d.id}`} onPress={() => setDoeId(d.id)}
                         style={[s.pick, doeId === d.id && s.pickOn]}>
                <Text style={[s.pickText, doeId === d.id && s.pickTextOn]}>
                  {d.name ?? d.tag}
                </Text>
              </Pressable>
            ))}
          </>
        )}

        <Text style={s.label}>HOW MANY BABIES</Text>
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <Field label="Born alive" testID="alive" value={alive} onChangeText={setAlive}
                   keyboardType="number-pad" placeholder="8" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Born dead" testID="dead" value={dead} onChangeText={setDead}
                   keyboardType="number-pad" placeholder="0" />
          </View>
        </View>
        {total > 0 && (
          <Muted>
            {total} in the litter{Number(dead || 0) > 0
              ? ` — ${alive || 0} alive, ${dead} dead` : ''}
          </Muted>
        )}
        <View style={{ height: space.md }} />

        <Field label="Date she kindled" testID="kindled-on" value={on} onChangeText={setOn}
               placeholder="2026-08-16" />

        <Text style={s.label}>NOTE (OPTIONAL)</Text>
        <TextInput
          testID="notes"
          style={s.notes}
          value={notes}
          onChangeText={setNotes}
          placeholder="Good nest, all covered. One small."
          placeholderTextColor={colors.muted}
          multiline
          numberOfLines={3}
        />
        <Muted>
          The thing you would tell someone standing next to the cage. It shows on
          her record next to the numbers.
        </Muted>
        <View style={{ height: space.lg }} />

        {/* What this record has already been corrected to say. */}
        {!!existing?.litter?.corrections?.length && (
          <>
            <Text style={s.label}>ALREADY CORRECTED</Text>
            {existing.litter.corrections.map((c, i) => (
              <View key={i} style={s.correction}>
                <Text style={s.correctionText}>
                  {Object.entries(c.old_values ?? {}).map(([k, v]) =>
                    `${k.replace(/_/g, ' ')}: ${v ?? '—'} → ${(c.new_values as any)?.[k] ?? '—'}`
                  ).join('\n')}
                </Text>
                <Text style={s.correctionMeta}>
                  {String(c.changed_at).slice(0, 10)}
                  {c.changed_by ? ` · ${c.changed_by}` : ''}
                </Text>
              </View>
            ))}
          </>
        )}

        {!!error && <Text style={{ color: colors.crit, marginBottom: space.md }}>{error}</Text>}
        <Button title={editing ? 'Save the correction' : 'Save kindling'}
                onPress={save} loading={busy} testID="save-kindling" />
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
  notes: {
    minHeight: 88, padding: space.lg, textAlignVertical: 'top',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, color: colors.ink, ...t.body, marginBottom: space.sm,
  },
  correction: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.sm, padding: space.md, marginBottom: space.sm,
  },
  correctionText: { ...t.small, color: colors.ink },
  correctionMeta: { ...t.small, color: colors.muted, marginTop: 4 },
});
