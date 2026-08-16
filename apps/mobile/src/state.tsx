import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import { ApiClient, OfflineError } from './api/client';
import { Outbox, type OutboxEntry } from './api/outbox';
import type { Storage } from './api/storage';
import type { Session } from './api/types';

const asyncStorage: Storage = {
  get: (k) => AsyncStorage.getItem(k),
  set: (k, v) => AsyncStorage.setItem(k, v),
  remove: (k) => AsyncStorage.removeItem(k),
};

/**
 * Where the API lives.
 *
 * Three cases, in order:
 *
 *  1. EXPO_PUBLIC_API_URL was set at build time — an absolute URL wins outright.
 *     This is how a native build finds the server, and how a developer points
 *     the web build at localhost.
 *  2. Running in a browser with nothing configured — the app was served by
 *     Netlify alongside the function, so the API is /api on this same origin.
 *     Same build works on a deploy preview and on production.
 *  3. Neither — a bare Node process in tests. Fall back to the dev server.
 */
function resolveApiUrl(): string {
  const configured = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  if (configured?.startsWith('http')) return configured.replace(/\/$/, '');
  if (typeof window !== 'undefined' && window.location) return `${window.location.origin}/api`;
  return 'http://localhost:3000';
}

/**
 * A support session handed over by the admin console, in the URL fragment.
 *
 * A fragment, not a query string, and that is the whole reason it looks like
 * this: `#support=…` is never sent to a server, so the token stays out of
 * access logs, out of the Referer header and out of any proxy in between. It is
 * taken out of the address bar the moment it is read, so a screenshot or a
 * shoulder does not carry it either.
 */
function takeSupportToken(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  const m = /(?:^#|[#&])support=([^&]+)/.exec(window.location.hash ?? '');
  if (!m?.[1]) return null;
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch { /* older browser, or no history API — the token still works */ }
  return decodeURIComponent(m[1]);
}

interface AppState {
  ready: boolean;
  session: Session | null;
  /** Support is looking. Every screen that writes refuses to open. */
  readOnly: boolean;
  client: ApiClient;
  outbox: Outbox;
  pending: OutboxEntry[];
  offline: boolean;
  signIn(email: string, password: string): Promise<void>;
  signUp(input: Parameters<ApiClient['signUp']>[0]): Promise<void>;
  signOut(): Promise<void>;
  setOffline(v: boolean): void;
  refreshOutbox(): Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [pending, setPending] = useState<OutboxEntry[]>([]);
  const [offline, setOffline] = useState(false);

  const client = useMemo(() => new ApiClient({
    baseUrl: resolveApiUrl(),
    storage: asyncStorage,
    onSignedOut: () => setSession(null),
  }), []);

  const outbox = useMemo(
    () => new Outbox(client, asyncStorage, setPending), [client]);

  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    (async () => {
      const handed = takeSupportToken();
      if (handed) {
        // A dead or already-ended link must leave the device as it found it —
        // adoptSupportToken restores the previous session if the token does not
        // resolve, so this falls through to whoever was already signed in.
        try {
          setSession(await client.adoptSupportToken(handed));
        } catch {
          setSession(await client.loadSession());
        }
      } else {
        setSession(await client.loadSession());
      }
      setPending(await outbox.load());
      setReady(true);
    })();
  }, [client, outbox]);

  // Keep trying to drain the queue in the background. A farm hand records six
  // things walking down a row with no signal; by the time they reach the house
  // it should all be gone without anyone pressing anything.
  useEffect(() => {
    if (!session) return;
    const tick = async () => {
      try {
        const r = await outbox.flush();
        setOffline(r.offline);
      } catch { /* nothing useful to do here */ }
    };
    tick();
    flushTimer.current = setInterval(tick, 30_000);
    return () => { if (flushTimer.current) clearInterval(flushTimer.current); };
  }, [session, outbox]);

  const signIn = useCallback(async (email: string, password: string) => {
    setSession(await client.signIn(email, password));
  }, [client]);

  const signUp = useCallback(async (input: Parameters<ApiClient['signUp']>[0]) => {
    setSession(await client.signUp(input));
  }, [client]);

  const signOut = useCallback(async () => {
    await client.signOut();
    setSession(null);
  }, [client]);

  const refreshOutbox = useCallback(async () => {
    setPending(await outbox.load());
  }, [outbox]);

  const value: AppState = {
    ready, session, readOnly: !!session?.support, client, outbox, pending, offline,
    signIn, signUp, signOut, setOffline, refreshOutbox,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside AppProvider');
  return v;
}

/**
 * Load something from the API, falling back to the last good copy when there is
 * no signal. `stale` lets a screen say so rather than quietly showing old data.
 */
export function useQuery<T>(key: string, fetcher: () => Promise<T>, deps: unknown[] = []) {
  const { client, ready, session } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);

  const run = useCallback(async () => {
    if (!ready || !session) return;
    setLoading(true);
    try {
      const r = await client.cached(key, fetcher);
      setData(r.data);
      setStale(r.stale);
      setError(null);
    } catch (err) {
      setError(err as Error);
      if (!(err instanceof OfflineError)) setData(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, session, key, ...deps]);

  /**
   * Refetch whenever the screen comes back into view, not only on mount.
   *
   * Expo Router keeps a screen mounted while you push another on top of it, so
   * a plain mount effect never runs again. Record a kindling and come back and
   * the doe's page still shows what it loaded before you went. That looks
   * exactly like a write that failed, which is the worst possible thing for an
   * app that people have to trust more than a paper card.
   */
  useFocusEffect(useCallback(() => { run(); }, [run]));

  return { data, error, loading, stale, reload: run };
}
