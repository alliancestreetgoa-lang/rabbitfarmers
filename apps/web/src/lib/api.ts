/**
 * The web app's session and API access, in one place.
 *
 * The session lands in localStorage or sessionStorage depending on the
 * "keep me signed in" choice at sign-in, so reads check both. A 401 clears it
 * and returns the person to sign-in — a dashboard rendering stale zeros after a
 * session dies is worse than a clean redirect.
 */

export interface Session {
  token: string;
  farm: { id: string; name?: string };
  user: { id: string; name: string; role: string; email?: string; phone?: string };
}

const KEY = 'rf.session';
/*
 * The full app (the Expo export under /app, same origin) keeps its session in
 * localStorage under these keys. One person, one origin, one login: signing in
 * here writes the session in BOTH dialects, so opening any card lands in the
 * app already signed in — and signing in over there first is honoured here via
 * the fallback in getSession. Asking a farmer to sign in twice on one website
 * is how they conclude it is broken.
 */
const APP_TOKEN_KEY = 'rb.token';
const APP_SESSION_KEY = 'rb.session';

export function saveSession(session: Session, remember: boolean) {
  const store = remember ? window.localStorage : window.sessionStorage;
  store.setItem(KEY, JSON.stringify(session));
  // The app has no sessionStorage mode; its session always persists. That is
  // its own long-standing behaviour, not something this write introduces.
  window.localStorage.setItem(APP_TOKEN_KEY, session.token);
  window.localStorage.setItem(APP_SESSION_KEY, JSON.stringify(session));
}

export function getSession(): Session | null {
  const raw = window.localStorage.getItem(KEY)
    ?? window.sessionStorage.getItem(KEY)
    // Signed in inside the full app first? Same person, same origin — honour it.
    ?? window.localStorage.getItem(APP_SESSION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as Session; } catch { return null; }
}

export function clearSession() {
  window.localStorage.removeItem(KEY);
  window.sessionStorage.removeItem(KEY);
  window.localStorage.removeItem(APP_TOKEN_KEY);
  window.localStorage.removeItem(APP_SESSION_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const session = getSession();
  const res = await fetch(`/api${path}`, {
    headers: session ? { authorization: `Bearer ${session.token}` } : {},
  });
  if (res.status === 401) {
    clearSession();
    window.location.href = '/';
    throw new ApiError(401, 'Signed out');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export async function apiPost<T>(path: string, data?: unknown): Promise<T> {
  const session = getSession();
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

/**
 * Where the complete product lives — the full app, same credentials. It is
 * served under /app on the same origin (the Expo export's baseUrl agrees);
 * in dev the Vite server has no /app, so it points at the one-origin site.
 */
export const FULL_APP_URL = import.meta.env.DEV ? 'http://localhost:8080/app' : '/app';
