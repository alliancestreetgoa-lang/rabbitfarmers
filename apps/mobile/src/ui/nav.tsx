import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useApp } from '../state';
import { TAP_MIN, colors, space, type as t } from './theme';

const TABS = [
  { href: '/(app)/daily', label: 'Today', match: 'daily' },
  { href: '/(app)/breeding', label: 'Breeding', match: 'breeding' },
  { href: '/(app)/herd', label: 'Herd', match: 'herd' },
  { href: '/(app)/more', label: 'More', match: 'more' },
] as const;

/**
 * A plain bottom bar rather than a tab navigator: four destinations, always
 * visible, no gestures to learn. Today is first because that is where the app
 * opens and where the work is.
 */
export function TabBar() {
  const path = usePathname();
  const { pending, offline, session } = useApp();
  const queued = pending.filter((p) => !p.failed).length;
  const support = session?.support ?? null;

  return (
    <View>
      {/*
        A stranger is looking at this farm. It says so on every screen, for as
        long as it is true, in the place the farmer's eye already goes for the
        sync status. The notification the console writes can be missed; a strip
        across the bottom of every screen cannot.
      */}
      {support && (
        <View style={[s.strip, s.stripSupport]}>
          <Text style={s.stripText} testID="support-strip">
            Support view · {support.by} · read-only
          </Text>
        </View>
      )}
      {(offline || queued > 0) && (
        <View style={[s.strip, offline ? s.stripOffline : s.stripQueued]}>
          <Text style={s.stripText} testID="sync-strip">
            {offline
              ? `No signal — ${queued} change${queued === 1 ? '' : 's'} saved on this phone`
              : `Sending ${queued} change${queued === 1 ? '' : 's'}…`}
          </Text>
        </View>
      )}
      <View style={s.bar}>
        {TABS.map((tab) => {
          const active = path.includes(tab.match);
          return (
            <Pressable
              key={tab.href}
              testID={`tab-${tab.match}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => router.replace(tab.href as never)}
              style={s.tab}
            >
              <Text style={[s.tabText, active && s.tabTextActive]}>{tab.label}</Text>
              {active && <View style={s.tabMark} />}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1, borderTopColor: colors.rule,
    backgroundColor: colors.surface,
  },
  tab: {
    flex: 1, minHeight: TAP_MIN,
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: space.sm,
  },
  tabText: { ...t.small, color: colors.muted, fontWeight: '600' },
  tabTextActive: { color: colors.accent },
  tabMark: {
    height: 2, width: 24, backgroundColor: colors.accent, marginTop: 4, borderRadius: 2,
  },
  strip: { paddingVertical: space.sm, paddingHorizontal: space.lg },
  stripOffline: { backgroundColor: colors.warnSoft },
  stripQueued: { backgroundColor: colors.accentSoft },
  stripSupport: { backgroundColor: colors.critSoft },
  stripText: { ...t.small, fontWeight: '600', color: colors.ink, textAlign: 'center' },
});
