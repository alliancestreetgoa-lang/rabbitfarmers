import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { Button, Card, H1, Label, Loading, Muted, Screen } from '../../src/ui/components';
import { colors, space, type as t } from '../../src/ui/theme';

/** Open cases and medicine doses, each with its action right on the row. */
export default function Health() {
  const { client } = useApp();
  const conditions = useQuery('conditions', () => client.conditions());
  const doses = useQuery('doses', () => client.medicationDue());
  const [busy, setBusy] = useState<string | null>(null);
  const loading = conditions.loading || doses.loading;
  const reload = () => { conditions.reload(); doses.reload(); };

  const check = async (id: string, status: 'ongoing' | 'stopped') => {
    setBusy(id);
    try { await client.checkCondition(id, status); reload(); } finally { setBusy(null); }
  };
  const given = async (d: { protocol_id: string; rabbit_id: string; dose_number: number }) => {
    const key = `${d.protocol_id}:${d.rabbit_id}:${d.dose_number}`;
    setBusy(key);
    try {
      await client.recordDose({
        protocol_id: d.protocol_id, rabbit_id: d.rabbit_id, dose_number: d.dose_number,
      });
      reload();
    } finally { setBusy(null); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}>
        <H1>Report a sick rabbit</H1>
        <Muted>Say it the moment you see it — reminders follow until it stops.</Muted>

        <View style={{ height: space.md }} />
        <Button title="Report a problem" testID="report"
                onPress={() => router.push('/record/condition')} />
        <View style={{ height: space.xl }} />

        <Label>OPEN CASES</Label>
        {conditions.data?.open?.length === 0 && <Muted>None open.</Muted>}
        {(conditions.data?.open ?? []).map((c) => (
          <Card key={c.condition_id}>
            <Text style={s.title}>
              {c.condition_name} — {c.rabbit_name ?? c.tag}
            </Text>
            <Muted>
              open {c.hours_open < 48 ? `${Math.round(c.hours_open)} hours` : `${Math.round(c.hours_open / 24)} days`}
            </Muted>
            <View style={s.row}>
              <Button title="Still going" variant="ghost"
                      loading={busy === c.condition_id}
                      onPress={() => check(c.condition_id, 'ongoing')} />
              <Button title="Stopped" loading={busy === c.condition_id}
                      onPress={() => check(c.condition_id, 'stopped')} />
            </View>
          </Card>
        ))}

        <View style={{ height: space.lg }} />
        <Label>MEDICINE DOSES DUE</Label>
        {doses.data?.due?.length === 0 && <Muted>Nothing due.</Muted>}
        {(doses.data?.due ?? []).map((d) => {
          const key = `${d.protocol_id}:${d.rabbit_id}:${d.dose_number}`;
          return (
            <Card key={key}>
              <Text style={s.title}>
                {d.protocol_name} — dose {d.dose_number} of {d.total_doses}
              </Text>
              <Muted>due {d.due_on}{d.dose_note ? ` · ${d.dose_note}` : ''}</Muted>
              <View style={s.row}>
                <Button title="Given" loading={busy === key} onPress={() => given(d)} />
              </View>
            </Card>
          );
        })}
        {loading && !conditions.data && <Loading />}

      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({
  title: { ...t.title, color: colors.ink },
  row: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
});
