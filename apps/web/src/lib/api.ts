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

export function getSession(): Session | null {
  const raw = window.localStorage.getItem(KEY) ?? window.sessionStorage.getItem(KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as Session; } catch { return null; }
}

export function clearSession() {
  window.localStorage.removeItem(KEY);
  window.sessionStorage.removeItem(KEY);
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

/** Where the complete product lives — the full app, same credentials. */
export const FULL_APP_URL = import.meta.env.DEV ? 'http://localhost:8080' : '/';
