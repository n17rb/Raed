'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++counter;
    setItems((current) => [...current.slice(-3), { id, kind, message }]);
    setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message),
      info: (message) => push('info', message),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.kind}`}>
            <Icon name={item.kind === 'error' ? 'alert' : item.kind === 'success' ? 'check' : 'bell'} size={18} />
            <span>{item.message}</span>
            <button type="button" className="icon-button" aria-label="إغلاق" onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}>
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
