import React from 'react';
import { Redirect } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { useApp } from '../src/state';
import { colors } from '../src/ui/theme';

export default function Index() {
  const { ready, session } = useApp();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center',
                     backgroundColor: colors.ground }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  // Daily is the landing screen, not a dashboard. Open the app and the work is
  // already in front of you.
  return <Redirect href={session ? '/(app)/daily' : '/(auth)/sign-in'} />;
}
