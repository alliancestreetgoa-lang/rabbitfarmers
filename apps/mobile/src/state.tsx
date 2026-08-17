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

/** A server address the farmer typed in, on a build that had none. */
const SERVER_KEY = 'rb.server';

const trimUrl = (u: string) => u.trim().replace(/\/+$/, '');

/**
 * Baked in at build time. An absolute URL wins outright: it is how a native
 * build finds the server, and how a developer points a web build at localhost.
 */
function bakedApiUrl(): string | null {
  const configured = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  return configured?.startsWith('http') ? trimUrl(configured) : null;
}

/**
 * The origin that served the page. Netlify puts the app and the function on one
 * site, so `/api` here is the same deploy — which is why one web build works on
 * a preview, a branch deploy and production without being told which it is.
 */
function sameOriginApiUrl(): string | null {
  if (typeof window !== 'undefined' && window.location) return `${window.location.origin}/api`;
  return null;
}

/**
 * Where the API lives, in order: baked in, then typed in, then the origin that
 * served the page, then the dev server for a bare Node process in tests.
 */
function resolveApiUrl(stored?: string | null): string {
  return bakedApiUrl()
    ?? (stored ? trimUrl(stored) : null)
    ?? sameOriginApiUrl()
    ?? 'http://localhost:3000';
}

/**
 * An installed app has no origin to fall back on.
 *
 * A web build is served by the same site as the API, so it can work that out
 * for itself. An APK cannot: it is a file on a phone, and unless the address
 * was compiled into it there is nothing to ask. Left unhandled that is an app
 * which installs, opens, and silently fails every request — the worst possible
 * first five minutes.
 *
 * So a build with no address asks for one, once, on the sign-in screen. Setting
 * EXPO_PUBLIC_API_URL at build time is still the right answer for an app handed
 * to farmers; this is what makes a build without it usable rather than inert.
 */
function needsServerAddress(): boolean {
  return bakedApiUrl() === null && sameOriginApiUrl() === null;
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
  /** The API this build is talking to. Shown so a wrong one is diagnosable. */
  serverUrl: string;
  /** True on an installed app with no address compiled in — it has to ask. */
  canSetServer: boolean;
  /** Checks the address answers before keeping it. Throws if it does not. */
  setServerUrl(url: string): Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [pending, setPending] = useState<OutboxEntry[]>([]);
  const [offline, setOffline] = useState(false);
  const [serverUrl, setServerUrlState] = useState(() => resolveApiUrl());

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
      // Before anything is fetched: an installed app may have been told where
      // its server is on a previous run, and the session below is about to be
      // checked against it.
      const stored = await asyncStorage.get(SERVER_KEY);
      const url = resolveApiUrl(stored);
      client.setBaseUrl(url);
      setServerUrlState(url);

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

  /**
   * Point the app at a server, having checked that something is there.
   *
   * The check is the point. A typo saved silently turns every screen into "no
   * connection" with no hint that the address is the problem, and the person
   * typing it is a farmer reading a URL off a piece of paper.
   */
  const setServerUrl = useCallback(async (input: string) => {
    const url = trimUrl(input);
    if (!/^https?:\/\/.+/i.test(url)) {
      throw new Error('That should start with https:// and be the address of your Rabbitry site');
    }

    // /health is unauthenticated and cheap, and answering it is exactly the
    // thing being checked.
    let ok = false;
    try {
      const res = await fetch(`${url}/health`, { headers: { accept: 'application/json' } });
      ok = res.ok;
    } catch { ok = false; }
    if (!ok) throw new Error(`Nothing answered at ${url}. Check the address and your signal.`);

    await asyncStorage.set(SERVER_KEY, url);
    client.setBaseUrl(url);
    setServerUrlState(url);
  }, [client]);

  const value: AppState = {
    ready, session, readOnly: !!session?.support, client, outbox, pending, offline,
    signIn, signUp, signOut, setOffline, refreshOutbox,
    serverUrl, canSetServer: needsServerAddress(), setServerUrl,
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
