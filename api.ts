'use client';

import { ApiError, createApiClient, type SessionTokens, type TokenStorage } from '@rayed/api-client';

const STORAGE_KEY = 'rayed.admin.session';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
export const GOOGLE_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_WEB_KEY ?? '';

/** Admin API prefix. */
export const A = '/api/v1/admin';

function readTokens(): SessionTokens | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SessionTokens) : null;
  } catch {
    return null;
  }
}

export const tokenStorage: TokenStorage = {
  async get() {
    return readTokens();
  },
  async set(tokens) {
    if (typeof window === 'undefined') return;
    try {
      if (tokens) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable (private mode) — the session lives only in memory for this tab */
    }
  },
};

export function hasStoredSession(): boolean {
  return readTokens() !== null;
}

let expiredHandled = false;

function handleSessionExpired(): void {
  if (typeof window === 'undefined' || expiredHandled) return;
  void tokenStorage.set(null);
  if (window.location.pathname.startsWith('/login')) return;
  expiredHandled = true;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.replace(`/login?expired=1&next=${next}`);
}

export const api = createApiClient({
  baseUrl: API_URL,
  storage: tokenStorage,
  onSessionExpired: handleSessionExpired,
  timeoutMs: 25_000,
});

/** The Arabic message to show for any failure (API messages are already Arabic). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403 && error.code === 'FORBIDDEN') return error.message || 'ليس لديك صلاحية لتنفيذ هذا الإجراء';
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'حدث خطأ، حاول مرة أخرى';
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiError && error.isNetwork;
}

export { ApiError };
