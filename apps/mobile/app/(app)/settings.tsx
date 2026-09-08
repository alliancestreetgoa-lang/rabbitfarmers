import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { Card, H1, Label, Loading, Muted, Screen } from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';

/**
 * The farm's own rules. One so far: how long after a delivery a doe goes back
 * to the buck — 16 days or 32 days, the two gaps the farm uses.
 */
const GAPS = [
  { days: 16, title: '16 days after delivery',
    note: 'Fast rhythm. She is served while the kits are still on her.' },
  { days: 32, title: '32 days after delivery',
    note: 'The usual rhythm here: the kits are separated first, then she goes back to the buck.' },
];

export default function Settings() {
  const { client } = useApp();
  const settings = useQuery('settings', () => client.settings());
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const s0 = settings.data?.settings;
  const current = s0?.rebreed_anchor === 'kindling' ? s0.rebreed_after_kindling_days : null;

  const choose = async (days: number) => {
    setSaving(days); setError(null); setSaved(null);
    try {
      await client.updateSettings({ rebreed_anchor: 'kindling', rebreed_after_kindling_days: days });
      settings.reload();
      setSaved(`Saved. From now on, ${days} days after a delivery she is on Today to be served, and every phone is told.`);
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(null); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        refreshControl={<RefreshControl refreshing={settings.loading} onRefresh={settings.reload} />}>
        <H1>Settings</H1>
        <Muted>The farm's own rules.</Muted>
        {!!error && <Text style={s.error}>{error}</Text>}
        {!!saved && <Text style={s.saved}>{saved}</Text>}

        <View style={{ height: space.lg }} />
        <Label>MATING AFTER DELIVERY</Label>
        <Muted>
          How long after a doe delivers she goes back to the buck. On that day she is
          on Today to be served, every phone is told, and she stays red until the
          mating is recorded.
        </Muted>
        {settings.loading && !settings.data && <Loading />}
        {GAPS.map((g) => {
          const on = current === g.days;
          return (
            <Pressable key={g.days} testID={`gap-${g.days}`} disabled={saving !== null}
                       accessibilityRole="radio" accessibilityState={{ checked: on }}
                       onPress={() => choose(g.days)}>
              <Card style={on ? s.chosen : undefined}>
                <View style={s.row}>
                  <View style={[s.dot, on && s.dotOn]} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.title}>{g.title}{on ? ' — chosen' : ''}</Text>
                    <Muted>{g.note}</Muted>
                    {saving === g.days && <Muted>Saving…</Muted>}
                  </View>
                </View>
              </Card>
            </Pressable>
          );
        })}
        {!!s0 && current === null && (
          <Muted>
            Right now this farm rebreeds after separating the kits, not after delivery.
            Choose a gap above to switch.
          </Muted>
        )}
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({
  title: { ...t.title, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.rule },
  dotOn: { borderColor: colors.accent, backgroundColor: colors.accent },
  chosen: { borderColor: colors.accent, borderWidth: 1, borderRadius: radius.sm },
  error: { ...t.body, color: colors.crit, marginTop: space.md },
  saved: { ...t.body, color: colors.accent, marginTop: space.md },
});
