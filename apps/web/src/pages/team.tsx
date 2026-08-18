'use client';

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPatch, apiPost, getSession } from '@/lib/api';
import {
  Shell, useIdentity, PageTitle, Section, Table, Empty, Btn, Input, Select,
} from '@/components/ui/shell';

interface Person {
  id: string; full_name: string; phone: string | null; role: string;
  is_active: boolean; can_sign_in: boolean; sheds: string | null;
  today_status: string | null; today_checked_in_at: string | null;
  monthly_salary: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', manager: 'Manager', caretaker: 'Farm hand',
  vet: 'Vet', accountant: 'Accountant',
};

const rupees = (n: string | number | null | undefined) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')}`;

export function TeamPage() {
  const id = useIdentity();
  const isOwner = id.userRole === 'owner';
  const [staff, setStaff] = useState<Person[] | null>(null);
  const [past, setPast] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ full_name: '', phone: '', role: 'caretaker', monthly_salary: '' });
  const [oneTime, setOneTime] = useState<{ name: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = (which = past) => apiGet<{ staff: Person[] }>(`/staff?include=${which ? 'past' : 'active'}`)
    .then((d) => setStaff(d.staff)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [past]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy('add'); setError(null);
    try {
      await apiPost('/staff', {
        full_name: form.full_name, phone: form.phone, role: form.role,
        ...(isOwner && form.monthly_salary !== ''
          ? { monthly_salary: Number(form.monthly_salary) } : {}),
      });
      setForm({ full_name: '', phone: '', role: 'caretaker', monthly_salary: '' });
      setShowAdd(false);
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  };

  const giveLogin = async (p: Person) => {
    setBusy(p.id); setError(null); setOneTime(null);
    try {
      const res = await apiPost<{ temporary_password: string }>(`/staff/${p.id}/login`);
      setOneTime({ name: p.full_name, password: res.temporary_password });
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  };

  const head = ['Name', 'Role', 'Phone', ...(isOwner ? ['Salary'] : []), 'Sheds', 'Today', 'Login'];

  return (
    <Shell {...id}>
      <PageTitle title="Team" sub={staff ? `${staff.length} on the farm` : undefined} />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}

      {oneTime && (
        <div className="mb-5 rounded-xl border border-farm-accent-soft bg-farm-accent-soft/50 p-4">
          <p className="text-sm font-bold">{oneTime.name} can now sign in with their phone number.</p>
          <p className="mt-1 text-sm">
            One-time password — shown exactly once, so pass it on now:{' '}
            <code className="rounded bg-farm-surface px-2 py-0.5 font-bold">{oneTime.password}</code>
          </p>
          <div className="mt-2"><Btn tone="quiet" onClick={() => setOneTime(null)}>I've passed it on</Btn></div>
        </div>
      )}

      <div className="mb-4 flex justify-end gap-3">
        <Btn tone="quiet" onClick={() => setPast((p) => !p)}>
          {past ? 'Back to the team' : 'People who left'}
        </Btn>
        <Btn onClick={() => setShowAdd((s) => !s)} tone={showAdd ? 'quiet' : 'accent'}>
          {showAdd ? 'Cancel' : 'Add a person'}
        </Btn>
      </div>

      {showAdd && (
        <form onSubmit={add}
          className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-farm-rule bg-farm-surface p-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Name</span>
            <Input required value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Ravi" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Phone</span>
            <Input required value={form.phone} placeholder="+91…"
              onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Role</span>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="caretaker">Farm hand</option>
              <option value="manager">Manager</option>
              <option value="vet">Vet</option>
              <option value="accountant">Accountant</option>
            </Select>
          </label>
          {isOwner && (
            <label className="text-sm">
              <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Monthly salary (₹)</span>
              <Input required type="number" min={0} step="any" value={form.monthly_salary}
                placeholder="8000" className="w-36"
                onChange={(e) => setForm({ ...form, monthly_salary: e.target.value })} />
            </label>
          )}
          <Btn type="submit" disabled={busy === 'add'}>{busy === 'add' ? 'Adding…' : 'Add'}</Btn>
        </form>
      )}

      {staff && staff.length === 0 && <Empty>{past ? 'Nobody has left.' : 'Just you so far.'}</Empty>}
      {staff && staff.length > 0 && (
        <>
          <Table head={head}>
            {staff.map((p) => (
              <tr key={p.id} className="border-b border-farm-rule last:border-0">
                <td className="px-4 py-2.5 font-semibold">
                  {isOwner
                    ? <Link className="text-farm-accent hover:underline" to={`/dashboard/team/${p.id}`}>{p.full_name}</Link>
                    : p.full_name}
                </td>
                <td className="px-4 py-2.5">{ROLE_LABEL[p.role] ?? p.role}</td>
                <td className="px-4 py-2.5">{p.phone ?? '—'}</td>
                {isOwner && <td className="px-4 py-2.5">{rupees(p.monthly_salary)}</td>}
                <td className="px-4 py-2.5">{p.sheds ?? '—'}</td>
                <td className="px-4 py-2.5">
                  {p.today_checked_in_at
                    ? `in since ${new Date(p.today_checked_in_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
                    : p.today_status ?? '—'}
                </td>
                <td className="px-4 py-2.5">
                  {p.can_sign_in
                    ? <span className="text-farm-accent">has one</span>
                    : p.role === 'owner'
                      ? '—'
                      : <Btn tone="quiet" disabled={busy === p.id} onClick={() => giveLogin(p)}>
                          {busy === p.id ? '…' : 'Give a login'}
                        </Btn>}
                </td>
              </tr>
            ))}
          </Table>
          {isOwner && (
            <p className="mt-3 text-sm text-farm-muted">
              Click a name to edit them — role, phone, salary, a new password, payslip PDFs.
            </p>
          )}
        </>
      )}
    </Shell>
  );
}

/* ----------------------------------------------------------- salary page -- */

interface PayMonth {
  month: string; days_in_month: number; present: number; half_days: number;
  holiday: number; absent: number; leave: number;
  monthly_amount: string | null; paid_days: string; amount: string | null;
}
interface SalaryData {
  person: { id: string; full_name: string; phone: string | null; role: string;
            joined_on: string | null; is_active: boolean; can_sign_in: boolean };
  current: { monthly_amount: string; effective_from: string } | null;
  history: { id: string; monthly_amount: string; effective_from: string; created_at: string; set_by_name: string | null }[];
  months: PayMonth[];
}

const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

/** One person's pay: what they are on, every month's slip, every change. */
export function TeamPersonPage() {
  const id = useIdentity();
  const navigate = useNavigate();
  const { personId } = useParams<{ personId: string }>();
  const [data, setData] = useState<SalaryData | null>(null);
  const [profile, setProfile] = useState({ full_name: '', phone: '', role: 'caretaker' });
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [oneTime, setOneTime] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => apiGet<SalaryData>(`/staff/${personId}/salary`)
    .then((d) => {
      setData(d);
      setProfile({ full_name: d.person.full_name, phone: d.person.phone ?? '', role: d.person.role });
    })
    .catch((e) => setError(e.message));
  useEffect(() => { load(); }, [personId]);

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy('profile'); setError(null);
    try {
      await apiPatch(`/staff/${personId}`, {
        full_name: profile.full_name.trim(), phone: profile.phone.trim(), role: profile.role,
      });
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  };

  const newPassword = async () => {
    setBusy('password'); setError(null); setOneTime(null);
    try {
      const res = await apiPost<{ temporary_password: string }>(`/staff/${personId}/login`);
      setOneTime(res.temporary_password);
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  };

  const setActive = async (is_active: boolean) => {
    setBusy('active'); setError(null);
    try {
      await apiPatch(`/staff/${personId}`, { is_active });
      if (!is_active) { navigate('/dashboard/team'); return; }
      setArmed(false);
      await load();
    } catch (err) { setError((err as Error).message); setArmed(false); }
    finally { setBusy(null); }
  };

  const setSalary = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy('set'); setError(null);
    try {
      await apiPost(`/staff/${personId}/salary`, {
        monthly_salary: Number(amount),
        ...(from ? { effective_from: from } : {}),
      });
      setAmount(''); setFrom('');
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  };

  const payslip = async (m: PayMonth) => {
    setBusy(m.month); setError(null);
    try {
      const session = getSession();
      const res = await fetch(`/api/staff/${personId}/payslip?month=${m.month}`, {
        headers: session ? { authorization: `Bearer ${session.token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'Could not make the payslip');
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `payslip-${data?.person.full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${m.month}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <Shell {...id}>
      <div className="mb-2">
        <Link to="/dashboard/team" className="text-sm font-semibold text-farm-accent hover:underline">← Team</Link>
      </div>
      <PageTitle
        title={data ? data.person.full_name : 'Salary'}
        sub={data ? `${ROLE_LABEL[data.person.role] ?? data.person.role}${data.person.phone ? ` · ${data.person.phone}` : ''}` : undefined}
      />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}

      {oneTime && data && (
        <div className="mb-5 rounded-xl border border-farm-accent-soft bg-farm-accent-soft/50 p-4">
          <p className="text-sm font-bold">
            {data.person.full_name} signs in with {data.person.phone} and this password.
          </p>
          <p className="mt-1 text-sm">
            Shown exactly once, so pass it on now:{' '}
            <code className="rounded bg-farm-surface px-2 py-0.5 font-bold">{oneTime}</code>
          </p>
          <div className="mt-2"><Btn tone="quiet" onClick={() => setOneTime(null)}>I've passed it on</Btn></div>
        </div>
      )}

      {data && (
        <>
          {!data.person.is_active && (
            <p className="mb-5 rounded-xl bg-farm-surface-alt px-4 py-3 text-sm font-medium">
              They have left the farm. Their records stay; you can bring them back below.
            </p>
          )}

          <Section title="Who they are">
            <form onSubmit={saveProfile}
              className="flex flex-wrap items-end gap-3 rounded-xl border border-farm-rule bg-farm-surface p-4">
              <label className="text-sm">
                <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Name</span>
                <Input required value={profile.full_name}
                  onChange={(e) => setProfile({ ...profile, full_name: e.target.value })} />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Phone (their sign-in)</span>
                <Input required value={profile.phone}
                  onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Role</span>
                <Select value={profile.role}
                  onChange={(e) => setProfile({ ...profile, role: e.target.value })}>
                  <option value="caretaker">Farm hand</option>
                  <option value="manager">Manager</option>
                  <option value="vet">Vet</option>
                  <option value="accountant">Accountant</option>
                  <option value="owner">Owner</option>
                </Select>
              </label>
              <Btn type="submit" disabled={busy === 'profile'}>
                {busy === 'profile' ? 'Saving…' : 'Save changes'}
              </Btn>
            </form>
          </Section>

          <Section title="Signing in">
            <div className="flex flex-wrap items-center gap-4 rounded-xl border border-farm-rule bg-farm-surface px-4 py-3">
              <p className="flex-1 text-sm">
                {data.person.can_sign_in
                  ? 'They have a login. A new password signs them out everywhere first.'
                  : 'They cannot sign in yet — plenty of staff never need to.'}
              </p>
              <Btn tone="quiet" disabled={busy === 'password'} onClick={newPassword}>
                {busy === 'password' ? '…'
                  : data.person.can_sign_in ? 'Set a new password' : 'Give them a login'}
              </Btn>
            </div>
          </Section>

          <Section title="Salary">
            <div className="flex flex-wrap items-end gap-6 rounded-xl border border-farm-rule bg-farm-surface p-4">
              <div>
                <p className="text-xs font-bold text-farm-muted uppercase">Now</p>
                <p className="font-display text-3xl">{rupees(data.current?.monthly_amount)}
                  <span className="ml-1 text-sm text-farm-muted">/ month</span></p>
                {data.current && (
                  <p className="text-xs text-farm-muted">
                    since {new Date(data.current.effective_from).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </p>
                )}
              </div>
              <form onSubmit={setSalary} className="flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">
                    {data.current ? 'Change to (₹ / month)' : 'Set salary (₹ / month)'}
                  </span>
                  <Input required type="number" min={0} step="any" value={amount}
                    placeholder="8000" className="w-36" onChange={(e) => setAmount(e.target.value)} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">From</span>
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <Btn type="submit" disabled={busy === 'set'}>{busy === 'set' ? 'Saving…' : 'Save'}</Btn>
              </form>
            </div>
            <p className="mt-2 text-xs text-farm-muted">
              Pay is worked out from attendance: present and half days count, farm holidays are paid,
              absence and leave are not. Monthly salary × days paid ÷ days in the month.
            </p>
          </Section>

          <Section title="Month by month">
            {data.months.length === 0
              ? <Empty>Nothing yet.</Empty>
              : (
                <Table head={['Month', 'Present', 'Half', 'Holiday', 'Absent', 'Days paid', 'Payable', 'Payslip']}>
                  {data.months.map((m) => (
                    <tr key={m.month} className="border-b border-farm-rule last:border-0">
                      <td className="px-4 py-2.5 font-semibold">{monthName(m.month)}</td>
                      <td className="px-4 py-2.5">{m.present}</td>
                      <td className="px-4 py-2.5">{m.half_days}</td>
                      <td className="px-4 py-2.5">{m.holiday}</td>
                      <td className="px-4 py-2.5">{m.absent}</td>
                      <td className="px-4 py-2.5">{m.paid_days} of {m.days_in_month}</td>
                      <td className="px-4 py-2.5 font-semibold">{rupees(m.amount)}</td>
                      <td className="px-4 py-2.5">
                        <Btn tone="quiet" disabled={busy === m.month || m.amount == null}
                          onClick={() => payslip(m)}>
                          {busy === m.month ? '…' : 'PDF'}
                        </Btn>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
          </Section>

          <Section title="Salary changes">
            {data.history.length === 0
              ? <Empty>No salary set yet — set one above.</Empty>
              : (
                <Table head={['From', 'Monthly salary', 'Set by', 'On']}>
                  {data.history.map((h) => (
                    <tr key={h.id} className="border-b border-farm-rule last:border-0">
                      <td className="px-4 py-2.5">{new Date(h.effective_from).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                      <td className="px-4 py-2.5 font-semibold">{rupees(h.monthly_amount)}</td>
                      <td className="px-4 py-2.5">{h.set_by_name ?? '—'}</td>
                      <td className="px-4 py-2.5">{new Date(h.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                    </tr>
                  ))}
                </Table>
              )}
          </Section>

          <Section title="Leaving the farm">
            <div className="flex flex-wrap items-center gap-4 rounded-xl border border-farm-rule bg-farm-surface px-4 py-3">
              {data.person.is_active ? (
                <>
                  <p className="flex-1 text-sm">
                    Nothing is deleted — their name stays on everything they recorded.
                    It ends their sessions and takes them off the team.
                  </p>
                  {!armed ? (
                    <Btn tone="crit" onClick={() => setArmed(true)}>They have left the farm</Btn>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Btn tone="crit" disabled={busy === 'active'} onClick={() => setActive(false)}>
                        {busy === 'active' ? '…' : `Yes, remove ${data.person.full_name.split(' ')[0]}`}
                      </Btn>
                      <Btn tone="quiet" onClick={() => setArmed(false)}>Cancel</Btn>
                    </span>
                  )}
                </>
              ) : (
                <>
                  <p className="flex-1 text-sm">Back on the farm? This puts them back on the team.</p>
                  <Btn disabled={busy === 'active'} onClick={() => setActive(true)}>
                    {busy === 'active' ? '…' : 'They are back'}
                  </Btn>
                </>
              )}
            </div>
          </Section>
        </>
      )}
    </Shell>
  );
}
