import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { TabBar } from '../../src/ui/nav';
import {
  Banner, Empty, H1, Loading, Muted, Pill, Screen,
} from '../../src/ui/components';
import { colors, radius, space, type as t, urgencyColor } from '../../src/ui/theme';
import type { DailyItem } from '../../src/api/types';

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The screen the app opens on.
 *
 * Not a dashboard — the actual work, in one list, with nothing to navigate to.
 * If a farm hand has to hunt for today's jobs they will use the paper card.
 */
export default function Daily() {
  const { client, outbox, refreshOutbox } = useApp();
  const { data, loading, stale, reload } = useQuery('daily', () => client.daily());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, { at: string; title: string }>>({});
  // "Still going" leaves the row on screen — the rabbit is still sick — so
  // without this the tap looks like it did nothing. The hours-open counter
  // keeps climbing from onset, correctly, which makes it worse: the one number
  // on the row is the one number that does not move when you answer.
  const [answered, setAnswered] = useState<Record<string, string>>({});

  const now = new Date();
  const items = (data?.items ?? []).filter((i) => !done[i.ref_id]);
  // Conditions come first and get their own section, so they must be taken out
  // of the others. A critical condition is critical — without this it lands in
  // "Needs a look now" AND "Overdue", and the farmer sees the same sick rabbit
  // twice and cannot tell whether that means two rabbits.
  const conditions = items.filter((i) => i.source === 'condition');
  // Doses get their own section and their own tick, because they are the one
  // kind of item that is answered by doing a thing rather than by opening a
  // screen — and the round is done standing at the cages.
  const doses = items.filter((i) => i.source === 'medication');
  const others = items.filter(
    (i) => i.source !== 'condition' && i.source !== 'medication');
  const overdue = others.filter((i) => i.urgency === 'critical');
  const rest = others.filter((i) => i.urgency !== 'critical');

  /**
   * The dose's ref_id is `protocol:rabbit:dose` — a schedule is generated, not
   * stored, so there is no dose row to name and those three things are what pin
   * one down. See migration 0017.
   */
  const giveDose = async (item: DailyItem) => {
    const [protocol_id, rabbit_id, dose_number] = item.ref_id.split(':');
    setBusyId(item.ref_id);
    try {
      await outbox.enqueue('dose', {
        protocol_id, rabbit_id, dose_number: Number(dose_number),
      });
      setDone((d) => ({
        ...d, [item.ref_id]: { at: new Date().toISOString(), title: item.title },
      }));
      await refreshOutbox();
      reload();
    } finally { setBusyId(null); }
  };

  const answerCondition = async (item: DailyItem, status: 'ongoing' | 'stopped') => {
    setBusyId(item.ref_id);
    try {
      await outbox.enqueue('condition_check', { status }, item.ref_id);
      if (status === 'stopped') {
        setDone((d) => ({
          ...d, [item.ref_id]: { at: new Date().toISOString(), title: item.title },
        }));
      } else {
        setAnswered((a) => ({ ...a, [item.ref_id]: new Date().toISOString() }));
      }
      await refreshOutbox();
      reload();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
      >
        <H1>Today</H1>
        <Muted>
          {DAY[now.getDay()]} {now.getDate()} {MONTH[now.getMonth()]}
          {items.length > 0 ? ` · ${items.length} to do` : ''}
        </Muted>

        {stale && (
          <View style={{ marginTop: space.md }}>
            <Banner tone="high" text="No signal — showing what was on the phone" />
          </View>
        )}

        <View style={{ height: space.lg }} />

        {loading && !data && <Loading />}

        {!!conditions.length && (
          <>
            <SectionTitle text="Needs a look now" count={conditions.length} />
            {conditions.map((i) => (
              <ConditionRow
                key={i.ref_id}
                item={i}
                busy={busyId === i.ref_id}
                answeredAt={answered[i.ref_id]}
                onStillGoing={() => answerCondition(i, 'ongoing')}
                onStopped={() => answerCondition(i, 'stopped')}
              />
            ))}
          </>
        )}

        {!!doses.length && (
          <>
            <SectionTitle text="Medicine round" count={doses.length} />
            {doses.map((i) => (
              <DoseRow key={i.ref_id} item={i} busy={busyId === i.ref_id}
                       onGiven={() => giveDose(i)} />
            ))}
          </>
        )}

        {!!overdue.length && (
          <>
            <SectionTitle text="Overdue" count={overdue.length} />
            {overdue.map((i) => <TaskRow key={i.ref_id} item={i} />)}
          </>
        )}

        {!!rest.length && (
          <>
            <SectionTitle text="Today" count={rest.length} />
            {rest.map((i) => <TaskRow key={i.ref_id} item={i} />)}
          </>
        )}

        {!!Object.keys(done).length && (
          <>
            <SectionTitle text="Done" count={Object.keys(done).length} />
            {Object.entries(done).map(([id, d]) => (
              <View key={id} style={[s.row, { opacity: 0.5 }]}>
                <Text style={[s.rowTitle, { flex: 1 }]}>✓ {d.title}</Text>
                <Text style={s.rowMeta}>{new Date(d.at).toTimeString().slice(0, 5)}</Text>
              </View>
            ))}
          </>
        )}

        {!loading && items.length === 0 && Object.keys(done).length === 0 && (
          <Empty text={'Nothing due today.\nRecord a mating or add a rabbit from Breeding.'} />
        )}
      </ScrollView>
      <TabBar />
    </Screen>
  );
}

function SectionTitle({ text, count }: { text: string; count: number }) {
  return (
    <View style={s.sectionHead}>
      <Text style={s.sectionText}>{text.toUpperCase()}</Text>
      <Text style={s.sectionCount}>{count}</Text>
    </View>
  );
}

function TaskRow({ item }: { item: DailyItem }) {
  const c = urgencyColor(item.urgency);
  return (
    <Pressable
      testID={`task-${item.ref_id}`}
      style={s.row}
      onPress={() => item.rabbit_id && router.push(`/(app)/animal?id=${item.rabbit_id}`)}
    >
      <View style={[s.stripe, { backgroundColor: c.fg }]} />
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{item.title}</Text>
        {!!item.tag && <Text style={s.rowMeta}>{item.tag}</Text>}
      </View>
      {item.urgency === 'critical' && <Pill text="now" urgency="critical" />}
    </Pressable>
  );
}

/**
 * A dose is given, not navigated to. One tap, and it leaves the list — which is
 * the whole reminder loop: five days before she kindles, five days after, and
 * nothing to remember.
 */
function DoseRow({ item, busy, onGiven }: {
  item: DailyItem; busy: boolean; onGiven: () => void;
}) {
  return (
    <View style={[s.row, { alignItems: 'center' }]} testID={`dose-${item.ref_id}`}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{item.title}</Text>
        {!!item.tag && <Text style={s.rowMeta}>{item.tag}</Text>}
      </View>
      <Pressable
        testID={`given-${item.ref_id}`}
        style={[s.smallBtn, { backgroundColor: colors.accent, borderColor: colors.accent }]}
        onPress={onGiven}
        disabled={busy}
      >
        <Text style={[s.smallBtnText, { color: colors.white }]}>
          {busy ? 'Saving…' : 'Given'}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * A condition row answers its own question inline. The reminder asks "still
 * going, or stopped?" so the answer has to be one tap away, not three screens
 * deep.
 */
function ConditionRow({ item, busy, answeredAt, onStillGoing, onStopped }: {
  item: DailyItem; busy: boolean; answeredAt?: string;
  onStillGoing: () => void; onStopped: () => void;
}) {
  return (
    <View style={[s.row, { alignItems: 'flex-start' }]} testID={`condition-${item.ref_id}`}>
      <View style={[s.dot, { backgroundColor: item.colour ?? colors.condition }]} />
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{item.title}</Text>
        {!!answeredAt && (
          <Text style={s.rowMeta} testID={`answered-${item.ref_id}`}>
            Logged at {new Date(answeredAt).toTimeString().slice(0, 5)} — quiet until the
            next reminder
          </Text>
        )}
        <View style={s.actions}>
          {/*
            "Still going" is a real answer, not a dismissal. It records the
            observation, which restarts the two-hour clock from now — so a
            caretaker who has just looked is not nagged again in ten minutes.
            Leaving it as a no-op meant the only way to stop being reminded was
            to claim the rabbit had recovered.
          */}
          <Pressable
            testID={`still-${item.ref_id}`}
            style={[s.smallBtn, { borderColor: colors.rule }]}
            onPress={onStillGoing}
            disabled={busy}
          >
            <Text style={[s.smallBtnText, { color: colors.inkSoft }]}>Still going</Text>
          </Pressable>
          <Pressable
            testID={`stopped-${item.ref_id}`}
            style={[s.smallBtn, { backgroundColor: colors.accent, borderColor: colors.accent }]}
            onPress={onStopped}
            disabled={busy}
          >
            <Text style={[s.smallBtnText, { color: colors.white }]}>
              {busy ? 'Saving…' : 'Stopped'}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between',
    marginTop: space.lg, marginBottom: space.sm,
  },
  sectionText: { ...t.label, color: colors.muted },
  sectionCount: { ...t.label, color: colors.muted },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.rule, borderRadius: radius.md,
    padding: space.lg, marginBottom: space.sm,
    minHeight: 64,
  },
  stripe: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 5 },
  rowTitle: { ...t.body, color: colors.ink, fontWeight: '600' },
  rowMeta: { ...t.small, color: colors.muted, marginTop: 2 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  smallBtn: {
    minHeight: 44, paddingHorizontal: space.lg, borderRadius: radius.sm,
    borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  smallBtnText: { ...t.small, fontWeight: '700' },
});
