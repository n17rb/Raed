import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import type { CustomerProfile, PublicConfig, SessionTokens } from '@rayed/api-client';
import { api, onSessionExpired, socket, tokenStorage } from '../lib/api';
import { clearCache, readCache, writeCache } from '../lib/cache';
import { registerForPush } from '../lib/push';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface SessionValue {
  status: Status;
  profile: CustomerProfile | null;
  config: PublicConfig | null;
  connected: boolean;
  signIn: (tokens: SessionTokens) => Promise<CustomerProfile | null>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  setProfile: (update: (profile: CustomerProfile) => CustomerProfile) => void;
  refreshConfig: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfileState] = useState<CustomerProfile | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [connected, setConnected] = useState(false);
  const signedIn = useRef(false);

  const refreshConfig = useCallback(async () => {
    try {
      const next = await api.get<PublicConfig>('/api/v1/config', { auth: false });
      setConfig(next);
      await writeCache('config', next);
    } catch {
      const cached = await readCache<PublicConfig>('config');
      if (cached) setConfig(cached);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const next = await api.get<CustomerProfile>('/api/v1/auth/me');
      setProfileState(next);
      await writeCache('profile', next);
    } catch {
      // Offline: keep the cached profile.
    }
  }, []);

  const startRealtime = useCallback(() => {
    if (!socket.connected) socket.connect();
  }, []);

  const signOut = useCallback(async () => {
    signedIn.current = false;
    try {
      await api.post('/api/v1/auth/logout');
    } catch {
      // The session is removed locally either way.
    }
    socket.disconnect();
    await tokenStorage.set(null);
    await clearCache();
    setProfileState(null);
    setStatus('signedOut');
  }, []);

  const signIn = useCallback(
    async (tokens: SessionTokens) => {
      await tokenStorage.set(tokens);
      signedIn.current = true;
      let next: CustomerProfile | null = null;
      try {
        next = await api.get<CustomerProfile>('/api/v1/auth/me');
        setProfileState(next);
        await writeCache('profile', next);
      } catch {
        next = null;
      }
      setStatus('signedIn');
      startRealtime();
      void registerForPush();
      return next;
    },
    [startRealtime]
  );

  // Boot: restore the session from secure storage, show cached data at once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [tokens, cachedProfile, cachedConfig] = await Promise.all([
        tokenStorage.get(),
        readCache<CustomerProfile>('profile'),
        readCache<PublicConfig>('config'),
      ]);
      if (cancelled) return;
      if (cachedConfig) setConfig(cachedConfig);
      void refreshConfig();
      if (!tokens) {
        setStatus('signedOut');
        return;
      }
      signedIn.current = true;
      if (cachedProfile) setProfileState(cachedProfile);
      setStatus('signedIn');
      startRealtime();
      void refreshProfile();
      void registerForPush();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshConfig, refreshProfile, startRealtime]);

  useEffect(() => {
    const unsubscribe = onSessionExpired(() => {
      if (!signedIn.current) return;
      signedIn.current = false;
      socket.disconnect();
      void clearCache();
      setProfileState(null);
      setStatus('signedOut');
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onNotification = () => setProfileState((current) => (current ? { ...current, unreadNotifications: current.unreadNotifications + 1 } : current));
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('notification:new', onNotification);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('notification:new', onNotification);
    };
  }, []);

  // Reconnect and refresh when the app returns to the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && signedIn.current) {
        startRealtime();
        void refreshProfile();
      }
    });
    return () => subscription.remove();
  }, [refreshProfile, startRealtime]);

  const setProfile = useCallback((update: (profile: CustomerProfile) => CustomerProfile) => {
    setProfileState((current) => {
      if (!current) return current;
      const next = update(current);
      void writeCache('profile', next);
      return next;
    });
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ status, profile, config, connected, signIn, signOut, refreshProfile, setProfile, refreshConfig }),
    [status, profile, config, connected, signIn, signOut, refreshProfile, setProfile, refreshConfig]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
