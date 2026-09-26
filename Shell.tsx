'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { NAV, isActive } from '@/lib/nav';
import { useAuth } from '@/lib/auth';
import { useRealtime, useSocketEvent } from '@/lib/realtime';
import { useApi, useDebouncedCallback } from '@/lib/hooks';
import { A } from '@/lib/api';
import { useConfirm } from './Confirm';
import styles from './Shell.module.css';

export interface DashboardStats {
  activeTrips: number;
  searchingTrips: number;
  onlineCaptains: number;
  offlineCaptains: number;
  customers: number;
  approvedCaptains: number;
  totalTrips: number;
  completedTrips: number;
  cancelledTrips: number;
  tripsToday: number;
  revenue: { grossFils: number; gross: string; commissionFils: number; commission: string; commissionToday: string };
  captainEarnings: { fils: number; display: string };
  pendingApprovals: number;
  pendingWithdrawals: number;
  pendingTransfers: number;
  openTickets: number;
}

interface StatsContextValue {
  stats: DashboardStats | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  updatedAt: number | null;
}

const StatsContext = createContext<StatsContextValue>({ stats: null, error: null, loading: false, reload: async () => undefined, updatedAt: null });

export function useDashboardStats(): StatsContextValue {
  return useContext(StatsContext);
}

const LIVE_EVENTS = [
  'trip:update',
  'captain:availability',
  'finance:transfer_proof',
  'finance:withdrawal',
  'support:ticket',
  'support:activity',
  'captains:review_queue',
];

function StatsProvider({ children }: { children: ReactNode }) {
  const { can } = useAuth();
  const enabled = can('dashboard.view');
  const { data, error, loading, reload } = useApi<DashboardStats>(enabled ? `${A}/dashboard` : null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  useEffect(() => {
    if (data) setUpdatedAt(Date.now());
  }, [data]);
  const refresh = useDebouncedCallback(() => void reload(), 1500);
  useSocketEvent(enabled ? LIVE_EVENTS : [], () => refresh());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => void reload(), 60_000);
    return () => clearInterval(timer);
  }, [enabled, reload]);
  return <StatsContext.Provider value={{ stats: data, error, loading, reload, updatedAt }}>{children}</StatsContext.Provider>;
}

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname() ?? '/';
  const { can } = useAuth();
  const { stats } = useDashboardStats();
  return (
    <nav className={styles.nav} aria-label="القائمة الرئيسية">
      {NAV.map((section) => {
        const items = section.items.filter((item) => can(item.permission));
        if (items.length === 0) return null;
        return (
          <div key={section.title} className={styles.section}>
            <span className={styles.sectionTitle}>{section.title}</span>
            {items.map((item) => {
              const count = item.badge && stats ? stats[item.badge] : 0;
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.label}
                  onClick={onNavigate}
                  className={`${styles.link}${active ? ` ${styles.linkActive}` : ''}`}
                >
                  <Icon name={item.icon} size={20} />
                  <span className={styles.linkLabel}>{item.label}</span>
                  {count > 0 ? <span className={styles.count}>{count > 99 ? '99+' : count}</span> : null}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { profile, logout } = useAuth();
  const { connected } = useRealtime();
  const confirm = useConfirm();

  useEffect(() => setOpen(false), [pathname]);

  const signOut = () =>
    void confirm({
      title: 'تسجيل الخروج',
      message: 'هل تريد تسجيل الخروج من لوحة الإدارة؟',
      confirmLabel: 'تسجيل الخروج',
      action: async () => {
        await logout();
        window.location.replace('/login');
      },
    });

  return (
    <StatsProvider>
      <div className={styles.shell}>
        <aside className={`${styles.sidebar}${open ? ` ${styles.sidebarOpen}` : ''}`}>
          <div className={styles.brand}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="رايد" className={styles.logo} />
            <span className={styles.brandText}>لوحة الإدارة</span>
            <button type="button" className={`icon-button ${styles.closeButton}`} onClick={() => setOpen(false)} aria-label="إغلاق القائمة">
              <Icon name="close" size={20} />
            </button>
          </div>
          <Sidebar onNavigate={() => setOpen(false)} />
          <div className={styles.sidebarFooter}>
            <button type="button" className={styles.link} onClick={signOut} title="تسجيل الخروج">
              <Icon name="logout" size={20} />
              <span className={styles.linkLabel}>تسجيل الخروج</span>
            </button>
          </div>
        </aside>
        {open ? <div className={styles.backdrop} onClick={() => setOpen(false)} /> : null}
        <div className={styles.main}>
          <header className={styles.topbar}>
            <button type="button" className={`icon-button ${styles.menuButton}`} onClick={() => setOpen(true)} aria-label="فتح القائمة">
              <Icon name="menu" size={22} />
            </button>
            <div className={styles.topbarSpacer} />
            <span className={`${styles.live}${connected ? ` ${styles.liveOn}` : ''}`} title={connected ? 'التحديث المباشر يعمل' : 'التحديث المباشر غير متصل'}>
              <span className={styles.liveDot} />
              {connected ? 'مباشر' : 'غير متصل'}
            </span>
            <div className={styles.user}>
              <span className={styles.userName}>{profile?.fullName ?? profile?.phone}</span>
              <span className={styles.userRole}>{profile?.roles.map((role) => role.name).join('، ')}</span>
            </div>
          </header>
          <main className={styles.content}>{children}</main>
        </div>
      </div>
    </StatsProvider>
  );
}
