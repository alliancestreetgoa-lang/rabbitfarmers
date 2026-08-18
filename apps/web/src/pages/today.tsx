'use client';

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '@/lib/api';
import { Shell, useIdentity, PageTitle, Section, Empty, Btn } from '@/components/ui/shell';

/**
 * The day's work, web-shaped: grouped by urgency, wide rows, and the two
 * actions a task can carry done inline — a dose recorded, a condition checked.
 * Scheduler tasks (nest box in, palpation) are pointers to the animal rather
 * than tick-boxes, exactly as on the phone: the work is done at the cage, and
 * recording the underlying event is what clears them.
 */

interface Item {
  source: string; ref_id: string; rabbit_id: string | null; tag: string | null;
  title: string; urgency: string; due_on: string | null;
}

const GROUPS: [string, string][] = [
  ['critical', 'Needs a look now'],
  ['high', 'Today'],
  ['medium', 'When you get to it'],
];

export function TodayPage() {
  const id = useIdentity();
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => apiGet<{ items: Item[] }>('/daily')
    .then((d) => setItems(d.items ?? [])).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const act = async (item: Item, fn: () => Promise<unknown>) => {
    setBusy(item.ref_id); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const doseGiven = (item: Item) => {
    // ref_id is protocol:rabbit:dose — the same triple the phone app posts.
    const [protocol_id, rabbit_id, dose_number] = item.ref_id.split(':');
    return act(item, () => apiPost('/medication', {
      protocol_id, rabbit_id, dose_number: Number(dose_number),
    }));
  };

  const conditionCheck = (item: Item, status: 'ongoing' | 'stopped') => {
    const conditionId = item.ref_id.split(':')[0];
    return act(item, () => apiPost(`/conditions/${conditionId}/check`, { status }));
  };

  return (
    <Shell {...id}>
      <PageTitle title="Today"
        sub={`${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}${
          items ? ` · ${items.length} to do` : ''}`} />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}
      {items?.length === 0 && <Empty>Nothing due. The scheduler adds work here as it comes.</Empty>}
      {GROUPS.map(([urgency, label]) => {
        const group = (items ?? []).filter((i) => i.urgency === urgency);
        if (!group.length) return null;
        return (
          <Section key={urgency} title={`${label} · ${group.length}`}>
            <div className="space-y-2">
              {group.map((i) => (
                <div key={i.ref_id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-farm-rule bg-farm-surface px-4 py-3">
                  <span className={`h-2.5 w-2.5 flex-none rounded-full ${
                    urgency === 'critical' ? 'bg-farm-crit' : urgency === 'high' ? 'bg-farm-warn' : 'bg-farm-accent'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{i.title}</p>
                    {i.tag && (
                      i.rabbit_id
                        ? <Link className="text-xs text-farm-accent" to={`/dashboard/herd/${i.rabbit_id}`}>{i.tag}</Link>
                        : <span className="text-xs text-farm-muted">{i.tag}</span>
                    )}
                  </div>
                  {i.source === 'medication' && (
                    <Btn onClick={() => doseGiven(i)} disabled={busy === i.ref_id}>
                      {busy === i.ref_id ? 'Saving…' : 'Given'}
                    </Btn>
                  )}
                  {i.source === 'condition' && (
                    <>
                      <Btn tone="quiet" onClick={() => conditionCheck(i, 'ongoing')} disabled={busy === i.ref_id}>Still going</Btn>
                      <Btn onClick={() => conditionCheck(i, 'stopped')} disabled={busy === i.ref_id}>Stopped</Btn>
                    </>
                  )}
                  {i.source === 'task' && i.rabbit_id && (
                    <Link to={`/dashboard/herd/${i.rabbit_id}`}
                      className="text-sm font-semibold text-farm-accent">Open rabbit →</Link>
                  )}
                </div>
              ))}
            </div>
          </Section>
        );
      })}
    </Shell>
  );
}
