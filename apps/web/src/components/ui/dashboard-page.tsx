'use client';

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown, ExternalLink, Loader2, LogOut, ShieldOff, Smartphone,
} from 'lucide-react';
import {
  apiGet, apiPost, clearSession, getSession, FULL_APP_URL, type Session,
} from '@/lib/api';

/**
 * The owner's cockpit — deliberately NOT the phone app.
 *
 * The phone is a task list for a person standing in a shed: one column, big
 * targets, "what do I do next". This screen is for the same person sitting
 * down: how is the farm doing, in four numerals readable from across a desk,
 * with everything urgent surfaced beneath. The two share a palette and the
 * Georgia display face so they read as one product, and nothing else.
 *
 * Every action still lives in the full app — the cards say so honestly and
 * deep-link into it — because a half-working record form is worse than a
 * clearly labelled door. The web grows its own record flows screen by screen;
 * until each exists, its card opens the app.
 */

interface Summary {
  herd: { total: number; bucks: number; does: number; growers: number };
  pregnant: {
    total_pregnant: number; confirmed_pregnant: number;
    presumed_pregnant: number; due_within_7_days: number;
  };
  ready: { ready: number; overdue: number };
  kits: { unweaned: number; litters_open: number; weaned_total: number };
  health: { open_conditions: number; doses_due: number };
  today: { open: number; urgent: number };
  team: { staff: number };
}

interface Me {
  user: { id: string; name: string; role: string };
  farm: { id: string; name: string; city: string | null; state: string | null };
}

interface ApkInfo {
  available: boolean;
  version?: string;
  size_bytes?: number;
  published_at?: string;
}

interface DailyItem {
  ref_id: string; title: string; tag: string | null;
  urgency: 'critical' | 'high' | 'medium' | string; due_on: string | null;
}

const URGENCY_DOT: Record<string, string> = {
  critical: 'bg-farm-crit',
  high: 'bg-farm-warn',
  medium: 'bg-farm-accent',
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 4) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function Kpi({ label, value, sub, tone }: {
  label: string; value: number; sub: string; tone?: 'warn';
}) {
  return (
    <div
      className={`rounded-xl border bg-farm-surface p-5 ${
        tone === 'warn' && value > 0 ? 'border-farm-warn/40' : 'border-farm-rule'
      }`}
    >
      <p className="text-[11px] font-bold tracking-[0.12em] text-farm-muted uppercase">{label}</p>
      <p
        className={`mt-2 font-display text-5xl leading-none ${
          tone === 'warn' && value > 0 ? 'text-farm-warn' : 'text-farm-ink'
        }`}
      >
        {value}
      </p>
      <p className="mt-2 text-sm leading-snug text-farm-ink-soft">{sub}</p>
    </div>
  );
}

