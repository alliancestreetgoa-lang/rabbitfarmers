import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import {
  Button, Dropdown, H1, Loading, Muted, Screen, SupportReadOnly,
} from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';

const SEVERITY = ['mild', 'moderate', 'severe'] as const;

/**
 * Anyone can report this — no permission, no manager. The whole value is that
 * it gets said the moment it is seen.
 */
export default function ReportCondition() {
  const { rabbit } = useLocalSearchParams<{ rabbit?: string }>();
  const { client, outbox, refreshOutbox, readOnly, session } = useApp();
  const [rabbitId, setRabbitId] = useState<string | undefined>(rabbit);
  const [code, setCode] = useState<string | null>(null);
  const [severity, setSeverity] = useState<typeof SEVERITY[number]>('moderate');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, loading } = useQuery('animals', () => client.animals());
  const animals = data?.animals ?? [];
  const typesQ = useQuery('condition-types', () => client.conditionTypes());
  const types = typesQ.data?.types ?? [];
  const picked = types.find((t) => t.code === code);

  const save = async () => {
    if (!rabbitId) { setError('Which rabbit?'); return; }
    if (!code) { setError('What sickness is it?'); return; }
    setBusy(true); setError(null);
    try {
      await outbox.enqueue('condition', {
        rabbit_id: rabbitId, code, severity,
      });
      await refreshOutbox();
      router.replace('/(app)/health');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  // Support is looking, not touching. The server refuses the write too — this
  // is so the refusal arrives before the typing rather than after it.
  if (readOnly) return <SupportReadOnly by={session?.support?.by} />;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>Report a problem</H1>
        <Muted>
          You will be reminded until someone marks it stopped. If a medicine is
          set for the sickness, its doses start today.
        </Muted>

        {(typesQ.loading && !typesQ.data) || (loading && !data)
          ? <Loading />
          : (
            <>
              <Dropdown
                label="What sickness"
                testID="ctype"
                value={code}
                placeholder="Choose the sickness…"
                options={types.map((ty) => ({
                  id: ty.code, label: ty.name,
                  sub: ty.treatment ? `${ty.treatment.medicine} · ${ty.treatment.days} day${ty.treatment.days === 1 ? '' : 's'}` : undefined,
                }))}
                onSelect={setCode}
              />
              {picked && (
                <Text style={s.rx}>
                  {picked.treatment
                    ? `Give ${picked.treatment.medicine} within 24 hours` +
                      `${picked.treatment.dose_note ? ` — ${picked.treatment.dose_note}` : ''}` +
                      `${picked.treatment.days > 1 ? `. ${picked.treatment.days} days while it lasts.` : '.'}`
                    : 'No medicine set for this one — reminders only.'}
                </Text>
              )}

              <Dropdown
                label="Which rabbit"
                testID="crab"
                value={rabbitId ?? null}
                placeholder="Choose the rabbit…"
                options={animals.map((a) => ({ id: a.id, label: a.name ?? a.tag }))}
                onSelect={setRabbitId}
              />
            </>
          )}

        <Text style={s.label}>HOW BAD</Text>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {SEVERITY.map((v) => (
            <Pressable key={v} testID={`sev-${v}`} onPress={() => setSeverity(v)}
                       style={[s.sev, severity === v && s.pickOn]}>
              <Text style={[s.pickText, severity === v && s.pickTextOn]}>
                {v[0]!.toUpperCase() + v.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>

        {!!error && <Text style={{ color: colors.crit, marginTop: space.md }}>{error}</Text>}
        <View style={{ height: space.lg }} />
        <Button title="Report it" onPress={save} loading={busy} testID="save-condition" />
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  rx: { ...t.small, color: colors.muted, marginTop: -space.sm, marginBottom: space.lg },
  label: { ...t.label, color: colors.muted, marginTop: space.lg, marginBottom: space.sm },
  pick: {
    minHeight: 56, paddingHorizontal: space.lg, justifyContent: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, marginBottom: space.sm,
  },
  sev: {
    flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md,
  },
  pickOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft, borderWidth: 2 },
  pickText: { ...t.body, color: colors.ink, fontWeight: '600' },
  pickTextOn: { color: colors.accent },
});
