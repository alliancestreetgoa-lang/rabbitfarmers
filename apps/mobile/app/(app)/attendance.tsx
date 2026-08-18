import React, { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { Button, Card, H1, Label, Muted, Screen } from '../../src/ui/components';
import { colors, space, type as t } from '../../src/ui/theme';

const clock = (s?: string | null) =>
  s ? new Date(s).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';

/** Check in, check out, and the month — the farm hand's own screen. */
export default function AttendanceScreen() {
  const { client, session } = useApp();
  const mine = useQuery('my-attendance', () => client.myAttendance());
  const canSeeAll = ['owner', 'manager', 'accountant'].includes(session?.user?.role ?? '');
  const month = useQuery('attendance-month',
    () => (canSeeAll ? client.attendance() : Promise.resolve(null)), [canSeeAll]);
  const [busy, setBusy] = useState(false);

  const today = mine.data?.attendance;
  const punch = async (which: 'in' | 'out') => {
    setBusy(true);
    try {
      if (which === 'in') await client.checkIn();
      else await client.checkOut();
      mine.reload(); month.reload();
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        refreshControl={<RefreshControl refreshing={mine.loading} onRefresh={() => { mine.reload(); month.reload(); }} />}>
        <H1>Attendance</H1>

        <Card>
          <Text style={s.title}>
            {today?.checked_in_at
              ? `Worked ${clock(today.checked_in_at)}${today.checked_out_at ? ` to ${clock(today.checked_out_at)}` : ' — still in'}`
              : 'Not checked in'}
          </Text>
          <View style={{ marginTop: space.md }}>
            {!today?.checked_in_at && <Button title="Check in" loading={busy} onPress={() => punch('in')} />}
            {today?.checked_in_at && !today?.checked_out_at && (
              <Button title="Check out" loading={busy} onPress={() => punch('out')} />
            )}
          </View>
        </Card>

        {canSeeAll && month.data && (
          <>
            <View style={{ height: space.lg }} />
            <Label>{`THE MONTH · ${month.data.month}`}</Label>
            {month.data.summary.map((p) => (
              <Card key={p.employee_id}>
                <Text style={s.title}>{p.full_name}</Text>
                <Muted>
                  {p.days_worked} days worked · {p.present} present · {p.half_days} half ·{' '}
                  {p.absent} absent · {p.leave} leave
                </Muted>
              </Card>
            ))}
          </>
        )}
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({ title: { ...t.title, color: colors.ink } });
