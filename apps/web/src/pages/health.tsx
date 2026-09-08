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
  dose_note: string | null; step: number; route: string | null; dose: string | null;
  /** The chart forbids this dose for this rabbit. Do not give. */
  hold_reason: string | null;
}
interface Animal { id: string; name: string | null; tag: string }
interface Step {
  protocol_id: string; step: number; medicine: string; route: string | null; dose: string | null;
  doses: number; interval_days: number; note: string | null;
  adults_only: boolean; min_age_days: number | null; not_when_pregnant: boolean;
  hold_reason?: string | null;
}
interface CondType {
  id: string; code: string; name: string; colour: string;
  reminder_interval_hours: string | number | null;
  advice: string | null;
  steps: Step[];
}
interface Routine {
  month: string; done: number; total: number; standing: string[];
  steps: { step: number; day: number; medicine: string; dose: string; detail: string;
           due_on: string; per_rabbit: boolean; task_id: string | null; task_status: string | null;
           to_give: number; held: number; given: number }[];
}

const stepLine = (st: Step) =>
  `${st.medicine}${st.dose ? ` ${st.dose}` : ''}${st.route ? ` (${st.route})` : ''} — ` +
  `${st.doses === 1 ? 'one dose' : `${st.doses} doses, ${st.interval_days === 1 ? 'daily' : `every ${st.interval_days} days`}`}` +
  `${st.note ? `. ${st.note}` : ''}`;

const notFor = (st: Step) => [
  st.not_when_pregnant ? 'a pregnant doe' : null,
  st.min_age_days ? `kits under ${Math.round(st.min_age_days / 30)} months` : null,
  st.adults_only && !st.min_age_days ? 'anything but an adult' : null,
].filter(Boolean).join(', or ');

/** Every step of a treatment, with its rules, as a list. */
function Steps({ steps, advice }: { steps: Step[]; advice: string | null }) {
  return (
    <div className="space-y-1 text-sm">
      {advice && <p className="font-semibold">{advice}</p>}
      {steps.length === 0 && <p className="text-farm-muted">No medicine is set for this one — reminders only.</p>}
      {steps.map((st) => (
        <div key={st.protocol_id}>
          <p>{steps.length > 1 ? `${st.step}. ` : ''}<b>{stepLine(st)}</b></p>
          {st.hold_reason
            ? <p className="font-bold text-farm-crit">Do not give — {st.hold_reason}. Ask the vet.</p>
            : notFor(st) && <p className="text-xs font-semibold text-farm-crit">Not for {notFor(st)}.</p>}
        </div>
      ))}
      <p className="text-xs italic text-farm-muted">Doses as given at the farm training. Confirm with a vet before use.</p>
    </div>
  );
}

