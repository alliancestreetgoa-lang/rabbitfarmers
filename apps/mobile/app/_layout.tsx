import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppProvider } from '../src/state';
import { colors } from '../src/ui/theme';

export default function RootLayout() {
  return (
    <AppProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.ground },
          headerTintColor: colors.ink,
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: colors.ground },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)/sign-in" options={{ title: 'Sign in' }} />
        <Stack.Screen name="(auth)/sign-up" options={{ title: 'Create your farm' }} />
        <Stack.Screen name="(app)/home" options={{ title: 'Home' }} />
        <Stack.Screen name="(app)/daily" options={{ title: 'Today' }} />
        <Stack.Screen name="(app)/health" options={{ title: 'Report a sick rabbit' }} />
        <Stack.Screen name="(app)/sick" options={{ title: 'Sick rabbit' }} />
        <Stack.Screen name="(app)/rabbit-health" options={{ title: 'Health record' }} />
        <Stack.Screen name="(app)/attendance" options={{ title: 'Attendance' }} />
        <Stack.Screen name="(app)/litters" options={{ title: 'Litters & kits' }} />
        <Stack.Screen name="(app)/herd" options={{ title: 'Herd' }} />
        <Stack.Screen name="(app)/breeding" options={{ title: 'Breeding' }} />
        <Stack.Screen name="(app)/more" options={{ title: 'More' }} />
        <Stack.Screen name="(app)/team" options={{ title: 'Team' }} />
        <Stack.Screen name="(app)/animal" options={{ title: 'Rabbit' }} />
        <Stack.Screen name="record/mating" options={{ title: 'Record a mating' }} />
        <Stack.Screen name="record/kindling" options={{ title: 'Record a kindling' }} />
        <Stack.Screen name="record/condition" options={{ title: 'Report a problem' }} />
        <Stack.Screen name="record/animal" options={{ title: 'Add a rabbit' }} />
        <Stack.Screen name="record/status" options={{ title: 'Leaving the herd' }} />
        <Stack.Screen name="record/kits" options={{ title: 'Add the kits' }} />
        <Stack.Screen name="record/edit-animal" options={{ title: 'Edit' }} />
        <Stack.Screen name="record/weaning" options={{ title: 'Separate the kits' }} />
        <Stack.Screen name="record/staff" options={{ title: 'Somebody on the farm' }} />
      </Stack>
    </AppProvider>
  );
}
