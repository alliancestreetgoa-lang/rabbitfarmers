import React, { useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import { Link, router } from 'expo-router';
import { useApp } from '../../src/state';
import { Button, Field, H1, Muted, Screen } from '../../src/ui/components';
import { colors, space } from '../../src/ui/theme';
import { ApiError, OfflineError } from '../../src/api/client';

export default function SignIn() {
  const { signIn, serverUrl, canSetServer, setServerUrl } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState(serverUrl);
  const [serverBusy, setServerBusy] = useState(false);
  const [serverNote, setServerNote] = useState<string | null>(null);

  const saveServer = async () => {
    setServerBusy(true);
    setServerNote(null);
    try {
      await setServerUrl(server);
      setServerNote('Connected.');
    } catch (err) {
      setServerNote((err as Error).message);
    } finally {
      setServerBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      router.replace('/(app)/home');
    } catch (err) {
      setError(
        err instanceof OfflineError
          ? 'No connection. Signing in needs internet — once you are in, the app works without it.'
          : err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.xxl }}>
        <Image
          source={require('../../assets/logo.png')}
          style={{ width: 280, height: 186, alignSelf: 'center' }}
          resizeMode="contain"
          accessibilityLabel="rabbitfarmers"
        />
        <Muted>Breeding, medicine rounds and staff, from the shed.</Muted>

        <View style={{ height: space.xl }} />

        {/*
          Only on an installed app that was built without an address. The web
          build knows it from the origin that served it, and an APK built with
          EXPO_PUBLIC_API_URL set never shows this either. It is here so a build
          without one is usable instead of silently unable to reach anything.
        */}
        {canSetServer && (
          <>
            <Field
              label="Your rabbitfarmers address"
              testID="server"
              value={server}
              onChangeText={setServer}
              autoCapitalize="none"
              keyboardType="url"
              placeholder="https://yourfarm.netlify.app"
            />
            <Button title="Connect" onPress={saveServer} loading={serverBusy}
                    variant="ghost" testID="connect" />
            {!!serverNote && (
              <Text style={{ color: colors.muted, marginTop: space.sm }} testID="server-note">
                {serverNote}
              </Text>
            )}
            <View style={{ height: space.xl }} />
          </>
        )}

        <Field
          label="Email"
          testID="email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@example.com"
        />
        <Field
          label="Password"
          testID="password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          placeholder="Your password"
        />

        {!!error && (
          <Text style={{ color: colors.crit, marginBottom: space.md }} testID="signin-error">
            {error}
          </Text>
        )}

        <Button title="Sign in" onPress={submit} loading={busy} testID="signin" />

        <View style={{ height: space.xl }} />
        <Link href="/(auth)/sign-up" testID="go-signup">
          <Text style={{ color: colors.accent, fontWeight: '600' }}>
            Sign up
          </Text>
        </Link>
      </ScrollView>
    </Screen>
  );
}
