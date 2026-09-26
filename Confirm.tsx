'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button, ErrorBanner, Field, Textarea } from './ui';
import { errorMessage } from '@/lib/api';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Ask for a reason (sent to the action). */
  reason?: { label: string; required?: boolean; minLength?: number; placeholder?: string };
  /** Extra form content rendered above the reason (e.g. an amount summary). */
  details?: ReactNode;
  /** Runs when confirmed; errors are shown inside the dialog and it stays open. */
  action: (reason: string) => Promise<unknown>;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    setOptions(next);
    setReason('');
    setError(null);
    setBusy(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (result: boolean) => {
    if (busy) return;
    resolver.current?.(result);
    resolver.current = null;
    setOptions(null);
  };

  const minLength = options?.reason?.minLength ?? (options?.reason?.required ? 2 : 0);
  const reasonInvalid = Boolean(options?.reason?.required) && reason.trim().length < minLength;

  const submit = async () => {
    if (!options || reasonInvalid) return;
    setBusy(true);
    setError(null);
    try {
      await options.action(reason.trim());
      resolver.current?.(true);
      resolver.current = null;
      setOptions(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={options !== null}
        onClose={() => close(false)}
        title={options?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)} disabled={busy}>
              تراجع
            </Button>
            <Button variant={options?.danger ? 'danger' : 'primary'} onClick={() => void submit()} loading={busy} disabled={reasonInvalid}>
              {options?.confirmLabel ?? 'تأكيد'}
            </Button>
          </>
        }
      >
        {options?.message ? <div className="confirm-message">{options.message}</div> : null}
        {options?.details}
        {options?.reason ? (
          <Field label={options.reason.label} required={options.reason.required} hint={minLength > 0 ? `${minLength} أحرف على الأقل` : undefined}>
            <Textarea rows={3} value={reason} placeholder={options.reason.placeholder} onChange={(event) => setReason(event.target.value)} autoFocus />
          </Field>
        ) : null}
        <ErrorBanner message={error} />
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error('useConfirm must be used inside ConfirmProvider');
  return context;
}
