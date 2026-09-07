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
  const routine = useQuery('routine', () => client.routine());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loading = conditions.loading || doses.loading;
  const reload = () => { conditions.reload(); doses.reload(); routine.reload(); };

  const check = async (id: string, status: 'ongoing' | 'stopped') => {
    setBusy(id);
    try { await client.checkCondition(id, status); reload(); } finally { setBusy(null); }
  };
  const given = async (d: { protocol_id: string; rabbit_id: string; dose_number: number }) => {
    const key = `${d.protocol_id}:${d.rabbit_id}:${d.dose_number}`;
    setBusy(key);
    setError(null);
    try {
      await client.recordDose({
        protocol_id: d.protocol_id, rabbit_id: d.rabbit_id, dose_number: d.dose_number,
      });
      reload();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  };
  const routineDone = async (taskId: string) => {
    setBusy(taskId);
    try { await client.taskDone(taskId); reload(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
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
        {!!error && <Text style={{ color: colors.crit, marginBottom: space.sm }}>{error}</Text>}
        {(doses.data?.due ?? []).map((d) => {
          const key = `${d.protocol_id}:${d.rabbit_id}:${d.dose_number}`;
          return (
            <Card key={key}>
              <Text style={s.title}>
                {d.protocol_name} — dose {d.dose_number} of {d.total_doses}
              </Text>
              <Muted>
                due {d.due_on}{d.dose ? ` · ${d.dose}` : ''}{d.route ? ` (${d.route})` : ''}
                {d.dose_note ? ` · ${d.dose_note}` : ''}
              </Muted>
              {d.hold_reason ? (
                /* The chart forbids this one for this rabbit. Said instead of
                   the button, not next to it — the button is the mistake. */
                <Text style={s.hold} testID={`hold-${key}`}>
                  Do not give — {d.hold_reason}. Ask the vet.
                </Text>
              ) : (
                <View style={s.row}>
                  <Button title="Given" loading={busy === key} onPress={() => given(d)} />
                </View>
              )}
            </Card>
          );
        })}
        {loading && !conditions.data && <Loading />}

        <View style={{ height: space.lg }} />
        <Label>THIS MONTH'S ROUTINE{routine.data ? ` · ${routine.data.done} OF ${routine.data.total} DONE` : ''}</Label>
        <Muted>
          Whole farm, first week of every month. Each day lands on Today and on
          every phone.
        </Muted>
        {(routine.data?.steps ?? []).map((st) => {
          const done = st.task_status === 'done';
          const open = st.task_status === 'open';
          return (
            <Card key={st.step} style={done ? { opacity: 0.55 } : undefined}>
              <Text style={s.title}>Day {st.day} — {st.medicine}</Text>
              <Muted>{st.dose} · {st.detail}</Muted>
              {done && <Muted>✓ done</Muted>}
              {open && st.task_id && (
                <View style={s.row}>
                  <Button title="Done for the whole farm" loading={busy === st.task_id}
                          onPress={() => routineDone(st.task_id!)} />
                </View>
              )}
            </Card>
          );
        })}
        {(routine.data?.standing ?? []).map((line) => (
          <Muted key={line}>{line}</Muted>
        ))}

      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({
  title: { ...t.title, color: colors.ink },
  row: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  hold: { ...t.body, color: colors.crit, fontWeight: '700', marginTop: space.md },
});
