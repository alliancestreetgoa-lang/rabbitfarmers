import React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import { H1, Loading, Muted, Screen } from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';

/**
 * The farm at a glance — the screen the app opens on, mirroring the web
 * dashboard: four numerals, then every section as a card. One /summary call.
 */

function Kpi({ label, value, sub, warn, crit, href }: {
  label: string; value: number; sub: string; warn?: boolean; crit?: boolean; href: string;
}) {
  const hotColor = value > 0 ? (crit ? colors.crit : warn ? colors.warn : null) : null;
  return (
    <Pressable style={[s.kpi, warn && value > 0 && s.kpiWarn, crit && value > 0 && s.kpiCrit]}
               onPress={() => router.push(href as never)}>
      <Text style={s.kpiLabel}>{label.toUpperCase()}</Text>
      <Text style={[s.kpiValue, hotColor ? { color: hotColor } : null]}>{value}</Text>
      <Text style={s.kpiSub}>{sub}</Text>
    </Pressable>
  );
}

function NavCard({ title, desc, badge, href }: {
  title: string; desc: string; badge?: number; href: string;
}) {
  return (
    <Pressable style={s.card} onPress={() => router.push(href as never)}
               testID={`card-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text style={s.cardTitle}>{title}</Text>
        {!!badge && (
          <View style={s.badge}><Text style={s.badgeText}>{badge}</Text></View>
        )}
      </View>
      <Muted>{desc}</Muted>
      <Text style={s.cardGo}>Open →</Text>
    </Pressable>
  );
}

/**
 * A farm hand's login sees their own day, not the team's. This card is their
 * check-in, standing where the Team and Attendance cards stand for the owner.
 */
function MyDayCard() {
  const { client } = useApp();
  const mine = useQuery('my-attendance', () => client.myAttendance());
  const [busy, setBusy] = React.useState(false);
  const today = mine.data?.attendance;
  const clock = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';

  const punch = async (which: 'in' | 'out') => {
    setBusy(true);
    try {
      if (which === 'in') await client.checkIn();
      else await client.checkOut();
      mine.reload();
    } finally { setBusy(false); }
  };

  return (
    <View style={s.card} testID="card-my-day">
      <Text style={s.cardTitle}>Your day</Text>
      <Muted>
        {today?.checked_in_at
          ? `Worked ${clock(today.checked_in_at)}${today.checked_out_at ? ` to ${clock(today.checked_out_at)}` : ' — still in'}`
          : 'Not checked in yet.'}
      </Muted>
      {!today?.checked_in_at && (
        <Pressable style={s.punch} disabled={busy} onPress={() => punch('in')}>
          <Text style={s.punchText}>Check in</Text>
        </Pressable>
      )}
      {today?.checked_in_at && !today?.checked_out_at && (
        <Pressable style={[s.punch, s.punchOut]} disabled={busy} onPress={() => punch('out')}>
          <Text style={[s.punchText, { color: colors.ink }]}>Check out</Text>
        </Pressable>
      )}
    </View>
  );
}

export default function Home() {
  const { client, session } = useApp();
  const { data, loading, reload } = useQuery('summary', () => client.summary());
  const role = session?.user?.role ?? '';
  const canSeeTeam = ['owner', 'manager', 'accountant'].includes(role);
  const name = (session?.user?.name ?? '').split(' ')[0];
  const h = new Date().getHours();
  const greeting = h < 4 ? 'Working late' : h < 12 ? 'Good morning'
    : h < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}>
        <H1>{greeting}{name ? `, ${name}` : ''}.</H1>
        <Muted>
          {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          {data ? ` · ${data.today.open} to do${data.today.urgent ? ` · ${data.today.urgent} urgent` : ''}` : ''}
        </Muted>

        {!data && loading && <Loading />}

        {data && (
          <>
            <View style={s.kpiGrid}>
              <Kpi href="/(app)/herd" label="In the herd" value={data.herd.total}
                   sub={`${data.herd.bucks} bucks · ${data.herd.does} does`} />
              <Kpi href="/(app)/breeding" label="Pregnant" value={data.pregnant.total_pregnant}
                   sub={`${data.pregnant.confirmed_pregnant} confirmed · ${data.pregnant.presumed_pregnant} presumed`} />
              <Kpi href="/(app)/breeding" label="Ready to mate" value={data.ready.ready} warn
                   sub={data.ready.overdue ? `${data.ready.overdue} overdue` : 'none overdue'} />
              <Kpi href="/(app)/litters" label="Kits" value={data.kits.unweaned}
                   sub={`unweaned · ${data.kits.litters_open} open litters`} />
              <Kpi href="/(app)/sick" label="Sick" value={data.health.sick_rabbits} crit
                   sub={data.health.sick_rabbits
                     ? `${data.health.open_conditions} open cases`
                     : 'everyone healthy'} />
            </View>

            <Text style={s.section}>EVERYTHING ELSE</Text>
            <NavCard title="Today" badge={data.today.open} href="/(app)/daily"
                     desc="The day's work — medicine rounds, checks, nest boxes." />
            <NavCard title="Breeding" href="/(app)/breeding"
                     desc="Record a mating, palpation check, kindling." />
            <NavCard title="Herd" href="/(app)/herd"
                     desc={`All ${data.herd.total} rabbits, their state and history.`} />
            <NavCard title="Litters & kits" href="/(app)/litters"
                     desc={`${data.kits.unweaned} kits to record individually or wean.`} />
            <NavCard title="Sick rabbit" badge={data.health.open_conditions || undefined}
                     href="/(app)/sick"
                     desc="Every rabbit's health record — sickness, medicine, history." />
            <NavCard title="Report a sick rabbit"
                     href="/(app)/health"
                     desc={data.health.doses_due
                       ? `${data.health.doses_due} medicine doses due.`
                       : 'Log a condition, medicine protocols.'} />
            {canSeeTeam && (
              <NavCard title="Team" href="/(app)/team"
                       desc={`${data.team.staff} on the farm. Hire, logins, roles, salaries.`} />
            )}
            {canSeeTeam ? (
              <NavCard title="Attendance" href="/(app)/attendance"
                       desc="Check in and out. Who worked which day." />
            ) : (
              <MyDayCard />
            )}
          </>
        )}
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

const s = StyleSheet.create({
  kpiGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: space.md,
    marginTop: space.lg, marginBottom: space.xl,
  },
  kpi: {
    flexBasis: '47%', flexGrow: 1,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.lg, padding: space.md,
  },
  kpiWarn: { borderColor: '#E4C9A6' },
  kpiCrit: { borderColor: '#E3BDB7' },
  kpiLabel: { ...t.label, color: colors.muted },
  kpiValue: { ...t.number, color: colors.ink, marginTop: space.xs },
  kpiSub: { ...t.small, color: colors.inkSoft, marginTop: space.xs },
  section: { ...t.label, color: colors.muted, marginBottom: space.md },
  card: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.lg, padding: space.lg, marginBottom: space.md,
  },
  cardTitle: { ...t.h2, color: colors.ink },
  cardGo: { ...t.small, color: colors.accent, fontWeight: '700', marginTop: space.sm },
  badge: {
    backgroundColor: colors.accentSoft, borderRadius: 4,
    paddingHorizontal: 6, paddingVertical: 1,
  },
  badgeText: { ...t.small, color: colors.accent, fontWeight: '700' },
  punch: {
    marginTop: space.md, alignSelf: 'flex-start',
    backgroundColor: colors.accent, borderRadius: radius.md,
    paddingVertical: space.sm, paddingHorizontal: space.lg,
  },
  punchOut: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule },
  punchText: { ...t.body, color: '#fff', fontWeight: '700' },
});
