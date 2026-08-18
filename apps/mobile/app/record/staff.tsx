import React, { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp, useQuery } from '../../src/state';
import {
  Button, Field, H1, H2, Loading, Muted, Screen, SupportReadOnly,
} from '../../src/ui/components';
import { colors, radius, space, type as t } from '../../src/ui/theme';
import type { StaffRole } from '../../src/api/types';

const ROLES: { value: StaffRole; label: string; blurb: string }[] = [
  { value: 'caretaker', label: 'Farm hand',
    blurb: 'Records matings, kindlings, weights and health. Cannot see the team.' },
  { value: 'manager', label: 'Manager',
    blurb: 'Everything a farm hand can, plus the team and attendance.' },
  { value: 'vet', label: 'Vet',
    blurb: 'Reads every animal record, writes health only.' },
  { value: 'accountant', label: 'Accountant',
    blurb: 'Attendance and what the farm pays. No animal records.' },
  { value: 'owner', label: 'Owner',
    blurb: 'Everything, including settings and billing.' },
];

const rupees = (n: string | number | null | undefined) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')}`;

const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

/**
 * What they are paid, month by month from attendance, and every change ever
 * made. Owner only — the server refuses everybody else, this screen simply
 * does not appear for them.
 */
function SalarySection({ personId }: { personId: string }) {
  const { client } = useApp();
  const pay = useQuery(`salary-${personId}`, () => client.staffSalary(personId), [personId]);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await client.setStaffSalary(personId, { monthly_salary: Number(amount) });
      setAmount('');
      await pay.reload();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const payslip = async (month: string) => {
    // Only the browser build can hand over a file; the phone app shows the
    // numbers and the web dashboard prints the slips.
    setBusy(true); setErr(null);
    try {
      const blob = await client.payslipBlob(personId, month);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `payslip-${month}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const d = pay.data;
  return (
    <>
      <H2>Salary</H2>
      {!d && pay.loading && <Loading />}
      {d && (
        <>
          <Muted>
            {d.current
              ? `${rupees(d.current.monthly_amount)} a month, since ${new Date(d.current.effective_from).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.`
              : 'No salary set yet.'}
          </Muted>
          <View style={{ height: space.sm }} />
          <Field label={d.current ? 'Change to (₹ / month)' : 'Set salary (₹ / month)'}
                 testID="salary-amount" value={amount} onChangeText={setAmount}
                 keyboardType="numeric" placeholder="8000" />
          <Button title={d.current ? 'Change salary' : 'Set salary'} variant="ghost"
                  onPress={save} loading={busy} disabled={!amount.trim()}
                  testID="salary-save" />

          <H2>Pay, month by month</H2>
          <Muted>
            Present and half days count, farm holidays are paid, absence and
            leave are not. Salary × days paid ÷ days in the month.
          </Muted>
          <View style={{ height: space.sm }} />
          {d.months.map((m) => (
            <View key={m.month} style={sal.row}>
              <View style={{ flex: 1 }}>
                <Text style={sal.month}>{monthName(m.month)}</Text>
                <Text style={sal.detail}>
                  {m.paid_days} of {m.days_in_month} days paid
                  {Number(m.absent) ? ` · ${m.absent} absent` : ''}
                  {Number(m.leave) ? ` · ${m.leave} leave` : ''}
                </Text>
              </View>
              <Text style={sal.amount}>{rupees(m.amount)}</Text>
              {Platform.OS === 'web' && m.amount != null && (
                <Pressable onPress={() => payslip(m.month)} disabled={busy}
                           testID={`payslip-${m.month}`}>
                  <Text style={sal.pdf}>PDF</Text>
                </Pressable>
              )}
            </View>
          ))}

          {d.history.length > 1 && (
            <>
              <H2>Salary changes</H2>
              {d.history.map((h) => (
                <Muted key={h.id}>
                  {rupees(h.monthly_amount)} from{' '}
                  {new Date(h.effective_from).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                  {h.set_by_name ? ` · set by ${h.set_by_name}` : ''}
                </Muted>
              ))}
            </>
          )}
        </>
      )}
      {!!err && <Text style={{ color: colors.crit, marginTop: space.sm }}>{err}</Text>}
    </>
  );
}

const sal = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.rule,
    borderRadius: radius.md, padding: space.md, marginBottom: space.sm,
  },
  month: { ...t.title, color: colors.ink },
  detail: { ...t.small, color: colors.muted, marginTop: 2 },
  amount: { ...t.title, color: colors.ink, fontWeight: '700' },
  pdf: { ...t.body, color: colors.accent, fontWeight: '700', padding: space.sm },
});

export default function StaffRecord() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { client, readOnly, session } = useApp();

  const staff = useQuery('staff-all', () => client.staff('all'), []);
  const sheds = useQuery('sheds', () => client.sheds(), []);
  const existing = staff.data?.staff.find((p) => p.id === id);

  const isOwner = session?.user?.role === 'owner';
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [salary, setSalary] = useState('');
  const [role, setRole] = useState<StaffRole>('caretaker');
  const [shedIds, setShedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handover, setHandover] = useState<{ phone: string; password: string } | null>(null);

  useEffect(() => {
    if (!existing) return;
    setName(existing.full_name);
    setPhone(existing.phone);
    setRole(existing.role);
    setShedIds(existing.shed_ids ?? []);
  }, [existing?.id]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await client.editStaff(existing.id, {
          full_name: name.trim(), phone: phone.trim(), role, shed_ids: shedIds,
        });
      } else {
        await client.addStaff({
          full_name: name.trim(), phone: phone.trim(), role, shed_ids: shedIds,
          ...(isOwner && salary.trim() !== '' ? { monthly_salary: Number(salary) } : {}),
        } as never);
      }
      await staff.reload();
      router.back();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const giveLogin = async () => {
    if (!existing) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.giveLogin(existing.id);
      setHandover({ phone: r.staff.phone, password: r.temporary_password });
      await staff.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (is_active: boolean) => {
    if (!existing) return;
    setBusy(true);
    setError(null);
    try {
      await client.editStaff(existing.id, { is_active } as never);
      await staff.reload();
      router.back();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (readOnly) return <SupportReadOnly by={session?.support?.by} />;
  if (id && staff.loading && !staff.data) return <Screen><Loading /></Screen>;

  // Shown once and never again — the whole reason this screen has a state.
  if (handover) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ padding: space.lg }}>
          <H1>Read this to them</H1>
          <View style={s.handover}>
            <Text style={s.label}>THEY SIGN IN WITH</Text>
            <Text style={s.big} testID="handover-phone">{handover.phone}</Text>
            <View style={{ height: space.md }} />
            <Text style={s.label}>PASSWORD</Text>
            <Text style={s.big} testID="handover-password">{handover.password}</Text>
          </View>
          <Muted>
            It is not shown again — it is stored scrambled, so nobody can read it
            back, not even from the admin console. They can change it from More
            once they are in. If it gets lost, set a new one from here.
          </Muted>
          <View style={{ height: space.lg }} />
          <Button title="Done" onPress={() => router.back()} testID="handover-done" />
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <H1>{existing ? existing.full_name : 'Add somebody'}</H1>

        <Field label="Name" testID="staff-name" value={name} onChangeText={setName}
               placeholder="Ravi Naik" />
        <Field
          label="Phone"
          testID="staff-phone"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          placeholder="+91…"
        />
        <Muted>This is what they sign in with. No email needed.</Muted>

        {!existing && isOwner && (
          <>
            <Field label="Monthly salary (₹)" testID="staff-salary" value={salary}
                   onChangeText={setSalary} keyboardType="numeric" placeholder="8000" />
            <Muted>
              Their payslip each month is worked out from this and their attendance.
            </Muted>
          </>
        )}

        <H2>What they can do</H2>
        {ROLES.map((r) => (
          <Pressable
            key={r.value}
            testID={`role-${r.value}`}
            style={[s.role, role === r.value && s.roleOn]}
            onPress={() => setRole(r.value)}
          >
            <Text style={[s.roleName, role === r.value && { color: colors.accent }]}>
              {r.label}
            </Text>
            <Text style={s.roleBlurb}>{r.blurb}</Text>
          </Pressable>
        ))}

        {(sheds.data?.sheds.length ?? 0) > 0 && (
          <>
            <H2>Sheds they look after</H2>
            <Muted>Work for an animal in these lands on their list on its own.</Muted>
            <View style={s.chips}>
              {(sheds.data?.sheds ?? []).map((shed) => {
                const on = shedIds.includes(shed.id);
                return (
                  <Pressable
                    key={shed.id}
                    testID={`shed-${shed.id}`}
                    style={[s.chip, on && s.chipOn]}
                    onPress={() => setShedIds(on
                      ? shedIds.filter((x) => x !== shed.id)
                      : [...shedIds, shed.id])}
                  >
                    <Text style={[s.chipText, on && { color: colors.accent }]}>
                      {shed.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}

        {!!error && (
          <Text style={{ color: colors.crit, marginTop: space.md }} testID="staff-error">
            {error}
          </Text>
        )}

        <View style={{ height: space.lg }} />
        <Button title={existing ? 'Save' : 'Add them'} onPress={save}
                loading={busy} disabled={!name.trim() || !phone.trim()} testID="staff-save" />

        {existing && isOwner && <SalarySection personId={existing.id} />}

        {existing && (
          <>
            <H2>Signing in</H2>
            <Muted>
              {existing.can_sign_in
                ? 'They have a login. Setting a new password signs them out everywhere.'
                : 'They cannot sign in yet. Plenty of staff never need to — a manager can mark their attendance instead.'}
            </Muted>
            <View style={{ height: space.sm }} />
            <Button
              title={existing.can_sign_in ? 'Set a new password' : 'Give them a login'}
              variant="ghost" onPress={giveLogin} loading={busy} testID="give-login" />

            {existing.is_active ? (
              <>
                <View style={{ height: space.xl }} />
                <Button title="They have left the farm" variant="danger"
                        onPress={() => setActive(false)} testID="deactivate" />
                <Muted>
                  Nothing is deleted — their name stays on everything they recorded.
                  It ends their sessions and takes them off the list.
                </Muted>
              </>
            ) : (
              <>
                <View style={{ height: space.xl }} />
                <Button title="They are back" variant="ghost"
                        onPress={() => setActive(true)} testID="reactivate" />
              </>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  role: {
    borderWidth: 1, borderColor: colors.rule, borderRadius: radius.md,
    padding: space.md, marginBottom: space.sm, backgroundColor: colors.surface,
  },
  roleOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  roleName: { ...t.title, color: colors.ink },
  roleBlurb: { ...t.small, color: colors.muted, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  chip: {
    borderWidth: 1, borderColor: colors.rule, borderRadius: radius.sm,
    paddingVertical: space.sm, paddingHorizontal: space.md, backgroundColor: colors.surface,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { ...t.body, color: colors.ink },
  handover: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.accent,
    borderRadius: radius.md, padding: space.lg, marginVertical: space.lg,
  },
  label: { ...t.label, color: colors.muted },
  big: { ...t.h2, color: colors.ink, marginTop: 4 },
});
