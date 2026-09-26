'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AdminProfile, SessionTokens } from '@rayed/api-client';
import { api, errorMessage, hasStoredSession, isNetworkError, tokenStorage } from './api';

type Status = 'loading' | 'authenticated' | 'unauthenticated' | 'offline';

interface LoginResult {
  tokens: SessionTokens;
  admin: { id: string; phone: string; fullName: string | null; permissions: string[] };
}

export interface OtpRequestResult {
  expiresInSeconds: number;
  resendAfterSeconds: number;
  demo: boolean;
  codeLength: number;
}

interface AuthContextValue {
  status: Status;
  profile: AdminProfile | null;
  error: string | null;
  can: (permission: string) => boolean;
  canAny: (permissions: string[]) => boolean;
  isSuperAdmin: boolean;
  /** Step 1: send a 4-digit code to the admin's phone. */
  requestCode: (phone: string) => Promise<OtpRequestResult>;
  /** Step 2: verify the code and start the session. */
  login: (phone: string, code: string) => Promise<AdminProfile>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProfile = useCallback(async (): Promise<AdminProfile | null> => {
    const me = await api.get<AdminProfile>('/api/v1/auth/me');
    if (me.app !== 'ADMIN') {
      await tokenStorage.set(null);
      return null;
    }
    return me;
  }, []);

  const reload = useCallback(async () => {
    if (!hasStoredSession()) {
      setProfile(null);
      setStatus('unauthenticated');
      return;
    }
    setStatus((current) => (current === 'authenticated' ? current : 'loading'));
    try {
      const me = await loadProfile();
      setProfile(me);
      setError(null);
      setStatus(me ? 'authenticated' : 'unauthenticated');
    } catch (caught) {
      if (isNetworkError(caught)) {
        setError(errorMessage(caught));
        setStatus('offline');
        return;
      }
      setError(errorMessage(caught));
      if (!hasStoredSession()) {
        setProfile(null);
        setStatus('unauthenticated');
      } else {
        setStatus('offline');
      }
    }
  }, [loadProfile]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const requestCode = useCallback(
    (phone: string) => api.post<OtpRequestResult>('/api/v1/auth/admin/otp/request', { phone }, { auth: false }),
    []
  );

  const login = useCallback(
    async (phone: string, code: string) => {
      const result = await api.post<LoginResult>('/api/v1/auth/admin/otp/verify', { phone, code }, { auth: false });
      await tokenStorage.set(result.tokens);
      const me = await loadProfile();
      if (!me) throw new Error('هذا الحساب ليس حساب إدارة');
      setProfile(me);
      setError(null);
      setStatus('authenticated');
      return me;
    },
    [loadProfile]
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } catch {
      /* the session is cleared locally either way */
    }
    await tokenStorage.set(null);
    setProfile(null);
    setStatus('unauthenticated');
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const permissions = new Set(profile?.permissions ?? []);
    return {
      status,
      profile,
      error,
      can: (permission: string) => permissions.has(permission),
      canAny: (list: string[]) => list.some((permission) => permissions.has(permission)),
      isSuperAdmin: Boolean(profile?.roles.some((role) => role.code === 'SUPER_ADMIN')),
      requestCode,
      login,
      logout,
      reload,
    };
  }, [status, profile, error, requestCode, login, logout, reload]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
