import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useApp } from '../../src/state';
import { Button, Field, H1, Muted, Screen } from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';

/** Name and sex are the only required fields. Everything else can wait. */
export default function AddAnimal() {
  const { outbox, refreshOutbox } = useApp();
  const [name, setName] = useState('');
  const [sex, setSex] = useState<'doe' | 'buck' | null>(null);
  const [dob, setDob] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim() || !sex) { setError('A name and doe or buck, that is all.'); return; }
    setBusy(true); setError(null);
    try {
      await outbox.enqueue('animal', {
        name: name.trim(), sex, role: 'breeder',
        date_of_birth: dob.trim() || undefined,
      });
      await refreshOutbox();
      router.replace('/(app)/herd');
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg }}>
        <H1>Add a rabbit</H1>
        <Muted>Call it whatever you call it. The app will use that name everywhere.</Muted>
        <View style={{ height: space.lg }} />

        <Field label="Name" testID="name" value={name} onChangeText={setName}
               placeholder="Lakshmi" />

        <Text style={s.label}>DOE OR BUCK</Text>
        <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
          {(['doe', 'buck'] as const).map((v) => (
            <Pressable key={v} testID={`sex-${v}`} onPress={() => setSex(v)}
                       style={[s.pick, sex === v && s.pickOn]}>
              <Text style={[s.pickText, sex === v && s.pickTextOn]}>
                {v === 'doe' ? 'Doe' : 'Buck'}
              </Text>
            </Pressable>
          ))}
        </View>

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
  pickTextOn: { color: colors.accent },
});
