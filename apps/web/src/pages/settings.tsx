'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPatch } from '@/lib/api';
import { Shell, useIdentity, PageTitle, Section, Btn } from '@/components/ui/shell';

/**
 * The farm's own rules. One so far: how long after a delivery a doe goes back
 * to the buck. The farm uses two gaps — 16 days or 32 days — so it is a
 * choice, not a number to type.
 */

interface Settings {
  rebreed_anchor: 'kindling' | 'weaning';
  rebreed_after_kindling_days: number;
}

const GAPS: { days: number; title: string; note: string }[] = [
  { days: 16, title: '16 days after delivery',
    note: 'Fast rhythm. She is served while the kits are still on her.' },
  { days: 32, title: '32 days after delivery',
    note: 'The usual rhythm here: the kits are separated first, then she goes back to the buck.' },
];

export function SettingsPage() {
  const id = useIdentity();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = () => apiGet<{ settings: Settings }>('/settings')
    .then((d) => setSettings(d.settings)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const choose = async (days: number) => {
    setSaving(days); setError(null); setSaved(null);
    try {
      const d = await apiPatch<{ settings: Settings }>('/settings', {
        rebreed_anchor: 'kindling', rebreed_after_kindling_days: days,
      });
      setSettings(d.settings);
      setSaved(`Saved. From now on, ${days} days after a delivery she is on Today to be served, and every phone is told.`);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(null); }
  };

  const current = settings?.rebreed_anchor === 'kindling' ? settings.rebreed_after_kindling_days : null;

  return (
    <Shell {...id}>
      <PageTitle title="Settings" sub="The farm's own rules." />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}
      {saved && <p className="mb-4 rounded-xl bg-farm-surface px-4 py-3 text-sm font-medium text-farm-accent">{saved}</p>}

      <Section title="Mating after delivery">
        <p className="mb-3 text-sm text-farm-muted">
          How long after a doe delivers she goes back to the buck. On that day she is on Today
          to be served, every phone is told, and she stays red until the mating is recorded.
        </p>
        <div className="space-y-2">
          {GAPS.map((g) => {
            const on = current === g.days;
            return (
              <button key={g.days} type="button" onClick={() => choose(g.days)}
                disabled={saving !== null}
                aria-pressed={on}
                className={`flex w-full items-center gap-4 rounded-xl border px-4 py-3 text-left ${
                  on ? 'border-farm-accent bg-farm-surface' : 'border-farm-rule bg-farm-surface hover:bg-farm-ground'}`}>
                <span className={`h-4 w-4 flex-none rounded-full border-2 ${
                  on ? 'border-farm-accent bg-farm-accent' : 'border-farm-rule'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{g.title}{on ? ' — chosen' : ''}</span>
                  <span className="block text-xs text-farm-muted">{g.note}</span>
                </span>
                {saving === g.days && <span className="text-xs text-farm-muted">Saving…</span>}
              </button>
            );
          })}
        </div>
        {settings && current === null && (
          <p className="mt-3 text-xs text-farm-muted">
            Right now this farm rebreeds after separating the kits, not after delivery. Choose a gap above to switch.
          </p>
        )}
        {settings && current !== null && !GAPS.some((g) => g.days === current) && (
          <p className="mt-3 text-xs text-farm-muted">
            Currently set to {current} days after delivery. Choose one of the two above to change it.
          </p>
        )}
        <div className="mt-3">
          <Btn tone="quiet" onClick={load}>Reload</Btn>
        </div>
      </Section>
    </Shell>
  );
}
