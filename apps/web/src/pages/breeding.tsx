'use client';

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '@/lib/api';
import {
  Shell, useIdentity, PageTitle, Section, Table, Empty, Btn, Select,
} from '@/components/ui/shell';

/** Pregnancies and the queue, with recording a mating right on the page. */

interface PregnantDoe {
  rabbit_id: string; name: string | null; tag: string; state: string;
  confidence: string | null; gestation_day: number | null;
  expected_kindling_on: string | null; window_start_on: string | null; window_end_on: string | null;
}
interface ReadyDoe {
  rabbit_id: string; name: string | null; tag: string; state: string;
  days_overdue: number | null; days_since_weaning: number | null; litters: number | null;
}
interface Animal { id: string; name: string | null; tag: string; sex: string }
interface Schedule { palpate_on: string; nest_box_on: string; expected_kindling_on: string }

export function BreedingPage() {
  const id = useIdentity();
  const [pregnant, setPregnant] = useState<PregnantDoe[] | null>(null);
  const [ready, setReady] = useState<ReadyDoe[] | null>(null);
  const [animals, setAnimals] = useState<Animal[]>([]);
  const [mating, setMating] = useState({ doe_id: '', buck_id: '' });
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => Promise.all([
    apiGet<{ does: PregnantDoe[] }>('/pregnant').then((d) => setPregnant(d.does)),
    apiGet<{ ready: ReadyDoe[] }>('/ready-to-mate').then((d) => setReady(d.ready)),
    apiGet<{ animals: Animal[] }>('/animals').then((d) => setAnimals(d.animals)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const recordMating = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null); setSchedule(null);
    try {
      const res = await apiPost<{ mating: { schedule: Schedule } }>('/matings', {
        doe_id: mating.doe_id, buck_id: mating.buck_id || undefined,
      });
      setSchedule(res.mating.schedule);
      setMating({ doe_id: '', buck_id: '' });
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const does = animals.filter((a) => a.sex === 'doe');
  const bucks = animals.filter((a) => a.sex === 'buck');

  return (
    <Shell {...id}>
      <PageTitle title="Breeding" />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}

      <Section title="Record a mating">
        <form onSubmit={recordMating}
          className="flex flex-wrap items-end gap-3 rounded-xl border border-farm-rule bg-farm-surface p-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Doe</span>
            <Select required value={mating.doe_id}
              onChange={(e) => setMating({ ...mating, doe_id: e.target.value })}>
              <option value="">Choose…</option>
              {does.map((d) => <option key={d.id} value={d.id}>{d.name ?? d.tag}</option>)}
            </Select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Buck (optional)</span>
            <Select value={mating.buck_id}
              onChange={(e) => setMating({ ...mating, buck_id: e.target.value })}>
              <option value="">Not recorded</option>
              {bucks.map((b) => <option key={b.id} value={b.id}>{b.name ?? b.tag}</option>)}
            </Select>
          </label>
          <Btn type="submit" disabled={busy || !mating.doe_id}>{busy ? 'Saving…' : 'Record mating'}</Btn>
          {schedule && (
            <p className="w-full text-sm text-farm-accent">
              Recorded. Palpate <b>{schedule.palpate_on}</b> · nest box in <b>{schedule.nest_box_on}</b> ·
              kindling expected <b>{schedule.expected_kindling_on}</b> — all on Today when due.
            </p>
          )}
        </form>
      </Section>

      <Section title={`Pregnant · ${pregnant?.length ?? '…'}`}>
        {pregnant?.length === 0
          ? <Empty>No pregnancies under way.</Empty>
          : (
            <Table head={['Doe', 'Confidence', 'Day', 'Due', 'Window']}>
              {(pregnant ?? []).map((d) => (
                <tr key={d.rabbit_id} className="border-b border-farm-rule last:border-0">
                  <td className="px-4 py-2.5">
                    <Link to={`/dashboard/herd/${d.rabbit_id}`} className="font-semibold text-farm-accent">{d.name ?? d.tag}</Link>
                  </td>
                  <td className="px-4 py-2.5 capitalize">{d.confidence ?? '—'}</td>
                  <td className="px-4 py-2.5">{d.gestation_day ?? '—'}</td>
                  <td className="px-4 py-2.5 font-semibold">{d.expected_kindling_on ?? '—'}</td>
                  <td className="px-4 py-2.5 text-farm-muted">{d.window_start_on} → {d.window_end_on}</td>
                </tr>
              ))}
            </Table>
          )}
      </Section>

      <Section title={`Ready to mate · ${ready?.length ?? '…'}`}>
        {ready?.length === 0
          ? <Empty>Nobody is waiting.</Empty>
          : (
            <Table head={['Doe', 'State', 'Days overdue', 'Litters so far']}>
              {(ready ?? []).map((d) => (
                <tr key={d.rabbit_id} className="border-b border-farm-rule last:border-0">
                  <td className="px-4 py-2.5">
                    <Link to={`/dashboard/herd/${d.rabbit_id}`} className="font-semibold text-farm-accent">{d.name ?? d.tag}</Link>
                  </td>
                  <td className="px-4 py-2.5">{d.state}</td>
                  <td className={`px-4 py-2.5 ${d.days_overdue && d.days_overdue > 0 ? 'font-bold text-farm-warn' : ''}`}>
                    {d.days_overdue ?? '—'}
                  </td>
                  <td className="px-4 py-2.5">{d.litters ?? 0}</td>
                </tr>
              ))}
            </Table>
          )}
      </Section>
    </Shell>
  );
}
