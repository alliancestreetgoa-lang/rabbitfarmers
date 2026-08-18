'use client';

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '@/lib/api';
import { Shell, useIdentity, PageTitle, Table, Empty } from '@/components/ui/shell';

interface Litter {
  id: string; doe_id: string; doe_name: string | null; doe_tag: string;
  kindled_on: string; born_alive: number; born_dead: number;
  weaned_on: string | null; weaned_count: number | null;
  recorded: number | null; not_yet_recorded: number | null;
}

export function LittersPage() {
  const id = useIdentity();
  const [litters, setLitters] = useState<Litter[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ litters: Litter[] }>('/litters')
      .then((d) => setLitters(d.litters)).catch((e) => setError(e.message));
  }, []);

  return (
    <Shell {...id}>
      <PageTitle title="Litters & kits"
        sub={litters ? `${litters.length} litter${litters.length === 1 ? '' : 's'} recorded` : undefined} />
      {error && <p className="mb-4 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">{error}</p>}
      {litters?.length === 0 && (
        <Empty>No litters yet. Record a mating on the Breeding page and a kindling follows.</Empty>
      )}
      {litters && litters.length > 0 && (
        <Table head={['Doe', 'Kindled', 'Born alive', 'Born dead', 'Weaned', 'Kits recorded individually']}>
          {litters.map((l) => (
            <tr key={l.id} className="border-b border-farm-rule last:border-0">
              <td className="px-4 py-2.5">
                <Link to={`/dashboard/herd/${l.doe_id}`} className="font-semibold text-farm-accent">
                  {l.doe_name ?? l.doe_tag}
                </Link>
              </td>
              <td className="px-4 py-2.5">{l.kindled_on}</td>
              <td className="px-4 py-2.5 font-semibold">{l.born_alive}</td>
              <td className="px-4 py-2.5">{l.born_dead}</td>
              <td className="px-4 py-2.5">
                {l.weaned_on ? `${l.weaned_count} on ${l.weaned_on}` : 'not yet'}
              </td>
              <td className="px-4 py-2.5 text-farm-muted">
                {l.recorded ?? 0} of {l.born_alive}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Shell>
  );
}
