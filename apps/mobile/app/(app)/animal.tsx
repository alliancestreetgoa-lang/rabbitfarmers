import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import { Card, ConditionMark, H1, Loading, Muted, Pill, Screen } from '../../src/ui/components';
import { sexLabelFull } from '../../src/ui/labels';
import { STATE_LABEL, colors, radius, relativeDay, space, type as t } from '../../src/ui/theme';
import type { HistoryEvent } from '../../src/api/types';

const GONE = ['sold', 'culled', 'dead'];

export default function AnimalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useApp();
  // One call now, not two: the history endpoint returns the animal, her
  // lifetime totals, her timeline and her offspring. It also works for an
  // animal who has left the herd, which the herd list deliberately does not
  // return.
  const { data, loading, stale } = useQuery(
    `history:${id}`, () => client.history(id), [id]);

  if (loading && !data) return <Screen><Loading /></Screen>;
  if (!data) {
    return <Screen><View style={{ padding: space.lg }}><Muted>Not found.</Muted></View></Screen>;
  }

  const { animal: a, lifetime: lt, events, offspring } = data;
  const gone = GONE.includes(a.status);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>{a.name ?? a.tag}</H1>
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center',
                       flexWrap: 'wrap' }}>
          <Pill text={sexLabelFull(a.sex)} urgency="low" />
          {gone && <Pill text={a.status} urgency="medium" />}
          {!gone && !!a.reproductive_state && (
            <Pill
              text={STATE_LABEL[a.reproductive_state] ?? a.reproductive_state}
              urgency={a.reproductive_state === 'OVERDUE' ? 'critical'
                : a.reproductive_state === 'NEST_BOX' ? 'high' : 'low'}
            />
          )}
        </View>

        {stale && <Muted>Showing what was last on the phone.</Muted>}

        {gone && (
          <View style={{ marginTop: space.md }}>
            <Muted>
              She has left the herd. Everything recorded about her is kept —
              this page is the record.
            </Muted>
          </View>
        )}

        {!gone && !!a.primary_colour && !!a.primary_condition && (
          <View style={{ marginTop: space.lg }}>
            <Card style={{ borderColor: a.primary_colour }}>
              <ConditionMark colour={a.primary_colour} label={a.primary_condition} />
              <Muted>Held out of breeding until this is marked stopped.</Muted>
            </Card>
          </View>
        )}

        <View style={{ height: space.lg }} />
        <Card>
          <Row k="Tag" v={a.tag} />
          <Row k="Breed" v={a.breed ?? '—'} />
          <Row k="Born" v={a.date_of_birth ?? '—'} />
          <Row k="Cage" v={a.cage ?? '—'} />
          {!!a.dam && <Row k="Mother" v={a.dam} />}
          {!!a.sire && <Row k="Father" v={a.sire} />}
          {!gone && !!a.expected_kindling_on && (
            <Row k="Due" v={`${a.expected_kindling_on} (${relativeDay(a.expected_kindling_on)})`} />
          )}
          {!gone && a.confidence && <Row k="Pregnancy" v={a.confidence} cap />}
        </Card>

        {/* Lifetime totals. The line a farmer decides on. */}
        {!!lt && (lt.litters > 0 || lt.services > 0) && (
          <>
            <SectionTitle text={a.sex === 'doe' ? 'Her record' : 'His record'} />
            <Card>
              {a.sex === 'doe' ? (
                <>
                  <Row k="Litters" v={String(lt.litters)} />
                  <Row k="Born alive" v={String(lt.born_alive)} />
                  <Row k="Weaned" v={String(lt.weaned)} />
                  <Row
                    k="Weaned per year"
                    v={lt.weaned_per_year != null ? String(lt.weaned_per_year)
                      : lt.days_in_service != null
                        // Never show an annual rate extrapolated from a couple
                        // of months — it reads like a track record and is not.
                        ? `too early — ${lt.days_in_service} days in service`
                        : '—'}
                  />
                </>
              ) : (
                <Row k="Does served" v={String(lt.services)} />
              )}
              {lt.illnesses > 0 && <Row k="Illnesses" v={String(lt.illnesses)} />}
            </Card>
          </>
        )}

        {!gone && (
          <>
            <View style={{ height: space.lg }} />
            {a.sex === 'doe' && (
              <>
                <Pressable style={s.action} testID="a-mate"
                           onPress={() => router.push(`/record/mating?doe=${a.id}`)}>
                  <Text style={s.actionText}>Record a mating</Text>
                </Pressable>
                <Pressable style={s.action} testID="a-kindle"
                           onPress={() => router.push(`/record/kindling?doe=${a.id}`)}>
                  <Text style={s.actionText}>Record a kindling</Text>
                </Pressable>
              </>
            )}
            <Pressable style={s.action} testID="a-sick"
                       onPress={() => router.push(`/record/condition?rabbit=${a.id}`)}>
              <Text style={s.actionText}>Report a problem</Text>
            </Pressable>
            <Pressable style={[s.action, s.leave]} testID="a-leave"
                       onPress={() => router.push(`/record/status?rabbit=${a.id}`)}>
              <Text style={[s.actionText, { color: colors.muted }]}>
                Sold, culled or died
              </Text>
            </Pressable>
          </>
        )}

        {offspring.length > 0 && (
          <>
            <SectionTitle text={`Offspring · ${offspring.length}`} />
            {offspring.map((k) => (
              <Pressable key={k.id} style={s.row} testID={`kid-${k.id}`}
                         onPress={() => router.push(`/(app)/animal?id=${k.id}`)}>
                <Text style={s.rowTitle}>{k.name ?? k.tag}</Text>
                <Text style={s.rowMeta}>
                  {k.date_of_birth ?? '—'}
                  {GONE.includes(k.status) ? ` · ${k.status}` : ''}
                </Text>
              </Pressable>
            ))}
          </>
        )}

        <SectionTitle text="History" />
        {events.length === 0
          ? <Muted>Nothing recorded yet.</Muted>
          : events.map((e, i) => <Event key={`${e.kind}-${e.on_date}-${i}`} e={e} />)}
      </ScrollView>
    </Screen>
  );
}

