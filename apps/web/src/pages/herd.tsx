'use client';

import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { apiGet, apiPost, getSession } from '@/lib/api';
import {
  Shell, useIdentity, PageTitle, Section, Table, Empty, Btn, Input, Select,
} from '@/components/ui/shell';

/** The herd as a table — the laptop view the phone's list can't be. */

interface Animal {
  id: string; tag: string; name: string | null; sex: string; role: string;
  status: string; date_of_birth: string | null; breed: string | null;
  cage: string | null; reproductive_state: string | null;
  primary_condition: string | null; primary_colour: string | null;
}

const STATE_LABEL: Record<string, string> = {
  GROWING: 'Growing', READY: 'Ready to mate', MATED: 'Awaiting check',
  PREGNANT: 'Pregnant', NEST_BOX: 'Due — nest box in', LACTATING: 'Nursing',
  PSEUDOPREGNANT: 'False pregnancy', OPEN: 'Resting', RESTING: 'Resting', OVERDUE: 'Overdue',
};

export function HerdPage() {
  const id = useIdentity();
  const [animals, setAnimals] = useState<Animal[] | null>(null);
  const [q, setQ] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', sex: 'doe', date_of_birth: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => apiGet<{ animals: Animal[] }>('/animals')
    .then((d) => setAnimals(d.animals)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await apiPost('/animals', {
        name: form.name, sex: form.sex,
        date_of_birth: form.date_of_birth || undefined,
      });
      setForm({ name: '', sex: 'doe', date_of_birth: '' });
      setShowAdd(false);
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const shown = (animals ?? []).filter((a) =>
    !q || (a.name ?? '').toLowerCase().includes(q.toLowerCase())
      || a.tag.toLowerCase().includes(q.toLowerCase()));

  return (
    <Shell {...id}>
      <PageTitle title="Herd" sub={animals ? `${animals.length} in the herd` : undefined} />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input placeholder="Search by name or tag" value={q}
               onChange={(e) => setQ(e.target.value)} className="w-64" />
        <div className="flex-1" />
        <Btn onClick={() => setShowAdd((s) => !s)} tone={showAdd ? 'quiet' : 'accent'}>
          {showAdd ? 'Cancel' : 'Add a rabbit'}
        </Btn>
      </div>

      {showAdd && (
        <form onSubmit={add}
          className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-farm-rule bg-farm-surface p-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Name</span>
            <Input required value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Lakshmi" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Sex</span>
            <Select value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}>
              <option value="doe">Female (doe)</option>
              <option value="buck">Male (buck)</option>
              <option value="unknown">Not sure yet</option>
            </Select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Born (optional)</span>
            <Input type="date" value={form.date_of_birth}
              onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} />
          </label>
          <Btn type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add to the herd'}</Btn>
        </form>
      )}

      {animals && animals.length === 0 && !showAdd && (
        <Empty>No rabbits yet — add your first with the button above.</Empty>
      )}

      {shown.length > 0 && (
        <Table head={['Name', 'Sex', 'State', 'Born', 'Breed', 'Cage', 'Health']}>
          {shown.map((a) => (
            <tr key={a.id} className="border-b border-farm-rule last:border-0 hover:bg-farm-ground">
              <td className="px-4 py-2.5">
                <Link to={`/dashboard/herd/${a.id}`} className="font-semibold text-farm-accent">
                  {a.name ?? a.tag}
                </Link>
              </td>
              <td className="px-4 py-2.5 capitalize">{a.sex === 'doe' ? 'Female' : a.sex === 'buck' ? 'Male' : '—'}</td>
              <td className="px-4 py-2.5">{STATE_LABEL[a.reproductive_state ?? ''] ?? '—'}</td>
              <td className="px-4 py-2.5">{a.date_of_birth ?? '—'}</td>
              <td className="px-4 py-2.5">{a.breed ?? '—'}</td>
              <td className="px-4 py-2.5">{a.cage ?? '—'}</td>
              <td className="px-4 py-2.5">
                {a.primary_condition
                  ? <span className="font-semibold" style={{ color: a.primary_colour ?? undefined }}>{a.primary_condition}</span>
                  : '—'}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------ one rabbit -- */

interface History {
  animal: {
    id: string; tag: string; name: string | null; sex: string; status: string;
    date_of_birth: string | null; breed: string | null; cage: string | null;
    dam: string | null; dam_id: string | null; sire: string | null; sire_id: string | null;
    notes: string | null;
  };
  events: { on_date: string; kind: string; title: string }[];
  offspring: { id: string; tag: string; name: string | null; status: string }[];
}

export function AnimalPage() {
  const identity = useIdentity();
  const { animalId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [leave, setLeave] = useState({ status: 'sold', reason: '' });
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const isOwner = getSession()?.user?.role === 'owner';

  const load = () => apiGet<History>(`/animals/${animalId}/history`)
    .then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [animalId]);

  const recordLeave = async () => {
    setBusy(true); setError(null);
    try {
      await apiPost(`/animals/${animalId}/status`, { status: leave.status, reason: leave.reason });
      setLeaving(false);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const reallyDelete = async () => {
    setBusy(true); setError(null);
    try {
      const session = getSession();
      const res = await fetch(`/api/animals/${animalId}`, {
        method: 'DELETE',
        headers: session ? { authorization: `Bearer ${session.token}` } : {},
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setDeleteArmed(false); setError(body?.error ?? 'Could not delete'); return; }
      navigate('/dashboard/herd');
    } finally { setBusy(false); }
  };

  const a = data?.animal;
  return (
    <Shell {...identity}>
      <div className="mb-2">
        <Link to="/dashboard/herd" className="text-sm font-semibold text-farm-accent">← Herd</Link>
      </div>
      <PageTitle title={a ? (a.name ?? a.tag) : '…'}
        sub={a ? [
          a.sex === 'doe' ? 'Female' : a.sex === 'buck' ? 'Male' : 'Sex unknown',
          a.date_of_birth && `born ${a.date_of_birth}`,
          a.breed, a.cage && `cage ${a.cage}`,
          a.status !== 'active' && a.status,
        ].filter(Boolean).join(' · ') : undefined} />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}

      {a && (a.dam || a.sire) && (
        <p className="mb-6 -mt-3 text-sm text-farm-muted">
          {a.dam && <>Dam: <Link className="text-farm-accent" to={`/dashboard/herd/${a.dam_id}`}>{a.dam}</Link></>}
          {a.dam && a.sire && ' · '}
          {a.sire && <>Sire: <Link className="text-farm-accent" to={`/dashboard/herd/${a.sire_id}`}>{a.sire}</Link></>}
        </p>
      )}

      {data && data.events.length > 0 && (
        <Section title="Everything recorded, newest first">
          <div className="rounded-xl border border-farm-rule bg-farm-surface">
            {data.events.map((e, i) => (
              <div key={i} className="flex gap-4 border-b border-farm-rule px-4 py-2.5 text-sm last:border-0">
                <span className="w-24 flex-none text-farm-muted">{e.on_date}</span>
                <span>{e.title}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {data && data.offspring.length > 0 && (
        <Section title={`Offspring · ${data.offspring.length}`}>
          <div className="flex flex-wrap gap-2">
            {data.offspring.map((k) => (
              <Link key={k.id} to={`/dashboard/herd/${k.id}`}
                className="rounded-lg border border-farm-rule bg-farm-surface px-3 py-1.5 text-sm text-farm-accent">
                {k.name ?? k.tag}{k.status !== 'active' ? ` · ${k.status}` : ''}
              </Link>
            ))}
          </div>
        </Section>
      )}

      {isOwner && a && a.status === 'active' && (
        <Section title="Owner actions">
          {!leaving && !deleteArmed && (
            <div className="flex gap-3">
              <Btn tone="quiet" onClick={() => setLeaving(true)}>Sold, culled or died</Btn>
              <Btn tone="crit" onClick={() => setDeleteArmed(true)}>Delete</Btn>
            </div>
          )}
          {leaving && (
            <div className="flex flex-wrap items-end gap-3 rounded-xl border border-farm-rule bg-farm-surface p-4">
              <label className="text-sm">
                <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">What happened</span>
                <Select value={leave.status} onChange={(e) => setLeave({ ...leave, status: e.target.value })}>
                  <option value="sold">Sold</option>
                  <option value="culled">Culled</option>
                  <option value="dead">Died</option>
                </Select>
              </label>
              <label className="flex-1 text-sm">
                <span className="mb-1 block text-xs font-bold text-farm-muted uppercase">Reason</span>
                <Input className="w-full" required value={leave.reason} placeholder="Why — kept on the record"
                  onChange={(e) => setLeave({ ...leave, reason: e.target.value })} />
              </label>
              <Btn onClick={recordLeave} disabled={busy || !leave.reason}>{busy ? 'Saving…' : 'Record it'}</Btn>
              <Btn tone="quiet" onClick={() => setLeaving(false)}>Cancel</Btn>
            </div>
          )}
          {deleteArmed && (
            <div className="rounded-xl border border-farm-crit/40 bg-farm-crit-soft p-4">
              <p className="text-sm font-bold text-farm-crit">Delete {a.name ?? a.tag} forever?</p>
              <p className="mt-1 text-sm text-farm-ink-soft">
                Only for a rabbit added by mistake — everything about her is erased. An animal
                that was sold, culled or died should be recorded as that instead, so the record survives.
              </p>
              <div className="mt-3 flex gap-3">
                <Btn tone="crit" onClick={reallyDelete} disabled={busy}>
                  {busy ? 'Deleting…' : 'Yes, delete forever'}
                </Btn>
                <Btn tone="quiet" onClick={() => setDeleteArmed(false)}>Keep her</Btn>
              </div>
            </div>
          )}
        </Section>
      )}
    </Shell>
  );
}
