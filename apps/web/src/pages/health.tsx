'use client';

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '@/lib/api';
import {
  Shell, useIdentity, PageTitle, Section, Empty, Btn, Select, Input,
} from '@/components/ui/shell';

interface Condition {
  condition_id: string; rabbit_id: string; tag: string; rabbit_name: string | null;
  condition_name: string; colour: string | null; severity: string | null; hours_open: number;
}
interface Dose {
  protocol_id: string; protocol_name: string; rabbit_id: string;
  dose_number: number; total_doses: number; due_on: string; days_until_due: number;
  dose_note: string | null;
}
interface Animal { id: string; name: string | null; tag: string }

export function HealthPage() {
  const id = useIdentity();
  const [open, setOpen] = useState<Condition[] | null>(null);
  const [due, setDue] = useState<Dose[] | null>(null);
  const [animals, setAnimals] = useState<Animal[]>([]);
  const [report, setReport] = useState({ rabbit_id: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => Promise.all([
    apiGet<{ open: Condition[] }>('/conditions').then((d) => setOpen(d.open)),
    apiGet<{ due: Dose[] }>('/medication').then((d) => setDue(d.due)),
    apiGet<{ animals: Animal[] }>('/animals').then((d) => setAnimals(d.animals)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const reportProblem = (e: React.FormEvent) => {
    e.preventDefault();
    return act('report', async () => {
      await apiPost('/conditions', {
        rabbit_id: report.rabbit_id, note: report.note || undefined,
      });
      setReport({ rabbit_id: '', note: '' });
    });
  };

  const name = (rid: string) => {
    const a = animals.find((x) => x.id === rid);
    return a ? (a.name ?? a.tag) : '';
  };

  return (
    <Shell {...id}>
      <PageTitle title="Health" />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}

      <Section title="Report a problem">
        <form onSubmit={reportProblem}
          className="flex flex-wrap items-end gap-3 rounded-xl border border-farm-rule bg-farm-surface p-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Rabbit</span>
            <Select required value={report.rabbit_id}
              onChange={(e) => setReport({ ...report, rabbit_id: e.target.value })}>
              <option value="">Choose…</option>
              {animals.map((a) => <option key={a.id} value={a.id}>{a.name ?? a.tag}</option>)}
            </Select>
          </label>
          <label className="flex-1 text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Note (optional)</span>
            <Input className="w-full" value={report.note} placeholder="What you saw"
              onChange={(e) => setReport({ ...report, note: e.target.value })} />
          </label>
          <Btn type="submit" disabled={busy === 'report' || !report.rabbit_id}>
            {busy === 'report' ? 'Saving…' : 'Report'}
          </Btn>
        </form>
      </Section>

      <Section title={`Open cases · ${open?.length ?? '…'}`}>
        {open?.length === 0
          ? <Empty>No open health cases.</Empty>
          : (
            <div className="space-y-2">
              {(open ?? []).map((c) => (
                <div key={c.condition_id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-farm-rule bg-farm-surface px-4 py-3">
                  <span className="h-2.5 w-2.5 flex-none rounded-full"
                        style={{ background: c.colour ?? '#8C332B' }} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      {c.condition_name} — <Link className="text-farm-accent" to={`/dashboard/herd/${c.rabbit_id}`}>
                        {c.rabbit_name ?? c.tag}</Link>
                    </p>
                    <p className="text-xs text-farm-muted">
                      open {c.hours_open < 48 ? `${Math.round(c.hours_open)}h` : `${Math.round(c.hours_open / 24)}d`}
                      {c.severity ? ` · ${c.severity}` : ''}
                    </p>
                  </div>
                  <Btn tone="quiet" disabled={busy === c.condition_id}
                    onClick={() => act(c.condition_id, () => apiPost(`/conditions/${c.condition_id}/check`, { status: 'ongoing' }))}>
                    Still going
                  </Btn>
                  <Btn disabled={busy === c.condition_id}
                    onClick={() => act(c.condition_id, () => apiPost(`/conditions/${c.condition_id}/check`, { status: 'stopped' }))}>
                    Stopped
                  </Btn>
                </div>
              ))}
            </div>
          )}
      </Section>

      <Section title={`Medicine doses due · ${due?.length ?? '…'}`}>
        {due?.length === 0
          ? <Empty>Nothing due.</Empty>
          : (
            <div className="space-y-2">
              {(due ?? []).map((d) => {
                const key = `${d.protocol_id}:${d.rabbit_id}:${d.dose_number}`;
                return (
                  <div key={key}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-farm-rule bg-farm-surface px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">
                        {d.protocol_name} — dose {d.dose_number} of {d.total_doses} for{' '}
                        <Link className="text-farm-accent" to={`/dashboard/herd/${d.rabbit_id}`}>{name(d.rabbit_id)}</Link>
                      </p>
                      <p className="text-xs text-farm-muted">
                        due {d.due_on}{d.days_until_due < 0 ? ` · ${-d.days_until_due} days overdue` : ''}
                        {d.dose_note ? ` · ${d.dose_note}` : ''}
                      </p>
                    </div>
                    <Btn disabled={busy === key}
                      onClick={() => act(key, () => apiPost('/medication', {
                        protocol_id: d.protocol_id, rabbit_id: d.rabbit_id, dose_number: d.dose_number,
                      }))}>
                      {busy === key ? 'Saving…' : 'Given'}
                    </Btn>
                  </div>
                );
              })}
            </div>
          )}
      </Section>
    </Shell>
  );
}
