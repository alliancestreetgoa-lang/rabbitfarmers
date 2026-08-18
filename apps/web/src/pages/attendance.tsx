'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost, getSession } from '@/lib/api';
import {
  Shell, useIdentity, PageTitle, Section, Table, Empty, Btn,
} from '@/components/ui/shell';

interface Summary {
  employee_id: string; full_name: string; present: number; half_days: number;
  absent: number; leave: number; days_worked: number; overtime_minutes: number;
}
interface Day {
  employee_id: string; full_name: string; work_date: string; status: string;
  checked_in_at: string | null; checked_out_at: string | null;
}

const t = (s: string | null) =>
  s ? new Date(s).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';

export function AttendancePage() {
  const id = useIdentity();
  const [month, setMonth] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary[] | null>(null);
  const [days, setDays] = useState<Day[]>([]);
  const [mine, setMine] = useState<{ checked_in_at: string | null; checked_out_at: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => Promise.all([
    apiGet<{ month: string; summary: Summary[]; days: Day[] }>('/attendance')
      .then((d) => { setMonth(d.month); setSummary(d.summary); setDays(d.days); }),
    apiGet<{ attendance: { checked_in_at: string | null; checked_out_at: string | null } | null }>('/me/attendance')
      .then((d) => setMine(d.attendance)).catch(() => {}),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const punch = async (which: 'check-in' | 'check-out') => {
    setBusy(true); setError(null);
    try { await apiPost(`/attendance/${which}`); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const csv = async () => {
    const session = getSession();
    const res = await fetch('/api/attendance.csv', {
      headers: session ? { authorization: `Bearer ${session.token}` } : {},
    });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `attendance-${month ?? 'month'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Shell {...id}>
      <PageTitle title="Attendance" sub={month ?? undefined} />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}

      <Section title="Your day" action={<Btn tone="quiet" onClick={csv}>Download CSV</Btn>}>
        <div className="flex items-center gap-4 rounded-xl border border-farm-rule bg-farm-surface px-4 py-3">
          <p className="flex-1 text-sm font-semibold">
            {mine?.checked_in_at
              ? `Worked ${t(mine.checked_in_at)}${mine.checked_out_at ? ` to ${t(mine.checked_out_at)}` : ' — still in'}`
              : 'Not checked in'}
          </p>
          {!mine?.checked_in_at && <Btn onClick={() => punch('check-in')} disabled={busy}>Check in</Btn>}
          {mine?.checked_in_at && !mine?.checked_out_at && (
            <Btn onClick={() => punch('check-out')} disabled={busy}>Check out</Btn>
          )}
        </div>
      </Section>

      <Section title="The month, per person">
        {summary?.length === 0
          ? <Empty>Nothing recorded this month yet.</Empty>
          : (
            <Table head={['Name', 'Present', 'Half days', 'Absent', 'Leave', 'Days worked', 'Overtime']}>
              {(summary ?? []).map((s) => (
                <tr key={s.employee_id} className="border-b border-farm-rule last:border-0">
                  <td className="px-4 py-2.5 font-semibold">{s.full_name}</td>
                  <td className="px-4 py-2.5">{s.present}</td>
                  <td className="px-4 py-2.5">{s.half_days}</td>
                  <td className="px-4 py-2.5">{s.absent}</td>
                  <td className="px-4 py-2.5">{s.leave}</td>
                  <td className="px-4 py-2.5 font-semibold">{s.days_worked}</td>
                  <td className="px-4 py-2.5">{s.overtime_minutes ? `${s.overtime_minutes}m` : '—'}</td>
                </tr>
              ))}
            </Table>
          )}
      </Section>

      <Section title="Day by day">
        {days.length === 0
          ? <Empty>No days recorded yet this month.</Empty>
          : (
            <Table head={['Date', 'Who', 'Status', 'In', 'Out']}>
              {days.map((d, i) => (
                <tr key={i} className="border-b border-farm-rule last:border-0">
                  <td className="px-4 py-2.5">{d.work_date}</td>
                  <td className="px-4 py-2.5">{d.full_name}</td>
                  <td className="px-4 py-2.5 capitalize">{d.status}</td>
                  <td className="px-4 py-2.5">{t(d.checked_in_at)}</td>
                  <td className="px-4 py-2.5">{t(d.checked_out_at)}</td>
                </tr>
              ))}
            </Table>
          )}
      </Section>
    </Shell>
  );
}