/**
 * One line of the timeline.
 *
 * The title already says what happened; the second line is only there when it
 * adds something a farmer would act on or ask about. Printing the whole detail
 * blob would bury the three lines that matter under twenty that do not.
 */
function Event({ e }: { e: HistoryEvent }) {
  const d = e.detail ?? {};
  const notes: string[] = [];

  if (e.kind === 'mating' || e.kind === 'service') {
    if (d.outcome && d.outcome !== 'pending') notes.push(String(d.outcome));
    if (d.services && Number(d.services) > 1) notes.push(`${d.services} services`);
  }
  if (e.kind === 'weaning' && d.days_to_wean) notes.push(`${d.days_to_wean} days old`);
  if (e.kind === 'condition') {
    if (d.severity) notes.push(String(d.severity));
    if (d.checks) notes.push(`${d.checks} checks`);
    if (d.hours_open) notes.push(`${d.hours_open}h`);
  }
  if (e.kind === 'status' && d.sale_price_paise != null) {
    notes.push(`₹${(Number(d.sale_price_paise) / 100).toFixed(0)}`);
  }
  if (typeof d.notes === 'string' && d.notes.trim()) notes.push(d.notes.trim());
  if (typeof d.reason === 'string' && d.reason.trim()) notes.push(d.reason.trim());

  // A kindling is the one entry a farmer routinely gets wrong in the dark and
  // wants to fix: eight in the nest at dawn, a ninth found under the fur later.
  const litterId = e.kind === 'kindling' ? (e.detail?.litter_id as string) : null;

  // And it is where the litter stops being a number. Offer that first while any
  // kit is still only a count — it is the more useful of the two actions, and
  // the one nobody would guess is hiding behind "Edit".
  const unrecorded = Number(e.detail?.kits_not_yet_recorded ?? 0);
  const recorded = Number(e.detail?.kits_recorded ?? 0);
  if (litterId && recorded > 0) notes.push(`${recorded} recorded individually`);

  return (
    <View style={s.event} testID={`event-${e.kind}`}>
      <View style={[
        s.dot,
        e.kind === 'status' && { backgroundColor: colors.muted },
        e.kind === 'correction' && { backgroundColor: colors.rule },
      ]} />
      <View style={{ flex: 1 }}>
        <Text style={s.eventTitle}>{e.title}</Text>
        {e.kind === 'correction' ? (
          <Text style={s.eventMeta}>
            {Object.entries((e.detail?.before ?? {}) as Record<string, unknown>)
              .map(([k, v]) =>
                `${k.replace(/_/g, ' ')}: ${v ?? '—'} → ` +
                `${(e.detail?.after as any)?.[k] ?? '—'}`)
              .join('  ·  ')}
            {e.detail?.by ? `\n${e.on_date} · ${e.detail.by}` : `\n${e.on_date}`}
          </Text>
        ) : (
          <Text style={s.eventMeta}>
            {e.on_date}{notes.length ? ` · ${notes.join(' · ')}` : ''}
          </Text>
        )}
      </View>
      {!!litterId && (
        <View style={{ gap: space.sm }}>
          {unrecorded > 0 && (
            <Pressable testID={`kits-${litterId}`} style={[s.edit, s.editPrimary]}
                       onPress={() => router.push(`/record/kits?litter=${litterId}`)}>
              <Text style={[s.editText, { color: colors.white }]}>
                + {unrecorded} kits
              </Text>
            </Pressable>
          )}
          <Pressable testID={`edit-${litterId}`} style={s.edit}
                     onPress={() => router.push(`/record/kindling?litter=${litterId}`)}>
            <Text style={s.editText}>Edit</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function SectionTitle({ text }: { text: string }) {
  return <Text style={s.sectionText}>{text.toUpperCase()}</Text>;
}

/**
 * `cap` title-cases the value, which is right for a bare status word from the
 * database ("trialing", "presumed") and wrong for anything written as a
 * sentence — capitalising every word turned "too early — 27 days in service"
 * into a headline.
 */
function Row({ k, v, cap = false }: { k: string; v: string; cap?: boolean }) {
  return (
    <View style={s.kv}>
      <Text style={s.k}>{k}</Text>
      <Text style={[s.v, cap && s.vCap]} numberOfLines={2}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm },
  k: { ...t.small, color: colors.muted },
  v: { ...t.body, color: colors.ink, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  vCap: { textTransform: 'capitalize' },
  sectionText: { ...t.label, color: colors.muted, marginTop: space.xl, marginBottom: space.sm },
  action: {
    minHeight: 52, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.accent,
    alignItems: 'center', justifyContent: 'center', marginBottom: space.sm,
  },
  leave: { borderColor: colors.rule },
  actionText: { ...t.title, color: colors.accent },
  row: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, padding: space.lg, marginBottom: space.sm, minHeight: 56,
    justifyContent: 'center',
  },
  rowTitle: { ...t.body, color: colors.ink, fontWeight: '600' },
  rowMeta: { ...t.small, color: colors.muted, marginTop: 2 },
  event: {
    flexDirection: 'row', gap: space.md, alignItems: 'flex-start',
    paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.rule,
  },
  dot: {
    width: 8, height: 8, borderRadius: 4, marginTop: 7,
    backgroundColor: colors.accent,
  },
  eventTitle: { ...t.body, color: colors.ink, fontWeight: '600' },
  eventMeta: { ...t.small, color: colors.muted, marginTop: 2 },
  edit: {
    minHeight: 44, minWidth: 72, paddingHorizontal: space.sm,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.rule,
  },
  editPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  editText: { ...t.small, color: colors.accent, fontWeight: '700' },
});
