'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { RealtimeProvider } from '@/lib/realtime';
import { Shell } from '@/components/Shell';
import { Button, Spinner } from '@/components/ui';
import { Icon } from '@/components/Icon';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { status, profile, error, reload } = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? '/';

  useEffect(() => {
    if (status === 'unauthenticated') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);

  if (status === 'offline') {
    return (
      <div className="full-center">
        <span className="empty-icon">
          <Icon name="alert" size={26} />
        </span>
        <h1 className="page-title">لا يوجد اتصال بالإنترنت</h1>
        <p className="muted">{error ?? 'تعذر الوصول إلى الخادم'}</p>
        <Button variant="primary" icon="refresh" onClick={() => void reload()}>
          إعادة المحاولة
        </Button>
      </div>
    );
  }

  if (status !== 'authenticated' || !profile) {
    return (
      <div className="full-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="رايد" style={{ height: 48 }} />
        <Spinner size={26} />
      </div>
    );
  }

  return (
    <RealtimeProvider>
      <Shell>{children}</Shell>
    </RealtimeProvider>
  );
}
