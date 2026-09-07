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
                  sub: ty.steps?.length
                    ? ty.steps.map((st) => st.medicine).join(', then ')
                    : undefined,
                }))}
                onSelect={setCode}
              />
              {picked && (
                <View style={s.rxBox} testID="treatment">
                  {picked.advice ? <Text style={s.advice}>{picked.advice}</Text> : null}
                  {picked.steps?.length ? picked.steps.map((st) => (
                    <View key={st.protocol_id} style={{ marginTop: space.sm }}>
                      <Text style={s.rxTitle}>
                        {picked.steps.length > 1 ? `${st.step}. ` : ''}{st.medicine}
                        {st.dose ? ` — ${st.dose}` : ''}{st.route ? ` (${st.route})` : ''}
                      </Text>
                      <Text style={s.rx}>
                        {st.doses === 1 ? 'One dose' : `${st.doses} doses, ${st.interval_days === 1 ? 'daily' : `every ${st.interval_days} days`}`}
                        {st.note ? `. ${st.note}` : ''}
                      </Text>
                      {(st.adults_only || st.min_age_days || st.not_when_pregnant) ? (
                        <Text style={s.warn}>
                          Not for {[
                            st.not_when_pregnant ? 'a pregnant doe' : null,
                            st.min_age_days ? `kits under ${Math.round(st.min_age_days / 30)} months` : null,
                            st.adults_only && !st.min_age_days ? 'anything but an adult' : null,
                          ].filter(Boolean).join(', or ')}.
                        </Text>
                      ) : null}
                    </View>
                  )) : (
                    <Text style={s.rx}>No medicine set for this one — reminders only.</Text>
                  )}
                  <Text style={s.disclaimer}>
                    Doses as given at the farm training. Confirm with a vet before use.
                  </Text>
                </View>
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
  rx: { ...t.small, color: colors.muted },
  rxBox: {
    marginTop: -space.sm, marginBottom: space.lg, padding: space.md,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md,
  },
  rxTitle: { ...t.body, color: colors.ink, fontWeight: '700' },
  advice: { ...t.body, color: colors.ink },
  warn: { ...t.small, color: colors.crit, fontWeight: '700', marginTop: 2 },
  disclaimer: { ...t.small, color: colors.muted, marginTop: space.md, fontStyle: 'italic' },
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
