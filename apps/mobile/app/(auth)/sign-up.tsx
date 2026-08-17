import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useApp } from '../../src/state';
import { Button, Field, H1, Muted, Screen } from '../../src/ui/components';
import { colors, space } from '../../src/ui/theme';
import { ApiError, OfflineError } from '../../src/api/client';

/**
 * Five fields and you are in. No OTP, no confirmation email, no waiting —
 * every step between "interested" and "using it" costs signups.
 */
export default function SignUp() {
  const { signUp } = useApp();
  const [f, setF] = useState({
    farm_name: '', full_name: '', email: '', phone: '', password: '',
    address_line: '', city: '', state: '', pincode: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await signUp({ ...f, email: f.email.trim().toLowerCase() });
      router.replace('/(app)/daily');
    } catch (err) {
      if (err instanceof ApiError && err.detail && typeof err.detail === 'object') {
        setErrors(err.detail as Record<string, string>);
        setError(err.message);
      } else {
        setError(err instanceof OfflineError
          ? 'No connection. Creating an account needs internet.'
          : err instanceof ApiError ? err.message : 'Could not create your farm');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg }}>
        <H1>Start your farm</H1>
        <Muted>Free, everything included. No card.</Muted>
        <View style={{ height: space.lg }} />

        <Field label="Farm name" testID="farm_name" value={f.farm_name}
               onChangeText={set('farm_name')} placeholder="Sunrise Rabbitry"
               error={errors.farm_name} />
        <Field label="Your name" testID="full_name" value={f.full_name}
               onChangeText={set('full_name')} placeholder="Ravi" error={errors.full_name} />
        <Field label="Email" testID="email" value={f.email} onChangeText={set('email')}
               autoCapitalize="none" keyboardType="email-address"
               placeholder="you@example.com" error={errors.email} />
        <Field label="Phone" testID="phone" value={f.phone} onChangeText={set('phone')}
               keyboardType="phone-pad" placeholder="+91…" error={errors.phone} />
        <Field label="Password" testID="password" value={f.password}
               onChangeText={set('password')} secureTextEntry
               placeholder="At least 8 characters" error={errors.password} />

        {/* Compulsory like everything above — the server rejects a blank, so
            each field carries its own error rather than leaving a farmer to
            guess which of nine boxes the banner meant. */}
        <Field label="Address" testID="address_line" value={f.address_line}
               onChangeText={set('address_line')} placeholder="Survey no., village"
               error={errors.address_line} />
        <Field label="Town" testID="city" value={f.city} onChangeText={set('city')}
               placeholder="Margao" error={errors.city} />
        <Field label="State" testID="state" value={f.state} onChangeText={set('state')}
               placeholder="Goa" error={errors.state} />
        <Field label="PIN code" testID="pincode" value={f.pincode}
               onChangeText={set('pincode')} keyboardType="number-pad" placeholder="403709"
               error={errors.pincode} />

        {!!error && (
          <Text style={{ color: colors.crit, marginBottom: space.md }} testID="signup-error">
            {error}
          </Text>
        )}

        <Button title="Create my farm" onPress={submit} loading={busy} testID="signup" />
        <View style={{ height: space.md }} />
        <Muted>Free to use. No card, no trial to run out.</Muted>
      </ScrollView>
    </Screen>
  );
}
