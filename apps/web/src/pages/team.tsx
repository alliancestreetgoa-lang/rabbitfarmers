'use client';

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiGet, apiPost, getSession } from '@/lib/api';
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
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ full_name: '', phone: '', role: 'caretaker', monthly_salary: '' });
  const [oneTime, setOneTime] = useState<{ name: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => apiGet<{ staff: Person[] }>('/staff')
    .then((d) => setStaff(d.staff)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

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

      <div className="mb-4 flex justify-end">
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

      {staff && staff.length === 0 && <Empty>Just you so far.</Empty>}
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
              Click a name for their salary, monthly pay from attendance, and payslip PDFs.
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
  person: { id: string; full_name: string; phone: string | null; role: string; joined_on: string | null };
  current: { monthly_amount: string; effective_from: string } | null;
  history: { id: string; monthly_amount: string; effective_from: string; created_at: string; set_by_name: string | null }[];
  months: PayMonth[];
}

const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

/** One person's pay: what they are on, every month's slip, every change. */
export function TeamPersonPage() {
  const id = useIdentity();
  const { personId } = useParams<{ personId: string }>();
  const [data, setData] = useState<SalaryData | null>(null);
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => apiGet<SalaryData>(`/staff/${personId}/salary`)
    .then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [personId]);

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

      {data && (
        <>
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
        </>
      )}
    </Shell>
  );
}
