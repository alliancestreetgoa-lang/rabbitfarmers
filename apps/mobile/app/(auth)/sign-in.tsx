import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Link, router } from 'expo-router';
import { useApp } from '../../src/state';
import { Button, Field, H1, Muted, Screen } from '../../src/ui/components';
import { colors, space } from '../../src/ui/theme';
import { ApiError, OfflineError } from '../../src/api/client';

export default function SignIn() {
  const { signIn } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      router.replace('/(app)/daily');
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
        <H1>Rabbitry</H1>
        <Muted>Breeding, medicine rounds and staff, from the shed.</Muted>

        <View style={{ height: space.xl }} />

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
            New here? Start a 30-day free trial
          </Text>
        </Link>
      </ScrollView>
    </Screen>
  );
}
