import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { Button, Field, H1, Muted, Screen } from '../../src/ui/components';
import { sexLabel, sexLabelFull, sexTerm } from '../../src/ui/labels';
import { colors, radius, space, type as t } from '../../src/ui/theme';

/** Name and sex are the only required fields. Everything else can wait. */
export default function AddAnimal() {
  const { client, outbox, refreshOutbox } = useApp();
  const [name, setName] = useState('');
  const [sex, setSex] = useState<'doe' | 'buck' | null>(null);
  const [dob, setDob] = useState('');
  const [breed, setBreed] = useState<{ id?: string; name?: string } | null>(null);
  const [newBreed, setNewBreed] = useState('');
  const [cage, setCage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cached, so this form still opens in a shed with no signal. A farmer who is
  // offline gets the lists from the last time they were not, and can type a
  // breed or cage that is not in them either way.
  const { data: breedData } = useQuery('breeds', () => client.breeds());
  const { data: cageData } = useQuery('cages', () => client.cages());
  const breeds = breedData?.breeds ?? [];
  const cages = cageData?.cages ?? [];

  const save = async () => {
    if (!name.trim() || !sex) { setError('A name, and male or female. That is all.'); return; }
    setBusy(true); setError(null);
    try {
      await outbox.enqueue('animal', {
        name: name.trim(), sex, role: 'breeder',
        date_of_birth: dob.trim() || undefined,
        // An id when they picked from the list, a name when they typed one.
        // The server creates what it does not recognise, so this stays a single
        // queued write and replays safely.
        breed_id: breed?.id,
        breed_name: breed?.id ? undefined : (breed?.name || undefined),
        cage_code: cage.trim() || undefined,
      });
      await refreshOutbox();
      router.replace('/(app)/herd');
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  const pickBreed = (b: { id: string; name: string }) => {
    setBreed(breed?.id === b.id ? null : { id: b.id, name: b.name });
    setNewBreed('');
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>Add a rabbit</H1>
        <Muted>Call it whatever you call it. The app will use that name everywhere.</Muted>
        <View style={{ height: space.lg }} />

        <Field label="Name" testID="name" value={name} onChangeText={setName}
               placeholder="Lakshmi" />

        {/*
          Male and female, with the rabbitry word underneath. The rest of the
          app talks about does and bucks; this is where someone learns which is
          which, and getting it wrong here is expensive — a buck filed as a doe
          shows up in the ready-to-mate queue and never kindles.
        */}
        <Text style={s.label}>MALE OR FEMALE</Text>
        <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
          {(['doe', 'buck'] as const).map((v) => (
            <Pressable key={v} testID={`sex-${v}`} onPress={() => setSex(v)}
                       accessibilityRole="radio"
                       accessibilityState={{ selected: sex === v }}
                       accessibilityLabel={sexLabelFull(v)}
                       style={[s.pick, sex === v && s.pickOn]}>
              <Text style={[s.pickText, sex === v && s.pickTextOn]}>
                {sexLabel(v)}
              </Text>
              <Text style={[s.pickSub, sex === v && s.pickTextOn]}>{sexTerm(v)}</Text>
            </Pressable>
          ))}
        </View>

        {/*
          Breed as taps, ordered by how many of that breed the farm already has,
          so the common answer is the first thing under the thumb. Typing is
          there for the breed this farm actually keeps that the seeded list has
          never heard of — Grey Giant, a local cross — and once typed it joins
          the taps for next time.
        */}
        <Text style={s.label}>BREED (OPTIONAL)</Text>
        <View style={s.chips}>
          {breeds.map((b) => (
            <Pressable key={b.id} testID={`breed-${b.id}`} onPress={() => pickBreed(b)}
                       accessibilityState={{ selected: breed?.id === b.id }}
                       style={[s.chip, breed?.id === b.id && s.chipOn]}>
              <Text style={[s.chipText, breed?.id === b.id && s.chipTextOn]}>{b.name}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          testID="breed-other"
          style={[s.input, !!newBreed && s.inputOn]}
          value={newBreed}
          onChangeText={(v) => {
            setNewBreed(v);
            setBreed(v.trim() ? { name: v.trim() } : null);
          }}
          placeholder={breeds.length ? 'Or type another breed' : 'Type the breed'}
          placeholderTextColor={colors.muted}
          autoCapitalize="words"
        />

        {/*
          Cage is typed, not picked. A working farm has dozens and the code is
          whatever is painted on the card — scrolling a list of sixty to find
          A-12 is slower than writing it. Recent ones are offered as taps
          because rabbits go in nearby cages in the same session.
        */}
        <Text style={s.label}>CAGE (OPTIONAL)</Text>
        <TextInput
          testID="cage"
          style={[s.input, !!cage.trim() && s.inputOn]}
          value={cage}
          onChangeText={setCage}
          placeholder="A-12"
          placeholderTextColor={colors.muted}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        {cages.length > 0 && (
          <View style={s.chips}>
            {cages.slice(0, 8).map((cg) => (
              <Pressable key={cg.id} testID={`cage-${cg.code}`}
                         onPress={() => setCage(cage === cg.code ? '' : cg.code)}
                         style={[s.chip, cage === cg.code && s.chipOn]}>
                <Text style={[s.chipText, cage === cg.code && s.chipTextOn]}>
                  {cg.code}
                  {Number(cg.occupants) > 0 ? ` · ${cg.occupants}` : ''}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        <Muted>
          {cage.trim() && !cages.some((cg) => cg.code === cage.trim())
            ? `${cage.trim()} is new — it will be added to your shed.`
            : 'Write what is painted on the cage. New ones are created as you go.'}
        </Muted>
        <View style={{ height: space.lg }} />

        <Field label="Date of birth (optional)" testID="dob" value={dob}
               onChangeText={setDob} placeholder="2024-01-15" />

        {!!error && <Text style={{ color: colors.crit, marginBottom: space.md }}>{error}</Text>}
        <Button title="Add" onPress={save} loading={busy} testID="save-animal" />
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  label: { ...t.label, color: colors.muted, marginBottom: space.sm },
  pick: {
    flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md,
  },
  pickOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft, borderWidth: 2 },
  pickText: { ...t.title, color: colors.ink },
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
    borderRadius: radius.md, color: colors.ink, ...t.body,
    marginBottom: space.sm,
  },
  inputOn: { borderColor: colors.accent, borderWidth: 2 },
});
