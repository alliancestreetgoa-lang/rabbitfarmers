import React from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View,
  type TextInputProps, type ViewStyle,
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
