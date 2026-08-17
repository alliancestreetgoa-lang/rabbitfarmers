import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { Empty, H1, H2, Loading, Muted, Screen } from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';
import type { Staff } from '../../src/api/types';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', manager: 'Manager', caretaker: 'Farm hand',
  vet: 'Vet', accountant: 'Accountant',
};

/** Present, on leave, not marked — as one short phrase per person. */
function todayLine(s: Staff): { text: string; tone: 'in' | 'out' | 'none' } {
  if (s.today_status === 'absent') return { text: 'Absent', tone: 'out' };
  if (s.today_status === 'leave') return { text: 'On leave', tone: 'out' };
  if (s.today_status === 'holiday') return { text: 'Holiday', tone: 'out' };
  if (!s.today_status) return { text: 'Not marked', tone: 'none' };

  const at = (iso: string | null) =>
    iso ? new Date(iso).toTimeString().slice(0, 5) : null;
  const inAt = at(s.today_checked_in_at);
  const outAt = at(s.today_checked_out_at);
  if (inAt && outAt) return { text: `${inAt} – ${outAt}`, tone: 'out' };
  if (inAt) return { text: `In since ${inAt}`, tone: 'in' };
  return { text: s.today_status === 'half_day' ? 'Half day' : 'Present', tone: 'in' };
}

export default function Team() {
  const { client, readOnly } = useApp();
  const [past, setPast] = useState(false);
  const staff = useQuery('staff', () => client.staff(past ? 'past' : 'active'), [past]);
  const list = staff.data?.staff ?? [];

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>Team</H1>
        <Muted>Who is on the farm today, and what is on their list.</Muted>

        <View style={s.tabs}>
          {[['On the farm', false], ['Left', true]].map(([label, isPast]) => (
            <Pressable
              key={String(label)}
              testID={`team-tab-${isPast ? 'past' : 'active'}`}
              style={[s.tab, past === isPast && s.tabOn]}
              onPress={() => setPast(isPast as boolean)}
            >
              <Text style={[s.tabText, past === isPast && s.tabTextOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {staff.loading && !staff.data && <Loading />}
        {!staff.loading && list.length === 0 && (
          <Empty text={past ? 'Nobody has left.' : 'Just you so far.'} />
        )}

        {list.map((p) => {
          const today = todayLine(p);
          return (
            <Pressable
              key={p.id}
              testID={`staff-${p.id}`}
              style={s.row}
              onPress={() => router.push(`/record/staff?id=${p.id}`)}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{p.full_name}</Text>
                <Text style={s.meta}>
                  {ROLE_LABEL[p.role] ?? p.role}
                  {p.sheds.length ? ` · ${p.sheds.join(', ')}` : ''}
                  {p.can_sign_in ? '' : ' · no login'}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                {!past && (
                  <Text style={[
                    s.today,
                    today.tone === 'in' && { color: colors.accent },
                    today.tone === 'out' && { color: colors.muted },
                  ]} testID={`today-${p.id}`}>
                    {today.text}
                  </Text>
                )}
                {p.open_tasks > 0 && (
                  <Text style={s.tasks}>{p.open_tasks} to do</Text>
                )}
              </View>
            </Pressable>
          );
        })}

        {!past && !readOnly && (
          <>
            <View style={{ height: space.lg }} />
            <Pressable style={s.action} onPress={() => router.push('/record/staff')}
                       testID="add-staff">
              <Text style={s.actionText}>Add somebody</Text>
            </Pressable>
          </>
        )}

        <H2>How work gets assigned</H2>
        <Muted>
          Give somebody a shed and every job for an animal in it lands on their
          list automatically. A shed two people share stays on everybody’s list —
          the farm has not said whose it is, and guessing makes work that looks
          assigned and is nobody’s.
        </Muted>
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: space.sm, marginTop: space.md, marginBottom: space.md },
  tab: {
    paddingVertical: space.sm, paddingHorizontal: space.md,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.rule,
  },
  tabOn: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  tabText: { ...t.small, color: colors.muted, fontWeight: '600' },
  tabTextOn: { color: colors.accent },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.rule, borderRadius: radius.md,
    padding: space.lg, marginBottom: space.sm,
  },
  name: { ...t.title, color: colors.ink },
  meta: { ...t.small, color: colors.muted, marginTop: 2 },
  today: { ...t.small, fontWeight: '600' },
  tasks: { ...t.small, color: colors.muted },
  action: {
    borderWidth: 1, borderColor: colors.accent, borderRadius: radius.sm,
    paddingVertical: space.md, alignItems: 'center', marginBottom: space.sm,
  },
  actionText: { ...t.title, color: colors.accent },
});
