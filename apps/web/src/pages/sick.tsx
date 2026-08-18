'use client';

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiGet, apiPost } from '@/lib/api';
import {
  Shell, useIdentity, PageTitle, Section, Table, Empty, Btn,
} from '@/components/ui/shell';

/**
 * The health tracker: every rabbit, then one rabbit's full medical record —
 * what she has now, what medicine is pending against what was actually given,
 * and the whole history. Nothing here is new data: conditions, doses and
 * health events have been recorded all along; this is the screen that reads
 * them per animal.
 */

interface Animal {
  id: string; tag: string; name: string | null; sex: string;
  status: string; reproductive_state: string | null;
  primary_condition: string | null; primary_colour: string | null;
}
interface Condition {
  condition_id: string; rabbit_id: string; condition_name: string;
  colour: string | null; severity: string | null; hours_open: number;
}
interface Dose {
  protocol_id: string; protocol_name: string; rabbit_id: string;
  dose_number: number; total_doses: number; due_on: string; days_until_due: number;
}

const STATE_LABEL: Record<string, string> = {
  GROWING: 'Growing', READY: 'Ready to mate', MATED: 'Awaiting check',
  PREGNANT: 'Pregnant', NEST_BOX: 'Due — nest box in', LACTATING: 'Nursing',
  PSEUDOPREGNANT: 'False pregnancy', OPEN: 'Resting', RESTING: 'Resting', OVERDUE: 'Overdue',
};

export function SickPage() {
  const id = useIdentity();
  const [animals, setAnimals] = useState<Animal[] | null>(null);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [doses, setDoses] = useState<Dose[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiGet<{ animals: Animal[] }>('/animals').then((d) => setAnimals(d.animals)),
      apiGet<{ open: Condition[] }>('/conditions').then((d) => setConditions(d.open)),
      apiGet<{ due: Dose[] }>('/medication').then((d) => setDoses(d.due)),
    ]).catch((e) => setError(e.message));
  }, []);

  return (
    <Shell {...id}>
      <PageTitle title="Sick rabbit"
        sub="Every rabbit's health record — open a rabbit to see everything." />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}
      {animals?.length === 0 && <Empty>No rabbits yet.</Empty>}
      {animals && animals.length > 0 && (
        <Table head={['Rabbit', 'State', 'Sickness now', 'Medicine pending']}>
          {animals.map((a) => {
            const sick = conditions.filter((c) => c.rabbit_id === a.id);
            const pending = doses.filter((d) => d.rabbit_id === a.id);
            return (
              <tr key={a.id} className="border-b border-farm-rule last:border-0 hover:bg-farm-ground">
                <td className="px-4 py-2.5">
                  <Link to={`/dashboard/sick/${a.id}`} className="font-semibold text-farm-accent">
                    {a.name ?? a.tag}
                  </Link>
                </td>
                <td className="px-4 py-2.5">{STATE_LABEL[a.reproductive_state ?? ''] ?? (a.sex === 'buck' ? 'Buck' : '—')}</td>
                <td className="px-4 py-2.5">
                  {sick.length
                    ? sick.map((c) => (
                        <span key={c.condition_id} className="mr-2 font-semibold"
                              style={{ color: c.colour ?? '#8C332B' }}>{c.condition_name}</span>
                      ))
                    : <span className="text-farm-muted">healthy</span>}
                </td>
                <td className="px-4 py-2.5">
                  {pending.length
                    ? <span className="font-semibold text-farm-warn">{pending.length} dose{pending.length === 1 ? '' : 's'} due</span>
                    : <span className="text-farm-muted">—</span>}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------- one rabbit -- */

interface HistoryEvent { on_date: string; kind: string; title: string }
interface Dossier {
  animal: { id: string; tag: string; name: string | null; sex: string; status: string };
  events: HistoryEvent[];
}

const HEALTH_KINDS = new Set(['condition', 'dose', 'health_event']);

export function RabbitHealthPage() {
  const identity = useIdentity();
  const { animalId } = useParams();
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [doses, setDoses] = useState<Dose[]>([]);
  const [state, setState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => Promise.all([
    apiGet<Dossier>(`/animals/${animalId}/history`).then(setDossier),
    apiGet<{ open: Condition[] }>('/conditions')
      .then((d) => setConditions(d.open.filter((c) => c.rabbit_id === animalId))),
    apiGet<{ due: Dose[] }>('/medication')
      .then((d) => setDoses(d.due.filter((x) => x.rabbit_id === animalId))),
    apiGet<{ animals: Animal[] }>('/animals')
      .then((d) => setState(d.animals.find((a) => a.id === animalId)?.reproductive_state ?? null)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [animalId]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const a = dossier?.animal;
  const healthHistory = (dossier?.events ?? []).filter((e) => HEALTH_KINDS.has(e.kind));

  return (
    <Shell {...identity}>
      <div className="mb-2">
        <Link to="/dashboard/sick" className="text-sm font-semibold text-farm-accent">← All rabbits</Link>
      </div>
      <PageTitle title={a ? (a.name ?? a.tag) : '…'}
        sub={a ? [
          a.sex === 'doe' ? 'Female' : a.sex === 'buck' ? 'Male' : null,
          STATE_LABEL[state ?? ''] ?? null,
          a.status !== 'active' ? a.status : null,
        ].filter(Boolean).join(' · ') : undefined} />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}

      <Section title={`Sickness now · ${conditions.length}`}>
        {conditions.length === 0
          ? <Empty>Nothing open — healthy as far as anyone has reported.</Empty>
          : conditions.map((c) => (
            <div key={c.condition_id}
              className="mb-2 flex flex-wrap items-center gap-3 rounded-xl border border-farm-rule bg-farm-surface px-4 py-3">
              <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: c.colour ?? '#8C332B' }} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{c.condition_name}</p>
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
      </Section>

      <Section title={`Medicine not yet given · ${doses.length}`}>
        {doses.length === 0
          ? <Empty>Nothing pending — every due dose has been given.</Empty>
          : doses.map((d) => {
            const key = `${d.protocol_id}:${d.dose_number}`;
            return (
              <div key={key}
                className="mb-2 flex flex-wrap items-center gap-3 rounded-xl border border-farm-warn/40 bg-farm-surface px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{d.protocol_name} — dose {d.dose_number} of {d.total_doses}</p>
                  <p className="text-xs text-farm-muted">
                    due {d.due_on}{d.days_until_due < 0 ? ` · ${-d.days_until_due} days overdue` : ''}
                  </p>
                </div>
                <Btn disabled={busy === key}
                  onClick={() => act(key, () => apiPost('/medication', {
                    protocol_id: d.protocol_id, rabbit_id: animalId, dose_number: d.dose_number,
                  }))}>
                  {busy === key ? 'Saving…' : 'Given'}
                </Btn>
              </div>
            );
          })}
      </Section>

      <Section title={`Health history · ${healthHistory.length}`}>
        {healthHistory.length === 0
          ? <Empty>No sickness or medicine has ever been recorded for this rabbit.</Empty>
          : (
            <div className="rounded-xl border border-farm-rule bg-farm-surface">
              {healthHistory.map((e, i) => (
                <div key={i} className="flex gap-4 border-b border-farm-rule px-4 py-2.5 text-sm last:border-0">
                  <span className="w-24 flex-none text-farm-muted">{e.on_date}</span>
                  <span>{e.title}</span>
                </div>
              ))}
            </div>
          )}
      </Section>
    </Shell>
  );
}
