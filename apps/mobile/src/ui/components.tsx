import React from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput,
  View, type TextInputProps, type ViewStyle,
} from 'react-native';
import { TAP_MIN, colors, radius, space, type as t, urgencyColor } from './theme';

export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.screen, style]}>{children}</View>;
}

export function H1({ children }: { children: React.ReactNode }) {
  return <Text style={s.h1} accessibilityRole="header">{children}</Text>;
}

export function H2({ children }: { children: React.ReactNode }) {
  return <Text style={s.h2} accessibilityRole="header">{children}</Text>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={s.label}>{String(children).toUpperCase()}</Text>;
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <Text style={s.muted}>{children}</Text>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Button({
  title, onPress, variant = 'primary', disabled, loading, testID,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
}) {
  const bg = variant === 'primary' ? colors.accent
    : variant === 'danger' ? colors.crit : 'transparent';
  const fg = variant === 'ghost' ? colors.accent : colors.white;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        s.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'ghost' && { borderWidth: 1, borderColor: colors.accent },
      ]}
    >
      {loading
        ? <ActivityIndicator color={fg} />
        : <Text style={[s.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({
  label, error, ...props
}: TextInputProps & { label: string; error?: string }) {
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor={colors.muted}
        style={[s.input, !!error && { borderColor: colors.crit }]}
      />
      {!!error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

/**
 * A dropdown, because a phone screen is short and a herd is long. Collapsed it
 * is one row showing what is picked; tapping opens a sheet with the options.
 * No native <select> exists in React Native, so the sheet is a Modal — which
 * also works identically in the web export.
 */
export function Dropdown({ label, value, placeholder, options, onSelect, testID }: {
  label: string;
  value: string | null;
  placeholder: string;
  options: { id: string; label: string; sub?: string }[];
  onSelect: (id: string) => void;
  testID?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const picked = options.find((o) => o.id === value);
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={s.ddTrigger}
      >
        <Text style={[s.ddValue, !picked && { color: colors.muted }]} numberOfLines={1}>
          {picked ? picked.label : placeholder}
        </Text>
        <Text style={s.ddChevron}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade"
             onRequestClose={() => setOpen(false)}>
        <Pressable style={s.ddBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={s.ddSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={s.ddSheetTitle}>{label.toUpperCase()}</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              {options.map((o) => (
                <Pressable
                  key={o.id}
                  testID={testID ? `${testID}-${o.id}` : undefined}
                  onPress={() => { onSelect(o.id); setOpen(false); }}
                  style={[s.ddOption, o.id === value && s.ddOptionOn]}
                >
                  <Text style={[s.ddOptionText,
                    o.id === value && { color: colors.accent, fontWeight: '700' }]}>
                    {o.label}
                  </Text>
                  {!!o.sub && <Text style={s.ddOptionSub}>{o.sub}</Text>}
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/** yyyy-mm-dd in the phone's own timezone. toISOString() is UTC and would
 *  hand back yesterday for any farm east of Greenwich after 05:30 local. */
export const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * A month grid behind a tap, for dates that are usually — but not always —
 * today. A mating written up in the evening, or on Monday for the Saturday it
 * actually happened, has to be recordable as the day it happened: every
 * gestation date the app then quotes is counted off it, so a date that is
 * silently "now" is a wrong palpation date and a wrong nest-box date.
 *
 * Hand-rolled rather than pulled from a package on purpose. A native date
 * module would mean a new APK for a field that is one month grid, and this one
 * behaves identically on the phone and on the web build.
 */
export function DatePicker({ label, value, onSelect, maxDate, minDate, testID }: {
  label: string;
  value: string;                       // yyyy-mm-dd
  onSelect: (iso: string) => void;
  maxDate?: string;
  minDate?: string;
  testID?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const parse = (iso: string) => {
    const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const monthName = (i: number) => MONTHS[i] ?? '';
  const selected = parse(value);
  const [cursor, setCursor] = React.useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));

  // Monday-first, which is how a week is read here.
  const firstDow = (new Date(cursor.getFullYear(), cursor.getMonth(), 1).getDay() + 6) % 7;
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array<null>(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const blocked = (day: number) => {
    const iso = isoDay(new Date(cursor.getFullYear(), cursor.getMonth(), day));
    return (!!maxDate && iso > maxDate) || (!!minDate && iso < minDate);
  };

  const human = (iso: string) => {
    const d = parse(iso);
    const today = isoDay(new Date());
    if (iso === today) return `Today · ${d.getDate()} ${monthName(d.getMonth()).slice(0, 3)}`;
    return `${d.getDate()} ${monthName(d.getMonth()).slice(0, 3)} ${d.getFullYear()}`;
  };

  const step = (months: number) =>
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + months, 1));

  return (
    <View style={{ marginBottom: space.lg }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <Pressable testID={testID} accessibilityRole="button"
                 onPress={() => setOpen(true)} style={s.ddTrigger}>
        <Text style={s.ddValue} numberOfLines={1}>{human(value)}</Text>
        <Text style={s.ddChevron}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade"
             onRequestClose={() => setOpen(false)}>
        <Pressable style={s.ddBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={s.ddSheet} onPress={(e) => e.stopPropagation()}>
            <View style={s.calHead}>
              <Pressable onPress={() => step(-1)} style={s.calNav}
                         testID={testID ? `${testID}-prev` : undefined}
                         accessibilityLabel="Previous month">
                <Text style={s.calNavText}>‹</Text>
              </Pressable>
              <Text style={s.calTitle}>
                {monthName(cursor.getMonth())} {cursor.getFullYear()}
              </Text>
              <Pressable onPress={() => step(1)} style={s.calNav}
                         testID={testID ? `${testID}-next` : undefined}
                         accessibilityLabel="Next month">
                <Text style={s.calNavText}>›</Text>
              </Pressable>
            </View>

            <View style={s.calRow}>
              {DOW.map((d, i) => (
                <Text key={i} style={s.calDow}>{d}</Text>
              ))}
            </View>

            <View style={s.calGrid}>
              {cells.map((day, i) => {
                if (day === null) return <View key={`x${i}`} style={s.calCell} />;
                const iso = isoDay(new Date(cursor.getFullYear(), cursor.getMonth(), day));
                const on = iso === value;
                const off = blocked(day);
                return (
                  <Pressable
                    key={iso}
                    testID={testID ? `${testID}-${iso}` : undefined}
                    disabled={off}
                    onPress={() => { onSelect(iso); setOpen(false); }}
                    style={[s.calCell, on && s.calCellOn, off && s.calCellOff]}
                  >
                    <Text style={[s.calDay, on && s.calDayOn, off && s.calDayOff]}>{day}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Pressable onPress={() => { onSelect(isoDay(new Date())); setOpen(false); }}
                       style={s.calToday}
                       testID={testID ? `${testID}-today` : undefined}>
              <Text style={s.calTodayText}>Today</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/**
 * A coloured dot is never shown on its own — the words always come with it.
 * Colour-blindness is common and a phone screen in sunlight washes colour out
 * entirely, so colour is the accent, not the message.
 */
export function ConditionMark({ colour, label }: { colour: string; label: string }) {
  return (
    <View style={s.markRow}>
      <View style={[s.dot, { backgroundColor: colour }]} />
      <Text style={s.markText}>{label}</Text>
    </View>
  );
}

export function Pill({ text, urgency = 'medium' }: { text: string; urgency?: string }) {
  const c = urgencyColor(urgency);
  return (
    <View style={[s.pill, { backgroundColor: c.bg }]}>
      <Text style={[s.pillText, { color: c.fg }]}>{text}</Text>
    </View>
  );
}

export function Stat({ n, label, tone }: { n: number | string; label: string; tone?: string }) {
  const c = tone ? urgencyColor(tone) : null;
  return (
    <View style={s.stat}>
      <Text style={[s.statN, c && { color: c.fg }]}>{n}</Text>
      <Text style={s.statLabel}>{label.toUpperCase()}</Text>
    </View>
  );
}

export function Banner({ text, tone = 'high' }: { text: string; tone?: string }) {
  const c = urgencyColor(tone);
  return (
    <View style={[s.banner, { backgroundColor: c.bg }]}>
      <Text style={[s.bannerText, { color: c.fg }]}>{text}</Text>
    </View>
  );
}

/**
 * What a support session sees instead of a screen that writes.
 *
 * The server refuses the write anyway — every method that is not a read is
 * blocked for an impersonated session. This exists so the refusal arrives
 * before the typing rather than after it, and so the reason is a sentence
 * rather than an error code.
 */
export function SupportReadOnly({ by }: { by?: string | null }) {
  return (
    <View style={s.screen}>
      <View style={{ padding: space.xl, gap: space.md }}>
        <Text style={s.h1}>Read-only</Text>
        <Text style={s.muted} testID="support-read-only">
          {by ? `${by} is` : 'You are'} viewing this farm to help with a support
          request. Nothing here can be changed — not a mating, not a weight, not
          a password. Ask the farmer to record it, or talk them through it.
        </Text>
      </View>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <View style={s.empty}><Text style={s.emptyText}>{text}</Text></View>;
}

export function Loading() {
  return (
    <View style={s.empty}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  h1: { ...t.h1, color: colors.ink, marginBottom: space.sm },
  h2: { ...t.h2, color: colors.ink, marginBottom: space.sm, marginTop: space.lg },
  label: { ...t.label, color: colors.muted, marginBottom: space.xs },
  muted: { ...t.small, color: colors.muted },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md,
    padding: space.lg,
    marginBottom: space.md,
  },
  button: {
    minHeight: TAP_MIN,
    borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  buttonText: { ...t.title },
  fieldLabel: { ...t.label, color: colors.muted, marginBottom: space.xs },
  ddTrigger: {
    minHeight: TAP_MIN,
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: colors.rule, borderRadius: radius.sm,
    paddingHorizontal: space.md,
    backgroundColor: colors.surface,
  },
  ddValue: { ...t.body, color: colors.ink, flex: 1 },
  ddChevron: { ...t.body, color: colors.muted, marginLeft: space.sm },
  ddBackdrop: {
    flex: 1, backgroundColor: 'rgba(27,33,29,0.45)',
    justifyContent: 'center', padding: space.lg,
  },
  ddSheet: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    paddingVertical: space.sm, maxWidth: 480, width: '100%', alignSelf: 'center',
  },
  ddSheetTitle: {
    ...t.label, color: colors.muted,
    paddingHorizontal: space.lg, paddingVertical: space.sm,
  },

  // --- calendar ---
  calHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: space.md,
  },
  calNav: {
    width: TAP_MIN, height: TAP_MIN, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.md,
  },
  calNavText: { fontSize: 28, lineHeight: 32, color: colors.accent, fontWeight: '600' },
  calTitle: { ...t.title, color: colors.ink },
  calRow: { flexDirection: 'row', paddingHorizontal: space.sm },
  calDow: {
    ...t.label, color: colors.muted, width: `${100 / 7}%`,
    textAlign: 'center', paddingBottom: space.xs,
  },
  calGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: space.sm, paddingBottom: space.sm,
  },
  // Square-ish and full-width-divided-by-seven, so the tap target stays near
  // TAP_MIN on the narrowest phone this runs on.
  calCell: {
    width: `${100 / 7}%`, height: TAP_MIN,
    alignItems: 'center', justifyContent: 'center', borderRadius: radius.md,
  },
  calCellOn: { backgroundColor: colors.accent },
  calCellOff: { opacity: 0.3 },
  calDay: { ...t.body, color: colors.ink },
  calDayOn: { color: colors.white, fontWeight: '700' },
  calDayOff: { color: colors.muted },
  calToday: {
    minHeight: TAP_MIN, alignItems: 'center', justifyContent: 'center',
    borderTopWidth: 1, borderTopColor: colors.rule,
  },
  calTodayText: { ...t.title, color: colors.accent },
  ddOption: {
    minHeight: TAP_MIN, justifyContent: 'center',
    paddingHorizontal: space.lg, paddingVertical: space.sm,
    borderTopWidth: 1, borderTopColor: colors.rule,
  },
  ddOptionOn: { backgroundColor: colors.accentSoft },
  ddOptionText: { ...t.body, color: colors.ink },
  ddOptionSub: { ...t.small, color: colors.muted, marginTop: 2 },
  input: {
    minHeight: TAP_MIN,
    borderWidth: 1, borderColor: colors.rule, borderRadius: radius.sm,
    paddingHorizontal: space.md,
    backgroundColor: colors.surface,
    color: colors.ink,
    ...t.body,
  },
  error: { ...t.small, color: colors.crit, marginTop: space.xs },
  markRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 11, height: 11, borderRadius: 6 },
  markText: { ...t.small, color: colors.ink, fontWeight: '600' },
  pill: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  pillText: { fontSize: 12, fontWeight: '600' },
  stat: { minWidth: 90 },
  statN: { ...t.number, color: colors.ink, fontVariant: ['tabular-nums'] },
  statLabel: { ...t.label, color: colors.muted, marginTop: space.xs },
  banner: { padding: space.md, borderRadius: radius.sm, marginBottom: space.md },
  bannerText: { ...t.small, fontWeight: '600' },
  empty: { padding: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: colors.muted, textAlign: 'center' },
});
