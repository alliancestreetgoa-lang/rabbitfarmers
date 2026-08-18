import React, { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { Button, Card, H1, Label, Loading, Muted, Screen } from '../../src/ui/components';
import { STATE_LABEL, colors, space, type as t } from '../../src/ui/theme';

/**
 * One rabbit's full medical record: what she has now, medicine pending against
 * medicine actually given, and the whole history — every condition, every dose,
 * kept for ever. Reads what the farm has recorded all along.
 */
const HEALTH_KINDS = new Set(['condition', 'dose', 'health_event']);

export default function RabbitHealth() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useApp();
  const history = useQuery(`health-history:${id}`, () => client.history(id), [id]);
  const conditions = useQuery('conditions', () => client.conditions());
  const doses = useQuery('doses', () => client.medicationDue());
  const animals = useQuery('animals', () => client.animals({}));
  const [busy, setBusy] = useState<string | null>(null);

  const reload = () => { history.reload(); conditions.reload(); doses.reload(); };
  const a = history.data?.animal;
  const state = animals.data?.animals?.find((x) => x.id === id)?.reproductive_state ?? null;
  const mine = (conditions.data?.open ?? []).filter((c) => c.rabbit_id === id);
  const pending = (doses.data?.due ?? []).filter((d) => d.rabbit_id === id);
  const record = (history.data?.events ?? []).filter((e) => HEALTH_KINDS.has(e.kind));

  const check = async (cid: string, status: 'ongoing' | 'stopped') => {
    setBusy(cid);
    try { await client.checkCondition(cid, status); reload(); } finally { setBusy(null); }
  };
  const given = async (d: { protocol_id: string; dose_number: number }) => {
    const key = `${d.protocol_id}:${d.dose_number}`;
    setBusy(key);
    try {
      await client.recordDose({ protocol_id: d.protocol_id, rabbit_id: id, dose_number: d.dose_number });
      reload();
    } finally { setBusy(null); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        refreshControl={<RefreshControl refreshing={history.loading} onRefresh={reload} />}>
        {!a && <Loading />}
        {a && (
          <>
            <H1>{a.name ?? a.tag}</H1>
            <Muted>
              {a.sex === 'doe' ? 'Female' : a.sex === 'buck' ? 'Male' : ''}
              {state ? ` · ${STATE_LABEL[state] ?? state}` : ''}
              {a.status !== 'active' ? ` · ${a.status}` : ''}
            </Muted>
            <View style={{ height: space.lg }} />

            <Label>SICKNESS NOW</Label>
            {mine.length === 0 && <Muted>Nothing open — healthy as far as anyone has reported.</Muted>}
            {mine.map((c) => (
              <Card key={c.condition_id}>
                <Text style={s.title}>{c.condition_name}</Text>
                <Muted>
                  open {c.hours_open < 48 ? `${Math.round(c.hours_open)} hours` : `${Math.round(c.hours_open / 24)} days`}
                </Muted>
                <View style={s.row}>
                  <Button title="Still going" variant="ghost" loading={busy === c.condition_id}
                          onPress={() => check(c.condition_id, 'ongoing')} />
                  <Button title="Stopped" loading={busy === c.condition_id}
                          onPress={() => check(c.condition_id, 'stopped')} />
                </View>
              </Card>
            ))}

            <View style={{ height: space.lg }} />
            <Label>MEDICINE NOT YET GIVEN</Label>
            {pending.length === 0 && <Muted>Nothing pending — every due dose has been given.</Muted>}
            {pending.map((d) => {
              const key = `${d.protocol_id}:${d.dose_number}`;
              return (
                <Card key={key}>
                  <Text style={s.title}>{d.protocol_name} — dose {d.dose_number} of {d.total_doses}</Text>
                  <Muted>due {d.due_on}</Muted>
                  <View style={s.row}>
                    <Button title="Given" loading={busy === key} onPress={() => given(d)} />
                  </View>
                </Card>
              );
            })}

            <View style={{ height: space.lg }} />
            <Label>{`HEALTH HISTORY · ${record.length}`}</Label>
            {record.length === 0 && (
              <Muted>No sickness or medicine has ever been recorded for this rabbit.</Muted>
            )}
            {record.map((e, i) => (
              <View key={i} style={s.histRow}>
                <Text style={s.histDate}>{e.on_date}</Text>
                <Text style={s.histTitle}>{e.title}</Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({
  title: { ...t.title, color: colors.ink },
  row: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  histRow: {
    flexDirection: 'row', gap: space.md, paddingVertical: space.sm,
    borderBottomWidth: 1, borderBottomColor: colors.rule,
  },
  histDate: { ...t.small, color: colors.muted, width: 88 },
  histTitle: { ...t.small, color: colors.ink, flex: 1 },
});