export function HealthPage() {
  const id = useIdentity();
  const [open, setOpen] = useState<Condition[] | null>(null);
  const [due, setDue] = useState<Dose[] | null>(null);
  const [animals, setAnimals] = useState<Animal[]>([]);
  const [types, setTypes] = useState<CondType[]>([]);
  const [routine, setRoutine] = useState<Routine | null>(null);
  const [report, setReport] = useState({ rabbit_id: '', code: '', note: '' });
  const [reported, setReported] = useState<{ rabbit: string; sickness: string; steps: Step[]; advice: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => Promise.all([
    apiGet<{ open: Condition[] }>('/conditions').then((d) => setOpen(d.open)),
    apiGet<{ due: Dose[] }>('/medication').then((d) => setDue(d.due)),
    apiGet<{ animals: Animal[] }>('/animals').then((d) => setAnimals(d.animals)),
    apiGet<{ types: CondType[] }>('/condition-types').then((d) => setTypes(d.types)),
    apiGet<Routine>('/routine').then(setRoutine),
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
      const res = await apiPost<{ steps: Step[]; advice: string | null }>('/conditions', {
        rabbit_id: report.rabbit_id, code: report.code,
        note: report.note || undefined,
      });
      setReported({
        rabbit: name(report.rabbit_id),
        sickness: types.find((t) => t.code === report.code)?.name ?? report.code,
        steps: res.steps, advice: res.advice,
      });
      setReport({ rabbit_id: '', code: '', note: '' });
    });
  };

  const name = (rid: string) => {
    const a = animals.find((x) => x.id === rid);
    return a ? (a.name ?? a.tag) : '';
  };

  return (
    <Shell {...id}>
      <PageTitle title="Report a sick rabbit" />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}

      {reported && (
        <div className="mb-5 rounded-xl border border-farm-accent-soft bg-farm-accent-soft/50 p-4">
          <p className="text-sm font-bold">{reported.sickness} reported for {reported.rabbit}.</p>
          <div className="mt-2"><Steps steps={reported.steps} advice={reported.advice} /></div>
          {reported.steps.length > 0 && (
            <p className="mt-1 text-xs text-farm-muted">The doses are on the list below and on Today. Mark the sickness stopped and any dose still to come is cancelled.</p>
          )}
          <div className="mt-2"><Btn tone="quiet" onClick={() => setReported(null)}>Okay</Btn></div>
        </div>
      )}

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
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Sickness</span>
            <Select required value={report.code}
              onChange={(e) => setReport({ ...report, code: e.target.value })}>
              <option value="">Choose…</option>
              {types.map((t) => <option key={t.id} value={t.code}>{t.name}</option>)}
            </Select>
          </label>
          <label className="flex-1 text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Note (optional)</span>
            <Input className="w-full" value={report.note} placeholder="What you saw"
              onChange={(e) => setReport({ ...report, note: e.target.value })} />
          </label>
          <Btn type="submit" disabled={busy === 'report' || !report.rabbit_id || !report.code}>
            {busy === 'report' ? 'Saving…' : 'Report'}
          </Btn>
        </form>
        {report.code && (() => {
          const t = types.find((x) => x.code === report.code);
          return t
            ? <div className="mt-3 rounded-xl border border-farm-rule bg-farm-surface p-4">
                <Steps steps={t.steps} advice={t.advice} />
              </div>
            : null;
        })()}
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
                        {d.dose ? ` · ${d.dose}` : ''}{d.route ? ` (${d.route})` : ''}
                        {d.dose_note ? ` · ${d.dose_note}` : ''}
                      </p>
                      {d.hold_reason && (
                        <p className="text-sm font-bold text-farm-crit">Do not give — {d.hold_reason}. Ask the vet.</p>
                      )}
                    </div>
                    {!d.hold_reason && (
                      <Btn disabled={busy === key}
                        onClick={() => act(key, () => apiPost('/medication', {
                          protocol_id: d.protocol_id, rabbit_id: d.rabbit_id, dose_number: d.dose_number,
                        }))}>
                        {busy === key ? 'Saving…' : 'Given'}
                      </Btn>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </Section>

      <Section title={`This month's routine${routine ? ` · ${routine.done} of ${routine.total} done` : ''}`}>
        <p className="mb-3 text-sm text-farm-muted">
          Hitech on the 7th, 8th and 9th; Liv 52 and Gutwell on the 13th, 14th and 15th — one row per rabbit on Today, ticked rabbit by rabbit, with a pregnant doe or a kit under 3 months held back where the chart says so. Tetracycline in the water on the 16th, for the whole farm. A dose not given stays red until it is.
        </p>
        <div className="space-y-2">
          {(routine?.steps ?? []).map((st) => (
            <div key={st.step}
              className={`flex flex-wrap items-center gap-3 rounded-xl border border-farm-rule bg-farm-surface px-4 py-3${st.task_status === 'done' ? ' opacity-60' : ''}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Day {st.day} — {st.medicine}{st.task_status === 'done' ? ' ✓' : ''}</p>
                <p className="text-xs text-farm-muted">{st.dose} · {st.detail}</p>
                {st.per_rabbit && (
                  <p className="mt-1 text-xs font-semibold">
                    {st.to_give} to give · {st.held} held · {st.given} given
                    <span className="font-normal text-farm-muted"> — each rabbit is ticked on Today</span>
                  </p>
                )}
              </div>
              {!st.per_rabbit && st.task_status === 'open' && st.task_id && (
                <Btn disabled={busy === st.task_id}
                  onClick={() => act(st.task_id!, () => apiPost(`/tasks/${st.task_id}/done`, {}))}>
                  {busy === st.task_id ? 'Saving…' : 'Done — whole farm'}
                </Btn>
              )}
            </div>
          ))}
        </div>
        {routine?.standing.map((line) => (
          <p key={line} className="mt-2 text-xs text-farm-muted">{line}</p>
        ))}
      </Section>

    </Shell>
  );
}
