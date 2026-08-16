import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { Button, Field, H1, Loading, Muted, Screen } from '../../src/ui/components';
import { sexLabel, sexTerm } from '../../src/ui/labels';
import { colors, radius, space, type as t } from '../../src/ui/theme';

type Sex = 'unknown' | 'doe' | 'buck';

/**
 * Edit a rabbit.
 *
 * The reason this exists is sexing. Kits are recorded unsexed on purpose,
 * because a guess at thirty days puts a buck in the ready-to-mate queue for two
 * months — but that is only defensible if there is somewhere to say "she is a
 * doe" once you have actually looked, and until now there was not.
 */
export default function EditAnimal() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useApp();

  const { data, loading } = useQuery(`history:${id}`, () => client.history(id), [id]);
  const { data: breedData } = useQuery('breeds', () => client.breeds());
  const { data: cageData } = useQuery('cages', () => client.cages());

  const [name, setName] = useState('');
  const [sex, setSex] = useState<Sex>('unknown');
  const [breedId, setBreedId] = useState<string | null>(null);
  const [cage, setCage] = useState('');
  const [dob, setDob] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const a = data?.animal;
  useEffect(() => {
    if (!a) return;
    setName(a.name ?? a.tag);
    setSex((a.sex as Sex) ?? 'unknown');
    setCage(a.cage ?? '');
    setDob(a.date_of_birth ?? '');
    setNotes((a as { notes?: string }).notes ?? '');
    const b = (breedData?.breeds ?? []).find((x) => x.name === a.breed);
    if (b) setBreedId(b.id);
  }, [a, breedData]);

  if (loading && !data) return <Screen><Loading /></Screen>;
  if (!a) {
    return <Screen><View style={{ padding: space.lg }}><Muted>Not found.</Muted></View></Screen>;
  }

  const save = async () => {
    if (!name.trim()) { setError('A rabbit needs a name.'); return; }
    setBusy(true); setError(null);
    try {
      await client.editAnimal(a.id, {
        name: name.trim(),
        sex,
        date_of_birth: dob.trim() || undefined,
        notes: notes.trim(),
        breed_id: breedId ?? undefined,
        // '' rather than undefined when it has been cleared: undefined omits the
        // key entirely, so a farmer who empties the cage field silently changed
        // nothing. An empty string is "no cage", which is a real answer — a
        // rabbit moved out to a run has left its cage.
        cage_code: cage.trim() === (a.cage ?? '') ? undefined : cage.trim(),
      });
      router.replace(`/(app)/animal?id=${a.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>{a.name ?? a.tag}</H1>
        <Muted>
          Whatever you change, what it said before stays on her record.
          Tag <Text style={{ fontWeight: '700' }}>{a.tag}</Text> does not change —
          it is what ties her to everything already written down.
        </Muted>
        <View style={{ height: space.lg }} />

        <Field label="Name" testID="edit-name" value={name} onChangeText={setName}
               placeholder="Lakshmi" />

        <Text style={s.label}>MALE OR FEMALE</Text>
        {a.sex === 'unknown' && (
          <Muted>She has not been sexed yet — this is where you say.</Muted>
        )}
        <View style={{ flexDirection: 'row', gap: space.sm, marginVertical: space.sm }}>
          {(['doe', 'buck', 'unknown'] as const).map((v) => (
            <Pressable key={v} testID={`edit-sex-${v}`} onPress={() => setSex(v)}
                       accessibilityState={{ selected: sex === v }}
                       style={[s.pick, sex === v && s.pickOn]}>
              <Text style={[s.pickText, sex === v && s.pickTextOn]}>{sexLabel(v)}</Text>
              <Text style={[s.pickSub, sex === v && s.pickTextOn]}>{sexTerm(v)}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={s.label}>BREED</Text>
        <View style={s.chips}>
          {(breedData?.breeds ?? []).map((b) => (
            <Pressable key={b.id} testID={`edit-breed-${b.id}`}
                       onPress={() => setBreedId(breedId === b.id ? null : b.id)}
                       style={[s.chip, breedId === b.id && s.chipOn]}>
              <Text style={[s.chipText, breedId === b.id && s.chipTextOn]}>{b.name}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={s.label}>CAGE</Text>
        <TextInput
          testID="edit-cage"
          style={[s.input, !!cage.trim() && s.inputOn]}
          value={cage}
          onChangeText={setCage}
          placeholder="A-12"
          placeholderTextColor={colors.muted}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <View style={s.chips}>
          {(cageData?.cages ?? []).slice(0, 8).map((cg) => (
            <Pressable key={cg.id} testID={`edit-cage-${cg.code}`}
                       onPress={() => setCage(cage === cg.code ? '' : cg.code)}
                       style={[s.chip, cage === cg.code && s.chipOn]}>
              <Text style={[s.chipText, cage === cg.code && s.chipTextOn]}>{cg.code}</Text>
            </Pressable>
          ))}
        </View>
        {cage.trim() !== (a.cage ?? '') && (
          <Muted>Moving her is recorded as a move, so it shows on her history.</Muted>
        )}
        <View style={{ height: space.md }} />

        <Field label="Date of birth" testID="edit-dob" value={dob} onChangeText={setDob}
               placeholder="2026-07-20" />

        <Text style={s.label}>NOTES</Text>
        <TextInput
          testID="edit-notes"
          style={s.notes}
          value={notes}
          onChangeText={setNotes}
          placeholder="Quiet, good mother, keeps the nest tidy."
          placeholderTextColor={colors.muted}
          multiline
          numberOfLines={3}
        />

        {/* Parents are shown but not editable — see the endpoint for why. */}
        {(!!a.dam || !!a.sire) && (
          <>
            <Text style={s.label}>PARENTS</Text>
            <Muted>
              {a.dam ? `Mother ${a.dam}` : 'Mother not recorded'}
              {a.sire ? ` · Father ${a.sire}` : ''}. These cannot be changed —
              every mating decision since was made on them.
            </Muted>
          </>
        )}
        <View style={{ height: space.lg }} />

        {!!error && <Text style={{ color: colors.crit, marginBottom: space.md }}>{error}</Text>}
        <Button title="Save" onPress={save} loading={busy} testID="save-edit" />
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  label: { ...t.label, color: colors.muted, marginTop: space.lg, marginBottom: space.sm },
  pick: {
    flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md,
  },
  pickOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft, borderWidth: 2 },
  pickText: { ...t.body, color: colors.ink, fontWeight: '600' },
  pickSub: { ...t.small, color: colors.muted, marginTop: 2 },
  pickTextOn: { color: colors.accent },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.sm },
  chip: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: space.lg,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.sm,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft, borderWidth: 2 },
  chipText: { ...t.body, color: colors.ink },
  chipTextOn: { color: colors.accent, fontWeight: '700' },
  input: {
    minHeight: 56, paddingHorizontal: space.lg,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, color: colors.ink, ...t.body, marginBottom: space.sm,
  },
  inputOn: { borderColor: colors.accent, borderWidth: 2 },
  notes: {
    minHeight: 88, padding: space.lg, textAlignVertical: 'top',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, color: colors.ink, ...t.body,
  },
});