function Card({ title, desc, badge, href }: {
  title: string; desc: string; badge?: string; href: string;
}) {
  return (
    <a
      href={href}
      className="group flex flex-col rounded-xl border border-farm-rule bg-farm-surface p-5 transition-colors hover:border-farm-accent"
    >
      <p className="font-display text-xl text-farm-ink">
        {title}
        {badge && (
          <span className="ml-2 rounded bg-farm-accent-soft px-1.5 py-0.5 align-middle text-[11px] font-bold text-farm-accent">
            {badge}
          </span>
        )}
      </p>
      <p className="mt-1.5 flex-1 text-sm leading-relaxed text-farm-muted">{desc}</p>
      <p className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-farm-accent">
        Open in the app <ExternalLink className="h-3.5 w-3.5" />
      </p>
    </a>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [session] = useState<Session | null>(() => getSession());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [daily, setDaily] = useState<DailyItem[]>([]);
  const [apk, setApk] = useState<ApkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session) { navigate('/', { replace: true }); return; }
    Promise.all([
      apiGet<Summary>('/summary'),
      apiGet<{ items: DailyItem[] }>('/daily'),
      // The signin response carries only the farm's id; /auth/me has its name.
      apiGet<Me>('/auth/me'),
    ])
      .then(([s, d, m]) => { setSummary(s); setDaily(d.items ?? []); setMe(m); })
      .catch((e) => setError(e.message));
    // Separate and forgiving: the dashboard must not fail because GitHub is slow.
    fetch('/api/download/apk/info')
      .then((r) => r.json())
      .then(setApk)
      .catch(() => setApk({ available: false }));
  }, [session, navigate]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const signOut = async (everywhere: boolean) => {
    try { await apiPost(`/auth/signout${everywhere ? '?all=1' : ''}`); } catch { /* signed out regardless */ }
    clearSession();
    navigate('/', { replace: true });
  };

  if (!session) return null;

  const urgent = daily.filter((i) => i.urgency === 'critical').slice(0, 3);
  const farmName = me?.farm?.name ?? session.farm?.name ?? 'Your farm';
  const userName = me?.user?.name ?? session.user?.name ?? 'there';
  const userRole = me?.user?.role ?? session.user?.role ?? '';
  const empty = summary !== null && summary.herd.total === 0 && summary.kits.unweaned === 0;

  return (
    <div className="min-h-screen bg-farm-ground">
      {/* ---- top bar ---- */}
      <header className="border-b border-farm-rule bg-farm-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3.5">
          <p className="font-display text-lg">
            <span className="text-farm-accent">rabbit</span>
            <span className="text-[#5a3a22]">farmers</span>
          </p>
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
                  <p className="mt-0.5 text-xs capitalize text-farm-muted">
                    {userRole} · {farmName}
                  </p>
                </div>
                <a href={FULL_APP_URL}
                   className="flex items-center gap-2.5 px-4 py-2.5 text-sm hover:bg-farm-ground">
                  <Smartphone className="h-4 w-4 opacity-70" /> Open the full app
                </a>
                <div className="border-t border-farm-rule" />
                <button
                  onClick={() => signOut(false)}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-bold text-farm-crit hover:bg-farm-crit-soft"
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
                <button
                  onClick={() => signOut(true)}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-farm-crit hover:bg-farm-crit-soft"
                >
                  <ShieldOff className="h-4 w-4" /> Sign out on all devices
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="font-display text-3xl">
          {greeting()}, {userName.split(' ')[0]}.
        </h1>
        <p className="mt-1 text-sm text-farm-muted">
          {new Date().toLocaleDateString('en-IN', {
            weekday: 'long', day: 'numeric', month: 'long',
          })}
          {summary && ` · ${summary.today.open} to do${
            summary.today.urgent ? ` · ${summary.today.urgent} urgent` : ''}`}
        </p>

        {error && (
          <p className="mt-6 rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit">
            {error}
          </p>
        )}

        {!summary && !error && (
          <div className="mt-16 flex justify-center text-farm-muted">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}

        {/* ---- a farm with nothing in it yet ---- */}
        {summary && empty && (
          <div className="mt-8 rounded-xl border border-farm-rule bg-farm-surface p-8 text-center">
            <p className="font-display text-2xl">Your farm is ready.</p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-farm-muted">
              Add your first rabbits and the dashboard fills itself in — pregnancies,
              kits, and the day's work will all appear here.
            </p>
            <a
              href={FULL_APP_URL}
              className="mt-5 inline-block rounded-xl bg-farm-accent px-5 py-3 text-sm font-semibold text-white"
            >
              Add your first rabbit →
            </a>
          </div>
        )}

        {/* ---- the four numerals ---- */}
        {summary && !empty && (
          <>
            <div className="mt-7 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Kpi label="In the herd" value={summary.herd.total}
                   sub={`${summary.herd.bucks} bucks · ${summary.herd.does} does`} />
              <Kpi label="Pregnant" value={summary.pregnant.total_pregnant}
                   sub={`${summary.pregnant.confirmed_pregnant} confirmed · ${summary.pregnant.presumed_pregnant} presumed${
                     summary.pregnant.due_within_7_days
                       ? ` · ${summary.pregnant.due_within_7_days} due this week` : ''}`} />
              <Kpi label="Ready to mate" value={summary.ready.ready} tone="warn"
                   sub={summary.ready.overdue
                     ? `${summary.ready.overdue} overdue` : 'none overdue'} />
              <Kpi label="Kits" value={summary.kits.unweaned}
                   sub={`unweaned · ${summary.kits.litters_open} open litter${
                     summary.kits.litters_open === 1 ? '' : 's'} · ${summary.kits.weaned_total} weaned`} />
            </div>

            {/* ---- what needs a look ---- */}
            {urgent.length > 0 && (
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                {urgent.map((i) => (
                  <a key={i.ref_id} href={FULL_APP_URL}
                     className="flex items-center gap-3 rounded-xl border border-farm-rule bg-farm-surface px-4 py-3 hover:border-farm-accent">
                    <span className={`h-2.5 w-2.5 flex-none rounded-full ${
                      URGENCY_DOT[i.urgency] ?? 'bg-farm-accent'}`} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{i.title}</span>
                      {i.tag && <span className="text-xs text-farm-muted">{i.tag}</span>}
                    </span>
                  </a>
                ))}
              </div>
            )}

            {/* ---- everything else ---- */}
            <p className="mt-9 mb-3 flex items-center gap-3 text-[11px] font-bold tracking-[0.14em] text-farm-muted uppercase">
              Everything else <span className="h-px flex-1 bg-farm-rule" />
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card title="Today" href={FULL_APP_URL}
                    badge={summary.today.open ? String(summary.today.open) : undefined}
                    desc="The day's work — medicine rounds, checks, nest boxes." />
              <Card title="Breeding" href={FULL_APP_URL}
                    desc="Record a mating, palpation check, kindling." />
              <Card title="Herd" href={FULL_APP_URL}
                    desc={`All ${summary.herd.total} rabbits, their state and history.`} />
              <Card title="Health" href={FULL_APP_URL}
                    badge={summary.health.open_conditions ? String(summary.health.open_conditions) : undefined}
                    desc={summary.health.doses_due
                      ? `${summary.health.doses_due} medicine doses due.`
                      : 'Log a condition, medicine protocols.'} />
              <Card title="Team" href={FULL_APP_URL}
                    desc={`${summary.team.staff} on the farm. Hire, logins, roles.`} />
              <Card title="Attendance" href={FULL_APP_URL}
                    desc="Who worked which day. Month totals, CSV." />
              <Card title="Litters & kits" href={FULL_APP_URL}
                    desc={`${summary.kits.unweaned} kits to record individually or wean.`} />
              <div className="flex flex-col rounded-xl border border-farm-accent-soft bg-gradient-to-b from-farm-accent-soft/40 to-farm-surface p-5">
                <p className="font-display text-xl text-farm-ink">Android app</p>
                <p className="mt-1.5 flex-1 text-sm leading-relaxed text-farm-muted">
                  {apk?.available
                    ? `${apk.version} · ${((apk.size_bytes ?? 0) / 1024 / 1024).toFixed(0)} MB — install on a phone for the shed. Works offline.`
                    : 'Install on a phone for the shed — works offline.'}
                </p>
                {apk?.available ? (
                  <a
                    href="/api/download/apk"
                    className="mt-3 rounded-lg bg-farm-accent px-4 py-2.5 text-center text-sm font-semibold text-white"
                  >
                    Download APK
                  </a>
                ) : (
                  <span className="mt-3 rounded-lg border border-farm-rule bg-farm-surface-alt px-4 py-2.5 text-center text-sm font-semibold text-farm-muted">
                    {apk === null ? 'Checking…' : 'Not published yet'}
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
