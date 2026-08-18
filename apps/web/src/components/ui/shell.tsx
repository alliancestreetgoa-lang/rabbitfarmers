'use client';

import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, ShieldOff } from 'lucide-react';
import { apiPost, clearSession, getSession } from '@/lib/api';

/**
 * The frame around every signed-in web screen: wordmark, section nav, account
 * menu. On a laptop the cards open real web pages — this nav is how those pages
 * hang together. The phone-style app stays reachable from the account menu
 * only, for the person who wants it; nothing on a laptop funnels there.
 */

const NAV = [
  { to: '/dashboard', label: 'Overview', end: true },
  { to: '/dashboard/today', label: 'Today' },
  { to: '/dashboard/herd', label: 'Herd' },
  { to: '/dashboard/breeding', label: 'Breeding' },
  { to: '/dashboard/litters', label: 'Litters' },
  { to: '/dashboard/sick', label: 'Sick rabbit' },
  { to: '/dashboard/health', label: 'Health' },
  { to: '/dashboard/team', label: 'Team', staffOnly: true },
  { to: '/dashboard/attendance', label: 'Attendance', staffOnly: true },
];

/**
 * Who sees Team and Attendance — mirrors the server's staff:read matrix. A farm
 * hand or vet given a login sees their own work, not the rest of the team; the
 * server enforces this, the nav simply stops offering doors that will not open.
 */
export const seesTeam = (role: string) => ['owner', 'manager', 'accountant'].includes(role);

export function Shell({ farmName, userName, userRole, children }: {
  farmName: string; userName: string; userRole: string; children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const signOut = async (everywhere: boolean) => {
    try { await apiPost(`/auth/signout${everywhere ? '?all=1' : ''}`); } catch { /* out anyway */ }
    clearSession();
    navigate('/', { replace: true });
  };

  return (
    <div className="min-h-screen bg-farm-ground">
      <header className="border-b border-farm-rule bg-farm-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 pt-3.5">
          <div className="flex items-center gap-2.5">
            <img src="/mark.png" alt="" className="h-10 w-10 rounded-full" />
            <p className="font-display text-lg font-bold">
              <span className="text-farm-accent">rabbit</span>
              <span className="text-farm-brown">farmers</span>
            </p>
          </div>
          <span className="hidden border-l border-farm-rule pl-4 text-sm text-farm-muted sm:inline">
            {farmName}
          </span>
          <div className="flex-1" />
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-lg border border-farm-rule bg-farm-surface-alt px-3 py-2 text-sm font-semibold"
            >
              {userName}
              <ChevronDown className={`h-4 w-4 transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-11 z-10 w-64 overflow-hidden rounded-xl border border-farm-rule bg-farm-surface shadow-lg">
                <div className="border-b border-farm-rule bg-farm-surface-alt px-4 py-3">
                  <p className="font-display">{userName}</p>
                  <p className="mt-0.5 text-xs capitalize text-farm-muted">{userRole} · {farmName}</p>
                </div>
                <button onClick={() => signOut(false)}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-bold text-farm-crit hover:bg-farm-crit-soft">
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
                <button onClick={() => signOut(true)}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-farm-crit hover:bg-farm-crit-soft">
                  <ShieldOff className="h-4 w-4" /> Sign out on all devices
                </button>
              </div>
            )}
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-6 pt-2">
          {NAV.filter((n) => !n.staffOnly || seesTeam(userRole)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) =>
                `whitespace-nowrap border-b-2 px-3 pb-2 text-sm font-semibold transition-colors ${
                  isActive
                    ? 'border-farm-accent text-farm-accent'
                    : 'border-transparent text-farm-muted hover:text-farm-ink'
                }`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}

/** Session + /me identity for any page under the shell; bounces if signed out. */
export function useIdentity() {
  const navigate = useNavigate();
  const [session] = useState(() => getSession());
  const [me, setMe] = useState<{
    user: { name: string; role: string };
    farm: { id: string; name: string };
  } | null>(null);

  useEffect(() => {
    if (!session) { navigate('/', { replace: true }); return; }
    import('@/lib/api').then(({ apiGet }) =>
      apiGet<NonNullable<typeof me>>('/auth/me').then(setMe).catch(() => {}));
  }, [session, navigate]);

  return {
    session,
    farmName: me?.farm?.name ?? session?.farm?.name ?? 'Your farm',
    userName: me?.user?.name ?? session?.user?.name ?? 'there',
    userRole: me?.user?.role ?? session?.user?.role ?? '',
  };
}

/* ---- small shared pieces the pages compose ---- */

export function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-6">
      <h1 className="font-display text-3xl">{title}</h1>
      {sub && <p className="mt-1 text-sm text-farm-muted">{sub}</p>}
    </div>
  );
}

export function Section({ title, children, action }: {
  title: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-[11px] font-bold tracking-[0.14em] text-farm-muted uppercase">{title}</h2>
        <span className="h-px flex-1 bg-farm-rule" />
        {action}
      </div>
      {children}
    </section>
  );
}

export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-farm-rule bg-farm-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-farm-rule bg-farm-surface-alt text-left">
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 text-[11px] font-bold tracking-wider text-farm-muted uppercase">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-farm-rule bg-farm-surface p-8 text-center text-sm text-farm-muted">
      {children}
    </div>
  );
}

export function Btn({ children, onClick, tone = 'accent', disabled, type = 'button' }: {
  children: React.ReactNode; onClick?: () => void;
  tone?: 'accent' | 'quiet' | 'crit'; disabled?: boolean; type?: 'button' | 'submit';
}) {
  const tones = {
    accent: 'bg-farm-accent text-white',
    quiet: 'border border-farm-rule bg-farm-surface text-farm-ink',
    crit: 'border border-farm-crit/40 bg-farm-crit-soft text-farm-crit',
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`rounded-lg px-3.5 py-2 text-sm font-semibold disabled:opacity-50 ${tones[tone]}`}>
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props}
      className={`rounded-lg border border-farm-rule bg-farm-surface px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-farm-accent ${props.className ?? ''}`} />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props}
      className={`rounded-lg border border-farm-rule bg-farm-surface px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-farm-accent ${props.className ?? ''}`} />
  );
}
